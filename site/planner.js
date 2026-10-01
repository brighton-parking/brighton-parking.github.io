/* Stay planner: the cheapest legal place to park for a given arrival time, stay and place.
 * Loaded after app.js and uses its globals (map, bays, prices, geocode, clock, duration, money…). */
"use strict";

const PLAN_DURATIONS = [30, 60, 90, 120, 180, 240, 300, 360, 480, 660, 720, 1440, 2880];
const PLAN_RADII = [100, 200, 300, 500, 800];
const PLAN_COLOR = { best: "#1b9e77", ok: "#2c6fbb", unknown: "#8a8f98", no: "#c9cdd3" };
const PLAN_STORE = "brighton-parking-plan";
const MY_LOCATION = "My location";

const planner = {
  active: false,
  inputs: null,        // { where, date, time, dur, radius }
  origin: null,        // { lat, lon }
  here: null,          // last "use my location" fix
  picked: null,        // last suggestion picked in the "Near" box
  results: null,       // { options, extra, counts, best, byId }
  flagged: [],         // ids carrying a "plan" feature-state
  savedPaint: null,    // paint properties to restore on exit
  savedLegend: null,
};

// ---------------------------------------------------------------- stay maths

/** Parts of [s, e) (week-minutes from Monday of the arrival week) inside restriction intervals, merged. */
function restrictedSessions(iv, s, e) {
  const hits = [];
  for (let k = -1; k * WEEK < e; k++) {
    for (const [a, b] of iv) {
      const x = Math.max(a + k * WEEK, s), y = Math.min(b + k * WEEK, e);
      if (y > x) hits.push([x, y]);
    }
  }
  hits.sort((p, q) => p[0] - q[0]);
  const out = [];
  for (const h of hits) {
    const last = out[out.length - 1];
    if (last && h[0] <= last[1]) last[1] = Math.max(last[1], h[1]);
    else out.push([h[0], h[1]]);
  }
  return out;
}

function seasonAt(t, ctx) {
  const dayOffset = Math.floor(t / 1440) - Math.floor(ctx.s / 1440);
  const month = new Date(Date.UTC(ctx.y, ctx.m - 1, ctx.d + dayOffset)).getUTCMonth() + 1;
  return month >= 3 && month <= 10 ? "summer" : "winter";
}

function sessionText([x, y], ctx) {
  const sameDay = Math.floor(x / 1440) === Math.floor(ctx.s / 1440);
  const day = sameDay ? "" : `${DAY_NAME[DAYS[Math.floor(x / 1440) % 7]]} `;
  return `${day}${clock(x)}–${clock(y)}`;
}

/**
 * What staying in this bay for the planned period means, for a driver without a permit.
 * Each separate stretch of charging hours is paid as its own session and must fit the max stay.
 */
function stayOutcome(bay, ctx) {
  const p = bay.p;
  if (!bay.iv) return { ok: false, unknown: true, reason: "The council's data has no hours for this bay" };
  if (permitCovers(p)) return { ok: true, cost: 0, sessions: [], text: `Free with your Zone ${myZone} permit` };
  const sessions = restrictedSessions(bay.iv, ctx.s, ctx.e);

  if (p.type === "permit") {
    if (sessions.length) {
      const [x] = sessions[0];
      const day = Math.floor(x / 1440) === Math.floor(ctx.s / 1440) ? "" : ` ${DAY_NAME[DAYS[Math.floor(x / 1440) % 7]]}`;
      return { ok: false, reason: `Permit holders only from ${clock(x)}${day}` };
    }
    return { ok: true, cost: 0, sessions: [], text: "Free, as your stay is outside permit hours" };
  }
  if (!sessions.length) return { ok: true, cost: 0, sessions: [], text: "Free, as your stay is outside charging hours" };

  const band = prices?.bands?.[p.price_band];
  let cost = 0, priced = true;
  const parts = [];
  for (const ses of sessions) {
    const len = ses[1] - ses[0];
    if (p.max_stay_mins != null && len > p.max_stay_mins) {
      return { ok: false, reason: `Max stay is ${duration(p.max_stay_mins)}, but you'd need ${duration(len)} (${sessionText(ses, ctx)})` };
    }
    const rates = band && (band.rates || band[seasonAt(ses[0], ctx)]);
    if (!rates) { priced = false; parts.push(`pay for ${sessionText(ses, ctx)}`); continue; }
    const tier = Object.keys(rates).map(Number).sort((a, b) => a - b).find(m => m >= len);
    if (tier == null) return { ok: false, reason: `No published price for a ${duration(len)} stay` };
    cost += rates[tier];
    parts.push(`${money(rates[tier])} for ${sessionText(ses, ctx)}`);
  }
  const charged = sessions.reduce((t, [x, y]) => t + y - x, 0);
  const tail = charged < ctx.e - ctx.s ? ", free the rest of the time" : "";
  return { ok: true, cost: priced ? cost : null, sessions, text: parts.join(", then ") + tail };
}

