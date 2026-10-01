"""Draw parking bays from a traffic order's schedule, for a zone the council hasn't mapped yet.

Usage:  python tools/build_tro_bays.py manual/zone14  [--refresh]

Reads <dir>/schedule.csv (the order's bay rows, transcribed) and <dir>/config.json, fetches
OpenStreetMap streets, buildings and house numbers around the zone (Overpass API, cached in
<dir>/osm_cache.json; --refresh re-downloads), and writes <dir>/bays.geojson with the same
properties as scrape.py's bays. scrape.py adds these bays only while the council's own data
has none for the zone.

Each row says where a bay is the way a traffic order does: "from a point 9 metres south of the
southern kerbline of Hollingbury Place, southwards for 19.5 metres". We find the landmark
(a side road's kerb, a house boundary, a building line) as a distance along the street's
centreline, step the stated distances along it, and offset to the kerb on the given side.
Kerbs are placed using the council's double yellow lines (drawn along real kerbs, cached in
<dir>/kerb_cache.json): the median distance of nearby ones from the centreline, per side.
Where there are none, typical half-widths from config.json are used. Results are good to a
few metres, not to the centimetre.

Ref syntax in schedule.csv:
  kerb:<Street>:<N|S|E|W>    that side's kerbline of a road meeting this one
  corner:<N|S|E|W>           that kerbline of this street's other arm, where it turns a corner
  bline:<No(s)>:<N|S|E|W>    that end of a building (or a run like 25-35) on this street
  bound:<A>&<B>              the boundary between two houses on this street
"""

import csv
import json
import math
import re
import statistics
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import scrape  # noqa: E402  (reuse the bay schema helpers)

COMPASS = {"N": (0.0, 1.0), "S": (0.0, -1.0), "E": (1.0, 0.0), "W": (-1.0, 0.0)}
POINT = {"N": "north", "S": "south", "E": "east", "W": "west"}
OVERPASS = "https://overpass-api.de/api/interpreter"
WEAK = 0.3   # below this, a compass direction barely runs along (or across) the street: flag it


# --------------------------------------------------------------------------- vectors

def sub(a, b): return (a[0] - b[0], a[1] - b[1])
def add(a, b): return (a[0] + b[0], a[1] + b[1])
def mul(a, k): return (a[0] * k, a[1] * k)
def dot(a, b): return a[0] * b[0] + a[1] * b[1]
def norm(a):
    n = math.hypot(*a)
    return (a[0] / n, a[1] / n) if n else (0.0, 0.0)
def left(t): return (-t[1], t[0])


class Local:
    """Equirectangular metres around the zone: plenty accurate over a kilometre."""

    def __init__(self, lat0, lon0):
        self.lat0, self.lon0 = lat0, lon0
        self.kx, self.ky = 111320 * math.cos(math.radians(lat0)), 110540

    def xy(self, lon, lat): return ((lon - self.lon0) * self.kx, (lat - self.lat0) * self.ky)
    def lonlat(self, p): return [p[0] / self.kx + self.lon0, p[1] / self.ky + self.lat0]


# --------------------------------------------------------------------------- polylines

class Line:
    def __init__(self, pts):
        self.pts = pts
        self.cum = [0.0]
        for a, b in zip(pts, pts[1:]):
            self.cum.append(self.cum[-1] + math.dist(a, b))
        self.length = self.cum[-1]

    def project(self, p, segs=None):
        """Nearest point: (s along the line, distance from it)."""
        best = (None, math.inf)
        for i in segs if segs is not None else range(len(self.pts) - 1):
            a, b = self.pts[i], self.pts[i + 1]
            ab = sub(b, a)
            L2 = dot(ab, ab)
            t = max(0.0, min(1.0, dot(sub(p, a), ab) / L2)) if L2 else 0.0
            d = math.dist(p, add(a, mul(ab, t)))
            if d < best[1]:
                best = (self.cum[i] + t * math.sqrt(L2), d)
        return best

    def at(self, s):
        """Point at distance s (extrapolating straight past either end)."""
        if s <= 0:
            return add(self.pts[0], mul(norm(sub(self.pts[1], self.pts[0])), s))
        if s >= self.length:
            return add(self.pts[-1], mul(norm(sub(self.pts[-1], self.pts[-2])), s - self.length))
        i = max(j for j in range(len(self.cum)) if self.cum[j] <= s)
        i = min(i, len(self.pts) - 2)
        t = (s - self.cum[i]) / (self.cum[i + 1] - self.cum[i])
        return add(self.pts[i], mul(sub(self.pts[i + 1], self.pts[i]), t))

    def tangent(self, s, window=8.0):
        return norm(sub(self.at(s + window), self.at(s - window)))

    def segs_between(self, s0, s1):
        return [i for i in range(len(self.pts) - 1) if self.cum[i + 1] >= s0 and self.cum[i] <= s1]


