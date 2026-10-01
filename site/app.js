/* Brighton Parking — map of on-street bays coloured by whether they're restricted right now. */
"use strict";

const BRIGHTON = [-0.1372, 50.8262];
const BASEMAP = "https://tiles.openfreemap.org/styles/positron";
const DATA_URL = "data/parking_bays.geojson";
const ZONES_URL = "data/unmapped_zones.geojson";   // controlled zones whose bays the council hasn't mapped yet
const MOTO_URL = "data/motorcycle_bays.geojson";   // loaded only when motorcycle bays are switched on
const BOUNDARIES_URL = "data/zone_boundaries.geojson";   // loaded only when zone boundaries are switched on
const SATELLITE = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_NAME = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
const WEEK = 7 * 1440;
const POINTS_MAX_ZOOM = 15.5;   // below this, bays are drawn as dots; above, as shapes

const css = getComputedStyle(document.documentElement);
const COLOR = Object.fromEntries(["free", "pay", "shared", "permit", "unknown", "moto", "zone"].map(k => [k, css.getPropertyValue(`--${k}`).trim()]));
COLOR.mine = COLOR.free;

const TYPE_TITLE = { paid: "Paid parking bay", permit: "Permit holders bay", shared: "Shared use bay" };
const STATUS_TEXT = {
  free: "Free to park now",
  pay: "Pay to park now",
  shared: "Pay to park now (or permit holders)",
  permit: "Permit holders only now",
  mine: "You can park here with your permit",
  unknown: "Hours unknown — check the signs",
};

const $ = id => document.getElementById(id);
const bays = new Map();         // id -> { p: properties, g: geometry, iv: [[start, end], ...] week-minute intervals | null, status }
let prices = null;              // site/prices.json, if it loaded
const unmapped = new Map();     // zone code -> { p: properties (from zones.json), g: geometry, iv }
const motos = new Map();        // motorcycle bay id -> properties, once loaded
let selectedId = null;
let selectedZone = null;
let selectedMoto = null;
let searchMarker = null;

// ---------------------------------------------------------------- my permit zone (saved on this device)

const ZONE_STORE = "brighton-parking-permit-zone";
let myZone = null;
try { myZone = localStorage.getItem(ZONE_STORE) || null; } catch { /* storage may be unavailable */ }

/** Does the user's permit cover this bay? Bays like "N&R" belong to more than one zone. */
function permitCovers(p) {
  if (!myZone || !p.zone || p.type === "paid") return false;
  return p.zone.split("&").map(z => z.trim()).includes(myZone);
}

// ---------------------------------------------------------------- view preferences (saved on this device)

const VIEW_STORE = "brighton-parking-view";
const view = { hidden: [], satellite: false, moto: false, zones: false };   // hidden legend categories, map layer switches
try { Object.assign(view, JSON.parse(localStorage.getItem(VIEW_STORE)) || {}); } catch { /* storage may be unavailable */ }
function saveView() {
  try { localStorage.setItem(VIEW_STORE, JSON.stringify(view)); } catch { /* optional */ }
}

/** Legend category for a bay status: bays your permit covers sit under "Free". */
const category = status => (status === "mine" ? "free" : status);
const planActive = () => typeof planner !== "undefined" && planner.active;

// ---------------------------------------------------------------- time (always Europe/London)

const londonFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

/** Minutes since Monday 00:00, London time. */
function weekMinute(date = new Date()) {
  const p = Object.fromEntries(londonFmt.formatToParts(date).map(x => [x.type, x.value]));
  return DAYS.indexOf(p.weekday.slice(0, 3).toLowerCase()) * 1440 + (+p.hour) * 60 + (+p.minute);
}

const hhmm = s => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };

function clock(min) {
  min = ((min % 1440) + 1440) % 1440;
  const h = Math.floor(min / 60), m = min % 60;
  if (h === 12 && m === 0) return "noon";
  if (h === 0 && m === 0) return "midnight";
  const h12 = h % 12 || 12, ap = h < 12 ? "am" : "pm";
  return m ? `${h12}:${String(m).padStart(2, "0")}${ap}` : `${h12}${ap}`;
}

/** Schedule windows -> list of [start, end) intervals in week-minutes. */
function compile(schedule) {
  if (!schedule || !schedule.length) return null;
  const iv = [];
  for (const w of schedule) {
    const s = hhmm(w.start), e = hhmm(w.end);
    for (const d of w.days) {
      const base = DAYS.indexOf(d) * 1440;
      iv.push([base + s, base + (e > s ? e : e + 1440)]);   // e <= s means it runs past midnight
    }
  }
  return iv;
}

function restrictedAt(iv, wm) {
  wm = ((wm % WEEK) + WEEK) % WEEK;
  return iv.some(([a, b]) => (wm >= a && wm < b) || (wm + WEEK >= a && wm + WEEK < b));
}

/** Minutes until the restriction next switches on/off, or null if it never does. */
function minutesToChange(iv, wm) {
  const now = restrictedAt(iv, wm);
  const deltas = [...new Set(iv.flat().map(x => ((x - wm) % WEEK + WEEK) % WEEK || WEEK))].sort((a, b) => a - b);
  for (const d of deltas) if (restrictedAt(iv, wm + d) !== now) return d;
  return null;
}

function statusOf(bay, wm) {
  if (!bay.iv) return "unknown";
  if (!restrictedAt(bay.iv, wm)) return "free";
  if (permitCovers(bay.p)) return "mine";
  return { paid: "pay", shared: "shared", permit: "permit" }[bay.p.type];
}