/** Straight-line metres from (lon0, lat0) to the nearest edge of a bay polygon. */
function distanceTo(geom, lon0, lat0) {
  const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  let best = Infinity;
  for (const poly of polys) {
    const ring = poly[0];
    for (let i = 0; i < ring.length - 1; i++) {
      const x1 = (ring[i][0] - lon0) * kx, y1 = (ring[i][1] - lat0) * ky;
      const x2 = (ring[i + 1][0] - lon0) * kx, y2 = (ring[i + 1][1] - lat0) * ky;
      const dx = x2 - x1, dy = y2 - y1, L = dx * dx + dy * dy;
      const t = L ? Math.max(0, Math.min(1, -(x1 * dx + y1 * dy) / L)) : 0;
      best = Math.min(best, Math.hypot(x1 + t * dx, y1 + t * dy));
    }
  }
  return best;
}

/** Is the point inside the polygon? Even-odd over every ring, so holes count as outside. */
function insidePolygon(geom, lon, lat) {
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  let inside = false;
  for (const ring of polys.flat()) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** A zone with no mapped bays at or within `radius` m of the point: its bays can't be in the results. */
function unmappedZoneNear(lon, lat, radius) {
  for (const z of unmapped.values()) {
    if (insidePolygon(z.g, lon, lat) || distanceTo(z.g, lon, lat) <= radius) return z;
  }
  return null;
}

/** Arrival date/time -> { s, e } in week-minutes from the Monday of that week, plus the date. */
function stayContext({ date, time, dur }) {
  const [y, m, d] = date.split("-").map(Number);
  const dayIdx = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;   // Monday = 0
  const s = dayIdx * 1440 + hhmm(time);
  return { y, m, d, s, e: s + dur };
}

function computePlan() {
  const { lat, lon } = planner.origin;
  const radius = planner.inputs.radius;
  const ctx = stayContext(planner.inputs);
  const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110540;
  const near = [];
  for (const [id, bay] of bays) {
    const [cx, cy] = bay.p.centroid;
    if (Math.hypot((cx - lon) * kx, (cy - lat) * ky) > radius + 300) continue;   // cheap pre-filter
    const dist = distanceTo(bay.g, lon, lat);
    if (dist <= radius) near.push({ id, bay, dist, out: stayOutcome(bay, ctx) });
  }
  const priced = near.filter(n => n.out.ok && n.out.cost != null)
    .sort((a, b) => a.out.cost - b.out.cost || a.dist - b.dist);
  const best = priced.length ? priced[0].out.cost : null;

  // One entry per distinct option (same price, bay type, zone and payment pattern): keep the nearest.
  const seen = new Set(), options = [];
  for (const n of priced) {
    const key = [n.out.cost, n.bay.p.type, n.bay.p.zone, n.out.text].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    options.push(n);
  }
  const extra = near.filter(n => n.out.ok && n.out.cost == null).sort((a, b) => a.dist - b.dist);
  const counts = {
    total: near.length,
    ok: near.filter(n => n.out.ok).length,
    best: priced.filter(n => n.out.cost === best).length,
    permit: near.filter(n => !n.out.ok && n.bay.p.type === "permit" && !n.out.unknown).length,
    maxStay: near.filter(n => !n.out.ok && /^Max stay/.test(n.out.reason)).length,
  };
  const byId = new Map(near.map(n => [n.id, n]));
  planner.results = { options, extra, counts, best, byId, ctx };
}

// ---------------------------------------------------------------- map styling

function planState(n) {
  if (n.out.unknown) return "unknown";
  if (!n.out.ok) return "no";
  if (n.out.cost == null) return "unknown";
  return n.out.cost === planner.results.best ? "best" : "ok";
}

function applyPlanStyle() {
  clearPlanStates();
  for (const [id, n] of planner.results.byId) {
    const st = planState(n);
    map.setFeatureState({ source: "bays", id }, { plan: st });
    map.setFeatureState({ source: "points", id }, { plan: st });
    planner.flagged.push(id);
  }
  const state = ["coalesce", ["feature-state", "plan"], "none"];
  const color = ["match", state, "best", PLAN_COLOR.best, "ok", PLAN_COLOR.ok,
    "unknown", PLAN_COLOR.unknown, "no", PLAN_COLOR.no, "#9aa0a6"];
  const on = (a, b) => ["case", ["!=", state, "none"], a, b];

  if (!planner.savedPaint) {
    planner.savedPaint = {};
    for (const [layer, props] of Object.entries(PLAN_PAINT_PROPS)) {
      for (const prop of props) planner.savedPaint[`${layer}|${prop}`] = map.getPaintProperty(layer, prop);
    }
  }
  map.setPaintProperty("bays-fill", "fill-color", color);
  map.setPaintProperty("bays-fill", "fill-opacity", on(0.75, 0.12));
  map.setPaintProperty("bays-line", "line-color", color);
  map.setPaintProperty("bays-line", "line-opacity", on(1, 0.15));
  map.setPaintProperty("bays-points", "circle-color", color);
  map.setPaintProperty("bays-points", "circle-opacity", on(1, 0.15));
  map.setPaintProperty("bays-points", "circle-stroke-opacity", on(1, 0.15));

  // Radius ring around the destination.
  const ring = [];
  const { lat, lon } = planner.origin, r = planner.inputs.radius;
  const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110540;
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * 2 * Math.PI;
    ring.push([lon + (r * Math.cos(a)) / kx, lat + (r * Math.sin(a)) / ky]);
  }
  const area = { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } };
  if (map.getSource("plan-area")) map.getSource("plan-area").setData(area);
  else {
    map.addSource("plan-area", { type: "geojson", data: area });
    map.addLayer({ id: "plan-area-fill", type: "fill", source: "plan-area",
      paint: { "fill-color": "#1f3a5f", "fill-opacity": 0.05 } }, "bays-fill");
    map.addLayer({ id: "plan-area-line", type: "line", source: "plan-area",
      paint: { "line-color": "#1f3a5f", "line-width": 1.5, "line-dasharray": [2, 2], "line-opacity": 0.6 } }, "bays-fill");
  }

  searchMarker?.remove();
  searchMarker = new maplibregl.Marker({ color: "#1f3a5f" }).setLngLat([lon, lat]).addTo(map);
}