def chain(ways):
    """Join a street's OSM ways into the longest single polyline (they share end nodes)."""
    ends = {}
    for w in ways:
        for end in (w[0], w[-1]):
            ends.setdefault(end, []).append(w)

    def extend(path, used):
        best = path
        for w in ends.get(path[-1], []):
            if id(w) in used:
                continue
            nxt = w if w[0] == path[-1] else w[::-1]
            cand = extend(path + nxt[1:], used | {id(w)})
            if len(cand) > len(best):
                best = cand
        return best

    best = []
    for w in ways:
        for start in (w, w[::-1]):
            cand = extend(start, {id(w)})
            if len(cand) > len(best):
                best = cand
    return best


# --------------------------------------------------------------------------- OSM

def load_osm(folder, bbox, refresh):
    cache = folder / "osm_cache.json"
    if cache.exists() and not refresh:
        return json.loads(cache.read_text(encoding="utf-8"))
    s, w, n, e = bbox
    q = (f'[out:json][timeout:90];(way["highway"]({s},{w},{n},{e});nwr["addr:housenumber"]({s},{w},{n},{e});'
         f'way["building"]({s},{w},{n},{e}););out body;>;out skel qt;')
    req = urllib.request.Request(OVERPASS, data=urllib.parse.urlencode({"data": q}).encode(),
                                 headers={"User-Agent": "brighton-parking-tro-bays/1.0"})
    with urllib.request.urlopen(req, timeout=120) as r:
        data = json.load(r)
    cache.write_text(json.dumps(data), encoding="utf-8")
    return data


def load_kerbs(folder, bbox, refresh):
    """Vertices (lon, lat) of the council's double yellow lines, densified to about 1 m."""
    cache = folder / "kerb_cache.json"
    if cache.exists() and not refresh:
        return json.loads(cache.read_text(encoding="utf-8"))
    s, w, n, e = bbox
    env = json.dumps({"xmin": w, "ymin": s, "xmax": e, "ymax": n, "spatialReference": {"wkid": 4326}})
    data = scrape.get_json(f"{scrape.SERVICE}/1/query", {
        "geometry": env, "geometryType": "esriGeometryEnvelope", "inSR": 4326,
        "spatialRel": "esriSpatialRelIntersects", "outFields": "OBJECTID", "outSR": 27700,
        "returnGeometry": "true", "f": "json"})
    pts = []
    for f in data.get("features", []):
        for path in f["geometry"].get("paths", []):
            for (x0, y0), (x1, y1) in zip(path, path[1:]):
                k = max(1, int(math.hypot(x1 - x0, y1 - y0)))
                pts.extend(scrape.bng_to_wgs84(x0 + (x1 - x0) * i / k, y0 + (y1 - y0) * i / k) for i in range(k))
            pts.append(scrape.bng_to_wgs84(*path[-1]))
    pts = [[round(lon, 7), round(lat, 7)] for lon, lat in pts]
    cache.write_text(json.dumps(pts), encoding="utf-8")
    return pts


