# How TEMPER and LIGHT ROAST work

The rules behind the viewer, with the numbers they use and the checks that set them. How to use the viewer is in
**README.md**. The rules are checked against places whose truth is known: see **Checking the rules** at the end.

Contents: data and country outlines · preprocessing · M11 · M15/M16 · hot spots · changes · the event log · how
consistent a place is · search by behaviour · related places · area analysis · LIGHT ROAST · the graphs · the
display · loading speed · what more data would add · checking the rules.

## Data and country outlines

(The folder was `VIIRS_NIGHT_M10` until 22 Oct 2026.) Prepared nights are cached under a key built from paths
relative to each country folder, so moving or renaming the data root keeps the cache.

Every subfolder with `raw_data` or `proccessed_data` appears as a country in the picker, with
its Hebrew name, its first and last night, and the outline it is analysed with.

**Country outlines.** A country is analysed inside the outline its data was pulled for (recorded in its year
inventory or night manifests), plus any area that `static/basemap/additions.geojson` adds to it.
- **Israel:** the pulled outline is Natural Earth's Israel plus the West Bank.
- **Gaza:** added from `additions.geojson`. Natural Earth 1:110m has no Gaza, so its outline is hand-made
  from known border points (Erez, Karni, Kissufim, Kerem Shalom and the Rafah coast).
  - Its area is 386 km² against the official 365 km², about 200 m along the border on average.
  - Checks: Gaza City, Beit Hanoun, Deir al-Balah, Khan Younis and Rafah fall inside; Sderot, Nahal Oz,
    Netiv HaAsara, Kissufim, Kerem Shalom and Egyptian Rafah fall outside.
  - 91% of it (627 pixels) lies in the pulled Israel image; the Rafah–Khan Younis coast west of 34.27°E was
    never pulled.
- **Map and picker:** the background map merges any Natural Earth country lying in the outline (the West
  Bank) and the additions into one country, and the picker card draws the same outline.
The range comes from the processed-night folders and the year inventories, without opening rasters.
To change the root, edit the file, or start the server with `--root <folder>`, which saves it.
An opened country stays in memory, so switching back is quick. It is re-read when its bundles,
inventories or manifests change.

The three-country year pull writes `raw_data/year_*_inventory.json` as full raw
TIFFs arrive. The viewer includes these dates alongside existing nightly metadata.
Choose the country again in the picker to load new arrivals. No radiometric correction is applied.
Inventory paths recorded on another machine (for example `C:\...` inside a Linux container) are found
by their bundle folder name inside `raw_data`.

## Preprocessing: nightly analysis layers

When a country is open, a background worker prepares every night, newest first: about 2.5–4 s a night,
about 12 minutes for Saudi Arabia's 171 nights. A night you open or sample first is prepared on the spot.
Each pass's `provenance.npz` already holds, per grid pixel, the satellite's view zenith, the native sample
it came from, and whether the value was clipped. The layers use them:

- **Nearest-nadir mosaic.** Where passes overlap, each pixel takes the pass with the smallest view zenith.
  It replaces "first valid pass in inventory order". Near nadir VIIRS averages 3 detector samples
  and pixels are smallest. Measured on one pass, noise pixels above 0.04 were 13–33 per million at
  0–30° and 244–437 per million at 50–75°.
- **One count per native sample.** Gridding copies a native sample into 1.2 grid pixels near nadir
  and 2.6 at the swath edge. The noise statistics and spot sizes (`samples`) count each sample once.
- **Noise model per night.** The mean of the clipped noise per 5° view-zenith band, with the top 0.1%
  left out. It rises from ~0.0026 near nadir to ~0.0048 at 60°. This is both the noise scale for the
  hot-spot threshold and the bias that clipping adds to every average. About half of all samples are
  negative noise stored as 0 (quality flag 2).
- Checked on 8 nights against the previous pipeline, by whether a spot repeats on other nights.
  Saudi Arabia: 418 repeating spots vs 395, with 53 vs 38 one-night spots. Iran: 737 vs 711, with 81 vs 73.
  A cold 15 km window over 169 nights: raw mean 0.0035 ± 0.00098, corrected −0.00008 ± 0.00070.
- Not done: scaling peak radiance by footprint size. Peaks do fall with view zenith (median correlation
  −0.2 to −0.3), but summed intensity did not remove that consistently. Overlapping edge samples and
  night-to-night flare changes (~45%) dominate.

Layers are cached as `cache/<dataset id>/<night>.v4.{value,vza,rep,m11,m15,m16,pass}.npy` plus `.v4.json`, and
the cloud layer `<night>.v4.c1.npy` and the change summary `<night>.v4.s3.npz`: ~16 bytes a pixel, ~106 MB a
night for Saudi Arabia. A night prepared by an
earlier version (`.v3.*`) is still served, without the thermal layers, until the worker has rebuilt it; the worker
then deletes the `.v3.*` files. Files named `<night>.npy` or `<night>.v2.*` come from earlier versions and can be deleted.
Preparing a night takes 7–10 s (longer if its bundles still need M15/M16), its cloud layer 2–4 s.

## M11 (2.25 µm): confirmation and source temperature

**Where M11 comes from.** The pull downloads full `VNP02MOD` granules, which hold every M-band, but only M10
was extracted. `bands.py` adds `M11.tif`, `M15.tif` and `M16.tif` (each with a `.json` record) to each raw bundle
from the archived granule. M15/M16 are described in the next section.
- **Same samples as M10.** It uses the bundle's `provenance.npz` `native_index`, so M11 comes from
  exactly the same native samples as `M10.tif`, with no new gridding.
- **Same rules as M10.** Calibration and quality follow the M10 conversion:
  radiance = integer × scale + offset, any quality flag rejects, and a raw 0 flagged only
  Out_of_Range is kept as a below-range 0.
- **Built-in check.** Each build re-derives M10 the same way and refuses to write unless it matches
  `M10.tif`. That check caught that GDAL flips NetCDF rows by default; reads use `GDAL_NETCDF_BOTTOMUP=NO`.
- **Commands.** Backfill all bundles with `python bands.py [data_root] [country ...]` (one process per country
  runs in parallel; ~13 s a bundle). Locally the viewer also adds the bands to any bundle it prepares, when the
  granule is reachable.
- **Where it looks.** The granule is found at the path recorded in the bundle, else by name under
  `TEMPER_ARCHIVE` (default `POSTPROCCESOR\archive`).
- **Missing.** 3 of 1,462 bundles have no M11, because one granule (13 Oct) was removed from the archive.

**Confirmation.** A hot spot is kept only if M11 is also above its own noise within one pixel. The per-sample
false-alarm rate is `config.json` → `hot_m11_confirm_far`, default 1e-3. M11 has its own clipped-noise model
per view-zenith band. Where a pass has no M11, the spot is kept and marked unconfirmed. Results over 7–8 nights:

| Rule | Saudi Arabia: repeating / one-night spots | Iran: repeating / one-night spots |
|---|---|---|
| M10 alone | 375 / 53 | 737 / 81 |
| **M10 + M11 confirmation (default)** | 375 / 34 | 737 / 79 |
| Looser M10 (budget 1,000) + M11 | 408 / 66 | 809 / 156 |

Raising `hot_false_alarms_per_night` to 1,000 is the "more sensitive" setting: about 10% more repeating
sources, about twice the one-night spots.

**Temperature, area, heat.** For one blackbody smaller than the pixel, the M10/M11 ratio depends only on
its temperature, not on how much of the pixel it fills.
- **How it's computed.** The sums of noise-corrected radiance in both bands are compared with Planck at the band
  centres. Area = M10 radiant intensity / Planck(M10, T). Heat = σT⁴ × area.
- **Which pixels are summed.** The sum is taken two ways: the detected pixels alone, and with a one-pixel ring
  around them. The clearer of the two in both bands is kept.
  - **Why the ring alone is not enough:** the ring catches a source that spills into its neighbours. For a source
    in one pixel it only adds noise.
  - **Example:** at 30.678 N 35.256 E on 28 Jul 2026, near the swath edge, a pixel had M10 at 12σ and M11 at 37σ:
    905 ± 48 °C on its own. Summed with its ring it fell to 2.6σ in M10, below the 10σ bar, and had no temperature.
  - **Effect:** over 5 nights each, sources with a temperature went from 133 to 199 in Saudi Arabia and from 318 to
    410 in Iran. The added ones have a median of about 1,400 °C. Where both ways gave a temperature they agree to
    within 26–35 °C (median).
  - **Same everywhere:** the hot spot list, the window graph and the change summaries (`s4`) all use this.
- **When it's shown.** Only when both bands are at least 10σ. Otherwise the list shows the M10
  brightness temperature, dimmed.
- **Measured.** Medians were 1,687 K (Saudi Arabia) and 1,763 K (Iran), with 10–90% ranges of about
  1,400–2,000 K, typical of gas flares. Typical areas were 13–20 m² and heat 6–11 MW. Per source the
  temperature varied 5% from night to night, against 36–41% for its brightness.
- **Known limits:**
  - The ± shown is measurement noise only.
  - Temperature reads 46–107 K higher at 60° view zenith than at nadir, likely because M11 is absorbed
    more over the longer slant path. It is not corrected: the two countries disagree and it barely
    exceeds the night-to-night scatter (~105 K).
  - No atmospheric correction, and a single-temperature source is assumed. A pixel with several flares
    or a flare plus a cooler fire gives an in-between temperature.

**The map: משולב | M10 | M11 | תרמי** (in the colour legend).
- **משולב (default)** is a composite of both bands on the night's corrections:
  - **Inputs:** the nearest-nadir mosaic, and each band's clipped-noise mean and spread for the pixel's view zenith.
  - **Brightness:** the combined significance, (σ₁₀ + σ₁₁)/√2, or M10 alone where a pass has no M11. It runs
    from 4σ (dark) to 2,000σ on an asinh stretch, so noise is one even dark floor across the swath.
  - **Colour:** the two-band temperature (700–2,300 °C on the legend ramp), wherever both bands are at least 10σ.
    Grey-white pixels are above the noise but too weak in one band for a temperature.
  - **Shrinking:** when the image is shrunk for display, each block keeps its most significant pixel,
    so one-pixel sources stay visible.
  - Display Min/Max and palette don't apply here and are greyed out.
- **M10 / M11** show raw radiance (nearest-nadir pass) with the Display stretch, for inspection.
  The chart's corrected and raw averages follow the band; in משולב and תרמי they use M10.
- **תרמי** shows M15 brightness temperature on a fixed −40 to 45 °C scale, as on weather-satellite infrared images:
  warm ground dark, cold cloud tops white. Pixels flagged cloudy are tinted blue, so the flag can be checked
  against the image.

**Temperatures are shown in °C** in the readout, the hot-spot list, the legends and the chart. The server
and the CSV keep kelvin (columns ending `_k`).