const PLAN_PAINT_PROPS = {
  "bays-fill": ["fill-color", "fill-opacity"],
  "bays-line": ["line-color", "line-opacity"],
  "bays-points": ["circle-color", "circle-opacity", "circle-stroke-opacity"],
};

function clearPlanStates() {
  for (const id of planner.flagged) {
    map.removeFeatureState({ source: "bays", id }, "plan");
    map.removeFeatureState({ source: "points", id }, "plan");
  }
  planner.flagged = [];
}

function exitPlan() {
  planner.active = false;
  clearPlanStates();
  if (planner.savedPaint) {
    for (const [key, value] of Object.entries(planner.savedPaint)) {
      const [layer, prop] = key.split("|");
      map.setPaintProperty(layer, prop, value);
    }
  }
  for (const id of ["plan-area-line", "plan-area-fill"]) if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource("plan-area")) map.removeSource("plan-area");
  if (planner.savedLegend != null) document.querySelector(".legend").innerHTML = planner.savedLegend;
  updatePermitChrome();
  $("plan-chip").hidden = true;
  $("plan-btn").hidden = false;
  $("clock").hidden = false;
  closeSheet();
}

function fitToPlan() {
  const { lat, lon } = planner.origin, r = planner.inputs.radius;
  const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110540;
  const sheetH = $("sheet").hidden ? 0 : $("sheet").offsetHeight;
  map.fitBounds([[lon - r / kx, lat - r / ky], [lon + r / kx, lat + r / ky]], {
    padding: { top: 160, bottom: Math.min(sheetH, window.innerHeight * 0.6) + 20, left: 20, right: 20 },
    maxZoom: 18, duration: 800,
  });
}