function whenText(wm, delta) {
  const t = wm + delta;
  const days = Math.floor(t / 1440) - Math.floor(wm / 1440);
  const time = clock(t);
  if (days === 0) return time;
  if (days === 1) return `${time} tomorrow`;
  return `${time} ${DAY_NAME[DAYS[Math.floor(t / 1440) % 7]]}`;
}

function daysLabel(days) {
  if (days.length === 7) return "Every day";
  const idx = days.map(d => DAYS.indexOf(d));
  const contiguous = idx.every((v, i) => i === 0 || v === (idx[i - 1] + 1) % 7);
  if (contiguous && days.length > 2) return `${DAY_NAME[days[0]]}–${DAY_NAME[days[days.length - 1]]}`;
  return days.map(d => DAY_NAME[d]).join(", ");
}

function hoursLines(schedule) {
  const groups = new Map();
  for (const w of schedule) {
    const k = daysLabel(w.days);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(`${clock(hhmm(w.start))}–${clock(hhmm(w.end))}`);
  }
  return [...groups].map(([d, t]) => `${d}, ${t.join(" & ")}`);
}

const money = n => `£${n.toFixed(2)}`;

/** Price rows for a bay, e.g. [["1 hr", 1.8], ["2 hr", 3.5]], capped at its max stay. */
function priceInfo(p) {
  const band = prices?.bands?.[p.price_band];
  if (!band) return null;
  let season = null, rates = band.rates;
  if (!rates) {
    const month = +new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", month: "numeric" }).format(new Date());
    season = month >= 3 && month <= 10 ? "summer" : "winter";
    rates = band[season];
  }
  const tiers = Object.entries(rates).map(([m, v]) => [+m, v]).sort((a, b) => a[0] - b[0]);
  const max = p.max_stay_mins;
  const rows = [];
  for (const [m, v] of tiers) {
    if (max != null && m > max) {
      // Max stay falls between tiers (e.g. 3 hr): you pay the next tier's "up to" price.
      if (!rows.length || rows[rows.length - 1][0] < max) rows.push([max, v]);
      break;
    }
    rows.push([m, v]);
  }
  return { label: band.label, season, rows: rows.map(([m, v]) => [duration(m), v]) };
}

function duration(mins) {
  if (mins == null) return null;
  const h = Math.floor(mins / 60), m = mins % 60;
  return [h && `${h} hr`, m && `${m} min`].filter(Boolean).join(" ");
}

// ---------------------------------------------------------------- map

const map = new maplibregl.Map({
  container: "map",
  style: BASEMAP,
  center: BRIGHTON,
  zoom: 14,
  minZoom: 10,
  attributionControl: { compact: true },
  dragRotate: false,
  pitchWithRotate: false,
});
map.touchZoomRotate.disableRotation();

const geolocate = new maplibregl.GeolocateControl({
  positionOptions: { enableHighAccuracy: true },
  trackUserLocation: true,
  fitBoundsOptions: { maxZoom: 17 },
});
map.addControl(geolocate, "bottom-right");
geolocate.on("error", () => toast("Couldn't get your location"));

map.addControl({
  onAdd() {
    const div = document.createElement("div");
    div.className = "maplibregl-ctrl maplibregl-ctrl-group";
    div.innerHTML = `<button type="button" aria-label="Map layers" title="Map layers">
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 3 2.5 8 12 13l9.5-5L12 3Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="m2.5 12.5 9.5 5 9.5-5M2.5 16.5l9.5 5 9.5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
    </button>`;
    div.querySelector("button").addEventListener("click", openLayers);
    return div;
  },
  onRemove() {},
}, "bottom-right");

// "no-cache" still uses the browser's copy, but checks with the server first that it's current.
const FRESH = { cache: "no-cache" };
fetch("prices.json", FRESH).then(r => r.ok ? r.json() : null).then(j => { prices = j; }).catch(() => {});

const dataReady = fetch(DATA_URL, FRESH).then(r => {
  if (!r.ok) throw new Error(r.status);
  return r.json();
});
const zonesReady = fetch(ZONES_URL, FRESH).then(r => r.ok ? r.json() : null).catch(() => null);