class World:
    def __init__(self, osm, local):
        self.local = local
        nodes = {e["id"]: local.xy(e["lon"], e["lat"]) for e in osm["elements"] if e["type"] == "node" and "lon" in e}
        self.street_ways = {}       # name -> [[node ids]]
        self.houses = {}            # (street, number) -> {"pts": [...], "poly": bool}
        for e in osm["elements"]:
            t = e.get("tags", {})
            if e["type"] == "way" and "highway" in t and t.get("name"):
                self.street_ways.setdefault(t["name"], []).append(e["nodes"])
            if t.get("addr:housenumber") and t.get("addr:street"):
                if e["type"] == "node":
                    pts, poly = [nodes[e["id"]]], False
                elif e["type"] == "way" and all(n in nodes for n in e["nodes"]):
                    pts, poly = [nodes[n] for n in e["nodes"][:-1]], True
                else:
                    continue
                for num in re.split(r"[;,]", t["addr:housenumber"]):
                    key = (t["addr:street"], num.strip().lower())
                    # Prefer a building outline over a bare address point.
                    if key not in self.houses or (poly and not self.houses[key]["poly"]):
                        self.houses[key] = {"pts": pts, "poly": poly}
        self.lines = {name: Line([nodes[n] for n in chain(ws)]) for name, ws in self.street_ways.items()}
        self.segments = {name: [(nodes[a], nodes[b]) for w in ws for a, b in zip(w, w[1:])]
                         for name, ws in self.street_ways.items()}
        self.kerb_pts = []
        self._kerbs = {}

    def add_kerb_points(self, lonlats):
        self.kerb_pts = [self.local.xy(lon, lat) for lon, lat in lonlats]

    def kerb_offset(self, street, s, sgn, default):
        """Distance from the centreline to the kerb on one side (sgn: +1 left, -1 right), near s.

        Measured from the council's double yellow lines, which are drawn along real kerbs: the
        median of those within 40 m along that side, else along that whole side, else the default.
        """
        if street not in self._kerbs:
            line, found = self.lines[street], []
            for p in self.kerb_pts:
                ps, dist = line.project(p)
                if dist > 7 or ps <= 1 or ps >= line.length - 1:
                    continue
                # A corner of a side road's double yellows belongs to that road, not this one.
                if any(o != street and ol.project(p)[1] < dist for o, ol in self.lines.items()):
                    continue
                side = dot(left(line.tangent(ps)), sub(p, line.at(ps)))
                found.append((ps, 1 if side > 0 else -1, abs(side)))
            self._kerbs[street] = found
        near = [d for ps, sd, d in self._kerbs[street] if sd == sgn and abs(ps - s) <= 40]
        if len(near) < 5:
            near = [d for ps, sd, d in self._kerbs[street] if sd == sgn]
        return statistics.median(near) if len(near) >= 5 else default


# --------------------------------------------------------------------------- resolving refs

class Ambiguous(Exception):
    pass


def along_sign(line, s, d, notes, what):
    """+1/-1: which way along the street a compass direction points, near s."""
    c = dot(line.tangent(s), COMPASS[d])
    if abs(c) < WEAK:
        notes.append(f"{what}: '{d}' barely runs along the street here ({c:+.2f})")
    return 1 if c >= 0 else -1


def house_extent(world, line, street, num, notes):
    h = world.houses.get((street, num.lower()))
    if not h:
        return None
    ss = [line.project(p)[0] for p in h["pts"]]
    if not h["poly"]:
        notes.append(f"No.{num} is an address point, not a building outline: assumed 6 m wide")
        return (ss[0] - 3, ss[0] + 3), h["pts"]
    return (min(ss), max(ss)), h["pts"]


def kerb_of(world, cfg, line, street, other, d, notes):
    """s on `line` of the given kerb of road `other` where it meets this one."""
    if other not in world.segments:
        raise Ambiguous(f"no street called {other!r} in OpenStreetMap here")
    samples = []                # (distance to the other road, s, the other road's direction there)
    s = 0.0
    while s <= line.length:
        p = line.at(s)
        best = (math.inf, None)
        for a, b in world.segments[other]:
            ab = sub(b, a)
            L2 = dot(ab, ab) or 1e-9
            t = max(0.0, min(1.0, dot(sub(p, a), ab) / L2))
            best = min(best, (math.dist(p, add(a, mul(ab, t))), norm(ab)), key=lambda x: x[0])
        samples.append((best[0], s, best[1]))
        s += 1.0
    # Each place the roads meet (a loop like a crescent meets its parent road twice).
    junctions = []
    for i, smp in enumerate(samples):
        if smp[0] > 15 or any(samples[j][0] < smp[0] for j in range(max(0, i - 20), min(len(samples), i + 21)) if j != i):
            continue
        if not junctions or smp[1] - junctions[-1][1] > 20:
            junctions.append(smp)
    if not junctions:
        raise Ambiguous(f"{other} doesn't meet {street} (closest {min(samples)[0]:.0f} m)")
    if len(junctions) > 1:
        # "The southern kerbline of X" where X meets twice: take the junction furthest south.
        notes.append(f"{other} meets {street} {len(junctions)} times: used the {POINT[d]}ernmost junction")
    dist, s0, tc = max(junctions, key=lambda j: dot(line.at(j[1]), COMPASS[d]))
    n = left(tc)
    if dot(n, COMPASS[d]) < 0:
        n = mul(n, -1)
    if abs(dot(n, COMPASS[d])) < WEAK:
        notes.append(f"'{POINT[d]}ern kerbline of {other}' is ambiguous: {other} runs {POINT[d]}-ward here")
    p0 = line.at(s0)
    oline = world.lines[other]
    so = oline.project(p0)[0]
    osgn = 1 if dot(left(oline.tangent(so)), n) > 0 else -1
    k = add(p0, mul(n, world.kerb_offset(other, so, osgn, half_width(cfg, other))))
    return line.project(k, line.segs_between(s0 - 40, s0 + 40))[0]