// ---------------------------------------------------------------- UI

function londonToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());   // YYYY-MM-DD
}

function defaultInputs() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(PLAN_STORE)) || {}; } catch { /* storage may be unavailable */ }
  const nowMin = weekMinute() % 1440;
  const next = Math.min(Math.ceil((nowMin + 1) / 15) * 15, 1425);
  return {
    where: $("q").value.trim() || saved.where || "",
    date: londonToday(),
    time: `${String(Math.floor(next / 60)).padStart(2, "0")}:${String(next % 60).padStart(2, "0")}`,
    dur: saved.dur || 120,
    radius: saved.radius || 200,
  };
}

function openPlanForm() {
  closeSheetQuietly();
  const v = planner.inputs || defaultInputs();
  const opt = (list, cur, fmt) => list.map(x => `<option value="${x}"${x === cur ? " selected" : ""}>${fmt(x)}</option>`).join("");
  $("sheet-body").innerHTML = `
    <h2>Plan a stay</h2>
    <div class="sub">Find the cheapest place to park, without moving the car.</div>
    <form id="plan-form" class="plan-form" autocomplete="off">
      <label class="full">Near
        <span class="row">
          <input name="where" value="${esc(v.where)}" placeholder="Street, venue or postcode" required
                 autocapitalize="words" spellcheck="false" enterkeyhint="go">
          <button type="button" class="btn" data-act="here">Use my location</button>
        </span>
        <ul class="suggest inline" id="plan-suggest" hidden></ul>
      </label>
      <label>Date <input type="date" name="date" value="${esc(v.date)}" required></label>
      <label>Arrive <input type="time" name="time" value="${esc(v.time)}" step="300" required></label>
      <label>Stay <select name="dur">${opt(PLAN_DURATIONS, +v.dur, m => m >= 1440 ? `${m / 1440} day${m > 1440 ? "s" : ""}` : duration(m))}</select></label>
      <label>Within <select name="radius">${opt(PLAN_RADII, +v.radius, r => `${r} m`)}</select></label>
      <button type="submit" class="btn primary big full">Find cheapest parking</button>
    </form>`;
  $("sheet").dataset.view = "form";
  $("sheet").hidden = false;
  attachSuggest($("plan-form").elements.where, $("plan-suggest"), it => { planner.picked = it; });
}

/** Hide the sheet without the plan-aware "back to results" behaviour. */
function closeSheetQuietly() {
  if (selectedId) map.setFeatureState({ source: "bays", id: selectedId }, { selected: false });
  selectedId = null;
  $("sheet").hidden = true;
}

