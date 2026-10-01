# Development notes

How the data is scraped and cleaned, how the web app works, and how it is deployed. For what the app does, see [README.md](README.md).

## Scraping the data

`scrape.py` downloads paid, permit, and shared-use parking bays from Brighton & Hove City Council's
public ArcGIS feature service (the one behind their
[On-Street Parking Information app](https://experience.arcgis.com/experience/bc9e3e192b794c268d144192a53939c6)).
It turns the council's messy free-text fields into structured data.

```
python scrape.py      # stdlib only, ~30s; re-run any time to refresh
```

## Source layers

| Layer | Service URL | `type` |
|---|---|---|
| Paid Parking Only | `.../Parking/MBTRO/FeatureServer/57` | `paid` |
| Permit Holders Only | `.../Parking/MBTRO/FeatureServer/60` | `permit` |
| Shared Permit Or Paid | `.../Parking/MBTRO/FeatureServer/62` | `shared` |
| Motorcycle Bay | `.../Parking/MBTRO/FeatureServer/55` | written to `motorcycle_bays.geojson` |
| Parking Zones (boundaries) | `.../Parking/Parking_ParkingZones/FeatureServer/39` | written to `zone_boundaries.geojson` and `unmapped_zones.geojson` |

## Outputs (`data/`)

- **`parking_bays.geojson`**: every bay as a polygon (WGS84, 6 dp) with the cleaned properties below. Loads directly into Leaflet or MapLibre.
- **`parking_bays.csv`**: the same properties without geometry, plus centroid `lat`/`lon`. Useful for lists, search, or a spreadsheet.
- **`motorcycle_bays.geojson`**: motorcycle bays (shape, zone, hours, centroid). The app loads it only when they're switched on.
- **`zone_boundaries.geojson`**: every zone's outline, with `label_point` (the point inside it furthest from any edge, so labels never fall outside an odd-shaped zone) and `event_day` for the stadium areas B and D.
- **`unmapped_zones.geojson`**: controlled parking zones whose boundary exists but which have no bays in the data, with any notes from `site/zones.json` merged into their properties. See "Zones with no mapped bays" below.
- **`metadata.json`**: fetch time, counts, unmapped zones, and every record that needed an assumption or couldn't be parsed.
- **`raw/*.json`**: the records exactly as the council serves them (Esri JSON, British National Grid).

## Coordinates

Don't ask the council server for WGS84 (`outSR=4326`). It converts from British National Grid without
the OSGB36 to WGS84 datum transformation, which moves everything about 128 m north-west. Because
Brighton's streets form a regular grid, that shift often lands bays beside the *wrong* street, so it
looks like only a slight misalignment. `scrape.py` downloads native EPSG:27700 coordinates instead and
converts them itself. It uses the Ordnance Survey projection maths plus a Helmert transform, with a local
correction calibrated against postcodes.io (OSTN15), and matches OSTN15 to within about 5 cm across the city.

## Bay properties

| Field | Example | Notes |
|---|---|---|
| `id` | `shared-1` | `<type>-<source OBJECTID>` |
| `type` | `shared` | `paid` \| `permit` \| `shared` |
| `zone` | `N&R` | Controlled parking zone |
| `red_route` | `false` | Bay is on a red route |
| `tariff` | `Low` | `Low` / `Medium` / `High` / `High-Summer & Low-Winter` (paid and shared only) |
| `pay_by_phone` | `85528` | PayByPhone location code |
| `max_stay_mins` | `120` | Maximum stay for paying visitors |
| `no_return_mins` | `240` | No return within this period |
| `schedule` | see below | When the restriction applies. Outside these windows the bay is unrestricted. |
| `centroid` | `[-0.1756, 50.8348]` | `[lon, lat]`, useful for markers and "nearest bay" |
| `area_m2`, `perimeter_m` | `104.2` | Rough bay size |
| `*_raw` | `9 am to 8 pm` | Original text, kept for display and audit |
| `issues` | `null` | Assumptions made while parsing, if any |

`schedule` is a list of windows, each with a set of days and a local (Europe/London) start and end time:

```json
[{"days": ["mon","tue","wed","thu","fri"], "start": "09:00", "end": "10:00"},
 {"days": ["mon","tue","wed","thu","fri"], "start": "13:00", "end": "14:00"}]
```

A bay is restricted when the current weekday is in `days` and `start <= now < end` for any window.

## Data caveats

- Around 30 records needed an assumption. Each one is listed in `metadata.json` and in the record's `issues` field. Examples: `"11"` max stay read as 11 hours; `"11 am Noon"` read as 11:00–12:00; `"7 pm & 8 pm"` read as 19:00–20:00.
- Two bays have no usable schedule: `paid-144` (no days or times recorded) and `permit-414` (start time missing).
- `permit-2753` ("Sun to Fri & Sat" / "9 am to 8 pm & 4 pm to 8 pm") was paired by position: Sun–Fri 09:00–20:00, Sat 16:00–20:00.
- New zones can appear in the boundaries before their bays are mapped. Zone 14 (South Hollingdean) started on 13 April 2026, but the bay layers had none of its bays as of October 2026, so its bays are drawn from the traffic order (see "Bays drawn from a traffic order" below). Its double yellow lines in the council data also predate the scheme (tagged `NA`/`OUT`, not `14`).
- The council's data is not the legal record. On-street signs and the traffic orders take precedence. Check the licence before republishing.

## The web app (`site/`)

`site/` is a static, mobile-first map (no build step, no framework):

- **`index.html` / `style.css` / `app.js`**: a MapLibre GL map on OpenFreeMap tiles. Bays are coloured by their status *right now*, in Europe/London time: free, pay, pay-or-permit, permit only, or unknown. The colours refresh every 30 seconds. Tapping a bay opens a card with its hours, when the status next changes, max stay, and PayByPhone code.
- **Search** (`suggest.js`): suggestions as you type for streets and venues from [Photon](https://photon.komoot.io), an OpenStreetMap geocoder that allows autocomplete. Postcodes come from [postcodes.io](https://postcodes.io). Results are limited to Brighton & Hove and ranked nearest to the map view. Picking a street frames the whole street. Enter without picking a suggestion falls back to postcodes.io and Nominatim. The planner's "Near" box uses the same suggestions.
- **Plan a stay** (`planner.js`): pick a place, date, arrival time, how long you're staying, and a distance (200 m by default). It lists the cheapest legal bays, without moving the car, and colours the map as cheapest / other options / not allowed. The rules, for a driver without a permit:
  - Permit bays only count if the whole stay avoids permit hours.
  - Paid and shared bays charge only for the part of the stay inside charging hours. Each separate stretch is paid as its own session at the "up to" price (e.g. 7pm to 10am the next day means paying for 7–8pm, then 9–10am).
  - A bay is ruled out if any one session is longer than its max stay.
  - Seasonal prices use the planned date.
  - Distance is a straight line to the nearest edge of the bay.
- **Legend filter and map layers**: tapping a legend colour hides that status (bays get a `hidden` feature-state and paint at zero opacity, and can't be tapped); a plan shows every bay with its own legend, then the filter comes back. The layers button opens switches for satellite (Esri World Imagery, under our layers and over the basemap), motorcycle bays and zone boundaries; the last two load their data on first use. The filter and switches are saved in `localStorage` (`brighton-parking-view`).
- **Picking up new data**: data files are fetched with `cache: "no-cache"` (revalidated, so a 304 when unchanged). When the app comes back into view (at most every 10 minutes), it compares `metadata.json`'s `fetched_at` with what it loaded and reloads if the data was rebuilt, unless a card or plan is open. Home-screen apps can otherwise sit on old data for days.
- **My permit zone**: the chip next to the time lets you pick your permit zone. It's saved in this browser only. Permit-only and shared-use bays in that zone (including joint zones like `N&R`) turn green while restricted, their cards say your permit covers them, and Plan a stay counts them as free with no time limit. That's an assumption about how shared bays treat permit holders, and the planner says so.
- **Prices** (`prices.json`): the council's current £ rates, copied by hand from its [per-zone price pages](https://www.brighton-hove.gov.uk/parking/street-parking/paid-parking-zone-prices). `scrape.py` gives each paid or shared bay a `price_band`, matching by PayByPhone code first (seafront and Kingsway bays have their own seasonal rates) and then by tariff (Low/Medium/High). The card shows rates up to the bay's max stay. **When the council changes prices, edit `prices.json` and update `checked`.**
- **Zones with no mapped bays** (`zones.json`): `scrape.py` compares the council's zone boundaries with the zones the bays belong to, and writes any zone with no bays to `unmapped_zones.geojson`. The map hatches these zones. Tapping one shows a card with its hours, current status and rules, the permit picker lists it, and Plan a stay warns when one is within the search distance. `zones.json` is hand-maintained from the zone's traffic order: `name`, `since`, `schedule` (same format as a bay's), `facts` (label/text pairs), `price_band` + `max_stay_mins` for the price table, and `source`. Zones under `skip` (the stadium event-day areas B and D) never have regular bays and aren't flagged. **Once the council adds a zone's bays, the scrape stops flagging it automatically, and its entry in `zones.json` can be deleted.**
- **Bays drawn from a traffic order** (`manual/<zone>/`, `tools/build_tro_bays.py`): for a zone the council hasn't mapped, the bays can be drawn from its sealed traffic order. `schedule.csv` is the order's bay rows, transcribed by hand: street, side, a landmark (`kerb:<Street>:<N|S|E|W>`, `corner:<dir>`, `bline:<No(s)>:<dir>` or `bound:<A>&<B>`), the offset from it, and a length or an end landmark. `config.json` maps each part of the order to a bay type, hours, max stay and price band. `python tools/build_tro_bays.py manual/zone14` finds each landmark along the street's OpenStreetMap centreline (side roads, house outlines and numbers), places the kerb using the council's double yellow lines nearby (they're drawn along real kerbs), and writes `bays.geojson`. Commit that; `scrape.py` adds those bays, tagged `source: "traffic_order"`, only while the council's own data has no bays in that zone, and the bay card says the position is approximate. The script prints rows worth checking: landmarks it had to guess (an address point with no building outline, a missing house number, a side road that meets twice) and bays at the ends of closes. Zone 14's order is `TRO-16a-2025` ([sealed order](https://tro.tpt.gov.uk/TRO/Brighton%20and%20Hove/912-CPZ-Amend-4-2026-TRO16a2025.pdf)); its one loading-and-permit bay (Part 4.14, Hollingdean Terrace) isn't drawn, because the app has no bay type for loading-only hours.
- **`manifest.webmanifest` + `icons/`**: lets you "Add to Home Screen" as an app. Regenerate the icons with `python tools/make_icons.py`.

To run it locally:

```
python scrape.py                                          # fetches data into data/ and site/data/
python -m http.server 8765 --directory site               # then open http://localhost:8765
```

## Deployment

The site is hosted on GitHub Pages at https://brighton-parking.github.io/.

`.github/workflows/deploy.yml` runs `scrape.py` and deploys `site/` (including fresh data):
- on every push to `main`
- every Monday at 04:17 UTC
- manually, from the Actions tab (**Run workflow**)

`data/` and `site/data/` are gitignored, because they're rebuilt on every deploy.