map.on("load", async () => {
  let fc;
  try {
    fc = await dataReady;
  } catch {
    $("loading").textContent = "Couldn't load parking data";
    return;
  }

  const points = { type: "FeatureCollection", features: [] };
  for (const f of fc.features) {
    const p = f.properties;
    bays.set(p.id, { p, g: f.geometry, iv: compile(p.schedule), status: null });
    points.features.push({ type: "Feature", properties: { id: p.id }, geometry: { type: "Point", coordinates: p.centroid } });
  }

  map.addSource("bays", { type: "geojson", data: fc, promoteId: "id" });
  map.addSource("points", { type: "geojson", data: points, promoteId: "id" });

  const color = ["match", ["coalesce", ["feature-state", "status"], "unknown"],
    "free", COLOR.free, "mine", COLOR.free, "pay", COLOR.pay, "shared", COLOR.shared, "permit", COLOR.permit, COLOR.unknown];
  const beforeLabels = map.getStyle().layers.find(l => l.type === "symbol")?.id;

  // Bays in a category switched off in the legend are drawn fully transparent.
  const shown = v => ["case", ["boolean", ["feature-state", "hidden"], false], 0, v];
  map.addLayer({
    id: "bays-fill", type: "fill", source: "bays", minzoom: POINTS_MAX_ZOOM - 0.5,
    paint: { "fill-color": color, "fill-opacity": shown(0.55) },
  }, beforeLabels);
  map.addLayer({
    id: "bays-line", type: "line", source: "bays", minzoom: POINTS_MAX_ZOOM - 0.5,
    paint: { "line-color": color, "line-opacity": shown(1), "line-width": ["interpolate", ["linear"], ["zoom"], 15, 1, 19, 2.5] },
  }, beforeLabels);
  map.addLayer({
    id: "bays-selected", type: "line", source: "bays",
    paint: {
      "line-color": "#111",
      "line-width": ["case", ["boolean", ["feature-state", "selected"], false], 3.5, 0],
    },
  });
  addUnmappedZones(await zonesReady, "bays-fill");
  map.addLayer({
    id: "bays-points", type: "circle", source: "points", maxzoom: POINTS_MAX_ZOOM,
    paint: {
      "circle-color": color,
      "circle-opacity": shown(1),
      "circle-stroke-opacity": shown(1),
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 1.5, 13, 2.5, 15.5, 5],
      "circle-stroke-color": "#fff",
      "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 12, 0, 14, 0.8],
    },
  });

  if (view.satellite) showSatellite(true);
  if (view.moto) showMoto(true);
  if (view.zones) showZones(true);
  refresh();
  updatePermitChrome();
  setInterval(refresh, 30 * 1000);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    refresh();
    reloadIfDataChanged();
  });
  $("loading").hidden = true;
  $("plan-btn").hidden = false;

  // Jump to the user's location straight away if they've already allowed it.
  navigator.permissions?.query({ name: "geolocation" })
    .then(s => { if (s.state === "granted") geolocate.trigger(); })
    .catch(() => {});
});

// ---------------------------------------------------------------- picking up new data
// A home-screen app can stay open for days. When it comes back into view, check whether the
// data has been rebuilt since it loaded, and reload if so (unless a card or plan is open).

const METADATA_URL = "data/metadata.json";
const loadedData = fetch(METADATA_URL, FRESH).then(r => r.ok ? r.json() : null).then(m => m?.fetched_at).catch(() => null);
let lastDataCheck = Date.now();

async function reloadIfDataChanged() {
  if (Date.now() - lastDataCheck < 10 * 60 * 1000) return;   // at most every 10 minutes
  lastDataCheck = Date.now();
  try {
    const [was, now] = await Promise.all([loadedData,
      fetch(METADATA_URL, { cache: "no-store" }).then(r => r.ok ? r.json() : null).then(m => m?.fetched_at)]);
    const busy = !$("sheet").hidden || planActive() || document.activeElement?.matches?.("input, select");
    if (was && now && now !== was && !busy) location.reload();
  } catch { /* offline: keep what we have */ }
}

/** Hatch the zones whose bays aren't in the data, so an empty patch of map doesn't read as "no restrictions". */
function addUnmappedZones(fc, before) {
  if (!fc?.features.length) return;
  for (const f of fc.features) unmapped.set(f.properties.zone, { p: f.properties, g: f.geometry, iv: compile(f.properties.schedule) });

  const size = 16, c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  g.strokeStyle = COLOR.unknown;
  g.lineWidth = 2.5;
  for (const o of [-size, 0, size]) { g.beginPath(); g.moveTo(o, size); g.lineTo(o + size, 0); g.stroke(); }
  map.addImage("hatch", g.getImageData(0, 0, size, size), { pixelRatio: 2 });

  map.addSource("unmapped-zones", { type: "geojson", data: fc });
  map.addLayer({ id: "zones-fill", type: "fill", source: "unmapped-zones", paint: { "fill-pattern": "hatch", "fill-opacity": 0.45 } }, before);
  map.addLayer({
    id: "zones-line", type: "line", source: "unmapped-zones",
    paint: { "line-color": COLOR.unknown, "line-width": 1.5, "line-dasharray": [3, 2] },
  }, before);
}

/** Recompute every bay's status for the current London time and repaint the ones that changed. */
function refresh() {
  const wm = weekMinute();
  for (const [id, bay] of bays) {
    const s = statusOf(bay, wm), hidden = view.hidden.includes(category(s));
    if (s !== bay.status || hidden !== bay.hidden) {
      bay.status = s;
      bay.hidden = hidden;
      map.setFeatureState({ source: "bays", id }, { status: s, hidden });
      map.setFeatureState({ source: "points", id }, { status: s, hidden });
    }
  }
  $("clock").textContent = `Now · ${DAY_NAME[DAYS[Math.floor(wm / 1440)]]} ${clock(wm % 1440)}`;
  if (selectedId) renderSheet(selectedId);
  else if (selectedZone) renderZoneSheet(selectedZone);
}

// ---------------------------------------------------------------- tapping a bay

const isMoto = f => f.layer.id.startsWith("moto");