async function submitPlan(form) {
  const f = new FormData(form);
  const inputs = {
    where: f.get("where").trim(), date: f.get("date"), time: f.get("time"),
    dur: +f.get("dur"), radius: +f.get("radius"),
  };
  if (!map.getLayer("bays-fill")) return toast("Still loading parking data, so try again in a moment");
  const btn = form.querySelector("[type=submit]");
  btn.disabled = true;
  btn.textContent = "Searching…";
  try {
    let origin;
    if (inputs.where === MY_LOCATION && planner.here) origin = planner.here;
    else if (planner.picked && inputs.where === planner.picked.label) origin = { lat: planner.picked.lat, lon: planner.picked.lon };
    else {
      const hit = await geocode(inputs.where);
      if (!hit) throw new Error(`Couldn't find “${inputs.where}”`);
      origin = { lat: hit.lat, lon: hit.lon };
    }
    try { localStorage.setItem(PLAN_STORE, JSON.stringify({ where: inputs.where, dur: inputs.dur, radius: inputs.radius })); } catch { /* optional */ }
    planner.inputs = inputs;
    planner.origin = origin;
    planner.active = true;
    computePlan();
    applyPlanStyle();
    showPlanChrome();
    showPlanResults();
    fitToPlan();
  } catch (err) {
    toast(err.message.startsWith("Couldn't") ? err.message : "Search failed, so check your connection");
    btn.disabled = false;
    btn.textContent = "Find cheapest parking";
  }
}

function planSummaryLabel() {
  const { date, time, dur, radius, where } = planner.inputs;
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = dt.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const stay = dur >= 1440 ? `${dur / 1440} day${dur > 1440 ? "s" : ""}` : duration(dur);
  return { short: `${day} ${clock(hhmm(time))} · ${stay}`, long: `${day}, ${clock(hhmm(time))} for ${stay}, within ${radius} m of ${where}` };
}

function showPlanChrome() {
  const legend = document.querySelector(".legend");
  if (planner.savedLegend == null) planner.savedLegend = legend.innerHTML;
  legend.innerHTML = `
    <li><i style="--c:${PLAN_COLOR.best}"></i>Cheapest</li>
    <li><i style="--c:${PLAN_COLOR.ok}"></i>Other options</li>
    <li><i style="--c:${PLAN_COLOR.no}"></i>Not allowed</li>`;
  $("plan-chip-open").textContent = `Plan · ${planSummaryLabel().short}`;
  $("plan-chip").hidden = false;
  $("plan-btn").hidden = true;
  $("clock").hidden = true;
}

function optionHtml(n) {
  const p = n.bay.p;
  const price = n.out.cost == null ? "£?" : n.out.cost === 0 ? "Free" : money(n.out.cost);
  const what = [TYPE_TITLE[p.type], p.zone && p.zone !== "SEA" && `Zone ${p.zone}`,
    p.type !== "permit" && !permitCovers(p) && p.max_stay_mins != null && `max ${duration(p.max_stay_mins)}`].filter(Boolean).join(" · ");
  return `<li><button class="option" data-id="${esc(n.id)}">
      <span class="price${n.out.cost === planner.results.best ? " best" : ""}">${price}</span>
      <span class="what"><b>${esc(what)}</b><small>${esc(n.out.text)}</small></span>
      <span class="dist">${Math.round(n.dist)} m</span>
    </button></li>`;
}

