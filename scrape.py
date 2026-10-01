"""Download Brighton & Hove on-street paid / permit / shared-use parking bays
from the council's public ArcGIS feature service and normalise them into
app-friendly files.

Usage:  python scrape.py            (stdlib only, Python 3.9+)

Outputs (in ./data):
  raw/<layer>.json          untouched records as served (Esri JSON, British National Grid)
  parking_bays.geojson      all bays, cleaned + structured schedule
  parking_bays.csv          same attributes, no geometry (centroid lat/lon)
  metadata.json             source URLs, fetch time, counts, parse issues
  unmapped_zones.geojson    controlled parking zones with no bays in the data yet (e.g. a new zone)
Bays drawn by hand from a traffic order (manual/<zone>/bays.geojson, see tools/build_tro_bays.py)
are added for any zone the council's data has no bays for yet.
and copies parking_bays.geojson, unmapped_zones.geojson + metadata.json into site/data for the web app.
"""

import csv
import json
import math
import re
import shutil
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SERVICE = "https://gis.brighton-hove.gov.uk/server/rest/services/Parking/MBTRO/FeatureServer"
LAYERS = {
    57: "paid",     # Paid Parking Only
    60: "permit",   # Permit Holders Only
    62: "shared",   # Shared Permit Or Paid Parking
}
ZONES_SERVICE = "https://gis.brighton-hove.gov.uk/server/rest/services/Parking/Parking_ParkingZones/FeatureServer"
ZONES_LAYER = 39   # Parking Zones (boundaries)
PAGE = 1000
OUT = Path(__file__).parent / "data"
SITE_DATA = Path(__file__).parent / "site" / "data"   # copy served by the web app
PRICES = Path(__file__).parent / "site" / "prices.json"  # hand-maintained tariff table
ZONES = Path(__file__).parent / "site" / "zones.json"    # hand-maintained notes on zones whose bays aren't mapped
MANUAL = Path(__file__).parent / "manual"                # bays drawn from traffic orders, per zone
DAY_NAMES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


# --------------------------------------------------------------------------- fetch