map.on("click", e => {
  const { x, y } = e.point;
  const withMotos = view.moto && map.getLayer("moto-fill");
  const fills = withMotos ? ["bays-fill", "moto-fill"] : ["bays-fill"];
  const dots = withMotos ? ["bays-points", "moto-points"] : ["bays-points"];
  // Bays switched off in the legend can't be tapped (a plan shows every bay, so they can then).
  const visible = f => isMoto(f) || planActive() || !bays.get(f.properties.id).hidden;
  // A tap squarely inside a bay wins; otherwise take the nearest bay within a finger's width.
  let hits = map.queryRenderedFeatures(e.point, { layers: fills }).filter(visible);
  if (!hits.length) {
    const pad = 18;
    hits = map.queryRenderedFeatures([[x - pad, y - pad], [x + pad, y + pad]], { layers: [...fills, ...dots] }).filter(visible);
  }
  if (!hits.length) {
    const zone = map.getLayer("zones-fill") && map.queryRenderedFeatures(e.point, { layers: ["zones-fill"] })[0];
    return zone ? selectZone(zone.properties.zone) : closeSheet();
  }

  let best = null, bestD = Infinity;
  for (const f of hits) {
    const c = map.project(isMoto(f) ? motos.get(f.properties.id).centroid : bays.get(f.properties.id).p.centroid);
    const d = (c.x - x) ** 2 + (c.y - y) ** 2;
    if (d < bestD) { bestD = d; best = f; }
  }
  isMoto(best) ? selectMoto(best.properties.id) : select(best.properties.id);
});

for (const layer of ["bays-fill", "bays-points", "zones-fill"]) {
  map.on("mouseenter", layer, () => { map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; });
}

/** Forget whichever bay, zone or motorcycle bay the sheet was showing. */
function clearSelection() {
  if (selectedId) map.setFeatureState({ source: "bays", id: selectedId }, { selected: false });
  if (selectedMoto) map.setFeatureState({ source: "moto", id: selectedMoto }, { selected: false });
  selectedId = selectedZone = selectedMoto = null;
}

function select(id) {
  clearSelection();
  selectedId = id;
  map.setFeatureState({ source: "bays", id }, { selected: true });
  renderSheet(id);

  // Nudge the map up if the bay is hidden behind the sheet.
  const sheetH = $("sheet").offsetHeight;
  const pt = map.project(bays.get(id).p.centroid);
  const visibleBottom = window.innerHeight - sheetH - 30;
  if (pt.y > visibleBottom) map.panBy([0, pt.y - (window.innerHeight - sheetH) / 2]);
}

function closeSheet() {
  const wasBay = ["bay", "zone", "moto"].includes($("sheet").dataset.view);
  clearSelection();
  // With a plan active, closing a bay card goes back to the plan results.
  if (wasBay && typeof planner !== "undefined" && planner.active) return showPlanResults();
  $("sheet").hidden = true;
}
$("sheet-close").addEventListener("click", closeSheet);
document.addEventListener("keydown", e => { if (e.key === "Escape") closeSheet(); });