function showPlanResults() {
  if (!planner.active || !planner.results) return;
  const { options, extra, counts, best } = planner.results;
  const label = planSummaryLabel().long;
  let body;
  if (!options.length && !extra.length) {
    const why = [
      counts.permit && `${counts.permit} permit-only during your stay`,
      counts.maxStay && `${counts.maxStay} with a max stay shorter than you need`,
    ].filter(Boolean).join(", ");
    body = `<div class="plan-summary none"><b>Nowhere legal within ${planner.inputs.radius} m</b>
      <span>${counts.total ? `${counts.total} bays nearby${why ? `: ${esc(why)}` : ""}.` : "No paid, permit or shared bays nearby."}
      Try a bigger distance or a shorter stay.</span></div>`;
  } else {
    const head = best == null ? "Prices unknown nearby"
      : best === 0 ? "You can park for free" : `Cheapest: ${money(best)}`;
    const sub = best == null ? "" : `${counts.best} bay${counts.best === 1 ? "" : "s"} at this price, and ${counts.ok} of ${counts.total} bays nearby work for your stay`;
    body = `<div class="plan-summary"><b>${head}</b><span>${esc(sub)}</span></div>
      <ol class="options">${options.slice(0, 8).map(optionHtml).join("")}${extra.slice(0, 3).map(optionHtml).join("")}</ol>`;
  }
  const gap = unmappedZoneNear(planner.origin.lon, planner.origin.lat, planner.inputs.radius);
  const gapWarn = gap ? `<div class="warn">Zone ${esc(gap.p.zone)}${gap.p.name ? ` (${esc(gap.p.name)})` : ""} is nearby,
    but the council hasn't mapped its bays yet, so they're missing from these results. Tap the hatched area for its rules.</div>` : "";
  $("sheet-body").innerHTML = `
    <h2>Your stay</h2>
    <div class="sub">${esc(label)}</div>
    ${gapWarn}
    ${body}
    <div class="actions">
      <button class="btn" data-act="edit">Change</button>
      <button class="btn" data-act="clear">Clear plan</button>
    </div>
    <p class="fine">Distances are in a straight line. ${myZone
      ? `Your Zone ${esc(myZone)} permit is treated as covering Zone ${esc(myZone)} permit and shared-use bays for free, with no time limit.`
      : "Assumes you don't have a permit."} Each separate charging period is paid for as its own session. Bank holidays and event days aren't included, so always check the signs.</p>`;
  $("sheet").dataset.view = "results";
  $("sheet").hidden = false;
}

// Hooks used by renderSheet() in app.js when a bay card is shown.
function planCardTop() {
  return planner.active ? `<button class="back" data-act="back">‹ Back to results</button>` : "";
}

function planCardBody(id) {
  if (!planner.active) return "";
  let n = planner.results.byId.get(id);
  if (!n) {
    const bay = bays.get(id);
    n = { bay, dist: distanceTo(bay.g, planner.origin.lon, planner.origin.lat), out: stayOutcome(bay, planner.results.ctx) };
  }
  const dist = `${Math.round(n.dist)} m away`;
  if (!n.out.ok) {
    return `<div class="plan-box no"><b>Not allowed for your stay</b><span>${esc(n.out.reason)} · ${dist}</span></div>`;
  }
  const price = n.out.cost == null ? "Price unknown" : n.out.cost === 0 ? "Free" : money(n.out.cost);
  return `<div class="plan-box ok"><b>Your stay: ${price}</b><span>${esc(n.out.text)} · ${dist}</span></div>`;
}

// ---------------------------------------------------------------- events

$("plan-btn").addEventListener("click", openPlanForm);
$("plan-chip-open").addEventListener("click", () => { closeSheetQuietly(); showPlanResults(); fitToPlan(); });
$("plan-chip-clear").addEventListener("click", exitPlan);

$("sheet-body").addEventListener("submit", e => {
  if (e.target.id !== "plan-form") return;
  e.preventDefault();
  document.activeElement?.blur();
  submitPlan(e.target);
});

$("sheet-body").addEventListener("click", e => {
  const act = e.target.closest("[data-act]")?.dataset.act;
  const option = e.target.closest(".option");
  if (option) {
    const bay = bays.get(option.dataset.id);
    select(option.dataset.id);
    const sheetH = $("sheet").offsetHeight;
    map.easeTo({ center: bay.p.centroid, zoom: Math.max(map.getZoom(), 17.5), offset: [0, -sheetH / 2 + 40], duration: 700 });
    return;
  }
  if (act === "back") closeSheet();
  else if (act === "edit") openPlanForm();
  else if (act === "clear") exitPlan();
  else if (act === "here") {
    const input = e.target.closest("form").elements.where;
    if (!navigator.geolocation) return toast("Location isn't available on this device");
    navigator.geolocation.getCurrentPosition(
      pos => { planner.here = { lat: pos.coords.latitude, lon: pos.coords.longitude }; input.value = MY_LOCATION; },
      () => toast("Couldn't get your location"),
      { enableHighAccuracy: true, timeout: 10000 });
  }
});