def corner_of(world, cfg, line, street, d, bay_side, notes):
    """This street turns a corner: s of the given kerbline of the arm across from the bay."""
    turns = []
    for i in range(1, len(line.pts) - 1):
        a, b = norm(sub(line.pts[i], line.pts[i - 1])), norm(sub(line.pts[i + 1], line.pts[i]))
        turns.append((math.degrees(math.acos(max(-1, min(1, dot(a, b))))), i))
    angle, i = max(turns)
    if angle < 45:
        raise Ambiguous(f"{street} has no corner (sharpest turn {angle:.0f} degrees)")
    sc = line.cum[i]
    arms = [(-1, norm(sub(line.at(sc - 15), line.pts[i]))), (1, norm(sub(line.at(sc + 15), line.pts[i])))]
    # The bay is on the arm that runs across its side (a south-side bay is on an east-west arm).
    bay_arm = min(arms, key=lambda a: abs(dot(a[1], COMPASS[bay_side])))
    other = [a for a in arms if a is not bay_arm][0]
    n = left(other[1])
    if dot(n, COMPASS[d]) < 0:
        n = mul(n, -1)
    s_arm = sc + 15 * other[0]
    sgn = 1 if dot(left(line.tangent(s_arm)), n) > 0 else -1
    k = add(line.pts[i], mul(n, world.kerb_offset(street, s_arm, sgn, half_width(cfg, street))))
    segs = line.segs_between(0, sc) if bay_arm[0] < 0 else line.segs_between(sc, line.length)
    return line.project(k, segs)[0]


def resolve(world, cfg, line, street, ref, side, notes):
    kind, _, rest = ref.partition(":")
    if kind == "kerb":
        other, d = rest.rsplit(":", 1)
        return kerb_of(world, cfg, line, street, other, d, notes)
    if kind == "corner":
        return corner_of(world, cfg, line, street, rest, side, notes)
    if kind == "bline":
        nums, d = rest.rsplit(":", 1)
        if "-" in nums:
            lo, hi = map(int, nums.split("-"))
            wanted = [str(n) for n in range(lo, hi + 1)]
        else:
            wanted = [nums]
        found = [house_extent(world, line, street, n, notes) for n in wanted]
        found = [f for f in found if f]
        if not found:
            raise Ambiguous(f"No.{nums} {street} isn't in OpenStreetMap")
        lo_s = min(f[0][0] for f in found)
        hi_s = max(f[0][1] for f in found)
        c = dot(line.tangent((lo_s + hi_s) / 2), COMPASS[d])
        if abs(c) >= WEAK:
            return hi_s if c > 0 else lo_s
        # The street runs across that direction here: use the building's corner furthest that way.
        pts = [p for f in found for p in f[1]]
        notes.append(f"{POINT[d]}ern building line of No.{nums} taken from its furthest corner")
        return line.project(max(pts, key=lambda p: dot(p, COMPASS[d])))[0]
    if kind == "bound":
        a, b = rest.split("&")
        ea, eb = house_extent(world, line, street, a, notes), house_extent(world, line, street, b, notes)
        if ea and eb:
            (a0, a1), (b0, b1) = ea[0], eb[0]
            return (a1 + b0) / 2 if (a0 + a1) < (b0 + b1) else (b1 + a0) / 2
        known, missing = (a, b) if ea else (b, a)
        ek = ea or eb
        if not ek:
            raise Ambiguous(f"neither No.{a} nor No.{b} {street} is in OpenStreetMap")
        # Find which way the numbers run from a neighbour of the known house.
        km = int(re.match(r"\d+", known).group())
        for nb in (km - 1, km + 1, km - 2, km + 2):
            if str(nb) == missing:
                continue
            en = house_extent(world, line, street, str(nb), [])
            if en:
                toward_missing = (int(re.match(r"\d+", missing).group()) - km) * (nb - km) < 0
                kmid, nmid = sum(ek[0]) / 2, sum(en[0]) / 2
                far_end = ek[0][1] if (kmid > nmid) == toward_missing else ek[0][0]
                notes.append(f"No.{missing} isn't in OpenStreetMap: boundary taken as the far side of No.{known}")
                return far_end
        raise Ambiguous(f"No.{missing} {street} isn't in OpenStreetMap and No.{known} has no neighbours to orient by")
    raise ValueError(f"unknown ref {ref!r}")


def half_width(cfg, street):
    return cfg["half_width_m"].get(street, cfg["half_width_m"]["default"])


# --------------------------------------------------------------------------- bays