def get_json(url, params, retries=3):
    full = url + "?" + urllib.parse.urlencode(params)
    for attempt in range(retries):
        try:
            req = urllib.request.Request(full, headers={"User-Agent": "brighton-parking-scraper/1.0"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except Exception:
            if attempt == retries - 1:
                raise
            time.sleep(2 * (attempt + 1))


def fetch_layer(layer_id, service=SERVICE):
    """All records of a layer in their native British National Grid (EPSG:27700), as Esri JSON.

    We deliberately don't ask the server for WGS84 (outSR=4326): it converts without an
    OSGB36 -> WGS84 datum transformation, which shifts everything ~128 m north-west.
    """
    url = f"{service}/{layer_id}/query"
    expected = get_json(url, {"where": "1=1", "returnCountOnly": "true", "f": "json"})["count"]
    features, offset = [], 0
    while True:
        page = get_json(url, {
            "where": "1=1", "outFields": "*", "returnGeometry": "true", "outSR": 27700,
            "orderByFields": "OBJECTID", "resultOffset": offset, "resultRecordCount": PAGE,
            "f": "json",
        })
        batch = page.get("features", [])
        features.extend(batch)
        offset += len(batch)
        if not batch or not page.get("exceededTransferLimit"):
            break
    if len(features) != expected:
        raise RuntimeError(f"layer {layer_id}: got {len(features)} features, expected {expected}")
    return {"spatialReference": {"wkid": 27700}, "features": features}


# --------------------------------------------------------------------------- coordinates

# British National Grid (OSGB36 Transverse Mercator) -> WGS84, via the Ordnance Survey
# inverse projection and a 7-parameter Helmert transform (OS "A guide to coordinate
# systems in Great Britain"). Helmert alone is ~2 m off OSTN15 here, but that error is a
# near-constant offset across the city: calibrated against postcodes.io (which uses
# OSTN15) at 18 postcodes from Portslade to Saltdean, the residual was +1.94 m E /
# -0.66 m N with a spread of 2-4 cm. Adding it back gets within a few cm of OSTN15.
LOCAL_DLON, LOCAL_DLAT = 2.7655e-05, -5.984e-06


def _bng_to_osgb36(E, N):
    a, b, F0 = 6377563.396, 6356256.909, 0.9996012717
    lat0, lon0, N0, E0 = math.radians(49), math.radians(-2), -100000, 400000
    e2, n = 1 - b * b / (a * a), (a - b) / (a + b)
    lat, M = lat0, 0.0
    while abs(N - N0 - M) >= 1e-5:
        lat += (N - N0 - M) / (a * F0)
        dl, sl = lat - lat0, lat + lat0
        M = b * F0 * ((1 + n + 1.25 * n**2 + 1.25 * n**3) * dl
                      - (3 * n + 3 * n**2 + 21 / 8 * n**3) * math.sin(dl) * math.cos(sl)
                      + (15 / 8 * n**2 + 15 / 8 * n**3) * math.sin(2 * dl) * math.cos(2 * sl)
                      - 35 / 24 * n**3 * math.sin(3 * dl) * math.cos(3 * sl))
    sin2 = math.sin(lat) ** 2
    nu = a * F0 / math.sqrt(1 - e2 * sin2)
    rho = a * F0 * (1 - e2) / (1 - e2 * sin2) ** 1.5
    eta2, t, sec, dE = nu / rho - 1, math.tan(lat), 1 / math.cos(lat), E - E0
    VII = t / (2 * rho * nu)
    VIII = t / (24 * rho * nu**3) * (5 + 3 * t * t + eta2 - 9 * t * t * eta2)
    IX = t / (720 * rho * nu**5) * (61 + 90 * t * t + 45 * t**4)
    X = sec / nu
    XI = sec / (6 * nu**3) * (nu / rho + 2 * t * t)
    XII = sec / (120 * nu**5) * (5 + 28 * t * t + 24 * t**4)
    XIIA = sec / (5040 * nu**7) * (61 + 662 * t * t + 1320 * t**4 + 720 * t**6)
    return (lat - VII * dE**2 + VIII * dE**4 - IX * dE**6,
            lon0 + X * dE - XI * dE**3 + XII * dE**5 - XIIA * dE**7)


def bng_to_wgs84(E, N):
    """(easting, northing) -> [lon, lat] in WGS84."""
    lat, lon = _bng_to_osgb36(E, N)
    a, b = 6377563.396, 6356256.909                      # Airy 1830 -> cartesian
    e2 = 1 - b * b / (a * a)
    nu = a / math.sqrt(1 - e2 * math.sin(lat) ** 2)
    x, y, z = nu * math.cos(lat) * math.cos(lon), nu * math.cos(lat) * math.sin(lon), (1 - e2) * nu * math.sin(lat)
    tx, ty, tz, s = 446.448, -125.157, 542.060, -20.4894e-6   # Helmert OSGB36 -> WGS84
    rx, ry, rz = (math.radians(v / 3600) for v in (0.1502, 0.2470, 0.8421))
    x, y, z = (tx + (1 + s) * x - rz * y + ry * z,
               ty + rz * x + (1 + s) * y - rx * z,
               tz - ry * x + rx * y + (1 + s) * z)
    a, b = 6378137.0, 6356752.3142                       # cartesian -> WGS84 ellipsoid
    e2 = 1 - b * b / (a * a)
    p = math.hypot(x, y)
    lat = math.atan2(z, p * (1 - e2))
    for _ in range(6):
        lat = math.atan2(z + e2 * a / math.sqrt(1 - e2 * math.sin(lat) ** 2) * math.sin(lat), p)
    return [math.degrees(math.atan2(y, x)) + LOCAL_DLON, math.degrees(lat) + LOCAL_DLAT]


def esri_to_geojson(feature):
    """Esri JSON polygon in BNG -> GeoJSON Feature in WGS84 (Polygon or MultiPolygon)."""
    polys = []
    for ring in feature["geometry"]["rings"]:
        # Esri outer rings are clockwise (negative shoelace area); holes are anticlockwise.
        area = sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(ring, ring[1:]))
        coords = [bng_to_wgs84(x, y) for x, y in ring]
        if area <= 0 or not polys:
            polys.append([coords])
        else:
            polys[-1].append(coords)
    geom = {"type": "Polygon", "coordinates": polys[0]} if len(polys) == 1 else {"type": "MultiPolygon", "coordinates": polys}
    return {"type": "Feature", "properties": feature["attributes"], "geometry": geom}


# --------------------------------------------------------------------------- parsing

def clean(s):
    if s is None:
        return None
    s = re.sub(r"\s+", " ", str(s)).strip()
    return None if s.upper() in ("", "NA", "N/A", "NULL") else s


def parse_duration(s):
    """'2hrs', '4 hrs', '11', '1hr' -> minutes. Returns (minutes|None, issue|None)."""
    s = clean(s)
    if s is None:
        return None, None
    s = s.replace("⁶", "6")  # a stray superscript six appears in the data
    m = re.fullmatch(r"(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours)?", s, re.I)
    if m:
        issue = None if m.group(2) else f"unit assumed hours: {s!r}"
        return int(float(m.group(1)) * 60), issue
    m = re.fullmatch(r"(\d+)\s*(m|min|mins|minutes)", s, re.I)
    if m:
        return int(m.group(1)), None
    return None, f"unparsed duration: {s!r}"


def parse_days(s):
    """'Mon to Fri' -> ['mon'..'fri']; '&'-separated groups -> list of lists."""
    s = clean(s)
    if s is None:
        return None
    groups = []
    for part in s.split("&"):
        part = re.sub(r"\bto\w*\b", "to", part.lower().strip())  # 'toi' typo
        names = re.findall(r"mon|tue|wed|thu|fri|sat|sun", part)
        if " to " in f" {part} " and len(names) == 2:
            a, b = DAY_NAMES.index(names[0]), DAY_NAMES.index(names[1])
            idx = [(a + i) % 7 for i in range(((b - a) % 7) + 1)]
            groups.append([DAY_NAMES[i] for i in idx])
        elif names:
            groups.append(names)
        else:
            return None
    return groups


def _to_24h(tok):
    tok = tok.strip().lower().replace(" ", "")
    if tok == "noon":
        return "12:00"
    if tok == "midnight":
        return "24:00"
    m = re.fullmatch(r"(\d{1,2})(?:[:.](\d{2}))?(am|pm|a|p)", tok)
    if not m:
        return None
    h, mins, ap = int(m.group(1)), int(m.group(2) or 0), m.group(3)
    if ap.startswith("p") and h != 12:
        h += 12
    if ap.startswith("a") and h == 12:
        h = 0
    return f"{h:02d}:{mins:02d}"


def parse_times(s):
    """'9 am to 8 pm & 4 pm to 8 pm' -> [('09:00','20:00'), ('16:00','20:00')].
    Returns (ranges|None, issue|None)."""
    s = clean(s)
    if s is None:
        return None, None
    t = s.lower()
    t = t.replace(",", " ")
    t = re.sub(r"(\d)\s*(am|pm)", r"\1\2", t)          # '9 am' -> '9am'
    t = re.sub(r"(\d)\s+a\b", r"\1am", t)               # '11 a to' -> '11am to'
    t = re.sub(r"(am|pm)(to)\b", r"\1 \2", t)          # '9amto' -> '9am to'
    t = re.sub(r"\b(t|tp|too)\b", "to", t)              # 't' typo
    tok_re = r"\d{1,2}(?:[:.]\d{2})?(?:am|pm)|noon|midnight|\bam\b|\bpm\b"
    parts = t.split("&")
    # '7 pm & 8 pm' typo for '7 pm to 8 pm': merge adjacent single-time parts.
    merged = []
    for part in parts:
        if merged and len(re.findall(tok_re, merged[-1])) == 1 and len(re.findall(tok_re, part)) == 1:
            merged[-1] = merged[-1] + " " + part
        else:
            merged.append(part)
    ranges, issue = [], None
    if len(merged) != len(parts):
        issue = f"'&' read as 'to': {s!r}"
    for part in merged:
        toks = re.findall(tok_re, part)
        if len(toks) == 2 and toks[0] in ("am", "pm"):
            return None, f"missing start time: {s!r}"
        if len(toks) != 2:
            return None, f"unparsed times: {s!r}"
        a, b = _to_24h(toks[0]), _to_24h(toks[1])
        if not a or not b:
            return None, f"unparsed times: {s!r}"
        if " to " not in f" {part} " and issue is None:
            issue = f"'to' assumed between times: {s!r}"
        ranges.append((a, b))
    return ranges, issue


def build_schedule(days_raw, times_raw):
    """Combine days + times into [{'days': [...], 'start': 'HH:MM', 'end': 'HH:MM'}]."""
    issues = []
    day_groups = parse_days(days_raw)
    ranges, t_issue = parse_times(times_raw)
    if t_issue:
        issues.append(t_issue)
    if clean(days_raw) and day_groups is None:
        issues.append(f"unparsed days: {days_raw!r}")
    if day_groups is None or ranges is None:
        if clean(days_raw) is None and clean(times_raw) is None:
            issues.append("no days/times recorded")
        return None, issues

    schedule = []
    if len(day_groups) == 1:
        # One day range, one or more time windows (e.g. two 1-hour permit windows).
        for a, b in ranges:
            schedule.append({"days": day_groups[0], "start": a, "end": b})
    elif len(day_groups) == len(ranges):
        # '&'-paired days and times: pair them up in order.
        issues.append(f"days/times paired by position: {days_raw!r} / {times_raw!r}")
        for g, (a, b) in zip(day_groups, ranges):
            schedule.append({"days": g, "start": a, "end": b})
    else:
        issues.append(f"cannot pair days with times: {days_raw!r} / {times_raw!r}")
        return None, issues
    return schedule, issues


# --------------------------------------------------------------------------- normalise

def round_coords(c, nd=6):
    if isinstance(c[0], (int, float)):
        return [round(c[0], nd), round(c[1], nd)]
    return [round_coords(x, nd) for x in c]


def centroid(geom):
    """Area-weighted centroid of the largest outer ring (good enough for bays)."""
    polys = [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]
    best, best_a = None, -1
    for poly in polys:
        ring = poly[0]
        a = cx = cy = 0.0
        for (x0, y0), (x1, y1) in zip(ring, ring[1:]):
            f = x0 * y1 - x1 * y0
            a += f
            cx += (x0 + x1) * f
            cy += (y0 + y1) * f
        if abs(a) > best_a:
            best_a = abs(a)
            best = (cx / (3 * a), cy / (3 * a)) if a else ring[0]
    return [round(best[0], 6), round(best[1], 6)]


def price_band(props, prices):
    """Which band in prices.json applies: PayByPhone code first (seafront, Kingsway), then tariff."""
    if props["type"] == "permit":
        return None
    return prices["by_pay_by_phone"].get(props["pay_by_phone"]) or prices["by_tariff"].get(props["tariff"])


def normalise(feature, bay_type):
    p = {k.lower(): v for k, v in feature["properties"].items()}
    layer_name = clean(p.get("layer")) or ""
    max_stay, i1 = parse_duration(p.get("max_stay"))
    no_return, i2 = parse_duration(p.get("no_return")) if clean(p.get("no_return")) != "Y" else (None, "no_return='Y' (meaning unclear)")
    schedule, issues = build_schedule(p.get("days"), p.get("times"))
    issues = [i for i in (i1, i2, *issues) if i]
    tariff = clean(p.get("tariff"))

    props = {
        "id": f"{bay_type}-{p['objectid']}",
        "type": bay_type,                                   # paid | permit | shared
        "zone": clean(p.get("zone")),
        "red_route": "red route" in layer_name.lower(),
        "tariff": tariff,                                   # Low | Medium | High | High-Summer & Low-Winter
        "pay_by_phone": clean(p.get("pay_by_phone_code")),
        "max_stay_mins": max_stay,
        "no_return_mins": no_return,
        "schedule": schedule,                               # when restrictions apply; outside = free/unrestricted
        "days_raw": clean(p.get("days")),
        "times_raw": clean(p.get("times")),
        "max_stay_raw": clean(p.get("max_stay")),
        "no_return_raw": clean(p.get("no_return")),
        "layer_raw": layer_name or None,
        "area_m2": round(p["shape__area"], 1) if p.get("shape__area") else None,
        "perimeter_m": round(p["shape__length"], 1) if p.get("shape__length") else None,
        "centroid": centroid(feature["geometry"]),
        "source_objectid": p["objectid"],
        "issues": issues or None,
    }
    geom = {"type": feature["geometry"]["type"], "coordinates": round_coords(feature["geometry"]["coordinates"])}
    return {"type": "Feature", "id": props["id"], "geometry": geom, "properties": props}


def unmapped_zones(bay_features, notes):
    """Zone boundaries that contain no mapped bays, e.g. a new zone the council hasn't drawn bays for yet.

    Zones listed under "skip" in zones.json (event-day areas) never have regular bays, so they're left out.
    """
    raw = fetch_layer(ZONES_LAYER, ZONES_SERVICE)
    zoned = {z.strip() for f in bay_features for z in (f["properties"]["zone"] or "").split("&")}
    out = []
    for feature in raw["features"]:
        code = clean(feature["attributes"].get("ZoneCode"))
        if not code or code in zoned or code in notes["skip"] or not feature.get("geometry"):
            continue
        f = esri_to_geojson(feature)
        f["geometry"]["coordinates"] = round_coords(f["geometry"]["coordinates"])
        f["id"] = code
        f["properties"] = {"zone": code, **notes["zones"].get(code, {})}
        out.append(f)
    return out


def traffic_order_bays(council_features):
    """Hand-drawn bays for zones the council hasn't mapped, dropped once its own bays appear."""
    zoned = {z.strip() for f in council_features for z in (f["properties"]["zone"] or "").split("&")}
    out = []
    for path in sorted(MANUAL.glob("*/bays.geojson")):
        fc = json.loads(path.read_text(encoding="utf-8"))
        if fc["zone"] in zoned:
            print(f"  zone {fc['zone']}: council data now has bays, ignoring {path}", flush=True)
            continue
        out.extend(fc["features"])
        print(f"  zone {fc['zone']}: {len(fc['features'])} bays drawn from {fc['order']}", flush=True)
    return out


# --------------------------------------------------------------------------- main

def main():
    (OUT / "raw").mkdir(parents=True, exist_ok=True)
    prices = json.loads(PRICES.read_text(encoding="utf-8"))
    all_features, counts, issue_log = [], {}, []
    for layer_id, bay_type in LAYERS.items():
        print(f"fetching layer {layer_id} ({bay_type}) ...", flush=True)
        raw = fetch_layer(layer_id)
        (OUT / "raw" / f"{bay_type}.json").write_text(json.dumps(raw), encoding="utf-8")
        feats = [normalise(esri_to_geojson(f), bay_type) for f in raw["features"] if f.get("geometry")]
        for f in feats:
            f["properties"]["price_band"] = price_band(f["properties"], prices)
        counts[bay_type] = len(feats)
        for f in feats:
            if f["properties"]["issues"]:
                issue_log.append({"id": f["id"], "issues": f["properties"]["issues"]})
        all_features.extend(feats)
        print(f"  {len(feats)} bays", flush=True)

    drawn = traffic_order_bays(all_features)
    counts["traffic_order"] = len(drawn)
    all_features.extend(drawn)

    fc = {"type": "FeatureCollection", "features": all_features}
    (OUT / "parking_bays.geojson").write_text(json.dumps(fc, separators=(",", ":")), encoding="utf-8")

    print("fetching zone boundaries ...", flush=True)
    zones = unmapped_zones(all_features, json.loads(ZONES.read_text(encoding="utf-8")))
    zfc = {"type": "FeatureCollection", "features": zones}
    (OUT / "unmapped_zones.geojson").write_text(json.dumps(zfc, separators=(",", ":")), encoding="utf-8")
    print(f"  zones with no mapped bays: {', '.join(f['id'] for f in zones) or 'none'}", flush=True)

    cols = ["id", "type", "zone", "red_route", "tariff", "price_band", "pay_by_phone", "max_stay_mins", "no_return_mins",
            "schedule", "days_raw", "times_raw", "lat", "lon", "area_m2", "source_objectid", "issues"]
    with open(OUT / "parking_bays.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for f in all_features:
            p = dict(f["properties"])
            p["lon"], p["lat"] = p["centroid"]
            p["schedule"] = "; ".join(f"{s['days'][0]}-{s['days'][-1]} {s['start']}-{s['end']}" for s in p["schedule"] or [])
            p["issues"] = "; ".join(p["issues"] or [])
            w.writerow(p)

    meta = {
        "source": SERVICE,
        "layers": {str(k): v for k, v in LAYERS.items()},
        "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "zones_source": f"{ZONES_SERVICE}/{ZONES_LAYER}",
        "counts": counts,
        "total": len(all_features),
        "unmapped_zones": [f["id"] for f in zones],
        "records_with_issues": len(issue_log),
        "issues": issue_log,
        "notes": "Coordinates are WGS84 (EPSG:4326), converted locally from British National Grid. 'schedule' lists when the restriction applies; "
                 "times are local (Europe/London). Always defer to on-street signage.",
    }
    (OUT / "metadata.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    SITE_DATA.mkdir(parents=True, exist_ok=True)
    for name in ("parking_bays.geojson", "unmapped_zones.geojson", "metadata.json"):
        shutil.copy(OUT / name, SITE_DATA / name)
    print(f"done: {len(all_features)} bays, {len(issue_log)} flagged -> {OUT}")


if __name__ == "__main__":
    main()
