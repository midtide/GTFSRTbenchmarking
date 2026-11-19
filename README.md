# ETA Benchmarks

Route-level **ETA accuracy** and **ETA completeness** for King County Metro, computed entirely in your browser from the public [gtfsrt.io](https://gtfsrt.io) GTFS-Realtime archive.

- Accuracy follows the [ETA Accuracy Benchmark](https://github.com/TransitApp/ETA-Accuracy-Benchmark): four time buckets with asymmetric windows, and an overall score that is the straight average of the buckets.
- Completeness follows the [ETA Completeness Benchmark](https://github.com/SwiftlyInc/ETA-Completeness-Benchmark): the share of scheduled trip-stops that had a vehicle and a 0–15 minute prediction, or were communicated as `CANCELED` or `SKIPPED`.

![Overview for Tue 2026-11-10](docs/eta-benchmarks-desktop.png)

The approach is modelled on [Transit Almanac](https://github.com/MisterClean/gtfsrt-dashboard). It is a static site with no server, account or upload. The browser reads Parquet straight from the archive's public bucket with HTTP range requests, and results stay on the device.

## What it shows

- **Summary tiles** for the selected days and time of day.
- **A daily diagnosis**: rule-based findings across all routes, ranked by priority, each with its evidence and where to look for causes. It covers trips running under services the calendar says aren't operating, realtime trip IDs from another schedule version, missing directions or routes, unstaffed blocks, ETAs missing at trip starts or ends, coaches losing ETAs (and shared ID series), service groups such as DART trailing Metro bus, early or late skew in predictions, low-accuracy routes, hourly completeness dips and archive gaps. Feed-quality rules drawn from the MobilityData GTFS Realtime Validator, California's realtime metrics and app makers' thresholds add ghost countdowns, timetable times shown as live, prediction jitter, early timepoint departures, frozen/stale/slow feeds, predictions stuck in the past, canceled trips that ran, late or intermittent predictions, feed inconsistencies (vehicle pairing, duplicates, single-feed trips, stop sequences, route/direction, ADDED misuse), likely detours, off-route buses and coaches with stale, sparse or impossible positions. Thresholds (sensitive for the most explanatory checks, higher for the rest) live in `src/ui/diagnosis.ts`. Each finding is a headline that expands to its evidence. Multi-day selections merge findings and show how many days each appeared on.
- **A system map** on OpenStreetMap. Every stretch of route between two stops is colored by how accurate departure predictions were at the stop where it starts (red = worse, blue = better). Hover for details; click a line or a table row to single out that route. A toggle switches the map to **completeness**, coloring the same stretches by the share of scheduled trip-stops that were complete, in the benchmark's rating tiers. Completeness is shown by stop, not whole route, because gaps cluster: whole directions or branches can be missing from the feed while the rest of the route is fine.
- **Hour-by-hour charts** of accuracy and completeness, and a **bucket chart** splitting each bucket into too early / accurate / too late, with the average minutes off for the early and late predictions.
- **A route table** with both benchmarks, sortable and downloadable as CSV (including per-bucket early/late shares and average minutes off). Expand a route (▸) to see its trips with less than 95% of trip-stops complete: for multi-day selections, the trips, blocks (for trips that never had a vehicle) and coaches with problems on two or more days come first, and any of them filters the full trip list. Each list downloads as CSV.
- **A Service column** (DART, RapidRide, Metro bus, Streetcar, Water taxi, Sound Transit) and a DART tag on route names. DART routes are found from the schedule's own fare classes (trips with the "DART" fare in `fare_attributes.txt`): 204, 224, 249, 902, 903, 906, 907, 914, 915, 917, 930 and 931 in the Sep–Oct 2026 schedules. Sort by Service to group them, or type "DART" in the filter.
- **Data notes** for each day. The note counting realtime trips whose IDs aren't in the schedule opens into a list of those trips (route, status in the feed, coach, when seen, stops, and which archived schedule version does contain the trip ID), downloadable as CSV.
- **A Coaches tab** listing coaches below 95% completeness (counting only trips each coach was assigned to), with days below 95%, routes driven, and an expandable list of their incomplete trips. Coaches are shown by `vehicle_label`, the number riders see, plus `vehicle_id` where it differs.

## Using it

Pick a date range, a time of day and a sampling rate, then press **Analyze**. Each service day is analysed once and saved in IndexedDB. After that, changing the time-of-day window, or reloading the page, needs no download.

The archive has King County Metro from 2026-09-09. The latest day you can pick is the day before the newest archived UTC file, because evening service runs past midnight UTC.

## Running locally

```bash
npm install
```

```bash
npm run dev
```

```bash
npm run build
```

`npm run build` writes a static site to `dist/` that can be hosted anywhere (GitHub Pages, Netlify, S3). The archive bucket allows cross-origin GET/HEAD.

### Publishing on GitHub Pages

`.github/workflows/pages.yml` builds and publishes the site on every push to `main`. One-time setup: in the repository's **Settings → Pages**, set **Source** to **GitHub Actions**. The site then appears at `https://<user>.github.io/<repo>/`.

You can also analyse one day from the command line with the same engine (Node 22.6+):

```bash
npm run analyze-day -- 2026-11-10 120
```

## How it works

```
src/engine/
  archive.ts    archive URLs, request limiter, compact row-group index, row-group reads (hyparquet)
  schedule.ts   choose the schedule version for a day, load and compile routes/trips/stop_times/calendars
  geometry.ts   route shapes cut into stop-to-stop pieces for the map (cached per schedule version)
  quality.ts    feed-quality facts for the daily diagnosis (jitter, ghosts, feed health, coach reporting...)
  shapegrid.ts  grid lookups for off-route and out-of-area checks
  analyze.ts    one service day -> per-route, per-hour rollups of both benchmarks
  metrics.ts    benchmark definitions, rollup layout, summaries, ratings
  cache.ts      IndexedDB (file indexes and finished days)
  worker.ts     Web Worker running the engine
  time.ts       service-day clock in America/Los_Angeles
src/ui/         plain TypeScript interface (no framework); diagnosis.ts holds the daily-diagnosis rules
```

For each service day:

1. **Schedule.** Uses the archived GTFS version in force (the latest one captured by the end of that day), with the trip-stops scheduled for active services.
2. **Actual departures.** Reads every vehicle-positions poll in the day's window. A trip has departed stop *s* when its vehicle is first reported with `current_stop_sequence > s`. The departure time is the midpoint between that report and the one before it, kept only when the two are ≤ 2 minutes apart.
3. **Predictions.** Reads trip-update polls at the chosen sampling rate (default one every 2 minutes, out of one every ~20 s). Each prediction's `departure_time` is compared with the actual departure, bucketed by time from `feed_timestamp` to actual. The same rows mark 0–15 minute predictions, `CANCELED` trips, `SKIPPED` stops and vehicle assignment for completeness.
4. **Map data.** Each scored prediction, and each scheduled trip-stop's completeness outcome, is also counted by route, stop and hour. The map colors each stop-to-stop piece of route shape by the pooled accuracy at its starting stop; pieces with fewer than 20 predictions are left uncolored.
5. **Rollup.** Results are additive counts by route and service hour (0–29). The UI sums them for any date range and time window, and rates are always computed from summed counts.

### Why these choices

- **Sampling.** Each daily trip-updates file is ~750 MB and 100M+ rows, with one row group per poll. Reading every Nth row group cuts the download proportionally. The accuracy benchmark allows a representative sample. Against every poll for one hour, 2-minute sampling matched within 0.6 points in each bucket.
- **Vehicle positions as ground truth.** KCM drops a stop from its trip updates once it is passed. The last predicted time is not an independent actual. VP-derived departures agree with the final prediction to a median of −12 s at stops passed without a STOPPED_AT report, and −19 s at stops with one.
- **Departure, not arrival.** KCM publishes identical arrival and departure predictions, and the departure is what a waiting rider can miss.
- **Footers.** Each daily file's Parquet footer is 15–25 MB because of the per-poll row groups. It is parsed once and reduced to a small index of poll times and the needed column chunks, which is cached.

### Known limitations

- The first download of a day is roughly 210 MB at 2-minute sampling (about 170 MB for each further consecutive day) and takes about a minute on a good connection. Saved days load instantly.
- "Assigned vehicle" means the trip had a vehicle position, or a `vehicle_id` in its trip update, at any time that day. This follows the completeness benchmark's wording literally.
- Final stops of trips are not scored for accuracy (there is no departure). The first stop is scored on its departure.
- Routes in KCM's schedule bundle that never appear in KCM's realtime feed (some Sound Transit routes run by other operators) are left out and counted in a note.
- Days whose archive files are missing or have gaps longer than 15 minutes are marked partial and are not saved, so they are fetched again next time.