def bay_polygon(world, cfg, line, street, s0, s1, side, depth, notes):
    a, b = sorted((s0, s1))
    mid_t = line.tangent((a + b) / 2)
    c = dot(left(mid_t), COMPASS[side])
    if abs(c) < WEAK:
        notes.append(f"'{side} side' is ambiguous here ({c:+.2f})")
    sgn = 1 if c >= 0 else -1
    hw = world.kerb_offset(street, (a + b) / 2, sgn, half_width(cfg, street))
    n_steps = max(2, int(math.ceil(b - a)))
    outer, inner = [], []
    for k in range(n_steps + 1):
        s = a + (b - a) * k / n_steps
        n = mul(left(line.tangent(s, 2.0)), sgn)
        p = line.at(s)
        outer.append(add(p, mul(n, hw)))
        inner.append(add(p, mul(n, hw - depth)))
    if a < 0 or b > line.length:
        notes.append("runs past the end of the street's centreline in OpenStreetMap")
    ring = outer + inner[::-1]
    return ring + [ring[0]]


def build(folder, refresh=False):
    cfg = json.loads((folder / "config.json").read_text(encoding="utf-8"))
    s_, w_, n_, e_ = cfg["bbox"]
    local = Local((s_ + n_) / 2, (w_ + e_) / 2)
    world = World(load_osm(folder, cfg["bbox"], refresh), local)
    world.add_kerb_points(load_kerbs(folder, cfg["bbox"], refresh))
    prices = json.loads(scrape.PRICES.read_text(encoding="utf-8"))

    features, problems = [], []
    with open(folder / "schedule.csv", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    for row in rows:
        part, item, street, side = row["part"], row["item"], row["street"], row["side"]
        label = f"Part {part} item {item} ({street}, {side} side)"
        notes = []
        try:
            line = world.lines.get(street)
            if not line:
                raise Ambiguous(f"no street called {street!r} in OpenStreetMap")
            s_ref = resolve(world, cfg, line, street, row["ref"], side, notes)
            dist = float(row["dist"] or 0)
            s_start = s_ref + (along_sign(line, s_ref, row["from_dir"], notes, "offset") * dist if dist else 0)
            if row["to_ref"]:
                s_end = resolve(world, cfg, line, street, row["to_ref"], side, notes)
            else:
                s_end = s_start + along_sign(line, s_start, row["dir"], notes, "direction") * float(row["length"])
        except Ambiguous as err:
            problems.append(f"SKIPPED {label}: {err}")
            continue

        echelon = "echelon" in row["note"]
        ring = bay_polygon(world, cfg, line, street, s_start, s_end, side,
                           cfg["echelon_depth_m"] if echelon else cfg["bay_depth_m"], notes)
        for n in notes:
            problems.append(f"check {label}: {n}")

        p = cfg["parts"][part]
        max_stay, _ = scrape.parse_duration(p.get("max_stay"))
        no_return, _ = scrape.parse_duration(p.get("no_return"))
        schedule, _ = scrape.build_schedule(p["days"], p["times"])
        geom = {"type": "Polygon", "coordinates": [scrape.round_coords([local.lonlat(q) for q in ring])]}
        area = abs(sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(ring, ring[1:]))) / 2
        props = {
            "id": f"{p['type']}-z{cfg['zone']}-{part}-{item}",
            "type": p["type"],
            "zone": cfg["zone"],
            "red_route": False,
            "tariff": p.get("tariff"),
            "pay_by_phone": None,
            "max_stay_mins": max_stay,
            "no_return_mins": no_return,
            "schedule": schedule,
            "days_raw": p["days"],
            "times_raw": p["times"],
            "max_stay_raw": p.get("max_stay"),
            "no_return_raw": p.get("no_return"),
            "layer_raw": f"{cfg['order']} Part {part} item {item}",
            "area_m2": round(area, 1),
            "perimeter_m": round(sum(math.dist(a, b) for a, b in zip(ring, ring[1:])), 1),
            "centroid": scrape.centroid(geom),
            "source_objectid": None,
            "issues": None,
            "source": "traffic_order",
            "source_text": f"{street}, {side} side: {row['note']}",
            "source_url": cfg["order_url"],
        }
        props["price_band"] = p.get("price_band") or scrape.price_band(props, prices)
        features.append({"type": "Feature", "id": props["id"], "geometry": geom, "properties": props})

    out = {"type": "FeatureCollection", "zone": cfg["zone"], "order": cfg["order"], "features": features}
    (folder / "bays.geojson").write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(f"{len(features)} of {len(rows)} bays drawn -> {folder / 'bays.geojson'}")
    for line in problems:
        print("  " + line)


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    build(Path(args[0]) if args else ROOT / "manual" / "zone14", refresh="--refresh" in sys.argv)