**The pixel readout** no longer shows a pixel brightness temperature, because noise reads ~130–180 °C there and means nothing.
- **Small line:** both radiances, each with its distance above that night's noise for the pixel's view zenith (σ).
  The spread is estimated as clipped-noise mean × √(2π); checked against the 84th percentile, it agrees within ~10%.
  The far tail at the swath edge is heavier than Gaussian, so read σ as a scale, not a probability.
- **Big value:** the two-band source temperature ± noise, where both bands are at least 10σ. Otherwise the
  M15 brightness temperature, labelled "קרקע" (ground), or "ענן" (cloud top) where the place is flagged cloudy,
  next to "מעל סף הגילוי" (above the night's detection threshold) or "ברמת הרעש" (at noise level).
  Over a source, the M15 value is added to the small line.

Hot spots and the source temperature always use both bands. The chart's **טמפ׳** option plots each window's
source temperature on nights it had a confirmed source.
- **Most windows are sparse:** a 3 km window over Haifa bay has a source temperature on 1 of 343 nights, and Tel
  Aviv on none.
- **Sparse graphs:** the graph says how many nights have one ("טמפ׳ מקור נמדדה ב־N מתוך M לילות").
- **Empty graphs:** with none, the graph says why, and that **מתוקן** shows the radiance every night.
- **Cloud ticks:** an empty night here means no confirmed source, not "not seen", so cloud ticks are not drawn on
  this metric.

**What is and isn't corrected:**
- **Corrected:** pass selection (nearest nadir), noise level by view zenith, the clipping bias, duplicated grid
  copies (in statistics), and M10+M11 confirmation.
- **Flagged, not corrected:** clouds (M15, next section). A cloudy night stays in the series, marked.
- **Not corrected:** atmosphere (no transmittance model), and the clipped negative noise itself.
  A stored 0 only says "≤ 0", which can't be undone. Filling the zeros with the median of the non-zero values
  would not recover a ground temperature: ground at 300 K emits 0.0002σ in M10 and 0.23σ in M11, so the filled
  mean (422 K in M10, 319 K in M11) is still noise. M15 measures the ground directly.
The CSV has `m11_corrected`, `m11_confirmed`, `temperature_k`, `temperature_noise_sd_k`, `emitting_area_m2`,
`radiant_heat_mw`, `m15_median_brightness_temperature_k` and `cloud_percent`.

## M15/M16 (10.8 / 12.0 µm): ground temperature and clouds

**Where they come from.** The same archived granules and the same native samples as M10 and M11
(`bands.py`, above). For these thermal bands NASA ships a lookup table in each granule
(`M15_brightness_temperature_lut`) that turns each stored integer into a brightness temperature.
- **Quality:** any quality flag rejects a sample. These bands have no clipped noise; M15 is ~0.07 K noise at 300 K.
- **Storage:** uint16 hundredths of a kelvin, 0 = no data (~14 MB a band per bundle).
- **Example:** one Saudi pass reads 254 / 291 / 299 K (5th / 50th / 95th percentile). M15 − M16 is −0.4 K at the median.

**Ground temperature.** The readout and each series point show M15 brightness temperature:
- **What it is:** what a blackbody at that temperature would emit at 10.8 µm. It is not land-surface
  temperature. Desert emissivity (~0.95–0.97) and water vapour put the true surface a few kelvin warmer.
- **Under cloud:** it is the cloud top's temperature, so it is labelled "ענן".
- **Flares:** a large flare warms its own pixel's M15 by up to ~10 K; a small one by less than 1 K.

**Cloud flag.**
- **Idea:** at night, clear ground is the warmest a place gets, and cloud tops are colder.
- **Reference:** for each pixel, the 3rd-warmest M15 of that night and the 10 nights on each side
  (at least 7 valid).
- **Drop:** the night's M15 minus that reference, taken as the median over 5×5 pixels. A flare warms its own
  pixel and so raises that pixel's reference; the median keeps it from faking cloud on a night it is off.
- **Rule:** a pixel is cloudy when the drop is at least 8 K. A window is cloudy on a night when at least half
  its pixels are.
- **Stored:** the drop itself (0.5 K steps), so the 8 K rule can change without rebuilding.

**Checked on 171–172 nights from mid-April 2026** against steady flares (lit on ≥ 60% of observed nights):
79 in Iran (13,427 flare-nights) and 35 in Saudi Arabia (5,909). Clear pixels sit 2.5 ± 1.4 K below their
reference; cloud sits 20–60 K below.

| Drop below clear sky (5×5 median) | Iran: flare missed | Saudi Arabia: flare missed |
|---|---|---|
| above −3 K | 6% | 11% |
| −3 to −6 K | 7.5% | 19% |
| −6 to −8 K | 16% | 27% |
| −8 to −20 K | 25% | 30–44% |
| −20 to −40 K | 47% | 78% |
| below −40 K | 82% | 98% |

- **What the flag means:** "cloud is likely hiding sources here", not "the source is hidden". At the 8 K rule,
  flagged nights were missed 49% / 70% of the time (Iran / Saudi Arabia) against 6.6% / 13% when clear.
  Only 4–7% of detected nights were flagged.
- **What it explains:** 51% / 39% of all misses over the half-year. In Iran's cloudy spring fortnight
  (17 Apr–3 May) it was 95%. The other misses are clear-sky: the swath edge's higher threshold, and flares
  that really pause.

**In the viewer:**
- **Chart:** cloudy nights are hollow markers off the line (see **The graphs** below). A cloudy night without a value
  (e.g. on the טמפ׳ metric) is a tick at the bottom. The readout row and the chip's hover text say "מעונן" or give
  the ground temperature.
- **Map:** the תרמי view shows the cloud mask (blue).

**Limits:**
- Thin cirrus and low warm cloud or fog can be missed. M15 − M16 is higher in cloud (+0.8 K median, against
  0 K clear), but it overlaps too much to use alone.
- A place cloudy on 19 of 21 nights has a cloudy reference, and cloud there is under-flagged.
- Near the first and last nights of the data the reference uses fewer nights.
- Nights prepared before the thermal layers existed show no ground temperature or cloud flag until rebuilt.
- 13 Oct 2026 in Saudi Arabia has no M11/M15/M16: its inventory points at the original processing of three
  granules, which the archive replaced with NASA's reprocessed versions (`…2026292…` bundles in the same folder).

## Hot spots: what burns tonight (TEMPER, בוער)

The switch beside the list's title lists the hot spots of the shown night inside the country, brightest first. A hot
spot is an 8-connected group of pixels above an extreme-value threshold.

- **What the list shows:** the sure spots, of two kinds:
  - **Measured tonight:** a two-band M10/M11 source temperature, both bands at least 10σ and at least 500 K,
    shown in °C.
  - **מוכר (known flare):** too faint tonight for a temperature, but one was measured at the same place (within
    two pixels) on one of the comparison nights before (default 14, in **⚙**). Shown as ≈ its latest measured
    temperature.
- **The + row ("N לא מאומתים"):** opens the rest, which have no temperature tonight and no history. They
  carry only an M10 pixel brightness of ~150–230 °C, because a 1,500 °C flare covering a tiny part of a
  750 m pixel averages to that.
- **Why the faint ones split this way.** Over 5 sample nights:
  - Most faint spots in Saudi Arabia and Iran were real: 86% / 78% recurred on 5 or more of 39 other nights,
    against 0.07% / 0.27% for random places.
  - 77% / 62% had a measured temperature at the same place on another night, with a median of
    1,438 / 1,405 °C.
  - Israel's 7 never recurred.
  - With a 14-night window the list held 127 measured + 101 known spots in Saudi Arabia (46 unconfirmed),
    361 + 100 in Iran (94 unconfirmed), and 0 + 0 in Israel (7 unconfirmed).
- **Line under the title:** the count of sure spots, how many of them are known flares, and the threshold.
- **Using it:** a click zooms to the spot and shows it over time. On the map, ring size and opacity grow with how
  far a spot is above the threshold.
- **The threshold** follows the viewing angle (see **Preprocessing**): radiance is divided by the night's
  noise level for each pixel's view zenith, and one threshold is set in those noise units. It is then
  equally strict near nadir and at the swath edge; in radiance it is lowest near nadir. Each native satellite
  sample counts once in the statistics.
- **Its method** is Heimdall's EVT, ported in `evt.py` from
  `Sentinel-2/src/MissionClusterEVTAndCHICreatorMerger/EVT.py` with its `default.json` settings:
  the tail is everything above the 95th percentile, and tail blobs over 5 px stay out of the fit.
  A Generalized Pareto distribution is fitted, and the threshold is its quantile for the false-alarm rate.
- **Three choices differ from Heimdall:**
  - **No KS trimming** (`evt.TRIM = False`). Heimdall deletes the tail's largest values while that
    improves the Kolmogorov-Smirnov fit. On M10 that deletes the noise's own upper tail: the tail has
    only ~55–80 distinct radiance levels, and the noise rises towards swath edges. The fit to what
    remains then ends where the deletion started, ~0.035, inside the noise. On Saudi nights 13–20 Oct 2026,
    23,091 of 23,589 such spots never repeated on other nights. Fitted to the whole tail, nearly all spots repeat.
  - **False-alarm budget** per country per night (`config.json` → `hot_false_alarms_per_night`, default 100),
    instead of Heimdall's 1e-3 per pixel, which would flag thousands of noise pixels a night. At 100
    the threshold came out at 0.049–0.063 W m⁻² µm⁻¹ sr⁻¹, adapting per night. It kept 96–97% of the sources
    that repeat on other nights found by a fixed 0.05 cut, with about half as many one-night spots
    (Saudi Arabia 38 vs 93, Iran 75 vs 109, over 8 nights). Lower the budget for a stricter list (1 gave
    0.071–0.096).
  - The GPD is fitted on 20,000 evenly spaced tail values for speed (same parameters as the full tail).

## Changes: each night against the nights before it

The list (**מה השתנה**) compares every place with a **context window**: the nights before the
shown night. **⚙** sets it (7–60); its default is 14 (`config.json` → `change_context_nights`).
- **Informative nights:** a context night counts for a place when the place was observed and was either clear
  (cloud flag) or lit. A flare seen through cloud still counts as "on"; an unlit cloudy night says nothing.
- **Lit:** above the hot-spot threshold, confirmed by M11 where M11 exists, within one pixel (gridding shifts
  sources by a pixel between passes).

| Kind | Rule |
|---|---|
| ▲ חדש (new) | lit tonight; lit on at most 10% of at least 7 informative context nights |
| ▽ כבה (off) | lit on at least 70% of them; nothing within one pixel tonight; tonight's M15 within 4 K of clear sky; and its usual brightness at least 2× tonight's threshold there, so a weak source at the swath edge doesn't count as off |
| ↑ התחזק / ↓ נחלש | lit tonight and on at least 5 context nights; the 3×3 sum of corrected radiance at least 3× (or at most ⅓) its context median, **and** at least 3 robust standard deviations of that place's own log brightness |

**Follow-up for past nights:** the next 5 informative nights after the shown one.
- **New:** "נמשך" (continues: lit on ≥ 2 of them) or "לילה אחד" (one night).
- **Off:** "נשאר כבוי" (stayed off) or "חזר" (came back).

**How it stays light.** Each night is summarised once in `<night>.v4.s3.npz` (~1 MB). It holds:
- packed bitmaps of the observed, clear and confidently clear pixels;
- the lit pixels with their radiance and 3×3 sum, and the measured source temperature where a hot spot had one.

A comparison reads one summary per night of the window, not the full layers:
- Preparing a summary takes ~1–2 s (it includes the night's hot spots); comparing a night takes 0.2–1 s.
- The background worker prepares the summaries after the cloud layers.
- Until a night's summaries are ready, the hot-spot list uses the ones that are, so a known flare may first
  show as unconfirmed.
- Each summary records the country outline and hot-spot settings it was built with, and is rebuilt when they change.

**Checked on 164–165 nights with a full window:**

| Kind | Iran, per night (median / 90th pct.) | Saudi Arabia | What happened next (Iran / Saudi Arabia) |
|---|---|---|---|
| new | 19 / 40 | 6.5 / 12 | continued 21% / 35%; one night only 64% / 49% |
| off | 3 / 8 | 2 / 4 | stayed off for 5 nights 38% / 24%; the rest came back |
| brighter | 7 / 17 | 3 / 5 | |
| dimmer | 6 / 12 | 1 / 3 | |

- **New** is mostly real, not noise. Strong events (≥ 5× the threshold) continue about as often as weak ones
  (Iran 22% vs 23%, Saudi Arabia 40% vs 30%); noise would sit only among the weak, and the expected noise rate
  after M11 confirmation is about one a night. Most one-night events in summer are fires (for example crop-residue burning). The
  follow-up tells them from new steady sources.
- Without the own-variability test, brighter and dimmer were 17 a night each: flares vary ~40% from night to
  night, so a fixed ×3 cut alone flags erratic sources.

**Limits:** the newest nights have no follow-up yet. The first 7 nights of the data have too short a window. An
off on a confidently clear night can still be a short pause; the follow-up shows that.

## Event log: each change once

A change is detected night after night while its week differs from its baseline. A light that came on stays "new"
in LIGHT ROAST for weeks. Over one week of nights, Saudi Arabia's 10,371 reported changes were 4,081 distinct ones
(2.5 reports each), and Israel's 1.7 each; 65% of a Saudi night's changes had been reported the night before.

The list's periods (**7 ימים**, **30 יום**, **הכל**) list each change once, and **הלילה** says since when each
change has been seen.
- **How:** each night's changes (default comparison window) are stored once, by the background worker after its
  other work, as `<night>.<layers>.events*.json`. The log links them: the same direction (new or brighter; off or
  dimmer) within 1.5 km, with gaps of at most 7 days, is one event, of its strongest night's kind. Linking by kind
  split one source going out into two events, "off" on its own pixel and "dimmer" on the next (Saudi Arabia,
  20.397 N 45.307 E, 18 Oct 2026). A night with two detections of one event counts once, and the night's list
  shows the stronger.
- **Significance (חזק / בינוני / חלש):** how much a change stands out, from the place's own year.
  - **LIGHT ROAST:** at the change's pixel, every night's week (the 7 days to it) is set against the 4 weeks before it.
    p is the share of the other weeks (outside the change and the 5 weeks after it) that swung the same way by at
    least 0.8 of this change's swing.
    - **חזק:** p ≤ 2% and seen on 2+ nights (or |z| ≥ 10). A change of 1–2 nights that was gone the week after is
      at most בינוני.
    - **חלש:** p > 8%, or one night, one pixel and |z| < 8.
    - **בינוני:** the rest.
  - **TEMPER:** חזק when seen on 3+ nights or at least 3× the detection threshold; חלש when one night under 1.5×.
  - **In the list:** a badge on each row, with its reasons in the hover text. Weak ones fold under **+N חלשים** and
    stay off the map until opened. The first 1,500 changes of a list are rated (0.2–1 s).
  - **Example:** at Ashdod (31.852 N 34.655 E), 9 one-night dips of port lights over the year. 2 Oct 2026 (one pixel,
    one night, z 6.2) is חלש. 27 May (2 nights, rare there, gone the week after) is בינוני. The regional outage of
    18 Feb (3 nights, p 0.4%) is חזק.
- **Heat at a light change (the flare and fire causes):** TEMPER must have detected a source itself (not a pixel next
  to one) within 2 pixels, on at least 2 nights of the change's week, or measured a temperature there once. Before,
  any detection or its neighbours within 2 pixels on any of the ~35 nights compared counted. At Ashdod one weak,
  unconfirmed detection weeks earlier made a one-night dip a "fire". Israel's fire causes went from 102 to 8, all with
  a measured temperature, and Saudi Arabia's from 1,714 to 849. The hover text gives the evidence: on how many of the
  week's nights TEMPER saw heat, and whether a temperature was measured.
- **לסירוגין (intermittent), LIGHT ROAST:** a change whose week went back and forth. At the change's strongest pixel,
  "before" is its median over the baseline nights and "now" its median over the week. Each of the week's nights
  reads as one of the two when within 35% of the step from it. The change is intermittent when both have at least 2
  nights and the level turns at least twice; a step within the week turns once. Only steps of at least ×2.
  - **Example:** at 20.397 N 45.307 E the light read ~15 nW until 4 Oct 2026, was off 15–19 Oct, back on 21–22 Oct
    and off again 23–24 Oct. The week's median called it "off, ongoing since 18 Oct".
  - **How many:** 6% of Saudi Arabia's nightly rows over 30 nights, and almost none of Israel's.
  - **In the list:** a dashed **לסירוגין** tag with the counts, a chip to hide them, and dashed marks on the map.
- **What each event has:**
  - A first and last night, and how many nights it was seen.
  - Its strongest night.
  - A status: נמשך (ongoing, seen in the last 2 nights of data) or ended.
- **Israel's year:** 4,324 nightly LIGHT ROAST reports became 2,231 events, and TEMPER's 392 became 378. Building
  the log takes under a second.
- **Cause, from both products:**

  | Cause | Hebrew label | Rule |
  |---|---|---|
  | Flare | להבה | TEMPER heat on it, and a steady TEMPER site within 2 km. Steady means burning on at least 20% of its nights. |
  | Fire or heat | שריפה / חום | Heat without a steady site nearby |
  | Oil or gas field | שדה נפט/גז | No heat, but a steady site within 10 km: facility lighting |
  | Regional outage | הפסקה אזורית | Lights out, or below half, together with 5 or more places of the same direction within 25 km, starting within 2 days |
  | Regional | אזורי (אובך?) | A moderate shift together with 5 or more such places, most likely haze or weather |
  | Lighting | תאורה | Everything else |

  Israel's year comes out as 1,757 lighting, 296 regional, 102 fire, 46 outage, 28 field and 2 flare events.
  Splitting "regional" from "outage" matters: Israel's clustered dimming is mostly moderate, as from haze.
- **In the list:**
  - **Period:** 7 or 30 days up to the shown night, or everything.
  - **Filters:** chips by cause and by kind (each with its count).
  - **Order:** the strongest and longest-lasting events first; 300 are listed at most.
  - **Clicking an event** goes to it and shows it over time, with its nights shaded in the graph.
  - **On the map:** the listed events; ended ones are faded.
- **Ids:** an event is named by its kind, first night and where it was first seen, so the name stays when later
  nights move its strongest place.
- **Export:** the listed events as CSV or GeoJSON (points, with kind, cause, dates, nights, status and peak).

**Context on the map:**
- **Known flare sites:** a layer showing TEMPER's steady flare sites as small rings, under **שכבות**.
- **רגיל (typical lights):** a LIGHT ROAST map view showing each pixel's median over the year (every other night).
  It shows whether a change happened somewhere usually dark. It is cached as `typical.n1.npy`.

**Cache per night.** Each country's cache folder is keyed by the country and grid (`cache\t-<id>` for TEMPER,
`cache\l-<id>` for LIGHT ROAST), with each night's source signature in `nights.json`.
- **When a night arrives or changes,** only that night and what reads its neighbours are rebuilt:
  - TEMPER: cloud flags and summaries within 21 days.
  - Stored change results: TEMPER from 10 days before to 30 days after, LIGHT ROAST from 25 days before (their
    follow-up and moon check look ahead) to 70 days after (their baseline cycles look back).
  - LIGHT ROAST's related-places blocks and typical lights, which rebuild themselves when the nights differ.
- **Before this,** the cache was keyed by every night's source files, so a single new night rebuilt the whole
  country. The 49 folders from earlier states of the data (3 GB) are left over from that and can be deleted.
- **Moving over:** existing caches were moved to the new keys without rebuilding.

## How consistent a place is: correlations only where something varies

A steady place, or one that is almost never lit or warm, correlates only through noise. When a place is chosen it
gets a consistency value and the shape of its year (see **Search by behaviour**). Correlations run only from places
that vary, and only against places that vary.
- **Consistency:**
  - **Lights:** the share of nights within ±20% of the place's usual level (its series less the country's night, its
    viewing pattern, moonlight and the regional swing).
  - **Heat:** the share of observed nights it was lit.