/** Directions to a point in Apple Maps on Apple devices, Google Maps elsewhere. */
function directionsUrl([lon, lat]) {
  const isApple = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent) && "ontouchend" in document;
  return isApple
    ? `https://maps.apple.com/?daddr=${lat},${lon}`
    : `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`;
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function renderSheet(id) {
  const bay = bays.get(id), p = bay.p;
  const wm = weekMinute();
  const status = statusOf(bay, wm);

  let detail = "";
  if (bay.iv) {
    const d = minutesToChange(bay.iv, wm);
    if (d != null) {
      const when = whenText(wm, d);
      detail = status === "free"
        ? { paid: `Charges apply from ${when}`, shared: `Charges apply from ${when}`, permit: `Permit holders only from ${when}` }[p.type]
        : `Free from ${when}`;
    } else if (status !== "free") {
      detail = "At all times";
    }
  }

  const title = TYPE_TITLE[p.type] + (p.red_route ? " · Red route" : "");
  const price = priceInfo(p);
  const priceLabel = p.price_band ? prices?.bands?.[p.price_band]?.label : null;
  const sub = [p.zone && p.zone !== "SEA" && `Zone ${p.zone}`, priceLabel || (p.tariff && `${p.tariff} tariff`)].filter(Boolean).join(" · ");
  // Make the stay limit impossible to miss: it's the rule most likely to get you a ticket.
  const maxStay = p.type !== "permit" && p.max_stay_mins != null ? `Max stay ${duration(p.max_stay_mins)}` : "";
  if (status === "pay" || status === "shared") {
    const from = price?.rows.length ? `From ${money(price.rows[0][1])} for ${price.rows[0][0]}` : "";
    detail = [maxStay, from, detail].filter(Boolean).join(" · ");
  } else if (status === "mine") {
    detail = `Covered by your Zone ${myZone} permit` + (p.type === "shared" ? ", so no need to pay" : "")
      + (detail.startsWith("Free from") ? ` · Restrictions end ${detail.slice(10)}` : "");
  } else if (status === "free" && permitCovers(p)) {
    detail = `Your Zone ${myZone} permit also covers this bay during restricted hours`;
  } else if (status === "free" && maxStay && detail) {
    detail = `${detail}, ${maxStay.toLowerCase()}`;
  }

  const facts = [];
  if (p.schedule) facts.push(["Hours", hoursLines(p.schedule).map(esc).join("<br>")]);
  else if (p.days_raw || p.times_raw) facts.push(["Hours", esc([p.days_raw, p.times_raw].filter(Boolean).join(", "))]);
  if (p.type !== "permit") {
    facts.push(["Max stay", p.max_stay_mins != null
      ? `<b>${esc(duration(p.max_stay_mins))}</b> during charging hours`
      : `<span class="muted">Not recorded, so check the sign</span>`]);
    if (p.no_return_mins != null) facts.push(["No return", `Can't come back within ${esc(duration(p.no_return_mins))} of leaving`]);
  }
  const you = permitCovers(p) ? " (that includes you)" : "";
  if (p.type === "shared") facts.push(["Permits", `Zone ${esc(p.zone || "?")} permit holders can park without paying${you}`]);
  if (p.type === "permit") facts.push(["Who", `Zone ${esc(p.zone || "?")} permit holders during hours${you}`]);
  if (price) {
    const note = price.season ? ` <span class="muted">(${price.season} rate)</span>` : "";
    facts.push(["Prices", `<table class="prices">${price.rows.map(([d, v]) =>
      `<tr><td>up to ${esc(d)}</td><td>${money(v)}</td></tr>`).join("")}</table>${note}`]);
  } else if (p.type !== "permit") {
    facts.push(["Prices", `<span class="muted">Not known, so check the sign or PayByPhone</span>`]);
  }
  if (p.pay_by_phone) facts.push(["PayByPhone", `<span class="pbp"><code>${esc(p.pay_by_phone)}</code>
      <button class="btn" data-copy="${esc(p.pay_by_phone)}">Copy</button></span>`]);

  const fromOrder = p.source === "traffic_order";
  const directions = directionsUrl(p.centroid);

  $("sheet-body").innerHTML = `
    ${typeof planCardTop === "function" ? planCardTop(id) : ""}
    <h2>${esc(title)}</h2>
    <div class="sub">${esc(sub)}</div>
    <div class="status" style="--c:${COLOR[status]}">
      <i></i><div><b>${esc(STATUS_TEXT[status])}</b>${detail ? `<span>${esc(detail)}</span>` : ""}</div>
    </div>
    ${typeof planCardBody === "function" ? planCardBody(id) : ""}
    <dl class="facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>
    ${fromOrder ? `<div class="warn">The council hasn't mapped this zone's bays yet, so this one was drawn from its traffic order.
      Its position is approximate, to within a few metres, so check the signs.</div>` : ""}
    ${p.issues ? `<div class="warn">Some of the council's data for this bay was unclear or missing, so double-check the signs.</div>` : ""}
    <div class="actions"><a class="btn primary" href="${directions}" target="_blank" rel="noopener">Directions</a></div>
    <p class="fine">${fromOrder
      ? `From the council's <a href="${esc(p.source_url)}" target="_blank" rel="noopener">traffic order</a>: ${esc(p.source_text)}.`
      : "From Brighton & Hove City Council data."} Signs on the street always take precedence.</p>`;
  $("sheet").dataset.view = "bay";
  $("sheet").hidden = false;
}

// ---------------------------------------------------------------- tapping a zone with no mapped bays

function selectZone(code) {
  clearSelection();
  selectedZone = code;
  renderZoneSheet(code);
}

function renderZoneSheet(code) {
  const { p, iv } = unmapped.get(code);
  const wm = weekMinute();
  let status = "unknown", head = "Bays not mapped yet", detail = "";
  if (iv) {
    const d = minutesToChange(iv, wm);
    const when = d != null ? whenText(wm, d) : null;
    if (!restrictedAt(iv, wm)) {
      [status, head, detail] = ["free", "Free to park in bays now", when ? `Restrictions start ${when}` : ""];
    } else if (myZone === code) {
      [status, head, detail] = ["mine", STATUS_TEXT.mine, `In permit and shared bays${when ? ` · Restrictions end ${when}` : ""}`];
    } else {
      [status, head, detail] = ["shared", "Pay in shared or paid bays now",
        `Permit bays are for Zone ${code} permit holders${when ? ` · Free from ${when}` : ""}`];
    }
  }

  const since = p.since && new Date(p.since).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const facts = [];
  if (p.schedule) facts.push(["Hours", hoursLines(p.schedule).map(esc).join("<br>")]);
  for (const [k, v] of p.facts || []) facts.push([k, esc(v)]);
  const price = priceInfo(p);
  if (price) {
    facts.push(["Prices", `<table class="prices">${price.rows.map(([d, v]) =>
      `<tr><td>up to ${esc(d)}</td><td>${money(v)}</td></tr>`).join("")}</table>`]);
  }

  $("sheet-body").innerHTML = `
    ${typeof planCardTop === "function" ? planCardTop() : ""}
    <h2>Zone ${esc(code)}${p.name ? ` · ${esc(p.name)}` : ""}</h2>
    <div class="sub">${since ? `Controlled parking zone since ${esc(since)}` : "Controlled parking zone"}</div>
    <div class="status" style="--c:${COLOR[status]}">
      <i></i><div><b>${esc(head)}</b>${detail ? `<span>${esc(detail)}</span>` : ""}</div>
    </div>
    <div class="warn">The council hasn't added this zone's bays to its data yet, so they aren't on the map.
      ${facts.length ? "These details are from the zone's traffic order. " : ""}Check the signs for where the bays are and what they allow.</div>
    ${facts.length ? `<dl class="facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>` : ""}
    <p class="fine">${p.source ? `From the council's <a href="${esc(p.source)}" target="_blank" rel="noopener">${esc(p.source_label || "traffic order")}</a>. ` : ""}Signs on the street always take precedence.</p>`;
  $("sheet").dataset.view = "zone";
  $("sheet").hidden = false;
}

$("sheet-body").addEventListener("click", async e => {
  const b = e.target.closest("[data-copy]");
  if (!b) return;
  try {
    await navigator.clipboard.writeText(b.dataset.copy);
    b.textContent = "Copied";
    setTimeout(() => { b.textContent = "Copy"; }, 1500);
  } catch {
    toast(`PayByPhone code: ${b.dataset.copy}`);
  }
});

// ---------------------------------------------------------------- search

const FULL_POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
const OUTCODE = /^[A-Z]{1,2}\d[A-Z\d]?$/i;
const BH_VIEWBOX = "-0.26,50.89,-0.02,50.79";   // Brighton & Hove, for place-name searches

/** Move the map to a search result and drop a pin. Streets with an extent are fitted whole. */
function showPlace(hit) {
  closeSheet();
  if (hit.bbox) map.fitBounds(hit.bbox, { padding: { top: 170, bottom: 60, left: 40, right: 40 }, maxZoom: 17 });
  else map.flyTo({ center: [hit.lon, hit.lat], zoom: hit.zoom || 17.5, speed: 1.6 });
  searchMarker?.remove();
  searchMarker = new maplibregl.Marker({ color: "#1f3a5f" }).setLngLat([hit.lon, hit.lat]).addTo(map);
}

const mainSuggest = attachSuggest($("q"), $("q-suggest"), showPlace);

$("search").addEventListener("submit", async e => {
  e.preventDefault();
  const input = $("q");
  const q = input.value.trim();
  if (!q) return;
  input.blur();   // dismiss the phone keyboard
  const top = mainSuggest.first();
  mainSuggest.close();
  if (top) { input.value = top.label; return showPlace(top); }
  try {
    const hit = await geocode(q);
    if (!hit) return toast(`Couldn't find “${q}”`);
    showPlace(hit);
  } catch {
    toast("Search failed, so check your connection");
  }
});

