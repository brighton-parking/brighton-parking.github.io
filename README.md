# Brighton Parking

**Where can I park in Brighton & Hove right now?**

👉 **[brighton-parking.github.io](https://brighton-parking.github.io/)**

A free, mobile-friendly map of every on-street paid, permit and shared-use parking bay in Brighton & Hove. Each bay is coloured by what it means for you at this moment, so you can see at a glance where you can park and whether you'll have to pay.

## What it does

- **See what's allowed right now.** Bays are coloured as free, pay, pay-or-permit, permit only, or unknown. The colours update by themselves as restrictions start and end.
- **Tap a bay for details.** You'll see its hours, when its status next changes, the maximum stay, the price and the PayByPhone code.
- **Search** for a street, venue or postcode to jump straight there.
- **Plan a stay.** Choose where you're going, the date, your arrival time and how long you'll stay. The app lists the cheapest bays nearby where you could legally stay the whole time without moving the car. It takes into account charging hours, maximum stays, permit hours and seasonal seafront prices.
- **Set your permit zone.** If you have a resident permit, choose your zone. Bays your permit covers are then shown as available, and the planner counts them as free. This is saved on your device only.
- **New zones are covered.** Where the council has started a new parking zone but not yet published where its bays are, the area is hatched. Tap it to see the zone's hours and rules. For South Hollingdean (Zone 14), the bays have been drawn from the council's traffic order instead, so their positions are approximate.
- **Filter the map.** Tap a colour in the legend to hide or show that kind of bay. Motorbike bays (free for solo motorcycles) are off until you tap them.
- **Map layers.** The layers button (bottom right) switches on satellite photos and the parking zone boundaries with their letters. Your choices are saved on your device.
- **Install it like an app.** On your phone, use "Add to Home Screen".

## Please check the signs

This map is based on the council's published data, which has gaps and occasional errors. **The signs on the street and the council's traffic orders are what count legally.** Always check the nearest sign before you leave your car. Prices are copied from the council's website and can go out of date.

The map covers council on-street bays only. It doesn't include car parks, single or double yellow lines, loading bays, disabled bays or private parking.

## Where the data comes from

- **Parking bays:** [Brighton & Hove City Council](https://www.brighton-hove.gov.uk/parking), from the public data behind their [On-Street Parking Information map](https://experience.arcgis.com/experience/bc9e3e192b794c268d144192a53939c6). It's refreshed every Monday.
- **Prices:** the council's [paid parking zone prices](https://www.brighton-hove.gov.uk/parking/street-parking/paid-parking-zone-prices).
- **Map:** [OpenFreeMap](https://openfreemap.org), © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.
- **Satellite photos:** © [Esri](https://www.esri.com), Maxar, Earthstar Geographics.
- **Search:** [Photon](https://photon.komoot.io), [Nominatim](https://nominatim.openstreetmap.org) and [postcodes.io](https://postcodes.io).

This is an independent project. It isn't affiliated with or endorsed by Brighton & Hove City Council.

## Feedback

Found a bay that's wrong, or have an idea? Please [open an issue](https://github.com/brighton-parking/brighton-parking.github.io/issues).

## For developers

The app is a static site with no build step. A Python script fetches the council's data and cleans it up. See [DEVELOPMENT.md](DEVELOPMENT.md) for how the data is processed, how the planner works out prices, and how to run the site locally.