- **Varies:** has a step, trend, swings or spikes. For heat, it must also be lit on at least 5% of its nights.
- **A place that does not vary:**
  - The area card shows its consistency and shape, says why, and skips light against heat and related places.
  - **≈** (related places) from it answers "where else" when the place changed around the night asked about, and
    otherwise explains that there is nothing to correlate instead of listing noise.
- **The candidates** for any correlation are the varying places only. That is 1,136 of Saudi Arabia's 16,503 lit
  blocks, and 36 of its 226 heat sites.
- **Checked on Saudi Arabia:**

  | Place | Result |
  |---|---|
  | Riyadh (15 km) | Light 99% consistent and stable: skipped |
  | Sharurah (3 km) | A step ×0.49 on 15 Sep 2026, 77% consistent: correlated |
  | Abqaiq | Light 95% consistent (skipped). Heat lit every night but swinging in strength: compared with the 36 varying sites |

## Search by behaviour

Most places never really change: 93% of Saudi Arabia's lit 2.25 km blocks and 98.5% of Israel's are stable all year.
Correlating them finds shared noise. The **חיפוש** tab finds the places that do change, by the shape of their year,
and compares only those (`/api/behaviour`).

**Shapes.** Each candidate place gets one profile of its year. For LIGHT ROAST that is the lit blocks: log radiance
less the night's country median, its 16-day viewing pattern and moonlight. For TEMPER it is the detected sites,
with standardised activity. Values are clipped at 5 robust standard deviations.