async function geocode(q) {
  const compact = q.replace(/\s+/g, "");
  if (FULL_POSTCODE.test(q)) {
    const r = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(compact)}`);
    if (r.ok) { const { result } = await r.json(); return { lat: result.latitude, lon: result.longitude, zoom: 17.5 }; }
    if (r.status !== 404) throw new Error(r.status);
    return null;
  }
  if (OUTCODE.test(q)) {
    const r = await fetch(`https://api.postcodes.io/outcodes/${encodeURIComponent(compact)}`);
    if (r.ok) { const { result } = await r.json(); return { lat: result.latitude, lon: result.longitude, zoom: 15 }; }
    if (r.status !== 404) throw new Error(r.status);
  }
  // Anything else: a street or place name in Brighton & Hove, via OpenStreetMap's Nominatim.
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=10&countrycodes=gb&bounded=1`
    + `&viewbox=${BH_VIEWBOX}&q=${encodeURIComponent(q)}`;
  const r = await fetch(url, { headers: { "Accept-Language": "en-GB" } });
  if (!r.ok) throw new Error(r.status);
  const hits = await r.json();
  if (!hits.length) return null;
  // Prefer results inside the city, then the one nearest to where the map is looking.
  const inCity = hits.filter(h => h.display_name.includes("Brighton and Hove"));
  const c = map.getCenter();
  const dist = h => (h.lat - c.lat) ** 2 + ((h.lon - c.lng) * Math.cos(c.lat * Math.PI / 180)) ** 2;
  const hit = (inCity.length ? inCity : hits).sort((a, b) => dist(a) - dist(b))[0];
  return { lat: +hit.lat, lon: +hit.lon, zoom: 17 };
}

// ---------------------------------------------------------------- toast

let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

// ---------------------------------------------------------------- my permit zone picker

function allZones() {
  const zones = new Set();
  for (const { p } of bays.values()) {
    if (p.type === "paid" || !p.zone) continue;
    for (const z of p.zone.split("&")) if (z.trim() && z.trim() !== "NA") zones.add(z.trim());
  }
  for (const z of unmapped.keys()) zones.add(z);
  return [...zones].sort((a, b) => (/^\d/.test(a) - /^\d/.test(b)) || a.localeCompare(b, "en", { numeric: true }));
}

function updatePermitChrome() {
  $("permit-btn").textContent = myZone ? `Zone ${myZone} permit` : "No permit";
  $("permit-btn").classList.toggle("on", !!myZone);
  const free = $("legend-free");
  if (free) free.textContent = myZone ? "Free / your permit" : "Free";
  syncLegend();
}

function openPermitPicker() {
  clearSelection();
  const zones = allZones();
  $("sheet-body").innerHTML = `
    <h2>My permit zone</h2>
    <div class="sub">Pick the zone on your resident or visitor permit. Permit and shared-use bays in that zone
      will show as available to you, and Plan a stay will count them as free.</div>
    <div class="zones">
      <button class="zone none${myZone ? "" : " on"}" data-zone="">No permit</button>
      ${zones.map(z => `<button class="zone${z === myZone ? " on" : ""}" data-zone="${esc(z)}">${esc(z)}</button>`).join("")}
    </div>
    <p class="fine">Saved on this device only. Your zone letter is on your permit, or on the signs at the entry to your zone.</p>`;
  $("sheet").dataset.view = "permit";
  $("sheet").hidden = false;
}

function setMyZone(zone) {
  myZone = zone || null;
  try {
    if (myZone) localStorage.setItem(ZONE_STORE, myZone);
    else localStorage.removeItem(ZONE_STORE);
  } catch { /* optional */ }
  updatePermitChrome();
  refresh();
  if (typeof planner !== "undefined" && planner.active) {
    computePlan();
    applyPlanStyle();
    showPlanResults();
  } else {
    $("sheet").hidden = true;
  }
  toast(myZone ? `Using your Zone ${myZone} permit` : "Showing bays for drivers without a permit");
}

$("permit-btn").addEventListener("click", openPermitPicker);
$("sheet-body").addEventListener("click", e => {
  const z = e.target.closest("[data-zone]");
  if (z) setMyZone(z.dataset.zone);
});

// ---------------------------------------------------------------- legend filter

const LEGEND_NAME = { free: "free", pay: "pay", shared: "pay or permit", permit: "permit-only" };

function syncLegend() {
  for (const b of document.querySelectorAll(".legend [data-cat]")) {
    const off = view.hidden.includes(b.dataset.cat);
    b.classList.toggle("off", off);
    b.setAttribute("aria-pressed", String(!off));
  }
}

function toggleCategory(cat) {
  const off = !view.hidden.includes(cat);
  view.hidden = off ? [...view.hidden, cat] : view.hidden.filter(c => c !== cat);
  saveView();
  syncLegend();
  refresh();
  if (selectedId && bays.get(selectedId).hidden) closeSheet();
  toast(off ? `Hiding ${LEGEND_NAME[cat]} bays. Tap again to show them` : `Showing ${LEGEND_NAME[cat]} bays`);
}

document.querySelector(".legend").addEventListener("click", e => {
  const b = e.target.closest("[data-cat]");
  if (b) toggleCategory(b.dataset.cat);
});

// ---------------------------------------------------------------- map layers: satellite and motorcycle bays

/** Our lowest layer, so the satellite goes under everything we draw but over the basemap. */
function firstOwnLayer() {
  const own = ["plan-area-fill", "plan-area-line", "zones-fill", "zones-line", "bays-fill"];
  return map.getStyle().layers.find(l => own.includes(l.id))?.id;
}

function showSatellite(on) {
  if (on && !map.getSource("satellite")) {
    map.addSource("satellite", {
      type: "raster", tiles: [SATELLITE], tileSize: 256, maxzoom: 19,
      attribution: 'Imagery © <a href="https://www.esri.com" target="_blank" rel="noopener">Esri</a>, Maxar, Earthstar Geographics',
    });
    map.addLayer({ id: "satellite", type: "raster", source: "satellite" }, firstOwnLayer());
  }
  if (map.getLayer("satellite")) map.setLayoutProperty("satellite", "visibility", on ? "visible" : "none");
}

const MOTO_LAYERS = ["moto-fill", "moto-line", "moto-selected", "moto-points"];
let motoLoading = null;

async function showMoto(on) {
  if (on && !map.getSource("moto")) {
    motoLoading ??= fetch(MOTO_URL, FRESH).then(r => {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    });
    let fc;
    try {
      fc = await motoLoading;
    } catch {
      motoLoading = null;
      toast("Couldn't load motorcycle bays");
      return setLayer("moto", false);
    }
    if (!map.getSource("moto")) addMotoLayers(fc);
  }
  for (const id of MOTO_LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
  if (!on && selectedMoto) closeSheet();
}

function addMotoLayers(fc) {
  const points = { type: "FeatureCollection", features: [] };
  for (const f of fc.features) {
    motos.set(f.properties.id, f.properties);
    points.features.push({ type: "Feature", properties: { id: f.properties.id }, geometry: { type: "Point", coordinates: f.properties.centroid } });
  }
  map.addSource("moto", { type: "geojson", data: fc, promoteId: "id" });
  map.addSource("moto-points", { type: "geojson", data: points, promoteId: "id" });
  const beforeLabels = map.getStyle().layers.find(l => l.type === "symbol")?.id;
  map.addLayer({
    id: "moto-fill", type: "fill", source: "moto", minzoom: POINTS_MAX_ZOOM - 0.5,
    paint: { "fill-color": COLOR.moto, "fill-opacity": 0.6 },
  }, beforeLabels);
  map.addLayer({
    id: "moto-line", type: "line", source: "moto", minzoom: POINTS_MAX_ZOOM - 0.5,
    paint: { "line-color": COLOR.moto, "line-width": ["interpolate", ["linear"], ["zoom"], 15, 1, 19, 2.5] },
  }, beforeLabels);
  map.addLayer({
    id: "moto-selected", type: "line", source: "moto",
    paint: { "line-color": "#111", "line-width": ["case", ["boolean", ["feature-state", "selected"], false], 3.5, 0] },
  });
  map.addLayer({
    id: "moto-points", type: "circle", source: "moto-points", maxzoom: POINTS_MAX_ZOOM,
    paint: {
      "circle-color": COLOR.moto,
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 1.5, 13, 2.5, 15.5, 5],
      "circle-stroke-color": "#fff",
      "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 12, 0, 14, 0.8],
    },
  });
  for (const layer of ["moto-fill", "moto-points"]) {
    map.on("mouseenter", layer, () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; });
  }
}

function selectMoto(id) {
  clearSelection();
  selectedMoto = id;
  map.setFeatureState({ source: "moto", id }, { selected: true });
  const p = motos.get(id);
  const when = !p.times_raw ? "Check the sign for times" : /^at any time$/i.test(p.times_raw) ? "At any time" : p.times_raw;
  $("sheet-body").innerHTML = `
    <h2>Motorcycle bay</h2>
    <div class="sub">${p.zone ? `Zone ${esc(p.zone)}` : "Outside the parking zones"}</div>
    <div class="status" style="--c:${COLOR.moto}">
      <i></i><div><b>Free for motorcycles</b><span>${esc(when)}</span></div>
    </div>
    <dl class="facts">
      <dt>Who</dt><dd>Solo motorcycles only. Trikes can't use these, but can use paid bays.</dd>
      <dt>Elsewhere</dt><dd>Motorcycles can't park in permit or paid bays, even with a paid session.</dd>
    </dl>
    <div class="actions"><a class="btn primary" href="${directionsUrl(p.centroid)}" target="_blank" rel="noopener">Directions</a></div>
    <p class="fine">From Brighton & Hove City Council data and its
      <a href="https://www.brighton-hove.gov.uk/parking-and-travel/parking/motorcycle-bay" target="_blank" rel="noopener">motorcycle bay rules</a>.
      Signs on the street always take precedence.</p>`;
  $("sheet").dataset.view = "moto";
  $("sheet").hidden = false;
}

const ZONE_LAYERS = ["zone-casing", "zone-lines", "zone-labels"];
let zonesLoading = null;

async function showZones(on) {
  if (on && !map.getSource("zone-boundaries")) {
    zonesLoading ??= fetch(BOUNDARIES_URL, FRESH).then(r => {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    });
    let fc;
    try {
      fc = await zonesLoading;
    } catch {
      zonesLoading = null;
      toast("Couldn't load zone boundaries");
      return setLayer("zones", false);
    }
    if (!map.getSource("zone-boundaries")) addZoneLayers(fc);
  }
  for (const id of ZONE_LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
}

function addZoneLayers(fc) {
  const labels = {
    type: "FeatureCollection",
    features: fc.features.map(f => ({
      type: "Feature",
      properties: { label: f.properties.event_day ? `Zone ${f.properties.zone} (event days)` : `Zone ${f.properties.zone}` },
      geometry: { type: "Point", coordinates: f.properties.label_point },
    })),
  };
  map.addSource("zone-boundaries", { type: "geojson", data: fc });
  map.addSource("zone-label-points", { type: "geojson", data: labels });
  // Use the basemap's own font, so the labels need no extra downloads.
  const fonts = map.getStyle().layers.map(l => l.layout?.["text-font"]).filter(Array.isArray);
  const font = fonts.find(f => f.some(n => /bold/i.test(n))) || fonts[0] || ["Noto Sans Regular"];
  const beforeLabels = map.getStyle().layers.find(l => l.type === "symbol")?.id;
  // A white casing keeps the outline visible on the satellite too.
  map.addLayer({
    id: "zone-casing", type: "line", source: "zone-boundaries",
    paint: { "line-color": "#fff", "line-opacity": 0.8, "line-width": ["interpolate", ["linear"], ["zoom"], 11, 3, 16, 5.5] },
  }, beforeLabels);
  map.addLayer({
    id: "zone-lines", type: "line", source: "zone-boundaries",
    paint: {
      "line-color": COLOR.zone, "line-opacity": 0.85,
      "line-width": ["interpolate", ["linear"], ["zoom"], 11, 1.2, 16, 2.5],
      "line-dasharray": ["case", ["get", "event_day"], ["literal", [2, 2]], ["literal", [1, 0]]],
    },
  }, beforeLabels);
  map.addLayer({
    id: "zone-labels", type: "symbol", source: "zone-label-points",
    layout: {
      "text-field": ["get", "label"], "text-font": font,
      "text-size": ["interpolate", ["linear"], ["zoom"], 11, 11, 16, 15],
      "text-allow-overlap": false,
    },
    paint: { "text-color": COLOR.zone, "text-halo-color": "#fff", "text-halo-width": 1.8 },
  });
}

function setLayer(name, on) {
  view[name] = on;
  saveView();
  const box = document.querySelector(`#sheet-body [data-layer="${name}"]`);
  if (box) box.checked = on;
  if (name === "satellite") showSatellite(on);
  if (name === "moto") showMoto(on);
  if (name === "zones") showZones(on);
}

function openLayers() {
  clearSelection();
  $("sheet-body").innerHTML = `
    <h2>Map layers</h2>
    <div class="sub">Tap a colour in the legend to hide or show that kind of bay.</div>
    <div class="switches">
      <label class="switch">
        <input type="checkbox" data-layer="satellite"${view.satellite ? " checked" : ""}>
        <span><b>Satellite</b><small>Aerial photos under the bays. They can be a few years old.</small></span>
      </label>
      <label class="switch">
        <input type="checkbox" data-layer="moto"${view.moto ? " checked" : ""}>
        <span><b><i class="swatch" style="--c:var(--moto)"></i>Motorcycle bays</b><small>Free for solo motorcycles</small></span>
      </label>
      <label class="switch">
        <input type="checkbox" data-layer="zones"${view.zones ? " checked" : ""}>
        <span><b>Zone boundaries</b><small>Outlines and letters of the controlled parking zones</small></span>
      </label>
    </div>`;
  $("sheet").dataset.view = "layers";
  $("sheet").hidden = false;
}

$("sheet-body").addEventListener("change", e => {
  const box = e.target.closest("[data-layer]");
  if (box) setLayer(box.dataset.layer, box.checked);
});