| Shape | Hebrew | Rule |
|---|---|---|
| step | מדרגה | The best single split (25+ nights a side) explains ≥ 45% of the variance. The step is ≥ ×1.5 (heat: 1 s.d.), ≥ 2.5× the spread left within the two parts, and beats a straight line by 0.1 |
| trend | מגמה | A straight line explains ≥ 35% and changes ×1.5 (1 s.d.) or more over the year |
| fluct | תנודתי | A 20th–80th percentile spread of ×2 (1 s.d.), and at least 6 full swings between the low and high levels |
| spike | קפיצות | Steady otherwise, with 0.3–4% of nights ×3 (2.5 s.d.) above its median |
| stable | יציב | The rest; left out unless asked for |

Saudi Arabia's 16,503 lit blocks: 226 steps, 351 trends, 348 fluctuating, 211 with spikes, 15,367 stable.
Israel's 2,542: 9, 21, 4, 3 and 2,505. The profiles take ~6 s for Saudi Arabia, prepared in the background.

**Limit:** places are 2.25 km blocks, so a single small light inside one is diluted. For that, use the change list.

**The query line, SQL-like:** conditions joined by AND, then optionally ORDER BY and LIMIT. A leading
`SELECT * FROM places WHERE` is accepted.
- `shape = step`, `shape IN (trend, spike)`, or Hebrew: `shape = מדרגה`.
- `direction = up | down` (עלייה / ירידה).
- `change >= 2`: the size, as a factor for lights (×2 up, or down to half), standard deviations for heat.
- `when BETWEEN 2026-09-01 AND 2026-10-24`: the night of a step, or a place's highest spike.
- `level >= 10`: the place's median nW, or for heat the percent of nights lit.
- `switches >= 20`: the number of full swings.
- `fit >= 0.7`: how well the shape fits (R²).
- `within = view`: what is on the map. `within = 'name'`: one of your personal areas.
- While working inside an area (README item 21) every search is also limited to the places whose centre is inside
  it (`focus`, the area's polygon, in the request), before the limit and the groups.
- `ORDER BY change | level | switches | fit | when [ASC|DESC]`, `LIMIT n` (300 by default).

The buttons above the line write it: shape, direction, size, when (the last 30 or 90 days, or the graph's period)
and where. The examples menu holds ready queries. Enter runs the line.

**Groups, among the results only:**
- **Together:** steps (and spikes) of the same direction within 3 days of one another, split by place (within 50 km
  of one another). The rest of such a run, 3 or more, is one scattered group.
- **Moving together:** the undated shapes (swings, trends) whose series, with the regional swing removed, correlate
  at r ≥ max(0.5, 4/√n).
- **Example:** `shape = step AND when BETWEEN 2026-09-01 AND 2026-10-24` in Saudi Arabia found 5 places that stepped
  down together on 9–12 Sep 2026, within 28 km, around 17.45 N 47.16 E.

A group shows only its places in the list and on the map. **בגרפים** opens up to four of them. Each result opens like
a change's row: ☆ keeps it, and ≈ asks related places (a step: where else it happened at its night).

**A time frame** (`from`, `to`): the same profile, on the candidates' nights inside it only (`shapes(product, lo, hi)`),
the step's least side min(25, max(6, n/4)) nights, a frame of 20 nights at least, and no shape for a place seen on
fewer than 12 of them (a short cloudy frame can leave a place 2 or 3 nights, and a line through them is no trend: in
Saudi Arabia's summer this once read as ×10¹¹). Its level (lights: median radiance; heat: share of nights lit) is the
frame's. **Constant** (`shape = constant`, not a shape): heat, a site lit on CONSTANT_HOT_SHARE (0.5) or more of the
nights it was observed in the frame; lights, a block above LIT_NW (5 nW) on CONSTANT_LIT_SHARE (0.9) or more of its
clear nights; both seen on 10 nights at least; listed by level. Saudi Arabia, the whole year: 36 of 357 heat sites
(the Eastern Province's fields), 11,502 of 16,475 lit blocks; Israel: none of its 37 heat sites (the most lit burns on
fewer than half its nights). The first search of a new frame takes 1–14 s (Saudi Arabia's lights the longest); again,
at once (the last three frames per product are kept).

**The map without the constant lights** (`/api/lr/image?steady=1&from=&to=`, `steady_png`): for every pixel over the
frame's nights, its clear nights n, the nights lit (LIT_NW+) and Σ log(L + 1); constant when lit on CONSTANT_LIT_SHARE
of n (n ≥ 10). Shown dimmed to 4% of its value, unless the night (or the period's composite) is off its usual level
(the geometric mean, exp(Σ/n) − 1) by ×2 or more. The counts add, so each whole month is kept in the lights' cache
(`<month>.<layers>.steady.npz`, uint8 counts, float16 sums, compressed) and a frame sums its whole months and reads
the nights of the months it cuts: Israel's year 14 s the first time, a three-month frame 1.2 s after; Saudi Arabia's
three months 40 s the first time. Asked for by the page, it is not held by the tour.

## Related places: one question, answered by the place itself

Correlating whole years matches places that are simply lit, or that swing together with haze and the seasons; that is
seldom the question. **≈** (on a row of the list, a hot spot, a search result, a personal area, the area card, or a
right-click on the map) asks what is related to a place, and the server (`/api/related`, `related` in server.py)
first looks at the place itself around the night asked about: the shown night, or a change's own nights when asked
from the change list.

1. **One night** stands out (a fire, a flash, a one-night outage): where else the same thing happened **that night**
   (*One night*, below).
2. **A lasting change** (a step that stayed): where else the same change happened **then** (*A lasting change*).
3. **A change in the list:** the place's own series shows neither, but the change log found a change at the place
   (within its central 2.25 km; a change somewhere in a large area is not the area's) starting from 3 nights before
   the night to the night after, or still going on then: that change is answered as if asked from its row
   (`detected_here`). The list looks at each pixel (or
   block) by itself, and a place's whole series can blur what it saw. A personal area kept from a change row is
   asked this way, since it keeps the place and not the change.
4. **Neither:** a place that varies over the period gets **what moves with it** (*What moves together*); a steady
   place, or one almost never lit or warm, gets why there is nothing to relate (see **How consistent a place is**).

A line at the top of the results says which question was answered and why; a link under it asks the other one
(`ask`). Until 27 Oct 2026 the two questions were two buttons, and "where else" knew only lasting changes: the
one-night fire east of Jerusalem (31.728 N 35.294 E, 28 Jul 2026) came back as "no change found".

### One night

- **Is it one night?** Of the nights from 3 before to 3 after the night asked about, the one furthest from the median
  of the nights from 21 days before to 7 after (the night and its two neighbours left out). z = deviation / robust
  spread (at least 0.10 log units for lights, 0.25 site s.d. for heat). It counts at |z| ≥ 5 and at least ×2 (lights)
  or 2 site s.d. (heat), and only if the week after is back near the level before (what stayed is under half the
  night's deviation); otherwise it is a step. When two nights qualify, the one nearer the night asked about wins.
  - **The place's own series:** LIGHT ROAST, its window's log(mean radiance + 1), at least 2.25 km wide; TEMPER, the
    activity of the heat sites in its window, or, with none inside, of the nearest site within 2 km (the distance at
    which the list calls a change a flare).
  - **A change of one or two nights from the list** (or found by step 3) is one night at its first night unless the
    place's own series shows a lasting step there, also when the series does not show the night by itself, has no
    week after it yet (the last nights in the data) or does not exist (a site seen on one night only). The answer then
    gives how the series saw that night (`own_z`). Example: the Jubail flare at 26.947 N 49.612 E burned about ×4 its
    usual on 25 Oct 2026, the last night in the data; its heat reached a pixel 1.7 km away that is usually cold, and
    the list marks the change there (×24, "strengthened · flame"). For the flare itself the night is +2.7σ, ordinary
    (it burned twice as strongly on 5 Oct). Before this rule, asking from a personal area kept from that row said
    "no change", and asking from the row treated it as a lasting step with no nights after it.
- **Every other place on that night,** scored the same way: TEMPER's sites, LIGHT ROAST's lit 2.25 km blocks (the
  country's night, the viewing pattern and moonlight taken out). Kept at |z| ≥ 5 and ×2 or 2 s.d.
- **Detected changes too:** the change log's changes of one or two nights that started from the night before to the
  night after, including places too dark, or too seldom lit, to be candidates (TEMPER's one-night heat).
- **Order:** as for a lasting change, with each place's rate the share of 60 ordinary nights on which it stood out
  the same way.
- **How unusual:** the places that stood out that night plus the short changes detected then, within 50 km and
  country-wide, against the same count on the 60 ordinary nights. A night seen only in part (a swath missing, or the
  last night still arriving) has fewer places that can stand out: when it saw under 80% of the places an ordinary
  night sees (nearby, or country-wide), the ordinary count is scaled to the share it saw, and the answer says so. On
  25 Oct 2026 TEMPER saw 168 of Saudi Arabia's usual ~330 sites: 9 places against 21 read "fewer than usual",
  against the scaled 11.4 "as usual".
- **Example:** the fire east of Jerusalem on 28 Jul 2026: lights ×3.4 in its 3 km window (z 12), heat 8.7σ (z 35).
  Lights: 3 places within 50 km against 1.7 on an ordinary night, 5 country-wide against 7.5. Heat: 2 against 1.4,
  and 4 against 4: TEMPER saw four other new heat sources that night, 38–115 km away. A summer night with a few
  fires; this one stands on its own.
- **Speed:** about 1 s in Israel.

### A lasting change

A change that stayed: where else did the same change happen at the same time, and is that more than in an ordinary
week? (`cooccur` in server.py.)
- **The switch night.** A week's median finds a change a few days late, so the night is found in the place's own
  nightly series (its window, at least 3×3): the day, from 10 before the change's first night to 3 after, where the
  median of the 7 days from it differs most from the 14 days before it, in the change's direction.
- **Every other place at that night.** TEMPER sites, or LIGHT ROAST's lit 2.25 km blocks with the regional swing kept
  (an outage is regional). The step is the median over the change's days (7 to 21) less the median over the 42 to 4
  days before. z = step / (1.25 × robust spread × √(1/n₁ + 1/n₂)). A step counts at |z| ≥ 4 and at least ×1.5
  (lights) or one site standard deviation (heat). Places already changing 4–14 days before are marked
  **התחיל קודם**.
- **Detected changes too.** The event log adds the changes detected from 3 days before the switch to its end,
  including lights too dark to be a block. A place on both is marked **זוהה**.
- **Order: the surprising first.** Each place's rate is the share of 24 other times of the year when it stepped the
  same way. Places are ranked by |z| × (1 − rate) × (1 + e^(−distance/50 km)), so a place that rarely changes but
  changed now comes first, one that flickers every week sinks, and of two such the nearer leads (up to double, for
  the same change nearby more likely shares a cause). Detected-only places, with no series, count at half.
- **How unusual.** The detected changes of that direction that started then, within 50 km and country-wide, against
  the same count at the 24 other times. Checked on Saudi Arabia:

  | The change | Within 50 km | Country |
  |---|---|---|
  | The strongest regional outage (Jan 2026) | 107 vs 26 usual, ×4.1 | ×1.3 |
  | An ordinary lasting new light (Apr 2026) | ×1.0 | ×0.8 |
  | The intermittent source at 20.397 N 45.307 E (Oct 2026) | 3 vs 1.3, ×2.2 | ×0.5 |

- **Other product.** The search can run in the other product: lights that went out, and where heat stopped then.
- **In the graphs.** The graph icon on a result shows both places from two months before the switch; the switch is
  dashed and the days compared are shaded.
- **Speed.** 1–7 s for Saudi Arabia, mostly the 24 ordinary times.

### What moves together

Given one place, the viewer lists the places whose behaviour from night to night moves with it, or against it. For
example: flares on one field that go out together, or districts whose lights dim on the same nights.

**What is compared:**
- **TEMPER places:** sites detected on at least 2 nights. A site is a group of touching pixels, taken at its most
  often detected pixel. The series is read from the nightly change summaries, so no raster is read.
  - **Per night:** the 3×3 sum of corrected M10 radiance where it was lit. A clear night when it wasn't lit counts
    as 0. A night it couldn't be seen (no pass, or cloud) counts as missing.
  - **Then:** compressed (asinh) and standardised per site. Taken out: the night's median over all sites (haze, or
    much of the country at the swath edge), and the site's own pattern over the 16-day orbit cycle (viewing angle).
- **LIGHT ROAST places:** lit 2.25 km blocks (3×3 cells), lit meaning at least 5 nW on a quarter of nights or more.
  - **Per night:** log(radiance + 1), when at least 7 of the 9 cells were measured.
  - **Taken out:** the night's country-wide median; the block's pattern over the 16-day cycle; its own response to
    moonlight; and the regional swing, a ~30 km weighted average around it.
  - **Why moonlight:** Black Marble removes most of the moon, but dim places on bright ground keep a lunar cycle.
    The moon is computed from the date alone, offline: its phase and its height at the 01:30 overpass.
  - **Why the regional swing:** haze and weather move every light in an area together. **כולל שינויים אזוריים**
    keeps it, to look for wide events such as a large outage.
  - **Cache:** built once per country, `cache\lr-<id>\blocks.b2.npz`, ~12 s for Saudi Arabia.
  - **Dark places** are not searched: what varies there is sensor noise and moonlight. The viewer says so.
- **The match:** Pearson r over the nights both were seen in the period.
  - **Kept:** at least 20 common nights and |r| ≥ max(0.3, 4/√n). With thousands of candidates a looser bar would
    list chance matches.
  - **Left out:** places within 3 km of the chosen one, since their pixels overlap it. A match within 5 km of a
    stronger one is merged into it, so a city is one entry.
  - **Speed:** about 0.1–0.2 s per search once the series are built.

**Checks:**
- **Chance matches:** every search was repeated with the chosen place's nights shuffled in time. It returned 0 places
  in most cases and at most 3, against 3–45 for the real searches.
- **Weather:**
  - Before the regional swing was taken out, Tel Aviv's best matches were its own neighbours 5–13 km away
    (r ≈ 0.75): shared haze.
  - After it, the metro area still co-varies (r ≈ 0.6, 5–35 km). A city's districts do move together.
- **Moonlight:** before the moon was taken out, a dark spot in the Arava matched dim places 100+ km away.
- **Search across products:** a flare against the lights is weaker (r 0.3–0.5). Read it as a lead, and open the pair
  with its graph icon to look.

## Area analysis: light against heat in one window

A card beside the graph analyses one place in both products: the one pinned or hovered, else the last. It updates when the place is sampled and when the period changes (`/api/area`).
- **Light against heat inside the window:** VIIRS lights (LIGHT ROAST) against SWIR heat (TEMPER).
  - **The r:** Pearson r between the two over the nights both products saw the place, with "נעים יחד",
    "נעים הפוך" or "אין קשר ברור", and a scatter plot with one dot a night.
  - **What is compared:** the same residual series as the related-places search. The heat is the mean of the
    detected sites in the window; the lights are the mean of its lit blocks, less the regional swing.
  - **Clear:** |r| ≥ max(0.2, 2.6/√n), about p < 0.01.
  - **Lead:** whether one follows the other by up to 7 nights. A lead must beat the same-night r by 0.1 and
    clear max(0.3, 3.5/√n), since 15 lags are tried.
  - **Checked on Saudi Arabia's 40 busiest flare sites (5 km windows):** median r 0.53, clear at 90%, no lead.
    With the heat nights shuffled: median r −0.02, clear at 0%, no lead. A looser lead bar found a lead at 15%
    of the shuffled sites.
  - **Examples:** the Shaybah flare field 0.65 (a flare is both hot and bright). Abqaiq 0.13, where facility
    lighting outweighs the flares. No heat in a window (Riyadh): the card says so.
- **Related places:** the top 5 that move with the window and the 2 that move against it, by its lights and by
  its heat. The seed is the whole window, and the places inside it are left out. Click a match to go to it
  (a dashed ring marks it); its graph icon adds it beside the place. **כל הרשימה** opens the full search in
  the list's place.

## LIGHT ROAST: night-lights change

**Data.** NASA Black Marble VNP46A2 (Collection 2, with labelled NRT for the latest days). It is daily DNB radiance
in nW cm⁻² sr⁻¹, already corrected by NASA for moonlight, atmosphere and surface BRDF.
- **Location:** `ARD\VIIRS_NIGHT_DNB\<country>\raw_data` (`config.json` → `lightroast_root`), with the same
  country folder names as TEMPER.
- **Period:** 333–334 nights per country, 20 Oct 2025–20 Oct 2026. NASA's archive has a gap on 5–14 Oct 2026.
- **Dates:** NASA labels each night by its UTC date. For the evening passes over these countries that is the
  same date as TEMPER's night label; a pass after midnight UTC falls on the next date.

**On TEMPER's grid.** Each night's tiles (10°×10°, 15″) are reduced once to the country's 750 m EPSG:6933 grid,
so a window covers the same cells in both products.
- **Usable cells:** finite radiance, Mandatory_Quality_Flag 0 or 1, cloud-mask bits 6–7 confident or probably
  clear, no snow (the masks of VIIRS_algo's `mask_loader`).
- **750 m cell:** the mean of its usable 15″ cells, kept when they are at least half of it.
- **Why 750 m loses nothing:** VIIRS's DNB sees ~742 m at every scan angle, so the 15″ Black Marble grid
  oversamples it.
- **Cache:** `cache\lr-<id>\<night>.n1.npy` (float16) and `.json`. A night takes 0.5 s (Israel) to 2.6 s
  (Saudi Arabia). The background worker prepares the open country.

**What a single night can tell.** Little: over central Israel a lit pixel varies ±0.43 in log units from one clear
night to the next (about ±50%). Changes are therefore measured on weeks.

**Clouds.** Where cloud hid the ground there are no lights to measure. Left blank, that would read as darkness,
or as lights that went off. Each night therefore also gets a cloud layer from Black Marble's own cloud mask:
- **Cloud layer:** the share of each 750 m cell whose 15″ cells are probably or confidently cloudy
  (`QF_Cloud_Mask` bits 6–7 ≥ 2).
- **Cache and speed:** stored as `cache\lr-<id>\<night>.n1.cloud.npy` (uint8). It takes ~0.7 s a night for Israel,
  built by the background worker after the lights (the header shows **עננים n/N**).
- **On the map:** a cell with no usable lights that is at least half cloudy is drawn as cloud, in the lights and
  change views. The picture says where cloud was; its texture is synthetic.
  - **Its own layer** (`/api/lr/clouds`): the viewer draws it over the lights with smooth scaling, so it stays soft
    at any zoom instead of turning into grey squares.
  - **Look:** heaps of a fixed per-night texture (five noise scales) with thinner gaps between them, lit from the
    upper left by the texture itself, so the tops facing the light are white and the far sides blue-grey.
  - **Edges:** soft, with faint wisps just past them over the nearest clear cells.
- **Readout:** says **ענן · אין תצפית הלילה**. The week's comparison is still shown, from the nights that were clear.
- **Chart:** a night when less than 80% of a window was measured, or most of it was under cloud, is a hollow marker
  off the line, and the weekly median leaves it out (see **The graphs** below). The weekly median needs at least 3 such
  reliable nights in its 7, and is drawn only on nights that were themselves observed.
- **Example:** on 24 Sep 2026, 33% of Israel was under cloud, and 1–8% on most other nights of that month.

**Changes** are listed for every night shown, in the list (**מה השתנה הלילה**). Per pixel, the median of log(radiance + 1 nW) over the 7 nights ending at the shown one
is compared with its **baseline**: the same 7 nights in earlier 16-day cycles. **השבוע מול** chooses how far back
the baseline reaches:

| Choice | Nights | Cycles back |
|---|---|---|
| החודש שקדם | 14 | 16–32 days |
| החודשיים שקדמו (default) | 28 | 16–64 days |
| 3 החודשים שקדמו | 42 | 16–96 days |
| 4 החודשים שקדמו | 56 | 16–128 days |
- **Why those nights:** Suomi-NPP repeats its ground track every 16 days, so each recent night is compared with
  nights seen from the same angle. The 16-day angle effect is real here: a shared ±12% pattern over lit pixels.
  VIIRS_algo's SFAC corrects it per pixel from roughly 14 cloud-free nights per angle, which is noisy; matching
  the cycle cancels it without estimating it.
- **Shared shift:** a hazier week moves every light together. The median change of well-lit pixels (≥ 5 nW) is
  reported as "כל המדינה ±X%", and each pixel is tested against it. A nationwide blackout therefore stays
  visible in that line, and in the windows' series.
- **Score:** z = change / (1.25 × the pixel's robust night-to-night spread × √(1/n₁ + 1/n₂)). It is then
  divided by that night's own spread of z over lit pixels, which is ≥ 1, since most places do not change.
  A change needs |z| ≥ 4. A lone pixel needs |z| ≥ 6.
- **Kinds:**
  - נדלק: baseline < 2 nW, now ≥ 5 nW.
  - כבה: the reverse.
  - התבהר: at least ×1.5.
  - התעמעם: at most ×⅔, both lit.
- **Follow-up:** for past nights, the next 7 nights against the same baseline: "נמשך" (holds) or "חלף" (passed).
- **Moonlit glow:** on full-moon weeks, dark ground can light up in large patches that move from night to night.
  The cloud mask calls them confidently clear.
  - **Where it happens:** Yemen's Al Mahra slopes, 10–100 km inland, in the July–September monsoon.
  - **How it looks:** 2,000–23,000 km² a night. On 3 Sep 2026, 110 "new lights" appeared and none lasted. Most
    likely it is moonlit fog.
  - **How it differs from real lights:** the glow comes in bursts (94% had 5 or more other new lights within 25 km
    that night); real new lights almost never do (0–2%). Size does not separate them (about 2 pixels each), and
    neither does brightness (both about 6–8 nW).
  - **On clear ground** the moon leaves −0.2 to −0.4 nW everywhere, which is harmless.
  - **The rule** (`_moon_check`):
    - A new light is area-wide when 5 or more other new lights are within 25 km that night. A new light within
      50 km of one already removed as glow is treated the same way, since the patches thin out at their edges.
    - An area-wide new light must also be lit (at least 3 nW over its pixels) on 2 moon-free nights (moonlight
      below 0.3). Those nights come from its own week, else from the nights after it, up to 21 days.
    - **Why 3 nW:** "dark" means below 2 nW, and the glow read 1.2 nW without the moon in Yemen (90th percentile
      2.2). A 5 nW bar also removed dim real lights: Saudi Arabia's read about 3.5 nW without the moon. At 3 nW,
      76% of those were kept, and 1.6% of Yemen's glow came back.
    - **Lit:** kept. **Dark:** removed as glow; the panel says "N הוסרו: זוהר ירח". **Not enough moon-free nights
      yet:** shown as pending ("ממתין · ירח", faded on the map, "+N" on its kind's chip).
  - **Checked on every night with a full baseline (about 270 per country, with the 5 nW bar):**

    | Country | New lights, before → after | Share lasting a week | Removed |
    |---|---|---|---|
    | Israel | 524 → 497 | 66% → 70% | 27 |
    | Yemen | 4,605 → 810 | 11% → 45% | 3,795 |
    | Iran | 30,887 → 9,384 | 15% → 42% | 20,516 |
    | Saudi Arabia | 27,989 → 25,136 | 70% → 77% | 2,853 |

    - Glow made up 78% of Yemen's new lights and 63% of Iran's.
    - Real clustered lights, such as Saudi Arabia's flare fields, are checked and kept. Those found on full-moon
      weeks waited a median of 4 days (at most 13) for moon-free nights.
    - Removed but marked "lasting" by the one-week follow-up: Yemen's read about 1 nW without the moon, so they were
      glow (the moon is still up the following week). Saudi Arabia's were mostly dim real lights, which the 3 nW bar
      now keeps.
  - **Why it is safe for regional events:** isolated new lights are never held. A burst on a moonless week is
    confirmed on the spot. So power coming back across a town is shown at once, or at worst after the next
    moon-free nights.
- **חום (heat, from TEMPER):** a change is marked when TEMPER saw a source above its hot-spot threshold within
  two pixels on the nights compared, so the light is a flare or a fire rather than lighting.
  - On 20 Aug 2026 this marked 46 of Saudi Arabia's 335 changes and 1 of Israel's 22.
  - The rest are lighting changes, or flares too small for M10: DNB sees far dimmer light than M10 sees heat.
- **Speed:** only pixels that reached 2 nW on some night of the two periods are examined, so a comparison takes
  0.1–0.8 s.

**Checked** on every 7th night with a full baseline:

| | Per night, median (Israel / Yemen) | Holds the following week (Israel / Yemen) |
|---|---|---|
| נדלק | 2 / 2 | 39% / 26% |
| כבה | 0 / 0 (rare) | 43% / 100% |
| התבהר | 5 / 1.5 | 43% / 69% |
| התעמעם | 4 / 1 | 24% / 56% |

- **Without the calibration and the lone-pixel rule:** brighter and dimmer were 22 and 20 a night in Israel,
  91–93% single pixels.
- **Short-lived changes are common:** temporary lighting, fires, and local dust or haze, which dims a region
  for days and is not in the cloud mask. The follow-up tells them apart.
- **Yemen's shared shift ranges 0.84–1.41 between weeks.** On the noisiest weeks the self-calibration raises
  the bar (up to 8×) rather than flagging the whole country.

**In the viewer:**
- **List:** a chip per kind for the shown night: נדלקו, כבו, התבהרו and התעמעמו. Clicking one hides or shows that
  kind in the list and on the map.
  - **Under the title:** the nights compared, the country-wide change ("כל המדינה כרגיל" or "כל המדינה +X%",
    which is not counted as change), the moon, and the lights removed as moon glow.
  - **⚙ → סימוני השינויים על המפה:** hides or shows the change marks.
- **Map, אורות:** radiance on a fixed log scale, 0.5–100 nW. Below 0.5 nW the sensor's noise floor shows
  detector striping, so it is kept dark. Clouds are drawn as cloud; the legend shows a cloud icon.
- **Map, שינוי:** the lights in grey, with each pixel's change against the usual over them (gold brighter,
  blue darker; stronger colour for larger and more certain changes).
- **Readout:** tonight's radiance (or **ענן**), and the week against the usual: "+X% מהרגיל", this week's and
  the usual radiance, σ, and the kind of change.
- **Chart:** **שבועי** (median of the 7 nights to each night, default) or **לילי** (each night's window mean).
  For both products together, see **The graphs** below.
- **CSV:** per window and night, mean radiance, the 7-night median, coverage and lit area (≥ 5 nW).

**Second method: VIIRS_algo's SFAC + RX** (`rxmethod.py`). **Paused:** no SFAC fitting in the background and no
method switch in the panel. Set `"rx_method": true` in `config.json` to bring it back as **⚙ → RX · VIIRS_algo**.
- **What it is:** the repository's own method, re-implemented from its source:
  - Files: `sfac.py`, `detection/rx_temporal_detector.py`, `wrapper_unstable_stable_rx.py`,
    `detection/anomaly_vectorizer.py`, `config.yaml`.
  - The repository was read, not run or imported. The viewer stays offline and needs nothing beyond numpy and scipy.
- **SFAC:** fitted once per country over all its nights.
  - **Outliers:** values above the pixel's mean + 3σ.
  - **Geolocation smoothing:** ntl_fix is the mean of the pixel's lowest 5% of non-outlier values. Each night's
    difference from ntl_fix is averaged over 3×3 pixels and added back.
  - **Viewing angle:** 16 groups by day mod 16. a_i = the group's mean ÷ the all-nights mean. Each night is divided
    by its group's a_i.
  - **Cost:** 9 s for Israel. Larger countries take minutes, in the background after the cloud layers; the header
    shows **SFAC n/N**.
  - **Cache:** `cache\lr-<id>\sfac.sf1.npy` (19 float16 bands) and each corrected night as `<night>.sf1.npy`.
  - **Size of the correction:** over Israel's lit pixels a_i differs from 1 by 6% (median) and 19% (90th percentile).
- **RX, per night:** the shown night against the stable period.
  - **Stable period:** the nights of the chosen months, ending where the shown night's week begins.
  - **Statistics:** per pixel, mean and std without values above the 98th percentile.
  - **Score:** max(night − mean, 0) ÷ max(std, floor). The floor is the 95th percentile of lit pixels' std within
    ~23 km, at least 0.5 nW.
  - **Anomaly:** 3 < score < 20.
  - **Clusters:** binary closing, then 8-connected groups.
  - **Brightening only:** no כבו or התעמעמו rows.
  - **Speed:** 0.2–1 s a night for Israel.
- **Differences from the repository:**
  - The data is on 750 m cells, not 15″ pixels.
  - The floor's sliding 23 km window is computed on 23 km tiles and interpolated. The sliding window takes ~60 s a
    night at this size; the tiles take ~0.1 s.
  - The stable period follows the night instead of being two fixed folders.
  - A one-week follow-up was added so the methods can be compared.
  - Quirk kept as in the repository: a pixel with fewer than 8 valid stable nights gets mean = std = 0, so a lit
    pixel under persistent cloud can score high.
- **In the viewer:**
  - **Change map view:** shows the RX score in gold.
  - **Readout:** shows the score, the night after SFAC, and the stable mean ± std.
  - **The other method:** whichever method is shown, the other one runs on the same night too.
  - **Agreement:** a ring around a map mark and a "גם RX" / "גם שבועי" tag mean the other method found a change
    within 1.5 km. The panel counts these: "◎ N מתוך M התבהרויות נמצאו גם בשיטה …". Only brightenings are counted,
    since RX looks for nothing else.
- **On Israel, every 7th night of the last two months (window 28):**
  - **RX:** 0–82 brightenings a night, mostly single pixels.
  - **Weekly method:** 2–14 brightenings a night.
  - **Held the following week:** 6 of 329 RX brightenings (2%).
  - **Why:** RX scores single nights, and DNB nights vary ±50%. The strongest RX hit on 19 Aug was 119 nW one
    night at a pixel that reads ~35 nW, back to normal the following week.
  - **Agreement:** the two methods agreed on 0–4 places a night.

**From VIIRS_algo** (`Downloads\VIIRS_algo-main`), read but not run, for the weekly method:
- **Used:** the quality and cloud masks; the "unstable against stable period" idea of its RX detector; and the
  long-lasting detector's question of whether a change persists (here the follow-up).
- **Replaced:**
  - SFAC's per-pixel 16-day coefficients, by comparing like with like.
  - Its spatial smoothing of geolocation jitter, by the 750 m reduction and the lone-pixel rule.
- **Not used:**
  - Image registration: the products are already on fixed grids.
  - Destriping: it only matters below ~1 nW, which the analysis does not examine.
  - The acquisition, S3 and Streamlit parts, which carry tokens and keys; they were not opened.
- **For TEMPER:** nothing changed; TEMPER already uses each pixel's actual viewing angle. One open idea is to
  compare TEMPER nights with nights of the same 16-day cycle as well.

**Limits:**
- Dust, haze and thin cloud missed by the cloud mask can still dim a week locally.
- NRT nights are provisional.
- The first ~2 months have no complete baseline.
- Gas flares are very bright in DNB too (up to 31,000 nW in Saudi Arabia). Their changes appear here as
  lights; TEMPER says what they are.

Image values always come from the **raw M10 TIFFs**. Existing nightly manifests
and provenance supply the common grid, country polygon, dates, and geometric
source-selection indices. The harmonized image is opened for grid metadata only;
none of its pixel values is read. No radiometric fitting, background subtraction,
normalization, or p95 clipping is applied.

A standalone directory of one-band `.tif` files, or `*/M10.tif` bundles, is also
supported when each file has a `time_start_utc` tag and all grids use the same
projected CRS in metres. These are grouped by UTC acquisition date and mosaicked
in filename order, first valid sample wins. A common union grid is used.

## The graphs

**The Noise scale** (`chart.js`: `relValue`, `noiseOf`, `squash`): a place's values as compared, light as log(L + 1)
(its noise grows with brightness), heat as they are; its usual level, their median over the period shown; its noise,
1.4826 × the median absolute difference between consecutive nights / √2, robust and blind to a step (a step moves the
level once; it adds one large difference among hundreds), never below 0.02 in log light. Drawn: z = (value − usual) /
noise, on an axis linear inside ±2 (to ±0.7) and logarithmic beyond (0.7 + log2(|z| / 2)), ticks at ±2, 5, 10, 20, 50,
100 as room allows. Israel's story place: noise 0.047 (about 5% night to night); before its step it sits about 48
times its noise below its usual level, after it about 10 times above. **Against a reference** (`chartRef`): the value
less the reference's on the same night (light in log, so a ratio), then the same median and noise, or in Change the
ratio (light) or difference (heat) as a percent against its median.

**What is plotted:** each place's night-by-night mean. With both graphs shown, both products' metrics sit side by side in the toolbar, each with its product's dot; changing one refits only its own panel.
- **TEMPER:** by default **מתוקן**, the window mean minus the night's clipped-noise mean for each pixel's
  viewing angle (see **Preprocessing**). A place without sources then sits at ~0 every night instead of
  ~0.0035 that moves with the viewing angle. **גולמי** is the mean as measured; **טמפ׳** the source temperature
  on nights with a confirmed source.
- **LIGHT ROAST:** **שבועי** (default) or **לילי**. **שבועי** is the median of the reliable nights among the 7
  ending at each night: at least 3 of them, as the change detection needs, and only on nights that were
  themselves observed. On a cloudy night the line has no point, only the cloud tick. Drawn there, the median
  was made only of the nights before it. Near 17.48 N, 47.16 E it then rose to its highest on 12–14 Sep 2026
  (25.9 nW, from 2–3 nights) while the place was under cloud, just before its lights dropped to ~4 nW.

**Reliable nights:** a line runs through a place's reliable nights only: at least 80% of the window measured, and not
mostly under cloud.
- **Why:** on partly clouded nights even the measured part reads low (thin cloud and haze next to the cloud mask).
  Over Tel Aviv, Beersheba and Haifa, 3 km windows read 73–83% of their clear-night level, so those nights made the
  line dip.
- **How they show:** such nights are small hollow markers off the line. A night with nothing measured because of
  cloud is a small tick at the bottom.

**No data:** stretches with no data (more than 4 days without a night, or before a product's first night) are shaded
and marked **אין נתונים**. Lines never cross them.

**The values axis** (js/chart.js, `chartMode`):
- **קבועה** (Fixed, the default): from 0 (or below it for negative corrected means) to a round number above the
  values, set once and kept while zooming in time; Shift+wheel zooms it by hand.
- **לפי התצוגה** (Fit to view): refitted to the values in the period shown each time it changes. With 30 values or more
  it spans their 2nd to 98th percentile (plus 8%), so one bright night (a flare's surge, a fire) does not flatten the
  rest; values beyond it are pinned to the edge with an arrowhead, as on the fixed scale. This is what makes a shift of
  a few percent visible when zoomed in on weeks.
- **שינוי** (Change): each place against its own median over the period shown, so places of very different brightness
  share one axis. Radiances in percent (LIGHT ROAST, TEMPER's raw mean: always positive); TEMPER's corrected mean and
  the source temperature as a difference (the corrected mean of a place without a source is ~0, where a percent
  means nothing). The chips above the graph still read the values themselves.

**The shape on the graph** (js/chart.js, `drawShape`): the shape a place was found by in the behaviour search, else the
one the area analysis found for it over the graph's period (series_profile; steady places get none). The shape's own
numbers are fitted to the values as drawn: a step's medians before and after its night; a trend's least-squares line;
swinging's 20th and 80th percentiles; spikes: the median, and the nights more than max(4 × 1.4826 × MAD, half the
median) above it ringed.

## Composites: a period in one layer

The map, its readout and the GeoTIFF can show the calendar block holding the shown night: its ISO week (Monday to
Sunday), its 16-day cycle (one cycle of Suomi NPP's ground track, so every view angle once; blocks of 16 days counted
from Monday 2 Jan 2012), its month or its year (server.py, "composites", `period_span`). A block's composite is kept
under its first day, so every night of the block shows the same one and the page does not ask again until the block
changes. The GeoTIFF's name ends with the block (`_2026-W07`, `_2026-02-09_16d`, `_2026-02`, `_2026`) and its tags
give its first and last day.
- **TEMPER** (the combined view): per pixel the night of the period with the highest combined significance (M10 and
  M11 in noise standard deviations, as on a night's map), coloured by that night's two-band source temperature where
  both bands were at least 10 sigma. Also kept: on how many nights it was clearly hot (combined significance ≥ 10),
  on how many it was observed, and its highest M10 radiance. A brightest-night composite shows every source the period
  saw, at its strongest; the hot-night count says whether it burned once or all along.
- **LIGHT ROAST** (the lights view): per pixel the median of its usable nights in the period (each night's layer
  already leaves out cloud and poor quality), and how many usable nights it had. The median keeps a single bright night
  (a fire, moonlit haze) out of the picture; the year's is close to the usual-lights view (which uses every other night
  of the whole record).
- **Built** once per country, night and period, kept in the country's cache with a signature of its nights' files (a
  changed night rebuilds it), the 8 latest per product. Meanwhile requests answer 202 with how far it got, and the page
  asks again.
- **Month blocks (TEMPER).** Every calendar month that is over (before the latest night's month) and that a period
  covers whole (at least 8 of its nights) is read from its own composite, built once from its nights and kept
  compressed (`blocks/<YYYY-MM>.<layers>.month.npz`, with the signature of its nights). The period's two ends are read
  night by night. The parts combine exactly: the strongest night wins only where strictly stronger, taken in time
  order (so of equal nights the earliest stays, as night by night), the highest M10 is the maximum, and the counts
  add up. Checked on Israel's year: all five layers identical to the night-by-night build. Cost: Saudi Arabia ~0.3 s a
  night, so a year was ~2 minutes; from blocks it reads ~12 blocks (0.4 s each) and up to ~30 edge nights, ~15 s. The
  median of LIGHT ROAST does not split into parts and is built from its nights (seconds).
- **Ahead.** Showing a night's map asks the background for its periods: after 2 s (stepping through nights builds only
  the night that stays), the week, 16 days, month and year of both products, one at a time, kept on disk only; then
  every month block of the record, newest first. A page that asks for a period meanwhile shares the same build.

## Answers kept

A place's series (both products), its area analysis, related places and a behaviour search are kept in memory (up to
160 answers) and given again at once to the same question: same country and nights, the same settings, and the request
the same after rounding numbers to 3 decimals and leaving out empty fields (and, for the search, the map's view and the
user's areas unless the query asks `within`). Answers are kept only while the background workers have nothing to do,
and every one is dropped when a worker starts on new data; an answer about nights still being prepared is not kept.

## The tour's story

`static/story.json` holds, per country, the place the tour walks through. Chosen from the data (October 2025 to October
2026), by these steps: the behaviour search's steps (shape = step), each checked against the change log and both
products' series at the same place, for a step that is large, clean (fit), in the middle of the year (enough nights on
both sides) and explained by both products; then the related-places answer for its change, for a partner that
changed on the same night (or, for a step without one, the best correlation).
- **Saudi Arabia, 50.125°E 24.770°N (3.75 km).** TEMPER: a flame on 27 of the 34 nights measured between 15 Nov and
  1 Jan, then on 1 night of 264. LIGHT ROAST: ~15 nW in early November, a median of 78 nW from mid-November to
  December (446 nW on 21 Dec), ~13 nW in January, 2.2 nW from 10 Feb 2026 (the change log: dimmer, strong; never so in
  another week of the year). Related (that night's change): a place 11.5 km south, 7.0 to 0.8 nW the same night (z =
  -12.7, detected off). Steps down in February: 14, the place itself first (x6.4), a group of 6 within 29 km, 10 to 18
  Feb.
- **Israel, 34.929°E 29.947°N (2.25 km).** No heat on any night. LIGHT ROAST: ~2.3 nW until February, ~16.6 nW from
  early March 2026 (the change log: new, 21 Feb to 7 Mar, strong). Related (correlation over the year): 34.812°E
  31.686°N, r = 0.79, ~2.4 to ~5.7 nW from spring. Steps up: 8, the place first (x4.2 on 7 Mar), the partner among them.
- The texts give these numbers; if a country's data are replaced, its story should be chosen again. The server asks the
  story's questions (`story_requests`) once the country is open and its workers are idle, so the tour's answers are
  kept (see **Answers kept**).

## A layer of points

`/api/points` (server.py, `points_series`): for up to 500 points a request, each night's layers are opened once and
every point's window (k × k cells around its cell, k = size / 750 m) is read at once.
- **TEMPER:** the window's mean of M10 less the night's noise mean for each pixel's view zenith (the graph's
  "corrected"), and whether a source burned in it: M10 above the night's threshold in the window, with M11 above its
  own threshold in the window where M11 exists (the place's graph also dilates by a pixel; in a 3 × 3 window that is
  the same).
- **LIGHT ROAST:** the window's mean radiance.
- **Shape of the year:** as the area analysis (`seed_series`, `series_profile`): heat from the detected sites within
  the window (none within 2 km: no heat source); light from the lit 2.25 km blocks inside it; with none, dark when its
  own median is under the lit level, else the shape of its own log radiance.
- **Speed:** Israel 100 points 2 s, 500 points 6 s (cold caches 1.3 s more).

## Importing files

`/api/import` with `vectors.py`: GeoJSON; CSV with lat/lon (or latitude/longitude, y/x) columns, any delimiter;
ESRI shapefiles read directly: the .shp records (point, multipoint, polyline, polygon, with or without Z/M), the .dbf
(dBase III; text in the .cpg's encoding, else UTF-8, else Windows-1255, else Latin-1), and the .prj (WKT, ESRI or OGC,
read by pyproj). Polygon rings: clockwise ones are outer rings, the others holes of the outer ring holding them. A
name comes from a field called name, שם, label, title or id. Checked with a shapefile written in the Israeli grid (EPSG
2039) with Hebrew names in Windows-1255: the points came back within a metre of their coordinates, and a polygon with a
hole kept it.

## The network of related places

`/api/network` (server.py, `network`): the place's series and every candidate's, as for related places; the strongest
matches by |r| (up to the number asked, a match within 5 km of a stronger one joining it), then every pair among them
correlated the same way, an edge kept at |r| ≥ max(least r, 4/√n) (and of the sign asked for). Eigenvector centrality:
the leading eigenvector of A, A_ij = |r_ij| on the edges (numpy `eigh` of the symmetric matrix), its absolute values
scaled so the most central is 1. The tab lays the nodes out by Fruchterman–Reingold (pairs push apart by k²/d, edges
pull by d²/k × |r|, 450 steps, cooling 1.5% a step, the place fixed in the middle), then scales the picture to the
canvas; or by their map positions. Israel's story place, 25 asked: 20 nodes, 176 edges (158 together, 18 opposite),
0.5 s.

## Changeable thresholds

`/api/params` lists them, `POST /api/params` sets them (clamped to their range) or resets them; `config.json` keeps only
those changed. A change of an event threshold drops the linked change log (linked again at the next question), of a
shape threshold the behaviour shapes; any change drops the kept answers and makes the tour's lab again (its stamp then
names the changed values). The defaults are those given in this file.

## The tour's lab

`/api/lab` gives the open country's lab: everything the tour shows, worked out ahead (server.py, `build_lab`).
- **Places:** the story's point and partner, the two strongest firm changes of each product, and the first (most
  significant) change of each phenomenon in the change log (a flare that lit or grew, a fire, new lights that stayed 5+
  nights, a regional outage, lights that went out alone, an oil/gas field, a regional shift), each with its window (the
  page's `clusterSize`), both products' series and its area analysis, as `/api/series`, `/api/lr/series` and
  `/api/area` answer them, with every night prepared.
- **Answers:** related places for each strongest change and for the story (its question as written in story.json), the
  behaviour search for steps of each product (or, with none, the shape the country has most of), and the story's search.
- **The tools' windows (version 2):** the lab's night (the last it was made with); the 16-day cycle holding it, its
  TEMPER and LIGHT ROAST composites rendered once as PNG (base64); the network of the story's place (else the strongest
  change), 25 asked, with where it was asked (`at`); and a point layer of its places (the story's two and one of each
  phenomenon), with `/api/points`' answer for them.
- **Stamp:** the version, the country, the layers' versions, each product's nights (count, first, last) and the story's
  data (not its texts). A sandbox: a lab is used for its country and its story whatever its nights, so new data do not
  change what the tour shows (it opens on the lab's night; `current` says whether the lab still matches the data). One
  is made in the background only for a country without one, or after its story changes, once the tour has ended and
  the workers are idle (Israel ~75 s, Saudi Arabia a few minutes), into `<cache>/lab.json`; the files shipped in
  `static/lab/` are made with `--make-lab`.
- **The hold:** while the question after the opening or the tour is open the page says so (`POST /api/tour`), and
  the background waits: the night builder, the light worker, the next night's images, the composites built ahead,
  the start-up warm-up and the lab maker. The hold ends with the tour, or after 15 minutes without word from the page.

## Graph colours

Every palette is checked with the dataviz validator on the dark surface, all pairs (`validate_palette.js --mode dark
--pairs all`): default (#22c55e #ec4899 #a855f7 #facc15), jewel, berry, pastel and high contrast pass colour-blind
separation (ΔE >= 8) and the normal-vision floor (>= 15); rainbow, soft and neon are in the 6-8 band, legal because each
line also carries its #n label. None has orange (hue 14-46°) or blue (192-238°), the products' own colours; a colour
from the picker in those hues is allowed, with a note.

## The night as a GeoTIFF

`/api/export` writes a night as the viewer reads it, over the country's grid (the rectangle around the country):
- **TEMPER:** the nightly layers (see **Preprocessing**): M10 and M11 radiance of the pass with the smallest view
  zenith at each pixel, M15 and M16 brightness temperature of the same sample (kelvin), that view zenith (degrees), and
  the cloud test (the night's M15 drop below its clear-sky reference, kelvin; cloud at −8 K or less; empty until the
  background worker has built it, e.g. on the last night before the next arrives).
- **LIGHT ROAST:** the night's Black Marble radiance averaged to the grid (nW cm⁻² sr⁻¹, usable 15″ cells only, as
  the analysis uses it) and the share of each cell the VIIRS cloud mask calls cloudy.
- **Projection:** the grid as it is (EPSG:6933, 750 m, no resampling), or WGS84 latitude/longitude on the grid's
  extent (rasterio's default transform for it), resampled by nearest neighbour so every value is a measured one.
- float32, NaN = no data; deflate with the floating-point predictor, 256-pixel tiles; each band named, with its units
  in the band's tags, and the product, night, country and source in the file's tags.
- **An area** (`clip=` its ring on the grid as JSON, `area=` its name): the file is cropped to the area's rectangle
  (whole cells, every cell the rectangle touches) and cells outside the polygon are NaN (rasterio `geometry_mask`, all
  touched, so the edge cells are kept); the name goes in the tags (`area`), and an ASCII form of it in the file name.
  In latitude/longitude the cropped grid is reprojected as a whole.
- **A period** (days=7/16/30/365): the composite's layers instead (see **Composites**): TEMPER sig_max (σ),
  temperature_k, m10_max, hot_nights, seen_nights; LIGHT ROAST median_nw, clear_nights. The file's tags give the
  period's days and nights; its name ends in `_<days>d`.

## Coordinates

js/geo.js converts latitude/longitude (WGS84) to and from: UTM (Transverse Mercator by Snyder's series, zone by
longitude, band by latitude); MGRS (UTM with the 100 km square letters, the row letters' 2,000 km repeat resolved by
the latitude band); ITM (EPSG:2039: a Helmert shift to Israel 1993, EPSG:1073's seven parameters, then Transverse
Mercator on GRS80); and the grid (EPSG:6933, Lambert cylindrical equal area, standard parallel 30°). Checked against
PROJ (pyproj) at ten places from Israel to Iran and Yemen: UTM and the grid agree to well under a metre, MGRS round
trips to 1 m (its digits are truncated to the metre), ITM within 2.5 m inside Israel. ITM is shown only around Israel
(29–34° N, 33.5–36.5° E): far from its central meridian the projection means nothing.

## Meaning of the display and time series

- Radiance units: **W m⁻² µm⁻¹ sr⁻¹**. Valid zeros are included.
- Display Min/Max are raw radiance; the default is 0–100. Display colors use an asinh
  stretch, fixed across days unless you change it. This affects the image only. The hover
  readout, the chart and sampling always use full-resolution raw values.
- **Brightness temperature** in the hover readout is the inverse Planck function at the
  M10 band centre (1.61 µm): the temperature of a blackbody filling the whole 750 m pixel
  that would emit the measured radiance. It is not a retrieved surface or flare temperature.
  A sub-pixel gas flare at ~1800 K appears as roughly 480–650 K. Retrieving the source
  temperature and area needs a multi-band Planck fit (as in VIIRS Nightfire). Zero or negative radiance has no
  brightness temperature ("no M10 signal"). Small positive noise reads as about 380–450 K,
  which is not a ground temperature.
- The basemap is Natural Earth 1:110m countries (public domain), bundled in
  `static/basemap/`. At this scale, borders and coasts are approximate to several
  kilometres. They are context only, never a sampling boundary.
- The sampling average includes valid pixel centers inside the square. Missing
  pixels are excluded. Zero valid pixels gives a missing mean, never a fake zero.
- **⚙ → ממוצע המקום רק ממה שבתוך המדינה והשכבות** intersects the square with the union of
  enabled country/user polygons. The basemap is an outline only.
- **רק בתוך המדינה** on the map affects the picture only. It does not
  change the averages unless that setting is on.
- Zeros are mostly clipped negative noise, so the raw mean of a place without sources is positive
  (~0.0035) and changes with the viewing angle. The corrected mean removes that (see **Preprocessing**).
- Clouds are flagged (M15), not removed: a cloudy night stays in the averages, marked in the chart.
  Gridded pixels can repeat native detector measurements;
  the average is descriptive, not an estimate based on independent observations.
- Night labels from country manifests are retained. Source times remain UTC.

Source data are read only. Locally the application binds only to `127.0.0.1`. Every API call must
come from the viewer's own address, and cross-site requests are refused.

## Loading speed

Measured on Saudi Arabia (175 TEMPER nights, 338 LIGHT ROAST nights) and Israel:

| Step | Before | Now |
|---|---|---|
| Opening a country | 76 MB of pass footprints sent; 12 s reading every pass | 57 KB; 0.2–0.6 s |
| The list for a night | LIGHT ROAST recompared the country on every night shown (2–4 s) | read from the stored night: 0.01 s |
| LIGHT ROAST event log | 45 s to 3 min (every event against every other) | 0.7 s (neighbours by place and day) |
| Returning to a night, or the next one | 0.5–5 s to draw the map | drawn ahead and kept: 0.1–0.3 s |
| First pixel read on a LIGHT ROAST night | 2–3 s (the whole comparison, for its calibration) | stored with the night |
| Related places after a restart | 12 s (the regional swing recomputed) | 0.5 s (stored once) |

- **Opening:** the country's response carries each night's pass count only, and passes listed in the inventory are
  not opened.
- **Maps:** the last ~256 MB of maps stay in memory, and after each one the nights either side are drawn in the
  background.
- **Background order:** the stored changes for the list come first, then the related-places blocks, typical lights
  and the stored calibrations of older nights.
- **Related places while new nights arrive:** requests use the blocks already built while the worker builds the new
  ones, instead of waiting a minute for the rebuild.

## What more data would add

The current data cannot answer these; in order of value (M11, M15 and M16 are now in, see above):

1. **M7/M8 and M12/M13.** They are in the same archived granules. M7/M8 would firm up the fit for the hottest
   sources. M12/M13 add cooler sources and allow a two-temperature fit (as VIIRS Nightfire v4 does), once the
   warm ground is subtracted; M15 now gives that ground. M12 minus M15 is also the standard night test for fog
   and low cloud, which the M15-only flag can miss.
2. **The VIIRS cloud mask** (`CLDMSK_L2_VIIRS_SNPP`), to check the M15 flag independently, mainly for thin cirrus.
3. **NOAA-20 and NOAA-21 VIIRS** (`VJ102MOD`, `VJ202MOD` with their geolocation). The same instrument,
   about 50 minutes apart, gives up to three looks a night. The nearest-nadir mosaic gets more nadir
   pixels, nights with gaps fill in, and persistence can be judged within one night.
4. **A full year** (the pull is underway), for steadier persistence statistics.
5. **For validation:** VIIRS Nightfire (Colorado School of Mines) and NASA's 375 m active fires (`VNP14IMG`).

## Checking the rules

`reference/known_cases.json` holds places whose truth is known: what is true there, how it is known, and what the
rules should then say. `check_rules.py` scores the rules against it, using the same functions the viewer uses:

```powershell
& 'C:\Program Files\Python313\python.exe' -B check_rules.py              # every case
& 'C:\Program Files\Python313\python.exe' -B check_rules.py Ashdod        # the cases whose name contains a word
```

Each check prints PASS or FAIL with what the rules said; the exit code is the number of failures. A failure means a
rule disagrees with a known truth: fix the rule, or, if the case was written wrongly, the case. The checks:

| Check | Passes when |
|---|---|
| `event` | the change log has a change near the place starting on the night given (of the kind and cause given) |
| `events_at_most` | no change near the place (in the dates given) is rated above a level, and none has a cause it must not have |
| `profile` | the place's year has the shape, steadiness, activity, consistency, direction and step date given |
| `related` | the related-places question answers as given: where else (one night or a step, up or down) or what moves together, steady, and how unusual nearby |

On 27 Oct 2026 the file holds 7 places in Israel and Saudi Arabia with 15 checks, all passing: the fire east of
Jerusalem, Ashdod's port lights, the flickering light at 20.397 N 45.307 E, Sharurah's September step, Riyadh, Abqaiq
and empty desert. While the viewer's background worker is still storing nights, a change's first night or kind can
move (a light going out reads "off" or "dimmer"): the checks allow for that.

Add a case whenever a place has been looked at closely, above all when a rule got it wrong.
