"""TEMPER and LIGHT ROAST viewer: the HTTP server behind static/ (the page). No remote services; it writes only
its cache and the user's saved areas. Local by default (127.0.0.1). In a container (deploy/openshift) the TEMPER_*
environment variables set the address, data folder, cache folder and accepted host names.

This file, top to bottom:
  settings ............. paths, the open country (DATASET, LIGHTS), the detection's constants, config.json
  event log ............ each night's changes linked into chains: heat, significance, on/off (events)
  saved areas .......... the user's named areas per country, with backups (get_areas, save_areas)
  what moves together .. one place's series against every other's over a period (similar)
  where else ........... the same change at the same time, a lasting step or one night (cooccur, related)
  behaviour search ..... the shape of each place's year, the query line and groups (shapes, behaviour)
  consistency .......... how steady a place is; correlations only where it varies (series_profile)
  area analysis ........ light against heat in one window (area)
  countries ............ outlines, folders and the nights they hold (list_countries, open_dataset)
  Dataset .............. one country's TEMPER data: layers, clouds, samples, hot spots, changes
  map images ........... PNGs of the map, cached and rendered ahead (map_image)
  HTTP ................. the API routes (GET_ROUTES, POST_ROUTES) and the page's files (Handler)
  workers, start-up .... preparing every night in the background (build_worker, lights_worker), main()

The other modules: lightroast.py (LIGHT ROAST: lights, clouds, blocks and changes), bands.py (TEMPER's M11, M15
and M16 bands), evt.py (the extreme-value threshold), rxmethod.py (the RX night-lights method)."""
import os
from pathlib import Path
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from datetime import datetime
import argparse
import hashlib
import glob
import io
import json
import mimetypes
import threading
import math
import re
import time
import warnings
import numpy as np
import rasterio
from scipy import ndimage
import evt
import bands
import lightroast
from rasterio.warp import reproject, Resampling, calculate_default_transform
from rasterio.features import geometry_mask
from rasterio.transform import from_origin
from rasterio.windows import from_bounds, Window
from PIL import Image
from pyproj import Transformer
from shapely.geometry import shape, mapping, box, Polygon
from shapely import transform, segmentize, make_valid, unary_union

# ---------- settings: paths, the open country, and the detection's constants ----------
ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
CACHE = Path(os.environ.get("TEMPER_CACHE") or ROOT / "cache")
CACHE.mkdir(parents=True, exist_ok=True)
HOST = os.environ.get("TEMPER_HOST", "127.0.0.1")
PORT = int(os.environ.get("TEMPER_PORT", "8768"))
# Host names the API answers besides the local address, comma-separated; "*" accepts any (behind an OpenShift route,
# which only forwards its own host). Cross-site requests are refused either way (Origin must match Host).
ALLOWED_HOSTS = {h.strip().lower() for h in os.environ.get("TEMPER_ALLOWED_HOSTS", "").split(",") if h.strip()}
LOCAL_ONLY = True   # set in main(): false when listening beyond the loopback address
BASEMAP = STATIC / "basemap" / "ne_110m_admin_0_countries.geojson"   # bundled, so the background map needs no network
CONFIG = ROOT / "config.json"   # {"data_root": ...}: the folder whose country subfolders the picker shows
DEFAULT_ROOT = Path.home() / "Desktop" / "ARD" / "VIIRS_NIGHT_SWIR"   # without config.json or TEMPER_DATA_ROOT
DEFAULT_LR_ROOT = Path.home() / "Desktop" / "ARD" / "VIIRS_NIGHT_DNB"   # LIGHT ROAST (Black Marble night lights)
LIGHTS = None   # LIGHT ROAST for the open country (lightroast.NightLights), on the same grid as DATASET
LOCK = threading.RLock()
DATASET = None
PRELOADING = False   # opening the last country at start (see preload)
# resolved path -> (folder signature, Dataset): switching back to a country is instant until its files change
DATASETS = {}
NATURAL_EARTH = None
M10_WAVELENGTH_UM = 1.61     # VIIRS M10 nominal band centre (1.58–1.64 µm)
PLANCK_C1 = 1.191042972e8    # 2hc², W µm⁴ m⁻² sr⁻¹
PLANCK_C2 = 1.438776877e4    # hc/k, µm K
# Heimdall's EVTFar of 1e-3 is per pixel: about 3,400 noise pixels a night over a country. Hot spots instead use
# a budget of expected background pixels per country per night: FAR = budget / valid pixels. The fit includes
# the real sources, so the budget is an upper bound. At 100, Saudi Arabia and Iran on 13-20 Oct 2026 gave a
# threshold of 0.049-0.063. The spots kept 96-97% of the sources that repeat on other nights found by a fixed
# 0.05 cut, with about half as many one-night spots. config.json "hot_false_alarms_per_night" overrides it.
HOT_FALSE_ALARMS_PER_NIGHT = 100.0
NOISE_BAND = 5.0   # degrees of view zenith per noise band
LAYERS = "v4"      # nightly layer format; v3 added M11, v4 adds M15/M16 brightness temperature and the pass index
OLDER_LAYERS = ("v3",)   # served (without thermal layers) until the background worker has rebuilt the night
M11_WAVELENGTH_UM = 2.25     # VIIRS M11 nominal band centre (2.225–2.275 µm)
KELVIN_STEP = bands.KELVIN_STEP   # thermal layers: kelvin = stored * KELVIN_STEP, 0 = no data
STEFAN_BOLTZMANN = 5.670374419e-8
# M11 confirmation: a hot spot counts only if M11 is also above its own noise within one pixel, at this per-sample
# false-alarm rate. On Saudi nights 14-20 Oct 2026 it kept all 375 repeating spots of the M10-only list and removed
# 19 of its 53 one-night spots. config.json "hot_m11_confirm_far" overrides it.
HOT_M11_CONFIRM_FAR = 1e-3
HOT_MIN_K = 500.0   # a spot counts as measured when its two-band source temperature is at least this
_T_TABLE = np.linspace(300.0, 5000.0, 20000)


def planck(lam_um, t):
    """Spectral radiance of a blackbody, W m-2 sr-1 um-1."""
    return PLANCK_C1 / lam_um ** 5 / np.expm1(PLANCK_C2 / (lam_um * t))


_R_TABLE = planck(1.61, _T_TABLE) / planck(M11_WAVELENGTH_UM, _T_TABLE)   # rises with temperature


SQRT_2PI = math.sqrt(2 * math.pi)
# Composite image: brightness = combined M10+M11 significance from COMPOSITE_FLOOR to COMPOSITE_TOP sigma (asinh);
# colour = two-band temperature where both bands are at least 10 sigma, on this ramp (K -> RGB).
COMPOSITE_FLOOR, COMPOSITE_TOP = 4.0, 2000.0
# Stops at round Celsius values (700, 1100, 1500, 1900, 2300 °C), which the viewer shows.
TEMPERATURE_RAMP = [(973.15, (190, 30, 20)), (1373.15, (255, 95, 25)), (1773.15, (255, 195, 70)), (2173.15, (255, 248, 205)), (2573.15, (195, 220, 255))]
# Cloud screening with M15 (10.76 µm). At night clear ground is the warmest thing a place shows; cloud tops are
# colder. Reference per pixel: the CLOUD_RANK-th warmest M15 of the night and CLOUD_NIGHTS nights on each side
# (at least CLOUD_MIN_VALID valid). drop = M15 - reference, taken as the median over CLOUD_SMOOTH x CLOUD_SMOOTH
# pixels so a flare's own warming of its pixel (which also raises that pixel's reference) neither fakes nor hides
# cloud. Cloud where drop <= -CLOUD_DROP_K.
# Iran, 172 nights from 17 Apr 2026, 79 steady flares: clear pixels sit 2.5 +- 1.4 K below the reference, cloud
# 20-60 K below. A steady flare was missed on 6% of nights with a drop above -6 K, 25% at -8 to -20 K, 47% at -20 to
# -40 K and 82% beyond. Flagged nights (8 K) were missed 49% of the time against 6.6% when clear. 8 K is where the
# miss rate starts to climb, with margin for humid nights and the colder swath edge.
CLOUD = "c1"
CLOUD_NIGHTS = 10
CLOUD_RANK = 3
CLOUD_MIN_VALID = 7
CLOUD_SMOOTH = 5
CLOUD_DROP_K = 8.0
# Thermal map (band "m15"): fixed range so nights compare; warm ground dark, cold cloud tops white.
THERMAL_LOW_K, THERMAL_HIGH_K = 233.15, 318.15   # -40 to 45 °C
# Temporal change detection: each night against a context window of the CHANGE_CONTEXT nights before it, from a
# small per-night summary (change_state). A context night is informative for a place when it was observed and
# either clear or lit there (a flare seen through cloud is still "on"). Changes, per place:
#   new      lit tonight (M11-confirmed), lit on at most CHANGE_NEW_MAX_FREQ of informative context nights
#   off      lit on at least CHANGE_OFF_MIN_FREQ of them, not lit tonight (within one pixel) although tonight is
#            confidently clear (M15 within CHANGE_CLEAR_K of clear sky) and its usual brightness is at least
#            CHANGE_OFF_MARGIN x tonight's threshold there (so the swath edge's higher threshold is no "off")
#   brighter / dimmer  lit both, the 3x3 sum of corrected radiance at least CHANGE_STEP x / at most 1/CHANGE_STEP
#            of its context median, over at least CHANGE_MIN_LIT lit context nights
# config.json "change_context_nights" overrides the window.
# s2: summaries record the country outline they were built with; s3: and measured source temperatures; s4: measured on the detected pixels alone too
CHANGE = "s4"
CHANGE_WINDOW_RANGE = (7, 60)   # context windows a user may choose
CHANGE_CONTEXT = 14
CHANGE_MIN_INFORMATIVE = 7
CHANGE_NEW_MAX_FREQ = 0.1
CHANGE_OFF_MIN_FREQ = 0.7
CHANGE_CLEAR_K = 4.0
CHANGE_OFF_MARGIN = 2.0
CHANGE_STEP = 3.0
CHANGE_STEP_Z = 3.0      # brighter / dimmer must also be this many robust sd of the place's own log brightness
CHANGE_MIN_LIT = 5
CHANGE_FOLLOW = 5        # for past nights: how the place did on up to this many informative nights after
# Related places: given a place, the places whose night-by-night behaviour moves with it (or against it), by Pearson
# correlation over the nights both were seen, in either product. A pair needs SIMILAR_MIN_NIGHTS common nights and
# |r| >= max(SIMILAR_MIN_R, 4 / sqrt(n)): with thousands of candidates a looser bar would list chance matches. The
# place's own surroundings (SIMILAR_EXCLUDE_KM) are left out: their pixels overlap it.
SIMILAR_MIN_NIGHTS = 20
SIMILAR_MIN_R = 0.3
SIMILAR_EXCLUDE_KM = 3.0
SIMILAR_TOP, SIMILAR_TOP_NEGATIVE = 30, 15
SIMILAR_GROUP_KM = 5.0      # matches this close to a stronger one join it as one place (a city is many blocks)
SIMILAR_SCALE = 0.02        # TEMPER activity is compared as asinh(3x3 corrected M10 sum / this), W m-2 um-1 sr-1
SIMILAR_SITE_NIGHTS = 2     # a TEMPER site: a place detected on at least this many nights


# ---------- settings read from config.json, and small helpers ----------
def rx_enabled():
    """VIIRS_algo's SFAC + RX as a second LIGHT ROAST method (rxmethod.py). Paused by default: no SFAC fitting in the
    background and no method switch; config.json "rx_method": true brings it back."""
    try:
        return bool(json.loads(CONFIG.read_text(encoding="utf-8")).get("rx_method", False))
    except (OSError, ValueError, TypeError):
        return False


def m11_confirm_far():
    try:
        return float(json.loads(CONFIG.read_text(encoding="utf-8")).get("hot_m11_confirm_far", HOT_M11_CONFIRM_FAR))
    except (OSError, ValueError, TypeError):
        return HOT_M11_CONFIRM_FAR


def two_band_temperature(sum10, sum11, sd10, sd11):
    """Temperature of one blackbody source from its M10/M11 radiance ratio (Planck at the band centres), independent
    of how much of the pixel it fills, with its 1-sigma uncertainty from the noise of both sums. None unless both
    bands are at least 10 sigma above noise."""
    if not (sum10 > 10 * sd10 and sum11 > 10 * sd11):
        return None
    ratio = sum10 / sum11
    if not (_R_TABLE[0] < ratio < _R_TABLE[-1]):
        return None
    t = float(np.interp(ratio, _R_TABLE, _T_TABLE))
    rel = math.hypot(sd10 / sum10, sd11 / sum11)
    return t, float(np.interp(ratio * (1 + rel), _R_TABLE, _T_TABLE) - t)


def change_context():
    try:
        return max(CHANGE_MIN_INFORMATIVE, int(json.loads(CONFIG.read_text(encoding="utf-8")).get("change_context_nights", CHANGE_CONTEXT)))
    except (OSError, ValueError, TypeError):
        return CHANGE_CONTEXT


def window_param(q):
    """The context window a request asks for (nights before the shown one), or None for the default."""
    if not q.get("window"):
        return None
    window = int(q["window"][0])
    low, high = CHANGE_WINDOW_RANGE
    if not low <= window <= high:
        raise ValueError(f"חלון ההקשר: {low} עד {high} לילות.")
    return window


def hot_budget():
    if os.environ.get("TEMPER_HOT_BUDGET"):
        return float(os.environ["TEMPER_HOT_BUDGET"])
    try:
        return float(json.loads(CONFIG.read_text(encoding="utf-8")).get("hot_false_alarms_per_night", HOT_FALSE_ALARMS_PER_NIGHT))
    except (OSError, ValueError, TypeError):
        return HOT_FALSE_ALARMS_PER_NIGHT


def bundle_name(recorded):
    """Last component of a bundle path recorded on any machine (Windows or POSIX separators)."""
    return re.split(r"[\\/]", str(recorded).rstrip("\\/"))[-1]


def bundle_path(raw_root, recorded):
    """A year-inventory bundle path, e.g. C:\\...\\raw_data\\VNP02MOD..., found inside this raw_data folder when the
    recorded path does not exist here (a copy on another machine or a mounted volume in a container)."""
    p = Path(recorded)
    return p if p.exists() else Path(raw_root) / bundle_name(recorded)


def brightness_temperature(radiance, wavelength_um=M10_WAVELENGTH_UM):
    """Inverse Planck at a band centre (M10 by default): the temperature of a blackbody filling the whole pixel
    that would emit this radiance. Not a retrieved surface or flare temperature; None without signal."""
    if radiance is None or not radiance > 0:
        return None
    return PLANCK_C2 / (wavelength_um * math.log1p(PLANCK_C1 / (wavelength_um ** 5 * radiance)))


def data_root():
    if os.environ.get("TEMPER_DATA_ROOT"):
        return Path(os.environ["TEMPER_DATA_ROOT"])
    try:
        return Path(json.loads(CONFIG.read_text(encoding="utf-8"))["data_root"])
    except (OSError, ValueError, KeyError):
        return DEFAULT_ROOT


def lightroast_root():
    """LIGHT ROAST's data root (Black Marble country folders named like TEMPER's)."""
    if os.environ.get("TEMPER_LR_ROOT"):
        return Path(os.environ["TEMPER_LR_ROOT"])
    try:
        return Path(json.loads(CONFIG.read_text(encoding="utf-8"))["lightroast_root"])
    except (OSError, ValueError, KeyError):
        return DEFAULT_LR_ROOT


def open_lights(ds):
    """LIGHT ROAST for the country TEMPER has open, on TEMPER's grid and outline; None when there is no such folder."""
    folder = lightroast_root() / ds.root.name
    if not (folder / "raw_data").is_dir():
        return None
    try:
        return lightroast.NightLights(folder, ds.profile, ds.country_mask(), CACHE)
    except (ValueError, OSError) as exc:
        print("LIGHT ROAST unavailable", folder, exc, flush=True)
        return None


def lights_meta():
    L = LIGHTS
    if not L:
        return dict(available=False)
    return dict(available=True, root=str(L.root), dates=L.dates, window=lightroast.DEFAULT_WINDOW, window_range=list(lightroast.WINDOW_RANGE), 
                recent_nights=lightroast.RECENT_NIGHTS, top_nw=lightroast.LIGHTS_TOP_NW, units="nW cm⁻² sr⁻¹", 
                methods=["weekly", "rx"] if rx_enabled() else ["weekly"])


# ---------- event log ----------
# A change is detected night after night while its week differs from its baseline (a light that came on stays "new"
# for weeks in LIGHT ROAST): in Saudi Arabia 65% of a night's changes had already been reported the night before, 2.5
# reports per change over a week. The log links them: the same kind within EVENT_LINK_KM, with gaps of at most
# EVENT_GAP_DAYS, is one event with its first and last night. Each night's changes are stored once (background
# worker) and the log is built from them.
EVENT_LINK_KM, EVENT_GAP_DAYS = 1.5, 7
EVENT_STEADY_SHARE = 0.2      # a TEMPER site burning on at least this share of its nights is a steady flare
EVENT_FLARE_KM, EVENT_FIELD_KM = 2.0, 10.0
EVENT_AREA_KM, EVENT_AREA_MIN, EVENT_AREA_DAYS = 25.0, 5, 2   # changes together in an area (see event_log)
EVENT_OUTAGE_RATIO = 0.5      # an outage: lights out, or below half, together; moderate shifts together are regional
EVENT_WAY = dict(new="up", brighter="up", off="down", dimmer="down")
# intermittent: a night within this share of the step from the old level (or the new one) counts as that level
MIXED_SHARE = 0.35
CAUSES = ("flare", "fire", "field", "outage", "regional", "lighting")


def _round(v, n=4):
    return round(float(v), n) if isinstance(v, (int, float, np.floating)) and math.isfinite(float(v)) else v


def compact(e, keep):
    return {k: (_round(e[k]) if k not in ("lonlat",) else [round(float(e[k][0]), 5), round(float(e[k][1]), 5)]) for k in keep if k in e}


TEMPER_KEEP = ("kind", "x", "y", "lonlat", "value", "threshold", "ratio", "usual", "lit_nights", "informative_nights", "pixels")
LIGHT_KEEP = ("kind", "x", "y", "lonlat", "before_nw", "after_nw", "ratio", "z", "pixels", "area_km2", "holds", "heat", "moon")


def store_path(product, d):
    """Where one night's changes (default window) are stored."""
    if product == "temper":
        return DATASET._v2(d, f"events.{CHANGE}.w{change_context()}.json")
    return LIGHTS._path(d, f"events.w{lightroast.DEFAULT_WINDOW}.json")


def night_events(product, d, build=True):
    """One night's changes (default window) from the store, built and stored when missing."""
    ds, L = DATASET, LIGHTS
    path = store_path(product, d)
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except ValueError:
            pass
    if not build:
        return None
    try:
        if product == "temper":
            if not ds.state_possible(d) or ds.change_state(d, build=False) is None:
                return None   # its summary is not ready yet
            r = ds.changes(d)
            out = dict(date=d, events=[compact(e, TEMPER_KEEP) for e in r["events"]])
        else:
            if not L.ready(d):
                return None
            r = annotate_heat(L.changes(d, lightroast.DEFAULT_WINDOW, ds.to_lonlat), ds)
            out = dict(date=d, events=[compact(e, LIGHT_KEEP) for e in r["events"]], glow=len(r.get("moonlit_removed", [])))
    except ValueError as exc:   # too few nights before it: stored, so it is not retried
        out = dict(date=d, events=[], error=str(exc))
    temp = path.with_name(path.name + ".partial")
    temp.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    temp.replace(path)
    return out


def steady_sites():
    """TEMPER sites burning on at least EVENT_STEADY_SHARE of their nights: x, y arrays, and the share."""
    A = DATASET.activity()
    if not len(A["sites"]):
        return np.zeros(0), np.zeros(0), np.zeros(0)
    seen = np.isfinite(A["Y"]).sum(1)
    share = (A["Y"] > 0).sum(1) / np.maximum(seen, 1)
    keep = share >= EVENT_STEADY_SHARE
    rows, cols = np.divmod(A["sites"][keep], DATASET.profile["width"])
    x, y = DATASET.profile["transform"] * (cols + .5, rows + .5)
    return np.asarray(x), np.asarray(y), share[keep]


def event_strength(e, product):
    """How strong one night's detection is: LIGHT ROAST |z|; TEMPER the brightness over the night's threshold (for
    lights out, the usual brightness), else the size of the step."""
    if product != "temper":
        return abs(e.get("z") or 0)
    v = e.get("usual") if e["kind"] == "off" else e.get("value")
    if v is not None and e.get("threshold"):
        return float(v) / float(e["threshold"])
    return abs(math.log(e["ratio"])) if e.get("ratio") else 0.0


_EVENT_CACHE = {}   # product -> the linked log
# Heat at a light change: TEMPER detected a source (a detection itself, not the pixels next to one) within HEAT_PX
# pixels on at least HEAT_NIGHTS of the change's week, or measured a temperature there once. Before, any detection or
# its neighbours within 2 pixels on any of the ~35 nights compared counted: at Ashdod (31.852 N 34.655 E) one weak,
# unconfirmed detection weeks before made a one-night dip of a port light a "fire".
HEAT_PX, HEAT_NIGHTS = 2, 2
# (dataset object, night) -> TEMPER's detections that night grown by HEAT_PX: (detected cells, measured cells)
_HEAT = {}


def heat_cells(d):
    ds, key = DATASET, (id(DATASET), d)
    if key not in _HEAT:
        st = None
        if d in ds.days:
            try:
                st = ds.change_state(d, build=False) or ds._older_state(d)
            except (OSError, ValueError, KeyError):
                st = None
        cells = None
        if st is not None:
            W, H = ds.profile["width"], ds.profile["height"]

            def grow(idx):
                if not len(idx):
                    return np.zeros(0, np.int64)
                r, c = np.divmod(np.asarray(idx, np.int64), W)
                parts = [((r + a) * W + c + b)[(r + a >= 0) & (r + a < H) & (c + b >= 0) & (c + b < W)]
                         for a in range(-HEAT_PX, HEAT_PX + 1) for b in range(-HEAT_PX, HEAT_PX + 1)]
                return np.unique(np.concatenate(parts))
            core = st["idx"][np.asarray(st["core"], bool)]
            measured = st["idx"][np.asarray(st["measured"], bool)] if "measured" in st else st["idx"][:0]
            cells = (grow(core), grow(measured))
        _HEAT[key] = cells
    return _HEAT[key]


def heat_at(d, xs, ys):
    """LIGHT ROAST night d: for changes at (xs, ys), on how many of the week's nights (the 7 ending at d) TEMPER detected
    a source within HEAT_PX pixels, on how many it measured a temperature there, and how many of those nights it has."""
    ds, L = DATASET, LIGHTS
    T, W = ds.profile["transform"], ds.profile["width"]
    cols, rows = ~T * (np.asarray(xs, float), np.asarray(ys, float))
    p = rows.astype(np.int64) * W + cols.astype(np.int64)
    heat, measured, n = np.zeros(len(p), np.int32), np.zeros(len(p), np.int32), 0
    for night in L.periods(d, lightroast.DEFAULT_WINDOW)[0]:
        cells = heat_cells(night)
        if cells is None:
            continue
        n += 1
        heat += np.isin(p, cells[0])
        measured += np.isin(p, cells[1])
    return heat, measured, n
EVENT_STALE_S = 30   # while the background worker is still storing nights, the log is relinked at most this often


def event_log(product, need=None):
    """Every event of a product over the stored nights: (log, nights stored, nights). log: chains (the events),
    index ((night, i) -> its event), nights (the nights linked). Relinked when more nights are stored: at most every
    EVENT_STALE_S seconds while the background worker is adding them, and at once when `need` (a night) is stored but
    not yet linked."""
    ds, L = DATASET, LIGHTS
    nights = ds.dates if product == "temper" else L.dates
    stored = [d for d in nights if store_path(product, d).exists()]
    key = (ds.id, tuple(stored))
    cached = _EVENT_CACHE.get(product)
    if cached and cached["key"][0] == ds.id and (cached["key"] == key or (
            time.time() - cached["at"] < EVENT_STALE_S and (need is None or need in cached["nights"] or need not in stored))):
        return cached, len(stored), len(nights)
    link = EVENT_LINK_KM * 1000
    chains, active, index, linked, heats = [], {}, {}, set(), {}   # active: (kind, cell) -> chains seen recently
    for d in stored:
        r = night_events(product, d, build=False)
        if r is None:
            continue
        linked.add(d)
        day = datetime.fromisoformat(d).toordinal()
        evs = r.get("events", [])
        if product == "lightroast" and evs:
            hh, hm, hn = heat_at(d, [e["x"] for e in evs], [e["y"] for e in evs])
        for i, e in enumerate(evs):
            hot = measured = False
            if product == "lightroast":
                heats[(d, i)] = (int(hh[i]), int(hm[i]), hn)
                hot, measured = bool(hh[i] >= HEAT_NIGHTS or hm[i] >= 1), bool(hm[i] >= 1)
            # Linked by direction, not kind: a source going out reads "off" on its own pixel and "dimmer" on the one
            # next to it (Saudi Arabia, 20.397 N 45.307 E, 18 Oct 2026): one event, of its strongest night's kind.
            cell, way = (int(e["x"] // link), int(e["y"] // link)), EVENT_WAY[e["kind"]]
            found = None
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for c in active.get((way, cell[0] + dx, cell[1] + dy), []):
                        if day - c["last_day"] <= EVENT_GAP_DAYS and math.hypot(c["x"] - e["x"], c["y"] - e["y"]) < link:
                            found = c
                            break
                    if found:
                        break
                if found:
                    break
            strength = event_strength(e, product)
            if found is None:
                found = dict(kind=e["kind"], onset=d, onset_day=day, first=e["lonlat"], x=e["x"], y=e["y"], lonlat=e["lonlat"], nights=0, peak=-1, heat=0, best=None, last=None, hot=set(), measured=set())
                chains.append(found)
                active.setdefault((way,) + cell, []).append(found)
            index[(d, i)] = found
            if found["last"] != d:   # two detections of one night count once
                found["nights"] += 1
            if hot:
                found["hot"].add(d)
            if measured:
                found["measured"].add(d)
            found["last"], found["last_day"] = d, day
            if strength > found["peak"]:
                found.update(peak=strength, best=e, kind=e["kind"], x=e["x"], y=e["y"], lonlat=e["lonlat"])
    for c in chains:   # heat: the nights it had heat (see HEAT_PX), and those with a measured temperature
        c["heat"], c["heat_measured"] = len(c.pop("hot")), len(c.pop("measured"))
    # cause: what the two products together say each event is
    sx, sy, share = steady_sites()
    for c in chains:
        near = np.hypot(sx - c["x"], sy - c["y"]) / 1000 if len(sx) else np.array([np.inf])
        if product == "temper":
            c["cause"] = "flare" if near.min() <= EVENT_FLARE_KM else "fire"
        elif c["heat"]:
            c["cause"] = "flare" if near.min() <= EVENT_FLARE_KM else "fire"
        elif near.min() <= EVENT_FIELD_KM:
            c["cause"] = "field"
        else:
            c["cause"] = "lighting"
    # Changes together in an area: lights out (or below half) together is an outage; moderate dimming or brightening
    # together is regional, most likely haze or weather (on partly clouded nights even clear cells read 17-27% low).
    # Neighbours are looked up in cells of EVENT_AREA_KM by onset day: comparing every event with every other took
    # minutes for Saudi Arabia's lights (226 million pairs).
    grouped = [c for c in chains if c["cause"] == "lighting"]
    area = EVENT_AREA_KM * 1000
    cells = {}
    for c in grouped:
        cells.setdefault((int(c["x"] // area), int(c["y"] // area), c["onset_day"]), []).append(c)
    for c in grouped:
        down = c["kind"] in ("off", "dimmer")
        gx, gy, crowd = int(c["x"] // area), int(c["y"] // area), 0
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for dd in range(-EVENT_AREA_DAYS, EVENT_AREA_DAYS + 1):
                    for o in cells.get((gx + dx, gy + dy, c["onset_day"] + dd), ()):
                        if o is not c and (o["kind"] in ("off", "dimmer")) == down and math.hypot(o["x"] - c["x"], o["y"] - c["y"]) < area:
                            crowd += 1
                    if crowd >= EVENT_AREA_MIN:
                        break
                if crowd >= EVENT_AREA_MIN:
                    break
            if crowd >= EVENT_AREA_MIN:
                break
        if crowd >= EVENT_AREA_MIN:
            deep = c["kind"] == "off" or (c["best"] or {}).get("ratio", 1) <= EVENT_OUTAGE_RATIO
            c["cause"] = "outage" if down and deep else "regional"
    end = datetime.fromisoformat(stored[-1]).toordinal() if stored else None
    for c in chains:
        c["status"] = "ongoing" if end and end - c["last_day"] <= 2 else "ended"
        # by where it was first seen: the peak, and so the place shown, can move as the event goes on
        c["id"] = f"{c['kind']}:{c['onset']}:{c['first'][0]:.3f}:{c['first'][1]:.3f}"
    log = dict(key=key, at=time.time(), chains=chains, index=index, nights=linked, heats=heats)
    _EVENT_CACHE[product] = log
    return log, len(stored), len(nights)


def public(c):
    """An event as sent to the viewer: its strongest night's numbers as detail."""
    out = {k: v for k, v in c.items() if k not in ("best", "first", "onset_day", "last_day")}
    out["detail"] = c["best"]
    return out


def night_info(product, d, store):
    """What one night was compared with, for the list's context line."""
    out = dict(error=(store or {}).get("error"))
    if product == "temper":
        out["context"] = len(DATASET._context(d, change_context(), build=False)) if d in DATASET.dates else 0
        return out
    out.update(glow=(store or {}).get("glow", 0), moon=float(lightroast.moon_light([d])[0]))
    s = LIGHTS.night_summary(d, lightroast.DEFAULT_WINDOW)
    if s:
        out.update(s)
    return out


SIG_RARE, SIG_COMMON = 0.02, 0.08   # how often a place swings like this: rare at most this share of weeks, common above
_SIG = {}   # (lights object, event id, pixel) -> the place's history for that change


def significance(product, items, limit=1500):
    """How much a change stands out, as a level (sig.level: strong, medium, weak) with what it rests on.
    LIGHT ROAST: the place's own year. Every night's week (the 7 days to it) against the 4 weeks before it, at the
    change's pixel; p = the share of the other weeks (outside the change and the 5 weeks after it) with a swing in the
    same direction at least 0.8 of this one's. Strong: p <= SIG_RARE and seen on 2+ nights (or |z| >= 10). Weak: p >
    SIG_COMMON, or one night, one pixel and |z| < 8. Medium otherwise, and at most medium for a change of 1-2 nights
    that was gone the week after (holds false). The first `limit` items only (a long list is read from the top).
    TEMPER: strong when seen on 3+ nights or at least 3x the detection threshold; weak when one night under 1.5x."""
    if product == "temper":
        for e in items:
            k, n = e.get("strength") or e.get("peak") or 0, e.get("nights") or 1
            e["sig"] = dict(level="strong" if n >= 3 or k >= 3 else "weak" if n == 1 and k < 1.5 else "medium", times=round(float(k), 2))
        return
    L, T = LIGHTS, DATASET.profile["transform"]
    items = items[:limit]
    if not items:
        return
    cols, rows = ~T * (np.array([e["x"] for e in items], float), np.array([e["y"] for e in items], float))
    keys = [(id(L), e["id"], int(r), int(c)) for e, r, c in zip(items, rows, cols)]
    todo = [k for k, key in enumerate(keys) if key not in _SIG]
    if todo:
        nights = [d for d in L.dates if L.ready(d)]
        o = np.array([_ord(d) for d in nights])
        rr, cc = rows[todo].astype(int), cols[todo].astype(int)
        V = np.log(np.maximum(np.stack([np.asarray(L.layer(d))[rr, cc].astype(np.float32) for d in nights], 1), 0) + 1)
        D = np.full(V.shape, np.nan, np.float32)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            for j, t in enumerate(o):
                week, base = (o > t - 7) & (o <= t), (o > t - 35) & (o <= t - 7)
                if week.sum() >= 3 and base.sum() >= 8:
                    D[:, j] = np.nanmedian(V[:, week], 1) - np.nanmedian(V[:, base], 1)
        for row, k in enumerate(todo):
            e = items[k]
            sign = 1 if EVENT_WAY[e["kind"]] == "up" else -1
            on, last = _ord(e["onset"]), _ord(e["last"])
            inside, other = (o >= on) & (o <= last + 3), (o < on - 7) | (o > last + 35)
            mine, ref = sign * D[row, inside], sign * D[row, other]
            mine, ref = mine[np.isfinite(mine)], ref[np.isfinite(ref)]
            swing = float(mine.max()) if len(mine) else float("nan")
            _SIG[keys[k]] = dict(p=round(float((ref >= 0.8 * swing).mean()), 3), swing=round(swing, 3), weeks=int(len(ref))) \
                if len(ref) >= 30 and np.isfinite(swing) and swing > 0 else dict(p=None, swing=None, weeks=int(len(ref)))
    for e, key in zip(items, keys):
        h = dict(_SIG[key])
        b, n = e.get("detail") or {}, e.get("nights") or 1
        z, px = abs(b.get("z") or 0), b.get("pixels") or 1
        p = h["p"]
        if p is not None and p <= SIG_RARE and (n >= 2 or z >= 10):
            level = "strong"
        elif (p is not None and p > SIG_COMMON) or (n == 1 and px <= 1 and z < 8):
            level = "weak"
        else:
            level = "medium"
        if level == "strong" and n <= 2 and b.get("holds") is not None and not b.get("holds"):
            level = "medium"   # rare here, but gone within days
        e["sig"] = dict(h, level=level, z=round(z, 1), nights=n, holds=b.get("holds"))


def mixed_week(d, items):
    """LIGHT ROAST: mark the changes whose week ending at night d was mixed rather than a step (pattern
    "intermittent"): a source that goes on and off. At each change's strongest pixel, the level before is its median
    over the baseline nights and the level now its median over the week. A night reads as one of the two when within
    MIXED_SHARE of the step from it; mixed when both have at least 2 of the week's nights and the level turns at least
    twice (a step within the week turns once). Steps of at least x2 only.
    Saudi Arabia, 20.397 N 45.307 E: ~15 nW until 4 Oct 2026, off 15-19 Oct, back on 21-22 Oct, off 23-24 Oct, read
    as "off" by the week's median."""
    L, T = LIGHTS, DATASET.profile["transform"]
    if not items:
        return
    recent, before = L.periods(d, lightroast.DEFAULT_WINDOW)
    recent, before = [n for n in recent if L.ready(n)], [n for n in before if L.ready(n)]
    if len(recent) < 4 or len(before) < 4:
        return
    cols, rows = ~T * (np.array([e["x"] for e in items]), np.array([e["y"] for e in items]))
    rows, cols = rows.astype(int), cols.astype(int)
    take = lambda nights: np.log(np.maximum(np.stack([np.asarray(L.layer(n))[rows, cols].astype(np.float32) for n in nights]), 0) + 1)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        now, then = take(recent), take(before)
        a, b = np.nanmedian(now, 0), np.nanmedian(then, 0)
    for k, e in enumerate(items):
        step = abs(a[k] - b[k])
        if not np.isfinite(step) or step < math.log(2):
            continue
        y = now[:, k][np.isfinite(now[:, k])]   # the week's nights in order
        level = np.where(np.abs(y - b[k]) <= MIXED_SHARE * step, 0, np.where(np.abs(y - a[k]) <= MIXED_SHARE * step, 1, -1))
        level = level[level >= 0]
        old, new, turns = int((level == 0).sum()), int((level == 1).sum()), int((np.diff(level) != 0).sum())
        e["week"] = dict(old=old, new=new, nights=int(len(y)), turns=turns)
        if old >= 2 and new >= 2 and turns >= 2:   # one turn is a step within the week; two or more, on and off
            e["pattern"] = "intermittent"


def events(q):
    """The events of a product: those seen on one night (night=), each with that night's detection (its
    place and numbers then), strongest first; or those overlapping [from, to], most significant first. A night not
    stored yet is computed and stored now (TEMPER ~0.5 s, LIGHT ROAST 2-4 s)."""
    product = q.get("product", ["temper"])[0]
    if product not in ("temper", "lightroast") or (product == "lightroast" and not LIGHTS):
        raise ValueError("מוצר לא מוכר.")
    night = q.get("night", [""])[0]
    lo, hi = q.get("from", [""])[0] or "", q.get("to", [""])[0] or "9999"
    store = night_events(product, night) if night else None
    log, ready, total = event_log(product, need=night if store is not None else None)
    out = []
    if night:
        seen = {}   # one row per event: its strongest detection that night
        for i, e in enumerate((store or {}).get("events", [])):
            c = log["index"].get((night, i))
            item = public(c) if c else dict(onset=night, last=night, nights=1, cause=None, status="ongoing", heat=int(bool(e.get("heat"))), 
                                            id=f"{e['kind']}:{night}:{e['lonlat'][0]:.3f}:{e['lonlat'][1]:.3f}")
            if product == "lightroast" and (night, i) in log["heats"]:
                h = log["heats"][(night, i)]
                e = dict(e, heat=h[0], heat_measured=h[1], heat_nights=h[2])
            item.update(kind=e["kind"], x=e["x"], y=e["y"], lonlat=e["lonlat"], detail=e, strength=event_strength(e, product))
            if item["id"] not in seen or item["strength"] > seen[item["id"]]["strength"]:
                seen[item["id"]] = item
        out = sorted(seen.values(), key=lambda e: -e["strength"])
        if product == "lightroast":
            mixed_week(night, out)
    else:
        for c in log["chains"]:
            if c["last"] < lo or c["onset"] > hi:
                continue
            out.append(public(c))
        out.sort(key=lambda e: -e["peak"] * (e["nights"] ** .5))
        if product == "lightroast" and hi in LIGHTS.dates:
            mixed_week(hi, [e for e in out if e["last"] == hi])
    significance(product, out)
    pending = lambda e: (e.get("detail") or {}).get("moon") == "pending"
    kinds = ("new", "off", "brighter", "dimmer")
    counts = {k: sum(1 for e in out if e["kind"] == k and not pending(e)) for k in kinds}
    waiting = {k: sum(1 for e in out if e["kind"] == k and pending(e)) for k in kinds}
    causes = {k: sum(1 for e in out if e.get("cause") == k) for k in CAUSES}
    return dict(product=product, night=night or None, events=out, ready=ready, total=total, counts=counts, pending=waiting, causes=causes, 
                intermittent=sum(1 for e in out if e.get("pattern") == "intermittent"), 
                levels={k: sum(1 for e in out if (e.get("sig") or {}).get("level") == k) for k in ("strong", "medium", "weak")}, 
                info=night_info(product, night, store) if night else None, 
                method="Each night's changes (default window) linked across nights: the same direction within %g km, gaps of at most %d days. "
                       "cause: flare = TEMPER heat on it and a steady TEMPER site (burning on >= %d%% of its nights) within %g km; "
                       "fire = heat without one; field = no heat, a steady site within %g km; with %d+ others of the same direction within %g km "
                       "starting within %d days: outage = lights out or below x%g, regional = the rest (haze, weather); lighting = the rest."
                       % (EVENT_LINK_KM, EVENT_GAP_DAYS, EVENT_STEADY_SHARE * 100, EVENT_FLARE_KM, EVENT_FIELD_KM, EVENT_AREA_MIN, EVENT_AREA_KM, EVENT_AREA_DAYS, EVENT_OUTAGE_RATIO))


def sites():
    """Steady TEMPER flare sites, for the map's context layer."""
    sx, sy, share = steady_sites()
    out = []
    for x, y, s in zip(sx, sy, share):
        lon, lat = DATASET.to_lonlat.transform(float(x), float(y))
        out.append(dict(x=float(x), y=float(y), lonlat=[lon, lat], share=round(float(s), 3)))
    return dict(sites=out, steady_share=EVENT_STEADY_SHARE)


# ---------- saved areas: the user's named areas, per country ----------
AREAS_HISTORY = 30   # earlier versions of each country's areas kept in user_areas/history
# the user's named areas, per country, outside the cache (tests point this elsewhere)
AREAS = Path(os.environ.get("TEMPER_USER_AREAS") or Path(__file__).resolve().parent / "user_areas")


def areas_path():
    return AREAS / f"{DATASET.root.name}.json"


def get_areas():
    """The user's areas for the open country (see save_areas)."""
    try:
        return dict(areas=json.loads(areas_path().read_text(encoding="utf-8")).get("areas", []))
    except (OSError, ValueError):
        return dict(areas=[])


def save_areas(body):
    """Replace the open country's areas. Each: id, name (the user's), kind ("window": a square of size_km around
    center; "polygon": geometry, a GeoJSON polygon in the grid's projection), center [x, y], size_km, created."""
    if body.get("country") != DATASET.root.name:   # the open country may have changed since the page loaded its areas
        raise ValueError("האזורים לא נשמרו: הם של %s, והמדינה הפתוחה היא %s. בחרו אותה שוב." % (body.get("country") or "מדינה אחרת", DATASET.root.name))
    areas = body.get("areas")
    if not isinstance(areas, list) or len(areas) > 200:
        raise ValueError("רשימת אזורים לא תקינה.")
    out = []
    for a in areas:
        kind = a.get("kind")
        if kind not in ("window", "polygon"):
            raise ValueError("סוג אזור לא מוכר.")
        item = dict(id=str(a["id"])[:40], name=str(a.get("name") or "")[:80], kind=kind, 
                    center=[float(a["center"][0]), float(a["center"][1])], size_km=float(a["size_km"]), created=str(a.get("created", ""))[:32])
        if kind == "polygon":
            g = a.get("geometry") or {}
            ring = g.get("coordinates", [[]])[0]
            if g.get("type") != "Polygon" or not 4 <= len(ring) <= 5000:
                raise ValueError("פוליגון לא תקין.")
            item["geometry"] = dict(type="Polygon", coordinates=[[[float(p[0]), float(p[1])] for p in ring]])
        out.append(item)
    AREAS.mkdir(exist_ok=True)
    path = areas_path()
    # The previous list is kept before every save (the last AREAS_HISTORY per country, in user_areas/history), so a
    # save that loses areas can be undone: on 26 Oct 2026 one test's clean-up and one empty save each erased a list.
    if path.exists():
        history = AREAS / "history"
        history.mkdir(exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        (history / f"{DATASET.root.name}.{stamp}.json").write_bytes(path.read_bytes())
        for old in sorted(history.glob(f"{glob.escape(DATASET.root.name)}.*.json"))[:-AREAS_HISTORY]:
            old.unlink(missing_ok=True)
    temp = path.with_name(path.name + ".partial")
    temp.write_text(json.dumps(dict(areas=out), ensure_ascii=False, indent=1), encoding="utf-8")
    temp.replace(path)
    return dict(areas=out)


# ---------- what moves together: one place's series against every other's, over a period ----------
def correlate(seed, Y, min_nights=SIMILAR_MIN_NIGHTS):
    """Pearson r of the seed series against each row of Y over their common finite nights, and the count."""
    M = np.isfinite(Y) & np.isfinite(seed)[None]
    n = M.sum(1)
    s = np.where(M, seed[None], 0).astype(np.float32)
    y = np.where(M, Y, 0).astype(np.float32)
    ms, my = s.sum(1) / np.maximum(n, 1), y.sum(1) / np.maximum(n, 1)
    s = np.where(M, s - ms[:, None], 0)
    y = np.where(M, y - my[:, None], 0)
    den = np.sqrt((s * s).sum(1) * (y * y).sum(1))
    with np.errstate(invalid="ignore", divide="ignore"):
        r = np.where(den > 0, (s * y).sum(1) / den, np.nan)
    r[n < min_nights] = np.nan
    return r, n


def _check_products(*products):
    for p in products:
        if p not in ("temper", "lightroast"):
            raise ValueError("מוצר לא מוכר.")
        if p == "lightroast" and not LIGHTS:
            raise ValueError("אין נתוני אורות למדינה הזו.")


def seed_series(product, x, y, size_km=None, regional=False):
    """A place's residual series in one product, as {date: value}, with its centre and what it was made of.
    A window (size_km): TEMPER, the mean residual of the detected sites inside it (none inside: the nearest site
    within EVENT_FLARE_KM, as the change list names a flare); LIGHT ROAST, the mean residual of the lit blocks inside
    it (else its centre block, if lit). A point: the nearest site, or the block holding it."""
    ds, L = DATASET, LIGHTS
    T, W = ds.profile["transform"], ds.profile["width"]
    half = size_km * 500 if size_km else None
    if product == "temper":
        A = ds.activity()
        if half:
            rows, cols = np.divmod(A["sites"], W)
            px, py = T * (cols + .5, rows + .5)
            px, py = np.asarray(px), np.asarray(py)
            inside = np.flatnonzero((np.abs(px - x) <= half) & (np.abs(py - y) <= half))
            extra = {}
            if not inside.size:
                # A flare's heat reaches the pixels around it on its strong nights, and the change list marks the
                # change where it grew most: often a pixel or two from the flare, with the flare outside a small window.
                d = np.hypot(px - x, py - y)
                if not d.size or d.min() > EVENT_FLARE_KM * 1000:
                    raise ValueError("בחלון, ועד %g ק״מ ממרכזו, אין מקור חום ש־TEMPER זיהה בשני לילות לפחות." % EVENT_FLARE_KM)
                inside = np.array([int(np.argmin(d))])
                extra = dict(nearest_km=round(float(d[inside[0]]) / 1000, 1))
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", RuntimeWarning)
                series = np.nanmean(A["R"][inside], 0)
            return dict(zip(A["dates"], series)), (x, y), dict(sites=int(inside.size), detected_nights=int(np.sum(np.nansum(A["Y"][inside], 0) > 0)),
                                                               observed_nights=int(np.isfinite(A["Y"][inside]).any(0).sum()), **extra)
        i = ds.activity_site(x, y)
        row, col = divmod(int(A["sites"][i]), W)
        return dict(zip(A["dates"], A["R"][i])), tuple(T * (col + .5, row + .5)), dict(sites=1, detected_nights=int(np.sum(A["Y"][i] > 0)), 
                                                                                     observed_nights=int(np.isfinite(A["Y"][i]).sum()))
    B = L.blocks()
    if half:
        bx, by = L.block_centres(B["blocks"])
        inside = np.flatnonzero((np.abs(np.asarray(bx) - x) <= half) & (np.abs(np.asarray(by) - y) <= half))
        if inside.size:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", RuntimeWarning)
                series = np.nanmean((B["R"] if regional else B["RL"])[inside], 0)
                level = float(np.nanmedian(np.exp(B["Y"][inside].astype(np.float32)) - 1))
            return dict(zip(B["dates"], series)), (x, y), dict(blocks=int(inside.size), median_nw=level)
    col, row = ~T * (x, y)
    series, centre, level = L.block_series(int(row), int(col))
    if level < lightroast.LIT_NW:
        raise ValueError("המקום חשוך מדי (ברוב הלילות פחות מ־%g nW): מה שמשתנה בו הוא בעיקר רעש החיישן ושארית אור ירח, ואין מה להשוות. בחרו מקום מואר." % lightroast.LIT_NW)
    if not regional:
        series = L.regional_at(int(row), int(col), series)
    return dict(zip(B["dates"], series)), (centre if not half else (x, y)), dict(blocks=1, median_nw=level)


def candidates(product, regional=False):
    """Every candidate place of a product: dates, residual matrix, centres and a per-place note."""
    ds, L = DATASET, LIGHTS
    T, W = ds.profile["transform"], ds.profile["width"]
    if product == "temper":
        A = ds.activity()
        rows, cols = np.divmod(A["sites"], W)
        px, py = T * (cols + .5, rows + .5)
        return A["dates"], A["R"], np.asarray(px), np.asarray(py), lambda k, used: dict(detected_nights=int(np.sum(A["Y"][k, used] > 0)))
    B = L.blocks()
    px, py = L.block_centres(B["blocks"])

    def note(k, used):
        v = B["Y"][k, used].astype(np.float32)
        return dict(median_nw=float(np.nanmedian(np.exp(v) - 1)) if np.isfinite(v).any() else None)
    return B["dates"], B["R"] if regional else B["RL"], np.asarray(px), np.asarray(py), note


def match(seed, centre, product, lo, hi, regional=False, half=None, top=SIMILAR_TOP, top_negative=SIMILAR_TOP_NEGATIVE):
    """The places of `product` whose series move with the seed (or against it) over [lo, hi]."""
    ds = DATASET
    dates, Y, px, py, note = candidates(product, regional)
    used = [j for j, d in enumerate(dates) if lo <= d <= hi and d in seed and np.isfinite(seed[d])]
    sv = np.array([seed[dates[j]] for j in used], np.float32)
    if len(used) < SIMILAR_MIN_NIGHTS or not np.nanstd(sv) > 0:
        raise ValueError("למקום הזה אין מספיק לילות עם ערך בתקופה הזו (צריך %d לפחות) כדי לחפש התאמות." % SIMILAR_MIN_NIGHTS)
    sx, sy = centre
    r, n = correlate(sv, Y[:, used])
    use = variable_rows(product)
    r[~use] = np.nan   # steady places, and heat sites almost never lit, match only through noise
    dist = np.hypot(px - sx, py - sy) / 1000
    margin = SIMILAR_EXCLUDE_KM * 1000 + (half or 0)   # the place itself, and (for a window) everything inside it
    r[(np.abs(px - sx) < margin) & (np.abs(py - sy) < margin)] = np.nan
    bar = np.maximum(SIMILAR_MIN_R, 4 / np.sqrt(np.maximum(n, 1)))
    ok = np.isfinite(r) & (np.abs(r) >= bar)

    def item(k, members):
        lon, lat = ds.to_lonlat.transform(float(px[k]), float(py[k]))
        return dict(x=float(px[k]), y=float(py[k]), lonlat=[lon, lat], r=float(r[k]), nights=int(n[k]), distance_km=round(float(dist[k]), 1), 
                    places=members, **note(k, used))

    def pick(order, limit):
        """Strongest first; a match within SIMILAR_GROUP_KM of one already listed joins it."""
        chosen = []
        for k in order:
            near = next((c for c in chosen if math.hypot(px[k] - px[c[0]], py[k] - py[c[0]]) < SIMILAR_GROUP_KM * 1000), None)
            if near:
                near[1] += 1
            elif len(chosen) < limit:
                chosen.append([k, 1])
        return [item(k, m) for k, m in chosen]
    return dict(target=product, nights=len(used), first=dates[used[0]], last=dates[used[-1]], candidates=int(use.sum()), places=int(Y.shape[0]), 
                positive=pick([k for k in np.argsort(-np.nan_to_num(r, nan=-9)) if ok[k] and r[k] > 0], top), 
                negative=pick([k for k in np.argsort(np.nan_to_num(r, nan=9)) if ok[k] and r[k] < 0], top_negative))


SIMILAR_METHOD = ("Pearson r over the nights both were seen, in [from, to]; kept where n >= %d and |r| >= max(%g, 4/sqrt(n)); "
                  "places within %g km of the seed (or inside its window) left out. TEMPER: detected sites, asinh(3x3 corrected M10 "
                  "sum / %g), 0 on clear nights without a detection, standardised per site, less the night's median over sites and "
                  "the site's median for its day of the 16-day cycle. LIGHT ROAST: lit 2.25 km blocks, log(radiance + 1) less the "
                  "night's country-wide median, the block's median for its day of the 16-day cycle, its own response to moonlight and "
                  "(unless regional) the regional swing within ~%g km."
                  % (SIMILAR_MIN_NIGHTS, SIMILAR_MIN_R, SIMILAR_EXCLUDE_KM, SIMILAR_SCALE, lightroast.REGIONAL_KM))


def similar(body):
    """Places related to one place (a point, or a window with size_km): its series in one product (seed) against every
    candidate place's in one product (target), over the chosen period."""
    ds = DATASET
    x, y = float(body["x"]), float(body["y"])
    size = float(body["size_km"]) if body.get("size_km") else None
    seed_p, target_p = body.get("seed", "temper"), body.get("target") or body.get("seed", "temper")
    _check_products(seed_p, target_p)
    lo, hi = body.get("from") or "", body.get("to") or "9999"
    regional = bool(body.get("regional"))   # LIGHT ROAST: keep the regional swing (wide events such as large outages)
    seed, (sx, sy), info = seed_series(seed_p, x, y, size, regional)
    profile = series_profile(seed, seed_p, info)
    lon, lat = ds.to_lonlat.transform(sx, sy)
    quiet = quiet_reason(profile, seed_p)
    if quiet:
        return dict(target=target_p, stable=True, message=quiet, profile=profile, positive=[], negative=[], nights=0, candidates=0, 
                    seed=dict(x=sx, y=sy, lonlat=[lon, lat], product=seed_p, size_km=size, **info), regional=regional, method=SIMILAR_METHOD)
    result = match(seed, (sx, sy), target_p, lo, hi, regional, half=size * 500 if size else None)
    return dict(result, profile=profile, seed=dict(x=sx, y=sy, lonlat=[lon, lat], product=seed_p, size_km=size, **info), regional=regional, method=SIMILAR_METHOD)


# ---------- the network: the place, the places that move with it, and how they move with each other ----------
# The place and up to `nodes` places related to it (as match: the residual series, Pearson r over the nights both were
# seen, kept at |r| >= max(min_r, 4/sqrt(n)), the strongest first, a match within SIMILAR_GROUP_KM of a stronger one
# joining it), then every pair among them correlated the same way: an edge where the pair passes the same bar, with
# its sign. Each node's eigenvector centrality: the leading eigenvector of the matrix of |r| over the edges (a place
# is central when it moves with places that are themselves central), scaled so the most central is 1.
NETWORK_MAX = 60


def network(body):
    ds = DATASET
    x, y = float(body["x"]), float(body["y"])
    size = float(body["size_km"]) if body.get("size_km") else None
    product = body.get("product") or "lightroast"
    _check_products(product)
    lo, hi = body.get("from") or "", body.get("to") or "9999"
    regional = bool(body.get("regional"))
    sign = body.get("sign") if body.get("sign") in ("positive", "negative") else "both"
    want = max(5, min(NETWORK_MAX, int(body.get("nodes") or 25)))
    min_r = max(SIMILAR_MIN_R, min(.95, float(body.get("min_r") or SIMILAR_MIN_R)))
    seed, (sx, sy), info = seed_series(product, x, y, size, regional)
    profile = series_profile(seed, product, info)
    dates, Y, px, py, note = candidates(product, regional)
    used = [j for j, d in enumerate(dates) if lo <= d <= hi and d in seed and np.isfinite(seed[d])]
    sv = np.array([seed[dates[j]] for j in used], np.float32)
    if len(used) < SIMILAR_MIN_NIGHTS or not np.nanstd(sv) > 0:
        raise ValueError("למקום הזה אין מספיק לילות עם ערך בתקופה הזו (צריך %d לפחות) כדי לבנות רשת." % SIMILAR_MIN_NIGHTS)
    M = Y[:, used]
    r, n = correlate(sv, M)
    r[~variable_rows(product)] = np.nan
    margin = SIMILAR_EXCLUDE_KM * 1000 + (size * 500 if size else 0)
    r[(np.abs(px - sx) < margin) & (np.abs(py - sy) < margin)] = np.nan
    ok = np.isfinite(r) & (np.abs(r) >= np.maximum(min_r, 4 / np.sqrt(np.maximum(n, 1))))
    if sign != "both":
        ok &= (r > 0) if sign == "positive" else (r < 0)
    picked = []
    for k in np.argsort(-np.abs(np.nan_to_num(r))):
        if not ok[k] or len(picked) >= want - 1:
            if len(picked) >= want - 1:
                break
            continue
        if any(math.hypot(px[k] - px[c], py[k] - py[c]) < SIMILAR_GROUP_KM * 1000 for c in picked):
            continue
        picked.append(int(k))
    S = np.vstack([sv[None], M[picked]]) if picked else sv[None]
    K = S.shape[0]
    R, Nn = np.eye(K, dtype=np.float32), np.zeros((K, K), int)
    for i in range(K):
        R[i], Nn[i] = correlate(S[i], S)
    A = np.where(np.isfinite(R) & (np.abs(R) >= np.maximum(min_r, 4 / np.sqrt(np.maximum(Nn, 1)))), np.abs(R), 0.0)
    np.fill_diagonal(A, 0)
    if sign != "both":
        A = np.where((R > 0) if sign == "positive" else (R < 0), A, 0.0)
    w, v = np.linalg.eigh((A + A.T) / 2)
    cent = np.abs(v[:, int(np.argmax(w))]) if K > 1 and A.any() else np.ones(K)
    cent = cent / max(float(cent.max()), 1e-12)
    P = shapes(product)
    shaped = len(P["shape"]) == len(px) and np.allclose(P["px"], px)
    nodes = [dict(x=sx, y=sy, lonlat=list(ds.to_lonlat.transform(sx, sy)), seed=True, r=1.0, nights=len(used), distance_km=0.0,
                  centrality=round(float(cent[0]), 4), shape=profile.get("shape"), size_km=size)]
    for i, k in enumerate(picked, 1):
        nodes.append(dict(x=float(px[k]), y=float(py[k]), lonlat=list(ds.to_lonlat.transform(float(px[k]), float(py[k]))), seed=False,
                          r=round(float(r[k]), 3), nights=int(n[k]), distance_km=round(math.hypot(px[k] - sx, py[k] - sy) / 1000, 1),
                          centrality=round(float(cent[i]), 4), shape=SHAPE_NAMES[P["shape"][k]] if shaped else None, size_km=2.25 if product == "lightroast" else None, **note(k, used)))
    edges = [[i, j, round(float(R[i, j]), 3), int(Nn[i, j])] for i in range(K) for j in range(i + 1, K) if A[i, j] > 0]
    return dict(product=product, regional=regional, sign=sign, min_r=min_r, nights=len(used), first=dates[used[0]], last=dates[used[-1]],
                candidates=int(ok.sum()), nodes=nodes, edges=edges, profile=profile,
                method="Nodes: the place and its strongest matches (as related places: Pearson r of residual series, |r| >= max(min_r, "
                       "4/sqrt(n))). Edges: every pair passing the same bar, r with its sign. Size: eigenvector centrality of |r| "
                       "over the edges, the most central 1.")


# ---------- where else the same change happened ----------
# Correlating whole years matches places that are simply lit, or that swing together with haze and the seasons. The
# question here is narrower: a change happened at one place; where else did the same change happen at the same time,
# and is that more than happens in an ordinary week?
CO_BEFORE_DAYS, CO_GAP_DAYS = 42, 4      # the baseline: these days before the switch, leaving out the last few
CO_Z, CO_REFS = 4.0, 24                  # a step counts at |z| >= CO_Z; ordinary weeks to compare with
CO_STEP = dict(lightroast=math.log(1.5), temper=1.0)   # and at least x1.5 (lights, log units) or one site s.d. (heat)
CO_FLOOR = dict(lightroast=0.10, temper=0.25)          # the smallest night-to-night spread trusted, in those units
CO_TOP, CO_TOP_OPPOSITE = 25, 15
CO_LOCAL_KM = 50.0                       # "nearby", for the second count
CO_METHOD = ("The switch: the night in the seed's own nightly series (3x3, or its window) where the median of the 7 days "
             "from it differs most from the 14 days before it, within 10 days before the event's first night (a week's "
             "median finds a change a few days late). Every candidate place (TEMPER sites; LIGHT ROAST lit 2.25 km blocks, "
             "regional swing kept) is scored at that night: the median over the event's days (7-21) less the median over "
             "the %d to %d days before, z = step / (1.25 x robust spread x sqrt(1/n1 + 1/n2)); kept when |z| >= %g and the "
             "step is at least x1.5 (lights) or one site s.d. (heat). Changes already under way 4-14 days before are "
             "marked. The event log adds the changes detected from 3 days before the switch to its last day (lights too dark "
             "to be candidates included). How unusual: the detected changes of the same direction starting then (3 days "
             "before the switch to its last day), within %g km and country-wide, against the same count at %d other times "
             "of the year. Each place's own rate (the share of those times it stepped the same way) ranks it: "
             "|z| x (1 - rate) x (1 + exp(-distance / %g km)), so a place that rarely changes but changed now comes first, "
             "and of two such, the nearer."
             % (CO_BEFORE_DAYS, CO_GAP_DAYS, CO_Z, CO_LOCAL_KM, CO_REFS, CO_LOCAL_KM))


# One night: a fire, a flash, a one-night outage. A week's median does not see it, so it is scored by itself.
CO_NIGHT_Z = 5.0                                       # a night counts at |z| >= this against the nights around it
CO_NIGHT = dict(lightroast=math.log(2), temper=2.0)    # and at least x2 (lights, log units) or 2 site s.d. (heat)
# those nights: 21 days before to 7 after (its neighbours left out)
CO_NIGHT_AROUND = (21, 7)
CO_NIGHT_REFS = 60                                     # ordinary nights to compare with
CO_NIGHT_SEEN = 0.8                                    # a night seen in part: fewer places than this share of usual
CO_NIGHT_METHOD = ("One night (a change of one or two nights, or a place asked about one night, where that night stands "
                   "out): of the 3 nights before to 3 after, the one furthest from the median of the nights %d days before "
                   "to %d after (the night and its neighbours left out), z = deviation / robust spread, kept at |z| >= %g "
                   "and x2 (lights) or 2 site s.d. (heat), and only if the week after is back near the level before (else "
                   "it is a step). A change of one or two nights from the list (or detected inside the place) is one "
                   "night at its first night unless the seed's own series shows a lasting step there. Every candidate is "
                   "scored on that same night the same way. How unusual: the places that "
                   "stood out that night, within %g km and country-wide, against %d ordinary nights (scaled to the share "
                   "of places seen that night, when under %g of usual); each place's rate is the share of those nights it "
                   "stood out the same way."
                   % (CO_NIGHT_AROUND[0], CO_NIGHT_AROUND[1], CO_NIGHT_Z, CO_LOCAL_KM, CO_NIGHT_REFS, CO_NIGHT_SEEN))


def _ord(d):
    return datetime.fromisoformat(d).toordinal()


def _iso(o):
    return datetime.fromordinal(int(o)).date().isoformat()


def _dm(o):
    """A day as the viewer's users write it: 15.9"""
    d = datetime.fromordinal(int(o)).date()
    return f"{d.day}.{d.month}"


def step_scores(Y, ords, t, days, product, earlier=True):
    """Each row's step at day t: median over [t, t+days) less median over [t-CO_BEFORE_DAYS, t-CO_GAP_DAYS], its z,
    and (earlier) whether at least half of it had already happened 4-14 days before."""
    b = (ords >= t - CO_BEFORE_DAYS) & (ords <= t - CO_GAP_DAYS)
    a = (ords >= t) & (ords < t + days)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        mb, ma = np.nanmedian(Y[:, b], 1), np.nanmedian(Y[:, a], 1)
        sb = 1.4826 * np.nanmedian(np.abs(Y[:, b] - mb[:, None]), 1)
        nb, na = np.isfinite(Y[:, b]).sum(1), np.isfinite(Y[:, a]).sum(1)
        step = ma - mb
        spread = np.maximum(np.nan_to_num(sb, nan=CO_FLOOR[product]), CO_FLOOR[product])
        z = step / (1.2533 * spread * np.sqrt(1 / np.maximum(nb, 1) + 1 / np.maximum(na, 1)))
        z[(nb < 6) | (na < 3)] = np.nan
        if not earlier:
            return step, z, None
        late = (ords >= t - 14) & (ords <= t - CO_GAP_DAYS)
        early = (ords >= t - CO_BEFORE_DAYS) & (ords < t - 14)
        moved = np.nanmedian(Y[:, late], 1) - np.nanmedian(Y[:, early], 1)
    return step, z, (np.sign(moved) == np.sign(step)) & (np.abs(moved) >= 0.5 * np.abs(step))


def lights_values(x, y, size_km, lo, hi):
    """LIGHT ROAST: the window's log(mean radiance + 1) on each night between ordinal days lo and hi, where at least
    half of it was measured."""
    L = LIGHTS
    _, r0, r1, c0, c1, roi = DATASET.window_cells(x, y, size_km, None)
    out = {}
    for d in L.dates:
        if lo <= _ord(d) <= hi and L.ready(d):
            a = np.where(roi, np.asarray(L.layer(d)[r0:r1, c0:c1], np.float32), np.nan)
            if np.isfinite(a).mean() >= .5:
                out[d] = math.log(max(float(np.nanmean(a)), 0) + 1)
    return out


def switch_night(values, onset, way):
    """The night of the step: the day from 10 before the onset to 3 after where the median of the 7 days from it
    differs most from the 14 days before it (in the event's direction, when known)."""
    if len(values) < 8:
        return onset, None
    o = np.array([_ord(d) for d in values])
    v = np.array(list(values.values()))
    best, when = -np.inf, onset
    for c in range(onset - 10, onset + 4):
        after, before = v[(o >= c) & (o < c + 7)], v[(o >= c - 14) & (o < c)]
        if len(after) < 2 or len(before) < 4:
            continue
        diff = float(np.median(after) - np.median(before))
        score = diff if way == "up" else -diff if way == "down" else abs(diff)
        if score > best:
            best, when = score, c
    return when, best


def night_scores(Y, ords, t, product):
    """Each row's one-night deviation at day t: its value less the median of the nights from CO_NIGHT_AROUND[0] days
    before to CO_NIGHT_AROUND[1] after (the night and its two neighbours left out), and its z against their robust
    spread (at least CO_FLOOR). NaN where the night was not seen or fewer than 8 nights around it were."""
    nan = np.full(Y.shape[0], np.nan, np.float32)
    j = np.flatnonzero(ords == t)
    if not j.size:
        return nan, nan.copy()
    around = (ords >= t - CO_NIGHT_AROUND[0]) & (ords <= t + CO_NIGHT_AROUND[1]) & (np.abs(ords - t) > 1)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        A = np.asarray(Y[:, around], np.float32)
        m = np.nanmedian(A, 1)
        s = 1.4826 * np.nanmedian(np.abs(A - m[:, None]), 1)
        dev = np.asarray(Y[:, j[0]], np.float32) - m
        z = dev / np.maximum(np.nan_to_num(s, nan=CO_FLOOR[product]), CO_FLOOR[product])
    z[np.isfinite(A).sum(1) < 8] = np.nan
    return dev, z


def seed_night(values, onset, way, product):
    """A one-night event at the seed: of the nights from 3 before the onset to 3 after, the one that stands out most
    against the nights around it (night_scores; in the event's direction when known), when |z| >= CO_NIGHT_Z, it is
    at least CO_NIGHT, and the week after it is back near the level before (what stayed is under half the night's own
    deviation; else it is a step). The shown night wins over a neighbour that stands out about as much.
    Returns (day, deviation, z), or None."""
    if len(values) < 10:
        return None
    o = np.array([_ord(d) for d in values])
    v = np.array(list(values.values()), np.float32)
    best = None
    for c in o[(o >= onset - 3) & (o <= onset + 3)]:
        c = int(c)
        dev, z = night_scores(v[None, :], o, c, product)
        dev, z = float(dev[0]), float(z[0])
        if not math.isfinite(z) or abs(z) < CO_NIGHT_Z or abs(dev) < CO_NIGHT[product] or (way and (dev > 0) != (way == "up")):
            continue
        before, after = v[(o >= c - 21) & (o < c - 1)], v[(o > c + 1) & (o <= c + 8)]
        if len(before) >= 3 and len(after) >= 2 and abs(float(np.median(after) - np.median(before))) >= 0.5 * abs(dev):
            continue
        score = abs(z) * (1 - 0.1 * abs(c - onset))
        if best is None or score > best[3]:
            best = (c, dev, z, score)
    return best[:3] if best else None


class NoChange(ValueError):
    """The place shows no change around the night asked about."""


def seed_values(seed_p, x, y, size, onset, days):
    """The seed's own nightly series around the onset, and what it was made of: LIGHT ROAST, its window's log(mean
    radiance + 1) (lights_values); TEMPER, the activity of the heat sites in its window (none inside: of the nearest
    site within EVENT_FLARE_KM, see seed_series)."""
    lo, hi = onset - CO_BEFORE_DAYS - 14, onset + days + 7
    if seed_p == "lightroast":
        return lights_values(x, y, max(size, 2.25), lo, hi), {}
    try:
        series, _, info = seed_series("temper", x, y, size if size else None)
    except ValueError:
        return {}, {}
    return {d: float(v) for d, v in series.items() if np.isfinite(v) and lo <= _ord(d) <= hi}, info


def own_step(values, t, days, product):
    """The seed's own step at day t (step_scores) as (step, z); (None, None) without enough nights on either side."""
    if not values:
        return None, None
    o = np.array([_ord(d) for d in values])
    st, zz, _ = step_scores(np.array([list(values.values())], np.float32), o, t, days, product, earlier=False)
    return (float(st[0]), float(zz[0])) if np.isfinite(zz[0]) else (None, None)


def is_step(step, z, product):
    """A step that counts: |z| >= CO_Z and at least CO_STEP."""
    return z is not None and abs(z) >= CO_Z and abs(step) >= CO_STEP[product]


def detected_here(body):
    """A change the change log found at the place around the night asked about (body: x, y, size_km, seed, onset):
    within its central 2.25 km (or its window, when smaller; a change somewhere in a large area is not the area's),
    starting from 3 nights before that night to the night after, or still going on that night. The nearest in time,
    then the strongest; None when there is none."""
    product = body.get("seed", "temper")
    if product not in ("temper", "lightroast") or (product == "lightroast" and not LIGHTS):
        return None
    x, y, n = float(body["x"]), float(body["y"]), _ord(body["onset"])
    half = min(float(body.get("size_km") or 2.25), 2.25) * 500
    log, _, _ = event_log(product)
    here = [c for c in log["chains"] if abs(c["x"] - x) <= half and abs(c["y"] - y) <= half
            and (n - 3 <= c["onset_day"] <= n + 1 or c["onset_day"] <= n <= c["last_day"])]
    gap = lambda c: 0 if c["onset_day"] <= n <= c["last_day"] else abs(c["onset_day"] - n)
    return min(here, key=lambda c: (gap(c), -c["peak"]), default=None)


def cooccur(body):
    """Where else the same change happened, at the same time: see CO_METHOD. body: the seed place (x, y, size_km),
    its product (seed), the product searched (target), the change's first and last night (onset, last) and kind
    (from the list), or only the night asked about (a place: onset = last, no kind)."""
    ds = DATASET
    x, y = float(body["x"]), float(body["y"])
    size = float(body.get("size_km") or 2.25)
    seed_p, target = body.get("seed", "lightroast"), body.get("target") or body.get("seed", "lightroast")
    _check_products(seed_p, target)
    if not body.get("onset"):
        raise ValueError("צריך לילה לשינוי.")
    onset, last = _ord(body["onset"]), _ord(body.get("last") or body["onset"])
    way = EVENT_WAY.get(body.get("kind"))
    asked = body.get("kind") is None   # a place and a night, not a change from the list
    days = int(min(21, max(7, last - onset + 7)))
    values, about = seed_values(seed_p, x, y, size, onset, days)
    # A lasting change: a week's median finds it a few days late, so find the night itself (TEMPER from the list sees
    # each night by itself: its first night is the switch).
    switch = lambda: onset if (seed_p == "temper" and not asked) else switch_night(values, onset, way)[0]
    # One night (a fire, a flash, a one-night outage): a change of a night or two, or a place asked about one night.
    short = last - onset <= 2
    night = seed_night(values, onset, way, seed_p) if short else None
    if night is None and short and not asked and not is_step(*own_step(values, switch(), days, seed_p), seed_p):
        # A short change from the list that the seed's own series does not show by itself: still one night. The
        # list sees each pixel (or block) by itself, and a site's or a window's series can blur a night; a change
        # on the last nights has no week after it yet; and some places have no series of their own.
        night = (onset, None, None)
    seed_step = seed_z = own_z = None
    if night:
        t, seed_step, seed_z = night
        if seed_step is not None:
            way = "up" if seed_step > 0 else "down"
        elif values:   # how the seed's own series saw that night, though it did not count by itself
            o = np.array([_ord(d) for d in values])
            _, zz = night_scores(np.array([list(values.values())], np.float32), o, t, seed_p)
            own_z = float(zz[0]) if np.isfinite(zz[0]) else None
        change, during = "night", 1
    else:
        change, during = "step", days
        t = switch()
        seed_step, seed_z = own_step(values, t, days, seed_p)
        if asked and not is_step(seed_step, seed_z, seed_p):
            raise NoChange("סביב %s לא נמצא כאן שינוי: לא לילה חריג ולא שינוי שנמשך." % _dm(onset))
        if way is None:
            if seed_step is None:
                raise NoChange("סביב %s לא נמצא כאן שינוי." % _dm(onset))
            way = "up" if seed_step > 0 else "down"
    sign = 1 if way == "up" else -1
    dates, Y, px, py, note = candidates(target, regional=True)
    ords = np.array([_ord(d) for d in dates])
    margin = max(SIMILAR_EXCLUDE_KM * 1000, size * 500)
    near = (np.abs(px - x) < margin) & (np.abs(py - y) < margin)
    nearby = (np.hypot(px - x, py - y) < CO_LOCAL_KM * 1000) & ~near
    if change == "night":
        step, z = night_scores(Y, ords, t, target)
        earlier = np.zeros(len(px), bool)
        sig_of = lambda s, zz: np.isfinite(zz) & (np.abs(zz) >= CO_NIGHT_Z) & (np.abs(s) >= CO_NIGHT[target])
        pool = ords[(ords >= ords.min() + CO_NIGHT_AROUND[0]) & (ords <= ords.max() - CO_NIGHT_AROUND[1]) & (np.abs(ords - t) > 7)]
        refs = [int(o) for o in pool[np.linspace(0, len(pool) - 1, min(CO_NIGHT_REFS, len(pool))).astype(int)]] if len(pool) else []
        scores_at = lambda o: night_scores(Y, ords, o, target)
        used = list(np.flatnonzero(ords == t))
        lo_day, hi_day = t - 1, t + 1   # detected changes "starting then"
    else:
        step, z, earlier = step_scores(Y, ords, t, days, target)
        sig_of = lambda s, zz: np.isfinite(zz) & (np.abs(zz) >= CO_Z) & (np.abs(s) >= CO_STEP[target])
        refs = [int(o) for o in np.linspace(ords.min() + CO_BEFORE_DAYS, ords.max() - days + 1, CO_REFS + 8).astype(int) if abs(o - t) > 21][:CO_REFS]
        scores_at = lambda o: step_scores(Y, ords, o, days, target, earlier=False)[:2]
        used = list(np.flatnonzero((ords >= t) & (ords < t + days)))
        lo_day, hi_day = t - 3, t + days - 1
    sig = sig_of(step, z)
    same, opposite = sig & ~near & (np.sign(step) == sign), sig & ~near & (np.sign(step) == -sign)
    # how often each place changes this way at an ordinary time, and how many places do
    often = np.zeros(len(px), np.int32)
    ref_hits = []
    for o in refs:
        s2, z2 = scores_at(o)
        hit = sig_of(s2, z2) & (np.sign(s2) == sign)
        often += hit
        ref_hits.append(hit)
    rate = often / max(len(refs), 1)
    log, _, _ = event_log(target)
    chains = [c for c in log["chains"] if change == "step" or c["nights"] <= 2]   # one night: only short changes
    # How unusual: the detected changes of this direction starting then (one night: the short ones, and the places
    # that stood out that night), nearby and country-wide, against the same count at ordinary times.
    ways = [(c["onset_day"], c["x"], c["y"]) for c in chains if EVENT_WAY[c["kind"]] == way]
    if ways:
        on, cx, cy = (np.array(v, np.float64) for v in zip(*ways))
        far_from_seed = ~((np.abs(cx - x) < margin) & (np.abs(cy - y) < margin))
        close_by = (np.hypot(cx - x, cy - y) < CO_LOCAL_KM * 1000) & far_from_seed
        starting = lambda o: (on >= o + lo_day - t) & (on <= o + hi_day - t) & far_from_seed
    else:
        starting = close_by = None
    def counted(o, hit):
        n = n_local = 0
        if starting is not None:
            s0 = starting(o)
            n, n_local = int(s0.sum()), int((s0 & close_by).sum())
        if change == "night":
            n, n_local = n + int((hit & ~near).sum()), n_local + int((hit & nearby).sum())
        return n, n_local
    count, count_local = counted(t, same)
    pairs = [counted(o, h) for o, h in zip(refs, ref_hits)]
    counts, local_counts = [c[0] for c in pairs], [c[1] for c in pairs]
    typical = float(np.median(counts)) if counts else None
    typical_local = float(np.mean(local_counts)) if local_counts else None
    # One night seen only in part (a swath missing, or the last night still arriving) has fewer places that can
    # stand out: the ordinary count is scaled to the share of places seen that night, when under CO_NIGHT_SEEN.
    seen_share = seen_share_local = None
    if change == "night" and refs:
        seen = lambda o: np.isfinite(np.asarray(Y[:, ords == o], np.float32)).any(1)
        seen_t, ref_seen = seen(t), [seen(o) for o in refs]
        usual, usual_local = np.median([s.sum() for s in ref_seen]), np.median([(s & nearby).sum() for s in ref_seen])
        share, share_local = seen_t.sum() / max(usual, 1), (seen_t & nearby).sum() / usual_local if usual_local else 1
        if share < CO_NIGHT_SEEN and typical is not None:
            typical, seen_share = typical * share, round(float(share), 2)
        if share_local < CO_NIGHT_SEEN and typical_local is not None:
            typical_local, seen_share_local = typical_local * share_local, round(float(share_local), 2)
    # nearby counts up to double
    close = lambda cx, cy: 1 + math.exp(-math.hypot(cx - x, cy - y) / (CO_LOCAL_KM * 1000))

    def item(k, members):
        lon, lat = ds.to_lonlat.transform(float(px[k]), float(py[k]))
        return dict(x=float(px[k]), y=float(py[k]), lonlat=[lon, lat], step=float(step[k]), z=float(z[k]), earlier=bool(earlier[k]), 
                    rate=round(float(rate[k]), 2), score=float(abs(z[k]) * (1 - rate[k]) * close(px[k], py[k])), 
                    distance_km=round(float(math.hypot(px[k] - x, py[k] - y)) / 1000, 1), places=members, detected=None, **note(k, used))

    def pick(mask, limit):
        chosen = []
        for k in np.argsort(-np.abs(np.nan_to_num(z)) * (1 - rate) * (1 + np.exp(-np.hypot(px - x, py - y) / (CO_LOCAL_KM * 1000))))[:5000]:
            if not mask[k]:
                continue
            near_one = next((c for c in chosen if math.hypot(px[k] - px[c[0]], py[k] - py[c[0]]) < SIMILAR_GROUP_KM * 1000), None)
            if near_one:
                near_one[1] += 1
            elif len(chosen) < limit:
                chosen.append([k, 1])
        return [item(k, m) for k, m in chosen]
    lists = {1: pick(same, CO_TOP), -1: pick(opposite, CO_TOP_OPPOSITE)}
    # changes the detection itself found at the same time (also where it is too dark, or too seldom lit, for a candidate)
    for c in chains:
        if not (lo_day <= c["onset_day"] <= hi_day) or (abs(c["x"] - x) < margin and abs(c["y"] - y) < margin):
            continue
        s = 1 if EVENT_WAY[c["kind"]] == "up" else -1
        target_list = lists[1 if s == sign else -1]
        hit = next((i for i in target_list if math.hypot(i["x"] - c["x"], i["y"] - c["y"]) < 2000), None)
        if hit:
            hit["detected"] = c["kind"]
            continue
        b = c["best"] or {}
        zz = float(b["z"]) if b.get("z") is not None else None
        target_list.append(dict(x=c["x"], y=c["y"], lonlat=c["lonlat"], step=math.log(b["ratio"]) if b.get("ratio") else None, 
                                z=zz, earlier=c["onset_day"] < t - 1, places=1, rate=None, score=abs(zz if zz is not None else CO_Z) * 0.5 * close(c["x"], c["y"]), 
                                distance_km=round(math.hypot(c["x"] - x, c["y"] - y) / 1000, 1), detected=c["kind"], onset=c["onset"], nights=c["nights"]))
    for k in lists:   # a place that rarely changes but changed now first; detected-only places (no rate) at half
        lists[k].sort(key=lambda i: -i["score"])
    lon, lat = ds.to_lonlat.transform(x, y)
    before = [_iso(t - CO_NIGHT_AROUND[0]), _iso(min(t + CO_NIGHT_AROUND[1], ords.max()))] if change == "night" else [_iso(t - CO_BEFORE_DAYS), _iso(t - CO_GAP_DAYS)]
    return dict(mode="event", change=change, target=target, candidates=int(Y.shape[0]), positive=lists[1][:CO_TOP + 10], negative=lists[-1][:CO_TOP_OPPOSITE + 5], 
                seed=dict(x=x, y=y, lonlat=[lon, lat], product=seed_p, size_km=size, switch=_iso(t), way=way, step=seed_step, z=seed_z, change=change,
                          own_z=own_z, nights_after=int(np.sum(ords > t)), nearest_km=about.get("nearest_km")),
                window=dict(before=before, during=[_iso(t), _iso(t + during - 1)]), 
                rarity=dict(count=count, typical=typical, ratio=round(count / max(typical, 1), 1) if typical is not None else None, weeks=len(counts), 
                            unit="nights" if change == "night" else "weeks", 
                            local_km=CO_LOCAL_KM, local=count_local, typical_local=None if typical_local is None else round(typical_local, 1), 
                            ratio_local=None if typical_local is None else round(count_local / max(typical_local, 0.5), 1),
                            seen=seen_share, seen_local=seen_share_local),
                method=CO_METHOD + " " + CO_NIGHT_METHOD)


def related(body):
    """One question for a place, the answer chosen by the place itself: a change from the list, a change in the
    place's own series around the night shown (a one-night event, or one that lasted), or else a change the change
    log found inside the place then (detected_here), gives where else the same happened then (cooccur); a place
    without one gives what moves with it over the period (similar) when it varies, and why there is nothing to relate
    when it is steady. ask ("event" or "corr") asks one of the two directly."""
    ask = body.get("ask")
    if ask == "corr":
        return dict(similar(body), mode="corr", chose="asked")
    if body.get("kind"):
        return dict(cooccur(body), chose="change")
    if not body.get("onset"):
        if ask == "event":
            raise ValueError("צריך לילה לשינוי.")
        return dict(similar(body), mode="corr", chose="no-night")
    try:
        return dict(cooccur(dict(body, last=body["onset"], kind=None)), chose="asked" if ask == "event" else "night")
    except NoChange as e:
        why = str(e)
    # The place's own series shows nothing then, but the change log (each pixel, or block, by itself) found a change
    # inside it: answer for that change, as from the list.
    c = detected_here(body)
    if c:
        found = dict(kind=c["kind"], cause=c.get("cause"), onset=c["onset"], last=c["last"], nights=c["nights"], lonlat=c["lonlat"])
        return dict(cooccur(dict(body, onset=c["onset"], last=c["last"], kind=c["kind"])), chose="detected", detected=found, why=why)
    if ask == "event":
        raise NoChange(why)
    try:
        return dict(similar(body), mode="corr", chose="no-change", why=why)
    except ValueError as e:   # e.g. no heat source here to follow over the period
        raise ValueError(why + " " + str(e)) from e


# ---------- behaviour search: find places by the shape of their year ----------
# Most places never really change (93% of Saudi Arabia's lit blocks, 98.5% of Israel's), and correlating them finds
# only shared noise. This finds the ones that do, by the shape of their year, with a query in an SQL-like line, and
# groups only those: steps by when they happened, swings by moving together.
SHAPE_NAMES = ("step", "trend", "fluct", "spike", "stable")
SHAPE_SIDE = 25                 # a step's split leaves at least this many nights a side
SHAPE_STEP_R2 = .45             # a step explains at least this share of the variance,
SHAPE_STEP_EFF = 2.5            # is this many times the spread left within its two parts,
SHAPE_STEP_BEAT = .1            # and beats a straight line by this much of the variance
SHAPE_TREND_R2 = .35            # a trend: a straight line explaining at least this share
SHAPE_FLUCT_SWITCHES = 6        # swinging: at least this many full swings between its low and high levels
SHAPE_SPIKE_MIN, SHAPE_SPIKE_MAX = .003, .04   # spikes: this share of nights far above its median
SHAPE_ALIASES = {"מדרגה": "step", "מגמה": "trend", "תנודתי": "fluct", "fluctuating": "fluct", "קפיצה": "spike", "spikes": "spike", "יציב": "stable",
                 "קבוע": "constant", "hot": "constant", "lit": "constant"}
SHAPE_UNITS = dict(lightroast=dict(step=math.log(1.5), spread=math.log(2), spike=math.log(3)), temper=dict(step=1.0, spread=1.0, spike=2.5))
SHAPE_METHOD = ("Each candidate place (LIGHT ROAST: lit 2.25 km blocks, log radiance less the night's country median, its "
                "16-day viewing pattern and moonlight; TEMPER: detected sites, standardised activity) gets one profile of "
                "its year, clipped at 5 robust s.d. Step: the single split (25+ nights a side) leaving the least squared "
                "error; a step when it explains >= 45% of the variance, is at least x1.5 (lights) or 1 s.d. (heat), at least "
                "2.5 times the spread left within the two parts, and beats a straight line by 0.1 of the variance. Trend: a "
                "straight line explaining >= 35% and changing x1.5 or more over the year. Fluctuating: 20th-80th percentile "
                "spread of x2 (1 s.d. for heat) and at least 6 full swings between the low and high levels. Spike: 0.3-4% of "
                "nights x3 (2.5 s.d.) above its median, steady otherwise. The rest: stable.")
_SHAPES = {}
# A time frame (the search's From / To): the shapes are worked out on its nights only; a step then needs SHAPE_SIDE
# nights a side, or a quarter of a shorter frame's (6 at least). And what is constant through it: heat, a site lit on
# CONSTANT_HOT_SHARE of its observed nights or more; lights, a place (or a map pixel) lit (LIT_NW+) on
# CONSTANT_LIT_SHARE of its clear nights or more.
FRAME_MIN_NIGHTS = 20
CONSTANT_HOT_SHARE = 0.5
CONSTANT_LIT_SHARE = 0.9
CONSTANT_MIN_SEEN = 10          # nights seen in the frame, at least, to call a place constant
SHAPE_MIN_SEEN = 12             # nights seen, at least, to give a place any shape (a short cloudy frame can leave 2 or 3)


def profile_rows(R, dates, product, side=None):
    """The shape of each row's year (see SHAPE_METHOD): code (0 step, 1 trend, 2 fluct, 3 spike, 4 stable), its size
    (change), direction, the night it happened (when, an index; -1 none), fit, full swings and the share of spike nights."""
    u = SHAPE_UNITS[product]
    side = side or SHAPE_SIDE
    n, T = R.shape
    ok = np.isfinite(R)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        med = np.nanmedian(R, 1)
        mad = 1.4826 * np.nanmedian(np.abs(R - med[:, None]), 1)
        lo_c, hi_c = med - 5 * np.maximum(mad, .05), med + 5 * np.maximum(mad, .05)
        X = np.clip(R, lo_c[:, None], hi_c[:, None]).astype(np.float32)
        Xz = np.where(ok, X, 0).astype(np.float64)
        N, S, Q = np.cumsum(ok, 1), np.cumsum(Xz, 1), np.cumsum(Xz * Xz, 1)
        NT, ST, QT = N[:, -1:], S[:, -1:], Q[:, -1:]
        nl, sl, ql = N[:, :-1], S[:, :-1], Q[:, :-1]
        nr, sr, qr = NT - nl, ST - sl, QT - ql
        sse = (ql - sl ** 2 / nl) + (qr - sr ** 2 / nr)
        sse = np.where((nl >= side) & (nr >= side), sse, np.inf)
        k = np.argmin(sse, 1)
        rows = np.arange(n)
        sse0 = (QT - ST ** 2 / NT)[:, 0]
        best = sse[rows, k]
        r2 = np.where(np.isfinite(best) & (sse0 > 0), 1 - best / np.maximum(sse0, 1e-12), 0)
        step = sr[rows, k] / nr[rows, k] - sl[rows, k] / nl[rows, k]
        sigma = np.sqrt(np.maximum(best, 0) / np.maximum(NT[:, 0] - 2, 1))
        tt = np.array([_ord(d) for d in dates], np.float64)
        span_months = (tt[-1] - tt[0]) / 30.44
        tt = (tt - tt.mean()) / 30.44
        tm = np.where(ok, tt[None], 0).sum(1) / np.maximum(NT[:, 0], 1)
        xm = ST[:, 0] / np.maximum(NT[:, 0], 1)
        cov = np.where(ok, (tt[None] - tm[:, None]) * (X - xm[:, None]), 0).sum(1)
        var = np.where(ok, (tt[None] - tm[:, None]) ** 2, 0).sum(1)
        slope = cov / np.maximum(var, 1e-9)
        r2lin = np.clip(slope ** 2 * var / np.maximum(sse0, 1e-9), 0, 1)
        p20, p80 = np.nanpercentile(X, 20, 1), np.nanpercentile(X, 80, 1)
        spread = p80 - p20
        lo, hi = (p20 + .2 * spread)[:, None], (p80 - .2 * spread)[:, None]
        state = np.where(ok & (X <= lo), -1, np.where(ok & (X >= hi), 1, 0)).astype(np.int8)
        pos = np.maximum.accumulate(np.where(state != 0, np.arange(T)[None], 0), 1)
        filled = np.take_along_axis(state, pos, 1)
        switches = ((filled[:, 1:] != filled[:, :-1]) & (filled[:, :-1] != 0) & (filled[:, 1:] != 0)).sum(1)
        above = np.where(ok, X - med[:, None], -np.inf)
        spikes = (above >= u["spike"]).sum(1) / np.maximum(NT[:, 0], 1)
        spike_at = np.argmax(above, 1)
    eff = np.abs(step) / np.maximum(sigma, .05)
    shape = np.full(n, 4, np.int8)   # stable
    is_step = (r2 >= SHAPE_STEP_R2) & (np.abs(step) >= u["step"]) & (eff >= SHAPE_STEP_EFF) & (r2 - r2lin >= SHAPE_STEP_BEAT)
    is_trend = ~is_step & (r2lin >= SHAPE_TREND_R2) & (np.abs(slope) * span_months >= u["step"])
    is_fluct = ~is_step & ~is_trend & (spread >= u["spread"]) & (switches >= SHAPE_FLUCT_SWITCHES)
    is_spike = ~is_step & ~is_trend & ~is_fluct & (spikes >= SHAPE_SPIKE_MIN) & (spikes <= SHAPE_SPIKE_MAX) & (spread < u["spread"] * .7)
    for code, mask in enumerate((is_step, is_trend, is_fluct, is_spike)):
        shape[mask] = code
    shape[NT[:, 0] < SHAPE_MIN_SEEN] = 4   # too few nights to tell: a line through 3 points is no trend
    # one magnitude per shape, and its direction: the step; the year's change along the line; the swing; the spikes
    spike_size = np.where(np.isfinite(np.max(above, 1)), np.max(above, 1), 0)
    change = np.select([shape == 0, shape == 1, shape == 2, shape == 3], [np.abs(step), np.abs(slope) * span_months, spread, spike_size], np.abs(step))
    direction = np.select([shape == 0, shape == 1, shape == 3], [np.sign(step), np.sign(slope), np.ones(n)], np.zeros(n))
    when = np.where(shape == 0, k + 1, np.where(shape == 3, spike_at, -1))
    fit = np.where(shape == 1, r2lin, r2)
    return dict(shape=shape, change=change.astype(np.float32), direction=direction.astype(np.int8), when=when.astype(np.int32), 
                fit=fit.astype(np.float32), switches=switches.astype(np.int32), spikes=spikes.astype(np.float32))


def shapes(product, lo="", hi=""):
    """The profile of every candidate place of a product (see SHAPE_METHOD) over its nights in [lo, hi] (all of them
    when not given), with its level and whether it is constant there; cached while its candidates stay."""
    dates, R, px, py, note = candidates(product, regional=True)
    cols = [j for j, d in enumerate(dates) if (not lo or d >= lo) and (not hi or d <= hi)]
    if len(cols) < FRAME_MIN_NIGHTS:
        raise ValueError("בתקופה הזו %d לילות; צריך %d לפחות כדי למצוא צורה." % (len(cols), FRAME_MIN_NIGHTS))
    key = (product, id(LIGHTS) if product == "lightroast" else id(DATASET), dates[cols[0]], dates[cols[-1]], len(cols), len(dates), R.shape[0])
    if key in _SHAPES:
        _SHAPES[key] = _SHAPES.pop(key)   # newest last
        return _SHAPES[key]
    whole = len(cols) == len(dates)
    D, Rf = [dates[j] for j in cols], R if whole else R[:, cols]
    prof = profile_rows(Rf, D, product, side=min(SHAPE_SIDE, max(6, len(cols) // 4)))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        if product == "lightroast":
            Y = LIGHTS.blocks()["Y"].astype(np.float32)
            Y = Y if whole else Y[:, cols]
            seen = np.isfinite(Y).sum(1)
            level = np.expm1(np.nanmedian(Y, 1))
            share = (np.expm1(np.nan_to_num(Y, nan=-1)) >= lightroast.LIT_NW).sum(1) / np.maximum(seen, 1)
            constant = (share >= CONSTANT_LIT_SHARE) & (seen >= CONSTANT_MIN_SEEN)
        else:
            Y = DATASET.activity()["Y"]
            Y = Y if whole else Y[:, cols]
            seen = np.isfinite(Y).sum(1)
            share = level = (Y > 0).sum(1) / np.maximum(seen, 1)
            constant = (share >= CONSTANT_HOT_SHARE) & (seen >= CONSTANT_MIN_SEEN)
    out = dict(product=product, dates=D, frame=[D[0], D[-1]], px=np.asarray(px, float), py=np.asarray(py, float), level=np.asarray(level, np.float32),
               lit_share=np.asarray(share, np.float32), constant=constant, R=Rf, **prof)
    _SHAPES[key] = out
    while sum(k[0] == product for k in _SHAPES) > 3:   # the whole year and the last frames asked, per product
        del _SHAPES[next(k for k in _SHAPES if k[0] == product)]
    return out


# ---------- how consistent a place is: correlations only where something varies ----------
# A place whose year is steady (no step, trend, swings or spikes), or that is almost never lit or warm, correlates
# only through noise; such places are neither searched from nor counted as matches.
CONSISTENT_BAND = math.log(1.2)   # lights: a night within +-20% of the place's usual level counts as usual
ACTIVE_HEAT = 0.05                # heat: a place lit on fewer than 5% of its observed nights is never warm


def series_profile(series, product, info=None):
    """A chosen place's year (its series as {date: value}, and for heat the nights it was lit and seen): its shape,
    its consistency (lights: the share of nights within +-20% of its median; heat: the share of nights in its usual
    state, lit or not), whether it is active (heat: lit on 5%+ of its nights) and whether it varies (active and not
    stable)."""
    dates = sorted(d for d, v in series.items() if v is not None and np.isfinite(v))
    out = dict(shape=None, consistency=None, active=True, variable=False, nights=len(dates))
    if product == "temper" and info:
        seen, lit = info.get("observed_nights") or 0, info.get("detected_nights") or 0
        share = lit / seen if seen else 0.0
        out.update(lit_share=round(share, 3), active=share >= ACTIVE_HEAT, consistency=round(max(share, 1 - share), 3))
    if len(dates) < 50:
        return out
    y = np.array([series[d] for d in dates], np.float32)
    p = profile_rows(y[None], dates, product)
    code = int(p["shape"][0])
    if product == "lightroast":
        out["consistency"] = round(float((np.abs(y - np.median(y)) <= CONSISTENT_BAND).mean()), 3)
    out.update(shape=SHAPE_NAMES[code], change=float(p["change"][0]), direction=int(p["direction"][0]), switches=int(p["switches"][0]), 
               when=dates[int(p["when"][0])] if p["when"][0] >= 0 else None)
    out["variable"] = bool(out["active"] and code != 4)
    return out


def quiet_reason(profile, product):
    """Why a place is not worth correlating, in Hebrew; None when it varies."""
    if profile["variable"]:
        return None
    if product == "temper" and not profile["active"]:
        return "כמעט אין כאן חום (דלק ב־%d%% מהלילות): אין מה לתאם." % round(100 * profile.get("lit_share", 0))
    if profile["shape"] is None:
        return "אין מספיק לילות כדי לדעת אם המקום משתנה."
    what = "האור" if product == "lightroast" else "החום"
    c = profile["consistency"]
    return "%s במקום עקבי%s, בלי מדרגה, מגמה, תנודות או קפיצות: מתאם כאן ימצא רק רעש." % (what, "" if c is None else " (%d%% מהלילות ברמה הרגילה)" % round(100 * c))


def variable_rows(product):
    """The candidate places worth correlating with: not stable, and for heat lit on 5%+ of their nights."""
    P = shapes(product)
    use = P["shape"] != 4
    if product == "temper":
        use &= P["level"] >= ACTIVE_HEAT
    return use


# ---------- behaviour search: the query line, the results and their groups ----------
GROUP_NEAR_KM = 50.0   # places that stepped together count as one local group within this distance of one another
QUERY_FIELDS = ("shape", "direction", "change", "when", "level", "switches", "fit", "within")


def parse_query(text):
    """An SQL-like line: conditions joined by AND, then optionally ORDER BY field [ASC|DESC] and LIMIT n.
    A condition: field op value (op: = != >= <= > <), field IN (a, b), or field BETWEEN a AND b. Words may be
    quoted; Hebrew names of shapes and directions work too."""
    import shlex
    t = " ".join((text or "").replace("×", "x").split())
    order, limit = None, 300
    m = re.search(r"\s+LIMIT\s+(\d+)\s*$", t, re.I)
    if m:
        limit, t = min(1000, int(m.group(1))), t[:m.start()]
    m = re.search(r"\s*ORDER\s+BY\s+(\w+)(?:\s+(ASC|DESC))?\s*$", t, re.I)
    if m:
        order, t = (m.group(1).lower(), (m.group(2) or "DESC").upper()), t[:m.start()]
    t = re.sub(r"^\s*(SELECT\s+\*?\s*(FROM\s+\w+\s*)?WHERE\s+)", "", t, flags=re.I)
    conds = []
    # split on AND, but not the AND inside BETWEEN a AND b
    parts, buf, toks = [], [], shlex.split(t, posix=True) if t.strip() else []
    i = 0
    while i < len(toks):
        if toks[i].upper() == "AND" and not (len(buf) >= 3 and buf[-2].upper() == "BETWEEN"):
            parts.append(buf)
            buf = []
        else:
            buf.append(toks[i])
        i += 1
    if buf:
        parts.append(buf)
    for p in parts:
        expr = " ".join(p)
        m = re.match(r"^(\w+)\s*(>=|<=|!=|=|>|<)\s*(.+)$", expr) or re.match(r"^(\w+)\s+(IN)\s*\((.+)\)$", expr, re.I) \
            or re.match(r"^(\w+)\s+(BETWEEN)\s+(\S+)\s+AND\s+(\S+)$", expr, re.I)
        if not m:
            raise ValueError("לא הבנתי את התנאי: " + expr)
        field = m.group(1).lower()
        if field not in QUERY_FIELDS:
            raise ValueError("שדה לא מוכר: %s. השדות: %s" % (field, ", ".join(QUERY_FIELDS)))
        op = m.group(2).upper()
        if op == "BETWEEN":
            conds.append((field, op, [m.group(3), m.group(4)]))
        elif op == "IN":
            conds.append((field, op, [v.strip().strip("'\"") for v in m.group(3).split(",")]))
        else:
            conds.append((field, op, m.group(3).strip().strip("'\"")))
    return conds, order, limit


def _number(v):
    v = str(v).lower().replace("nw", "").replace("x", "").replace("%", "").strip()
    return float(v)


def behaviour(body):
    """Places whose year has the shape asked for (see SHAPE_METHOD and parse_query), with groups among them: steps
    (and spikes) by when they happened, within 3 days; the rest by moving together night by night (Pearson r of their
    series with the regional swing taken out, r >= max(0.5, 4/sqrt(n)))."""
    product = body.get("product", "lightroast")
    _check_products(product)
    conds, order, limit = parse_query(body.get("query", ""))
    P = shapes(product, body.get("from") or "", body.get("to") or "")
    dates, n = P["dates"], len(P["shape"])
    keep = np.ones(n, bool)
    asked_constant = False
    if not any(f == "shape" for f, _, _ in conds):
        keep &= P["shape"] != 4   # the stable places only when asked for
    lr = product == "lightroast"
    for field, op, val in conds:
        if field == "shape":
            names = val if op == "IN" else [val]
            codes, constant = [], False
            for v in names:
                v = SHAPE_ALIASES.get(v, v.lower())
                if v == "constant":   # not a shape: constantly hot (heat) or constantly lit (lights) through the frame
                    constant = True
                    continue
                if v not in SHAPE_NAMES:
                    raise ValueError("צורה לא מוכרת: %s (step, trend, fluct, spike, stable, constant)" % v)
                codes.append(SHAPE_NAMES.index(v))
            hit = np.isin(P["shape"], codes) | (P["constant"] if constant else False)
            keep &= ~hit if op == "!=" else hit
            asked_constant = constant and op != "!="
            continue
        if field == "direction":
            v = {"up": 1, "עלייה": 1, "down": -1, "ירידה": -1}.get(str(val).lower())
            if v is None:
                raise ValueError("כיוון: up או down")
            keep &= (P["direction"] == v) if op != "!=" else (P["direction"] != v)
            continue
        if field == "within":
            geom = (body.get("areas") or {}).get(val) if val not in ("view", "country") else body.get("view") if val == "view" else None
            if val == "country":
                continue
            if not geom:
                raise ValueError("לא נמצא אזור בשם: %s" % val)
            from shapely import contains_xy
            g = box(*geom) if isinstance(geom, list) else shape(geom)
            keep &= contains_xy(g, P["px"], P["py"])
            continue
        if field == "when":
            ords = np.array([_ord(d) for d in dates])
            w = np.where(P["when"] >= 0, ords[np.clip(P["when"], 0, len(dates) - 1)], -10 ** 9)
            if op == "BETWEEN":
                a, b = (_ord(v) for v in val)
                keep &= (w >= a) & (w <= b)
            else:
                ref = _ord(val)
                keep &= {"=": w == ref, ">=": w >= ref, "<=": w <= ref, ">": w > ref, "<": (w < ref) & (w > 0), "!=": w != ref}[op]
            continue
        arr = {"change": None, "level": P["level"], "switches": P["switches"], "fit": P["fit"]}[field]
        if field == "change":   # as a factor for lights (x2 = twice or half), standard deviations for heat
            arr = np.exp(P["change"]) if lr else P["change"]
        if op == "BETWEEN":
            a, b = (_number(v) for v in val)
            keep &= (arr >= a) & (arr <= b)
        else:
            v = _number(val)
            if field == "level" and not lr and v > 1:
                v /= 100   # heat level: the share of nights lit, given in percent
            keep &= {"=": arr == v, ">=": arr >= v, "<=": arr <= v, ">": arr > v, "<": arr < v, "!=": arr != v}[op]
    if body.get("focus"):   # the area the user works in: only the places inside it
        from shapely import contains_xy
        keep &= contains_xy(shape(body["focus"]), P["px"], P["py"])
    idx = np.flatnonzero(keep)
    fields = dict(change=P["change"], level=P["level"], switches=P["switches"], fit=P["fit"], when=P["when"].astype(float))
    by, desc = (order or (("level", "DESC") if asked_constant else ("change", "DESC")))
    if by not in fields:
        raise ValueError("ORDER BY: change, level, switches, fit או when")
    idx = idx[np.argsort(fields[by][idx] * (-1 if desc == "DESC" else 1), kind="stable")]
    total = len(idx)
    idx = idx[:limit]
    ds = DATASET
    rows = []
    fin = lambda v, nd=None: (round(float(v), nd) if nd is not None else float(v)) if np.isfinite(v) else None   # a frame can leave a place unseen
    for i in idx:
        lon, lat = ds.to_lonlat.transform(float(P["px"][i]), float(P["py"][i]))
        rows.append(dict(i=int(i), x=float(P["px"][i]), y=float(P["py"][i]), lonlat=[lon, lat], shape="constant" if asked_constant and P["constant"][i] else SHAPE_NAMES[P["shape"][i]], year_shape=SHAPE_NAMES[P["shape"][i]], 
                         direction=int(P["direction"][i]), change=fin(P["change"][i]) or 0.0, when=dates[P["when"][i]] if P["when"][i] >= 0 else None, 
                         level=fin(P["level"][i]) or 0.0, lit_share=fin(P["lit_share"][i], 3) or 0.0, switches=int(P["switches"][i]), fit=fin(P["fit"][i], 2) or 0.0, spikes=fin(P["spikes"][i], 3) or 0.0))
    return dict(product=product, total=total, results=rows, groups=[] if asked_constant else behaviour_groups(P, rows, product), candidates=n, 
                counts=dict({name: int((P["shape"] == c).sum()) for c, name in enumerate(SHAPE_NAMES)}, constant=int(P["constant"].sum())), frame=P["frame"], nights=len(dates), method=SHAPE_METHOD)


def behaviour_groups(P, rows, product):
    """Groups among the found places: those with a date (steps, spikes) whose dates lie within 3 days of the next, of
    the same direction (3 or more); the others by moving together (union of pairs with r >= max(0.5, 4/sqrt(n)))."""
    groups = []

    def span(members):
        xs, ys = [rows[j]["x"] for j in members], [rows[j]["y"] for j in members]
        return round(math.hypot(max(xs) - min(xs), max(ys) - min(ys)) / 1000, 1)

    def add(members, scattered=False):
        members = sorted(members, key=lambda j: rows[j]["when"])
        groups.append(dict(kind="together", members=members, first=rows[members[0]]["when"], last=rows[members[-1]]["when"], scattered=scattered, 
                           direction=rows[members[0]]["direction"], shape=rows[members[0]]["shape"], span_km=span(members)))
    # the same direction within 3 days; then by place: places within GROUP_NEAR_KM of one another (single linkage)
    # together; the rest of a run, if 3 or more, as one scattered group
    dated = sorted([k for k, r in enumerate(rows) if r["when"]], key=lambda k: (rows[k]["direction"], rows[k]["when"]))
    run = []
    for k in dated + [None]:
        if run and (k is None or rows[k]["direction"] != rows[run[-1]]["direction"] or _ord(rows[k]["when"]) - _ord(rows[run[-1]]["when"]) > 3):
            clusters = []
            for j in run:
                near = [c for c in clusters if any(math.hypot(rows[j]["x"] - rows[m]["x"], rows[j]["y"] - rows[m]["y"]) < GROUP_NEAR_KM * 1000 for m in c)]
                clusters = [c for c in clusters if not any(c is t for t in near)] + [[j] + [m for c in near for m in c]]
            singles = [c[0] for c in clusters if len(c) == 1]
            for c in clusters:
                if len(c) >= 2:
                    add(c)
            if len(singles) >= 3:
                add(singles, scattered=True)
            run = []
        if k is not None:
            run.append(k)
    free = [k for k, r in enumerate(rows) if not r["when"]][:300]
    if len(free) >= 2:
        R = P["R"] if product != "lightroast" else LIGHTS.blocks()["RL"]
        Y = R[[rows[k]["i"] for k in free]].astype(np.float32)
        ok = np.isfinite(Y)
        Z = np.where(ok, Y - np.nanmean(Y, 1, keepdims=True), 0)
        nn = ok.astype(np.float32) @ ok.T.astype(np.float32)
        num = Z @ Z.T
        sq = (Z * Z) @ ok.T.astype(np.float32)
        with np.errstate(invalid="ignore", divide="ignore"):
            r = num / np.sqrt(sq * sq.T)
        bar = np.maximum(.5, 4 / np.sqrt(np.maximum(nn, 1)))
        parent = list(range(len(free)))

        def root(a):
            while parent[a] != a:
                parent[a] = parent[parent[a]]
                a = parent[a]
            return a
        pairs = np.argwhere(np.triu(np.nan_to_num(r) >= bar, 1) & (nn >= SIMILAR_MIN_NIGHTS))
        for a, b in pairs:
            parent[root(a)] = root(b)
        sets = {}
        for a in range(len(free)):
            sets.setdefault(root(a), []).append(a)
        for members in sets.values():
            if len(members) >= 2:
                sub = r[np.ix_(members, members)]
                mean_r = float(np.nanmean(sub[np.triu_indices(len(members), 1)]))
                xs, ys = [rows[free[j]]["x"] for j in members], [rows[free[j]]["y"] for j in members]
                groups.append(dict(kind="moving", members=[free[j] for j in members], r=round(mean_r, 2), 
                                   span_km=round(math.hypot(max(xs) - min(xs), max(ys) - min(ys)) / 1000, 1)))
    groups.sort(key=lambda g: -len(g["members"]))
    return groups[:40]


# ---------- area analysis: light against heat in one window ----------
CROSS_LAGS = 7    # nights either way: does one product lead the other?
CROSS_MIN_R = 0.2


def cross(heat, light, lo, hi):
    """Light (LIGHT ROAST) against heat (TEMPER) in one place: Pearson r of their residual series over the nights both
    were seen, at lags of up to CROSS_LAGS nights (lag > 0: the light follows the heat by that many nights). Clear when
    |r| >= max(CROSS_MIN_R, 2.6 / sqrt(n)) (about p < 0.01). A lead must beat lag 0 by 0.1 and clear a stricter bar,
    max(0.3, 3.5 / sqrt(n)), since 15 lags are tried: with the heat nights shuffled, the looser bar found a lead at 15%
    of 40 flare sites."""
    from datetime import date as _date, timedelta as _td

    def pairs(lag):
        out = []
        for d, a in heat.items():
            if not (lo <= d <= hi) or not np.isfinite(a):
                continue
            b = light.get((_date.fromisoformat(d) + _td(days=lag)).isoformat())
            if b is not None and np.isfinite(b):
                out.append((d, float(a), float(b)))
        return out
    curve = []
    for lag in range(-CROSS_LAGS, CROSS_LAGS + 1):
        p = pairs(lag)
        if len(p) >= SIMILAR_MIN_NIGHTS:
            a, b = np.array([v[1] for v in p]), np.array([v[2] for v in p])
            r = float(np.corrcoef(a, b)[0, 1]) if a.std() > 0 and b.std() > 0 else float("nan")
            curve.append(dict(lag=lag, r=r, n=len(p)))
    zero = next((c for c in curve if c["lag"] == 0), None)
    if not zero or not np.isfinite(zero["r"]):
        raise ValueError("אין מספיק לילות שבהם שני המוצרים ראו את המקום (צריך %d לפחות)." % SIMILAR_MIN_NIGHTS)
    clear = lambda c: np.isfinite(c["r"]) and abs(c["r"]) >= max(CROSS_MIN_R, 2.6 / math.sqrt(c["n"]))
    best = max((c for c in curve if np.isfinite(c["r"])), key=lambda c: abs(c["r"]))
    strict = abs(best["r"]) >= max(0.3, 3.5 / math.sqrt(best["n"]))
    lead = best if best["lag"] != 0 and strict and abs(best["r"]) >= abs(zero["r"]) + 0.1 else None
    return dict(r=zero["r"], n=zero["n"], clear=bool(clear(zero)), lags=curve, lead=lead, 
                pairs=[[d, a, b] for d, a, b in pairs(0)])


def area(body):
    """One window, both products: light against heat inside it, and the places related to its lights and to its heat."""
    x, y, size = float(body["x"]), float(body["y"]), float(body["size_km"])
    lo, hi = body.get("from") or "", body.get("to") or "9999"
    out, seeds = dict(x=x, y=y, size_km=size), {}
    for p in ("temper", "lightroast"):
        try:
            _check_products(p)
            series, centre, info = seed_series(p, x, y, size)
            seeds[p] = (series, centre)
            out[p] = dict(info, profile=series_profile(series, p, info))
        except ValueError as e:
            out[p] = dict(error=str(e))
    quiet = {p: quiet_reason(out[p]["profile"], p) for p in seeds}
    try:
        if not ("temper" in seeds and "lightroast" in seeds):
            raise ValueError(out.get("temper", {}).get("error") or out.get("lightroast", {}).get("error"))
        if quiet["temper"] or quiet["lightroast"]:
            out["cross"] = dict(error=quiet["lightroast"] or quiet["temper"], skipped=True)
        else:
            out["cross"] = cross(seeds["temper"][0], seeds["lightroast"][0], lo, hi)
    except ValueError as e:
        out["cross"] = dict(error=str(e))
    out["related"] = {}
    for p, (series, centre) in seeds.items():
        if quiet[p]:
            out["related"][p] = dict(error=quiet[p], skipped=True)
            continue
        try:
            out["related"][p] = match(series, centre, p, lo, hi, half=size * 500, top=5, top_negative=3)
        except ValueError as e:
            out["related"][p] = dict(error=str(e))
    return out


def annotate_heat(result, ds):
    """Shared-workspace comparison: mark each night-lights change where TEMPER saw heat (a source above its hot-spot
    threshold, within two pixels) on the nights compared, i.e. a flare or a fire rather than lighting. Uses TEMPER's
    prepared change summaries for the same night labels; `heat` = how many of those nights, of `heat_nights`."""
    if result.get("heat_checked"):
        return result
    nights = [d for d in result["recent"] + result["context"] if d in ds.days]
    states = [s for s in (ds.change_state(d, build=False) for d in nights) if s is not None]
    W, H = ds.profile["width"], ds.profile["height"]
    t = ds.profile["transform"]
    for e in result["events"]:
        col, row = ~t * (e["x"], e["y"])
        row, col = int(row), int(col)
        near = np.array([(row + a) * W + col + b for a in range(-2, 3) for b in range(-2, 3) if 0 <= row + a < H and 0 <= col + b < W])
        e["heat"] = int(sum(bool(len(s["idx"])) and bool(np.isin(near, s["idx"]).any()) for s in states))
        e["heat_nights"] = len(states)
    result["heat_checked"] = bool(states)
    return result


def lights_window(q):
    try:
        window = int(q.get("window", [lightroast.DEFAULT_WINDOW])[0])
    except ValueError:
        window = lightroast.DEFAULT_WINDOW
    low, high = lightroast.WINDOW_RANGE
    if not low <= window <= high:
        raise ValueError(f"תקופת הבסיס: {low} עד {high} לילות.")
    return window


# ---------- countries: outlines, folders and the nights they hold ----------
def natural_earth(name):
    """The bundled Natural Earth feature for a country folder name, matched on its English names."""
    global NATURAL_EARTH
    if NATURAL_EARTH is None:
        index = {}
        for f in json.loads(BASEMAP.read_text(encoding="utf-8"))["features"]:
            for key in ("NAME", "NAME_LONG", "ADMIN", "NAME_EN"):
                if f["properties"].get(key):
                    index.setdefault(f["properties"][key].lower(), f)
        NATURAL_EARTH = index
    return NATURAL_EARTH.get(name.lower())


def hebrew_name(name):
    f = natural_earth(name)
    return (f and f["properties"].get("NAME_HE")) or name


_AOI_CACHE = {}
ADDITIONS = STATIC / "basemap" / "additions.geojson"   # areas added to a country's outline (Gaza to Israel)


def outline_additions(country):
    """Geometries that additions.geojson adds to this country folder's outline (property add_to = folder name)."""
    if not ADDITIONS.exists():
        return []
    return [make_valid(shape(f["geometry"])) for f in json.loads(ADDITIONS.read_text(encoding="utf-8"))["features"]
            if str(f["properties"].get("add_to", "")).lower() == str(country).lower()]


def merge_outlines(geometries):
    """Union of outlines. Where an addition meets the coarse 1:110m outline the edges never match exactly, leaving thin
    gaps; holes under 0.01 deg² (~100 km²) are closed so those pixels stay inside."""
    merged = make_valid(unary_union([make_valid(g) for g in geometries]))
    parts = merged.geoms if merged.geom_type in ("MultiPolygon", "GeometryCollection") else [merged]
    return unary_union([Polygon(p.exterior, [r for r in p.interiors if Polygon(r).area >= .01]) for p in parts if p.geom_type == "Polygon"])


def with_additions(aoi, country):
    """The outline plus its additions (additions.geojson)."""
    extra = outline_additions(country)
    return mapping(merge_outlines([shape(aoi)] + extra)) if aoi and extra else aoi


def folder_aoi(folder):
    """The outline a country folder is analysed with: the one its data was pulled for (a processed night's manifest,
    else the year inventory) plus additions.geojson. None when neither records one."""
    folder = Path(folder)
    files = sorted((folder / "proccessed_data").glob("*/manifest.json"))[:1] or sorted((folder / "raw_data").glob("year_*_inventory.json"))[:1]
    if not files:
        return None
    key = (str(files[0]), files[0].stat().st_mtime_ns)
    if key not in _AOI_CACHE:
        record = json.loads(files[0].read_text(encoding="utf-8"))
        _AOI_CACHE[key] = with_additions(record.get("configuration", {}).get("aoi") or record.get("aoi"), folder.name)
    return _AOI_CACHE[key]


def list_countries(root):
    """Country folders under the data root: anything with raw_data or proccessed_data."""
    root = Path(root).expanduser().resolve()
    if not root.is_dir():
        raise ValueError("התיקייה לא קיימת.")
    countries = []
    for child in sorted(root.iterdir(), key=lambda p: p.name.lower()):
        if not child.is_dir() or not ((child / "raw_data").is_dir() or (child / "proccessed_data").is_dir()):
            continue
        f = natural_earth(child.name)
        aoi = folder_aoi(child)   # the analysed outline (Israel's includes the West Bank); Natural Earth otherwise
        outline = mapping(make_valid(shape(aoi or f["geometry"])).simplify(.05)) if aoi or f else None
        first, last, count = night_range(child)
        lr_first, lr_last, lr_count = lights_range(lightroast_root() / child.name)
        countries.append(dict(name=child.name, name_he=hebrew_name(child.name), path=str(child), first=first, last=last, nights=count, outline=outline, 
                              lightroast_first=lr_first, lightroast_last=lr_last, lightroast_nights=lr_count))
    return dict(root=str(root), countries=countries, current=str(DATASET.root) if DATASET else None)


_LR_RANGES = {}


def lights_range(folder):
    """First and last LIGHT ROAST night of a country and the number of nights, from its year inventories (no rasters
    opened)."""
    files = sorted((Path(folder) / "raw_data").glob("year_*_inventory.json"))
    if not files:
        return None, None, 0
    key = tuple((str(f), f.stat().st_mtime_ns) for f in files)
    if key not in _LR_RANGES:
        dates = {s["date"] for f in files for s in json.loads(f.read_text(encoding="utf-8")).get("sources", []) if s.get("date")}
        _LR_RANGES[key] = (min(dates), max(dates), len(dates)) if dates else (None, None, 0)
    return _LR_RANGES[key]


def night_range(folder):
    """First and last available night and the number of nights, without opening the rasters: an open, unchanged
    dataset if there is one, else processed-night folders plus year-inventory nights whose M10.tif exists."""
    key = str(folder.resolve())
    with LOCK:
        cached = DATASETS.get(key)
    if cached and cached[0] == folder_signature(key):
        return cached[1].dates[0], cached[1].dates[-1], len(cached[1].dates)
    nights = {p.parent.name for p in (folder / "proccessed_data").glob("*/manifest.json")}
    raw = folder / "raw_data" if (folder / "raw_data").is_dir() else folder
    for inventory in raw.glob("year_*_inventory.json"):
        try:
            for item in json.loads(inventory.read_text(encoding="utf-8")).get("sources", []):
                if (bundle_path(raw, item["path"]) / "M10.tif").is_file():
                    nights.add(item["night"])
        except (OSError, ValueError, KeyError):
            continue
    nights = sorted(n for n in nights if re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(n)))
    return (nights[0], nights[-1], len(nights)) if nights else (None, None, 0)


def folder_signature(path):
    """Changes whenever bundles, inventories or manifests are added or rewritten."""
    root = Path(path)
    raw = root / "raw_data" if (root / "raw_data").is_dir() else root
    parts = [raw.stat().st_mtime_ns]
    parts += [(p.name, p.stat().st_mtime_ns) for p in sorted(raw.glob("year_*_inventory.json"))]
    parts += [(p.parent.name, p.stat().st_mtime_ns) for p in sorted((root / "proccessed_data").glob("*/manifest.json"))]
    return tuple(parts)


def open_dataset(path):
    key = str(Path(path).expanduser().resolve())
    if not Path(key).is_dir():
        raise ValueError("התיקייה לא קיימת.")
    signature = folder_signature(key)
    with LOCK:
        cached = DATASETS.get(key)
    if cached and cached[0] == signature:
        return cached[1]
    dataset = Dataset(key)
    with LOCK:
        DATASETS[key] = (signature, dataset)
    return dataset


def projected(geometry, crs):
    geometry = make_valid(shape(geometry))
    if geometry.geom_type not in ("Polygon", "MultiPolygon"):
        raise ValueError("נדרשים פוליגונים בקווי אורך ורוחב.")
    convert = Transformer.from_crs(4326, crs, always_xy=True).transform
    return mapping(transform(segmentize(geometry, .05), convert, interleaved=False))


# ---------- Dataset: one country's TEMPER data (layers, clouds, samples, hot spots, changes) ----------
class Dataset:
    def __init__(self, root):
        self.root = Path(root).expanduser().resolve()
        if not self.root.is_dir():
            raise ValueError("בתיקייה אין raw_data ואין קובצי TIFF.")
        self.raw_root = self.root / "raw_data" if (self.root / "raw_data").is_dir() else self.root
        self.days = {}
        self.country = None
        self.locks = {}
        # Existing manifests/provenance supply geometry only. Image values always come from raw TIFFs.
        for f in sorted((self.root / "proccessed_data").glob("*/manifest.json")):
            m = json.loads(f.read_text(encoding="utf-8"))
            sources = []
            for source in m.get("sources", []):
                folder = self.raw_root / bundle_name(source["raw_bundle"])
                if not (folder / "M10.tif").is_file():
                    folder = Path(source["raw_bundle"])
                if (folder / "M10.tif").is_file():
                    sources.append(self.source(folder / "M10.tif", source["index"], read=False))
            if not sources:
                continue
            # Profile and polygon are metadata; never read harmonized radiance.
            with rasterio.open(f.parent / "M10.tif") as ds:
                profile = ds.profile.copy()
            self.days[f.parent.name] = dict(sources=sources, profile=profile, 
                                             provenance=f.parent / "provenance.npz")
            self.country = m.get("configuration", {}).get("aoi", self.country)
        # Growing raw-only year exports have explicit local-night inventories.
        # Include these alongside the older six processed-night metadata records.
        for inventory_path in sorted(self.raw_root.glob("year_*_inventory.json")):
            inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
            self.country = self.country or inventory.get("aoi")
            if self.days:
                raw_profile = next(iter(self.days.values()))["profile"]
            elif self.country:
                crs = rasterio.crs.CRS.from_epsg(6933)
                geometry = shape(projected(mapping(box(*shape(self.country).bounds)), crs))
                west, south, east, north = geometry.bounds
                res = 750
                west, south = math.floor(west / res) * res, math.floor(south / res) * res
                east, north = math.ceil(east / res) * res, math.ceil(north / res) * res
                raw_profile = dict(crs=crs, transform=from_origin(west, north, res, res), 
                                 width=round((east-west)/res), height=round((north-south)/res))
            else:continue
            known = {s["path"].resolve() for day in self.days.values() for s in day["sources"]}
            for item in inventory.get("sources", []):
                path = bundle_path(self.raw_root, item["path"])/"M10.tif"
                if not path.exists() or path.resolve() in known:continue
                day = self.days.setdefault(item["night"], dict(sources=[], profile=raw_profile.copy(), provenance=None))
                if day["provenance"]:
                    # Keep a saved geometric selection immutable for its original source list.
                    continue
                day["sources"].append(self.source(path, len(day["sources"])+1, read=False))
                known.add(path.resolve())
        if not self.days:
            paths = sorted(self.raw_root.glob("*/M10.tif"))
            if not paths:
                paths = sorted(self.raw_root.glob("*.tif"))
            for path in paths:
                s = self.source(path, 1)
                if not s["time"]:
                    raise ValueError("לקובצי ה־TIFF חסר התג time_start_utc.")
                day = s["time"][:10]
                self.days.setdefault(day, dict(sources=[], provenance=None))["sources"].append(s)
            if self.days:
                # A common grid across all dates so every sampled window has the same pixel support.
                bounds = []
                for path in paths:
                    with rasterio.open(path) as ds:bounds.append(ds.bounds)
                with rasterio.open(paths[0]) as ds:
                    base = ds.profile.copy()
                    resolution = ds.res[0]
                    target_crs = ds.crs
                for p in paths:
                    with rasterio.open(p) as ds:
                        if ds.crs != target_crs or not ds.crs.is_projected:
                            raise ValueError("כל קובצי ה־TIFF צריכים אותו היטל, במטרים.")
                left, bottom = min(b.left for b in bounds), min(b.bottom for b in bounds)
                right, top = max(b.right for b in bounds), max(b.top for b in bounds)
                base.update(transform=from_origin(left, top, resolution, resolution), 
                            width=int(np.ceil((right-left)/resolution)), height=int(np.ceil((top-bottom)/resolution)))
                for day in self.days.values():
                    day["profile"] = base.copy()
                    for i, s in enumerate(day["sources"], 1):
                        s["index"] = i
        if not self.days:
            raise ValueError("לא נמצאו קובצי M10 עם תאריך בתיקייה.")
        self.country = with_additions(self.country, self.root.name)   # e.g. Gaza for Israel (additions.geojson)
        # Identifies the outline in caches that depend on it (change summaries); the night layers' noise fit used the
        # outline of the day they were built, which a small addition barely changes.
        self.outline_key = hashlib.sha256(json.dumps(self.country, sort_keys=True).encode()).hexdigest()[:12] if self.country else "none"
        self.dates = sorted(self.days)
        self.profile = self.days[self.dates[0]]["profile"]
        crs = self.profile["crs"]
        if not crs or not crs.is_projected or "metre" not in crs.linear_units.lower() and "meter" not in crs.linear_units.lower():
            raise ValueError("הדגימה דורשת רשת מוטלת במטרים.")
        for day in self.days.values():
            p = day["profile"]
            if any(p[k] != self.profile[k] for k in ("crs", "transform", "height", "width")):
                raise ValueError("לרשתות של הלילות אין גריד משותף.")
        self.bounds = rasterio.transform.array_bounds(self.profile["height"], self.profile["width"], self.profile["transform"])
        self.to_lonlat = Transformer.from_crs(crs, 4326, always_xy=True)
        # The cache is kept per night: one folder per country and grid, each night's files valid while that night's
        # source files are unchanged (nights.json), so a new night rebuilds only itself and what reads its neighbours.
        self.id = self.stable_id()
        self.cache = CACHE / self.id
        legacy = CACHE / self.signature_id()   # the earlier key, over every night's sources: moved over once
        if not self.cache.exists() and legacy.is_dir():
            try:
                legacy.rename(self.cache)
            except OSError:   # still open in another process: keep using it this time
                self.id, self.cache = legacy.name, legacy
        self.cache.mkdir(exist_ok=True)
        self.reconcile_nights()

    def stable_id(self):
        p = self.profile
        key = "|".join([self.root.name, str(p["crs"]), str(tuple(p["transform"])[:6]), f"{p['width']}x{p['height']}"])
        return "t-" + hashlib.sha256(key.encode()).hexdigest()[:16]

    def night_signature(self, date):
        parts = []
        for s in self.days[date]["sources"]:
            try:
                rel = s["path"].relative_to(self.root).as_posix()
            except ValueError:
                rel = str(s["path"])
            st = s["path"].stat()
            parts.append(f"{rel}:{st.st_size}:{st.st_mtime_ns}")
        prov = self.days[date].get("provenance")
        if prov and Path(prov).exists():
            parts.append(f"prov:{Path(prov).stat().st_mtime_ns}")
        return hashlib.sha256("|".join(parts).encode()).hexdigest()[:16]

    def reconcile_nights(self):
        """Keep each night's cached files while its sources are unchanged. A changed or removed night loses its
        files. Around every changed, new or removed night, what reads neighbouring nights is rebuilt: cloud flags
        and change summaries within 21 days; stored change results of the 10 days before it (their follow-up looks
        ahead) and the 30 days after it (their context looks back)."""
        path = self.cache / "nights.json"
        now = {d: self.night_signature(d) for d in self.dates}
        try:
            before = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            before = None
        if before is not None:
            touched = [d for d in set(before) | set(now) if before.get(d) != now.get(d)]
            for d in touched:
                if d in before:   # changed or removed: its own files go
                    for f in self.cache.glob(f"{d}.*"):
                        try:
                            f.unlink()
                        except OSError:
                            pass
            if touched:
                days = [datetime.fromisoformat(d).toordinal() for d in touched]
                for e in self.dates:
                    k = datetime.fromisoformat(e).toordinal()
                    stale = []
                    if any(abs(k - t) <= 21 for t in days):
                        stale += [self._v2(e, CLOUD + ".npy")] + list(self.cache.glob(f"{e}.{LAYERS}.s*.npz"))
                    # night k reads its context before it and its follow-up after
                    if any(-30 <= t - k <= 10 for t in days):
                        stale += list(self.cache.glob(f"{e}.{LAYERS}.events*.json"))
                    for f in stale:
                        try:
                            f.unlink()
                        except OSError:
                            pass
        if before != now:
            path.write_text(json.dumps(now, sort_keys=True), encoding="utf-8")

    def signature_id(self, root_text=None, relative=True):
        """The cache key: the country and every source file's path, size and modification time. Paths are relative to
        the country folder, so moving or renaming the data root keeps the cache. relative=False with root_text gives
        the earlier absolute-path key, for moving caches built before this (migrate_cache)."""
        def text(path):
            if relative:
                try:
                    return path.relative_to(self.root).as_posix()
                except ValueError:
                    return str(path)
            return str(path).replace(str(self.root), root_text, 1) if root_text else str(path)
        signature = [self.root.name if relative else (root_text or str(self.root))]
        for date, day in self.days.items():
            for s in day["sources"]:
                stat = s["path"].stat()
                signature.append(f"{date}:{text(s['path'])}:{stat.st_size}:{stat.st_mtime_ns}")
        return hashlib.sha256("|".join(signature).encode()).hexdigest()[:16]

    @staticmethod
    def source(path, index, read=True):
        """One pass. read: open the file for its pass time (needed only without an inventory, which dates every pass).
        Opening a country used to read every pass's file and project its footprint: 12 s for Israel's 546 passes."""
        time = ""
        if read:
            with rasterio.open(path) as ds:
                if ds.count != 1:
                    raise ValueError("נדרשים קובצי M10 בערוץ אחד.")
                time = ds.tags().get("time_start_utc", "")
        return dict(index=index, path=path, name=path.parent.name if path.name == "M10.tif" else path.name, time=time)

    def metadata(self):
        west, south, east, north = self.bounds
        polygon = projected(self.country, self.profile["crs"]) if self.country else None
        return dict(id=self.id, root=str(self.root), name=self.root.name, name_he=hebrew_name(self.root.name), 
                    dates=self.dates, crs=str(self.profile["crs"]), 
                    bounds=[west, south, east, north], width=self.profile["width"], height=self.profile["height"], 
                    resolution=abs(self.profile["transform"].a), country=polygon, 
                    units="W m⁻² µm⁻¹ sr⁻¹", change_window=change_context(), change_window_range=list(CHANGE_WINDOW_RANGE), source_count=sum(len(d["sources"]) for d in self.days.values()), 
                    # the passes' footprints stay here: sent per night they were 76 MB for Saudi Arabia
                    passes={date: len(day["sources"]) for date, day in self.days.items()},
                    method="Raw calibrated radiance; per pixel the pass with the smallest view zenith. No radiometric correction.", 
                    caveat="Valid zeros included. Clouds flagged from M15 against each place's clear-sky reference, not removed. "
                           "Window averages describe gridded pixels.")

    def array(self, date):
        """The night's radiance mosaic used everywhere: see layers()."""
        return self.layers(date)["value"]

    # ---------- analysis layers ----------
    def _v2(self, date, part, version=LAYERS):
        return self.cache / f"{date}.{version}.{part}"

    def layers_version(self, date):
        """The newest layer format built for the night, or None."""
        return next((v for v in (LAYERS, *OLDER_LAYERS) if self._v2(date, "json", v).exists()), None)

    def layers_ready(self, date):
        return self.layers_version(date) is not None

    def layers(self, date):
        """The night's analysis layers, built once and cached next to the image:
        value  radiance of the pass with the smallest view zenith at each pixel. Near nadir VIIRS averages 3
               detector samples and pixels are smallest; at the swath edge noise is ~1.6x higher.
        vza    that view zenith in half degrees (255 = unknown)
        rep    True on the first grid copy of each native sample (gridding copies edge samples into 2-3 pixels)
        m11    M11 (2.25 µm) radiance of the same native sample (bands.py), NaN where the pass has no M11
        m15, m16  M15 (10.76 µm) / M16 (12.0 µm) brightness temperature of the same sample, uint16 in KELVIN_STEP,
               0 = none; None while the night is still served from an older format
        noise  the night's noise model (_fit_noise), with the M11 model under "m11" """
        if date not in self.days:
            raise ValueError("אין נתונים ללילה הזה.")
        with LOCK:
            self._v2locks = getattr(self, "_v2locks", {})
            lock = self._v2locks.setdefault(date, threading.Lock())
        with lock:
            version = self.layers_version(date)
            if version is None:
                self._build_layers(date)
                version = LAYERS
        load = lambda part: np.load(self._v2(date, part, version), mmap_mode="r", allow_pickle=False)
        thermal = version == LAYERS
        return dict(value=load("value.npy"), vza=load("vza.npy"), rep=load("rep.npy"), m11=load("m11.npy"), 
                    m15=load("m15.npy") if thermal else None, m16=load("m16.npy") if thermal else None, 
                    noise=self.noise_model(date), version=version)

    def upgrade_layers(self, date):
        """Rebuild a night served from an older layer format (background worker)."""
        with LOCK:
            self._v2locks = getattr(self, "_v2locks", {})
            lock = self._v2locks.setdefault(date, threading.Lock())
        with lock:
            if self.layers_version(date) != LAYERS:
                self._build_layers(date)

    def _build_layers(self, date):
        p = self.profile
        H, W, t = p["height"], p["width"], p["transform"]
        res = t.a
        value = np.full((H, W), np.nan, np.float32)
        m11 = np.full((H, W), np.nan, np.float32)
        m15 = np.zeros((H, W), np.uint16)
        m16 = np.zeros((H, W), np.uint16)
        vza = np.full((H, W), np.inf, np.float32)
        key = np.full((H, W), -1, np.int64)
        geometry = True
        for k, s in enumerate(self.days[date]["sources"], 1):
            prov = s["path"].parent / "provenance.npz"
            try:   # M11/M15/M16 from the archived granule, when it is reachable and they are not added yet (bands.py)
                bands.build(s["path"].parent)
            except (OSError, ValueError, KeyError) as exc:
                print("M11/M15/M16 unavailable", s["path"].parent.name, exc, flush=True)
            with rasterio.open(s["path"]) as src:
                st = src.transform
                col, row = (st.c - t.c) / res, (t.f - st.f) / res
                if (src.crs != p["crs"] or abs(st.a - res) > 1e-6 or abs(st.e + res) > 1e-6 or not prov.exists()
                        or abs(col - round(col)) > 1e-6 or abs(row - round(row)) > 1e-6):
                    geometry = False
                    break
                col, row = int(round(col)), int(round(row))
                r0, c0, r1, c1 = max(0, row), max(0, col), min(H, row + src.height), min(W, col + src.width)
                if r1 <= r0 or c1 <= c0:
                    continue
                window = Window(c0 - col, r0 - row, c1 - c0, r1 - r0)
                v = src.read(1, window=window, masked=True).filled(np.nan)
                source_shape = (src.height, src.width)
            w11 = np.full(v.shape, np.nan, np.float32)
            if (s["path"].parent / "M11.tif").is_file():
                with rasterio.open(s["path"].parent / "M11.tif") as src:
                    w11 = src.read(1, window=window, masked=True).filled(np.nan)
            thermal = {}
            for band in bands.THERMAL:
                thermal[band] = np.zeros(v.shape, np.uint16)
                if bands.present(s["path"].parent, band):
                    with rasterio.open(s["path"].parent / f"{band}.tif") as src:
                        thermal[band] = src.read(1, window=window)   # stored hundredths of a kelvin, 0 = none
            with np.load(prov, allow_pickle=False) as z:
                if not {"valid", "view_zenith", "native_index"} <= set(z.files):
                    geometry = False
                    break
                pv = z["valid"]
                if pv.shape != source_shape:
                    geometry = False
                    break
                sl = (slice(r0 - row, r1 - row), slice(c0 - col, c1 - col))
                pv, pz, pn = pv[sl], z["view_zenith"][sl], z["native_index"][sl]
            dst = (slice(r0, r1), slice(c0, c1))
            take = pv & np.isfinite(v) & np.isfinite(pz) & (pz < vza[dst])
            value[dst][take] = v[take]
            m11[dst][take] = w11[take]
            m15[dst][take] = thermal["M15"][take]
            m16[dst][take] = thermal["M16"][take]
            vza[dst][take] = pz[take]
            key[dst][take] = (np.int64(k) << 24) | pn[take].astype(np.int64)
        if geometry:
            rep = np.zeros((H, W), bool)
            ok = np.flatnonzero(np.isfinite(value) & (key >= 0))
            _, first = np.unique(key.ravel()[ok], return_index=True)
            rep.ravel()[ok[first]] = True
            # pass index (1-based in source order), 0 = none
            chosen = np.where(key >= 0, key >> 24, 0).astype(np.uint8)
        else:
            # A pass without geometry layers or on another grid: the previous mosaic, every pixel its own sample.
            value = np.array(self._legacy_array(date), dtype=np.float32)
            m11 = np.full((H, W), np.nan, np.float32)
            m15[:] = 0
            m16[:] = 0
            vza = np.full((H, W), np.inf, np.float32)
            rep = np.isfinite(value)
            chosen = np.zeros((H, W), np.uint8)
        del key
        model = self._fit_noise(value, vza, rep, geometry)
        model["m11"] = self._fit_noise(m11, vza, rep, geometry) if np.isfinite(m11).any() else None
        inside = np.isfinite(value) & self.country_mask() & rep
        model["m11_coverage"] = float((inside & np.isfinite(m11)).sum() / max(1, inside.sum()))
        model["thermal_coverage"] = float((inside & (m15 > 0)).sum() / max(1, inside.sum()))
        vza8 = np.where(np.isfinite(vza), np.clip(np.round(vza * 2), 0, 254), 255).astype(np.uint8)
        for part, array in (("value.npy", value), ("vza.npy", vza8), ("rep.npy", rep), ("m11.npy", m11), 
                            ("m15.npy", m15), ("m16.npy", m16), ("pass.npy", chosen)):
            temp = self._v2(date, "partial." + part)
            np.save(temp, array, allow_pickle=False)
            temp.replace(self._v2(date, part))
        # written last: marks the night complete
        self._v2(date, "json").write_text(json.dumps(model), encoding="utf-8")
        print("LAYERS", date, "nearest-nadir" if geometry else "legacy", flush=True)

    def sweep_older_layers(self):
        """Delete older-format files of nights rebuilt in the current format. Files still open (memory-mapped by a
        request) are left for the next sweep. Returns how many remain."""
        left = 0
        for date in self.dates:
            if self.layers_version(date) != LAYERS:
                continue
            stale = [f for old in OLDER_LAYERS for f in self.cache.glob(f"{date}.{old}.*")]
            if self._v2(date, CHANGE + ".npz").exists():   # change summaries of an earlier format
                stale += [f for f in self.cache.glob(f"{date}.{LAYERS}.s*.npz") if f.name != f"{date}.{LAYERS}.{CHANGE}.npz"]
            for f in stale:
                try:
                    f.unlink()
                except OSError:
                    left += 1
        return left

    def _fit_noise(self, value, vza, rep, geometry):
        """The night's noise model. bias: mean of the clipped noise per 5-degree view-zenith band (top 0.1% left out,
        so sources do not count). Clipping negative noise to zero adds exactly this to any average, and it is the
        noise scale. fit: Heimdall's EVT (evt.py, no trimming) on radiance / bias, one value per native sample,
        inside the country."""
        inside = np.isfinite(value) & self.country_mask()
        samples = inside & rep
        bands, bias = [], []
        if geometry:
            for lo in np.arange(0, 90, NOISE_BAND):
                sel = samples & (vza >= lo) & (vza < lo + NOISE_BAND)
                if sel.sum() >= 2000:
                    x = value[sel]
                    bands.append(float(lo + NOISE_BAND / 2))
                    bias.append(float(np.mean(x[x <= np.percentile(x, 99.9)])))
        if not bands and samples.any():
            x = value[samples]
            bands, bias = [0.0], [float(np.mean(x[x <= np.percentile(x, 99.9)]))]
        model = dict(version=2, geometry=geometry, bands=bands, bias=[max(b, 1e-5) for b in bias], samples=int(samples.sum()), fit=None)
        if bands:
            z = np.where(inside, value / self._bias_of(np.where(np.isfinite(vza), vza, np.nan), model), np.nan)
            try:
                model["fit"] = evt.threshold(z, max_tail=20000, samples=rep)[1]
            except ValueError:
                pass
        return model

    def noise_model(self, date):
        with LOCK:
            self._models = getattr(self, "_models", {})
            version = self.layers_version(date)
            model = self._models.get((date, version))
        if model is None:
            model = json.loads(self._v2(date, "json", version).read_text(encoding="utf-8"))
            with LOCK:
                self._models[(date, version)] = model
        return model

    @staticmethod
    def _deg(vza8):
        vza8 = np.asarray(vza8)
        return np.where(vza8 == 255, np.nan, vza8 / 2.0).astype(np.float32)

    @staticmethod
    def _bias_of(deg, model):
        if not model["bands"]:
            return np.full(np.shape(deg), np.nan, np.float32)
        deg = np.where(np.isfinite(deg), deg, model["bands"][0])
        return np.interp(deg, model["bands"], model["bias"]).astype(np.float32)

    def limit(self, model, deg, budget):
        """Detection threshold per pixel: the EVT threshold in noise units times the local noise level."""
        if not model.get("fit"):
            return np.full(np.shape(deg), np.inf, np.float32)
        return (evt.quantile(model["fit"], budget / model["fit"]["N"]) * self._bias_of(deg, model)).astype(np.float32)

    def significance(self, model, deg, values):
        """How far a pixel is above the night's noise for its view zenith, in noise standard deviations:
        (value - clipped-noise mean) / sd, with sd = that mean * sqrt(2 pi) (zero-mean noise clipped at 0).
        Checked on Saudi 20 Oct 2026 against the 84th percentile of the noise: within ~10% at every angle.
        The far tail is heavier than Gaussian at the swath edge, so it is a scale, not a probability."""
        if not model or not model["bands"]:
            return np.full(np.shape(values), np.nan, np.float32)
        b = self._bias_of(deg, model)
        return ((values - b) / (b * SQRT_2PI)).astype(np.float32)

    # ---------- cloud screening (M15) ----------
    def cloud_nights(self, date):
        i = self.dates.index(date)
        return self.dates[max(0, i - CLOUD_NIGHTS): i + CLOUD_NIGHTS + 1]

    def cloud_ready(self, date):
        return self._v2(date, CLOUD + ".npy").exists()

    def cloud_possible(self, date):
        """The night and at least CLOUD_MIN_VALID nights of its window have current layers. The worker builds
        clouds only after every night it can build has current layers, so a night that fails to build is left
        out of its neighbours' references instead of blocking them."""
        return (self.layers_version(date) == LAYERS
                and sum(self.layers_version(d) == LAYERS for d in self.cloud_nights(date)) >= CLOUD_MIN_VALID)

    def cloud(self, date):
        """The night's M15 drop below the clear-sky reference (see CLOUD_*), int8 in half kelvins, -128 = unknown;
        None until the background worker has prepared it (prepare_cloud)."""
        path = self._v2(date, CLOUD + ".npy")
        return np.load(path, mmap_mode="r", allow_pickle=False) if path.exists() else None

    def prepare_cloud(self, date):
        with LOCK:
            self._cloudlocks = getattr(self, "_cloudlocks", {})
            lock = self._cloudlocks.setdefault(date, threading.Lock())
        with lock:
            if not self.cloud_ready(date) and self.cloud_possible(date):
                self._build_cloud(date)

    def _build_cloud(self, date):
        nights = [d for d in self.cloud_nights(date) if self.layers_version(d) == LAYERS]
        stack = np.stack([np.asarray(self.layers(d)["m15"]) for d in nights])
        n = len(nights)
        valid = (stack > 0).sum(axis=0)
        rank = min(CLOUD_RANK, n)
        reference = np.partition(stack, n - rank, axis=0)[n - rank]   # rank-th warmest; no-data (0) sorts coldest
        del stack
        bt = np.asarray(self.layers(date)["m15"])
        known = (bt > 0) & (reference > 0) & (valid >= CLOUD_MIN_VALID)
        drop = np.where(known, (bt.astype(np.float32) - reference) * KELVIN_STEP, 0).astype(np.float32)
        drop = ndimage.median_filter(drop, size=CLOUD_SMOOTH, mode="nearest")   # unknown pixels count as no change
        out = np.where(known, np.clip(np.round(drop * 2), -127, 127), -128).astype(np.int8)
        temp = self._v2(date, "partial." + CLOUD + ".npy")
        np.save(temp, out, allow_pickle=False)
        temp.replace(self._v2(date, CLOUD + ".npy"))

    @staticmethod
    def cloudy(drop8):
        """Cloud flags from stored drops: True cloud, False clear; the second array marks known pixels."""
        drop8 = np.asarray(drop8)
        return drop8 <= -2 * CLOUD_DROP_K, drop8 != -128

    def m11_confirmation(self, model, deg, m11):
        """Where M11 is above its own noise (per-sample false-alarm rate m11_confirm_far()), grown by one pixel so
        a source counts as confirmed when M11 sees it in the same or a neighbouring pixel. None without M11."""
        m = model.get("m11")
        if not m or not m.get("fit"):
            return None
        hit = np.nan_to_num(m11) > self.limit(m, deg, m11_confirm_far() * m["fit"]["N"])
        return ndimage.binary_dilation(hit, structure=np.ones((3, 3)))

    def source_physics(self, region, value, m11, rep, deg, model, core=None):
        """Temperature, emitting area and radiant heat of a source, measured on its detected pixels alone (core) and
        with their one-pixel ring (region); the clearer of the two in both bands is kept (`cells` says how many
        pixels were summed). The ring catches a source spread over neighbouring pixels; for a source in one pixel it
        only adds noise: at 30.678 N 35.256 E on 28 Jul 2026, near the swath edge, a pixel at 12 sigma in M10 and 37 in
        M11 (905 +- 48 C on its own) summed with its ring to 2.6 and 10.9 sigma, and had no temperature."""
        best = {}
        for part in (region,) if core is None else (core, region):
            r = self._physics(part, value, m11, rep, deg, model)
            if r and (not best or ("temperature_k" in r, min(r["snr10"], r["snr11"])) > ("temperature_k" in best, min(best["snr10"], best["snr11"]))):
                best = r
        return best

    def _physics(self, region, value, m11, rep, deg, model):
        """The source in `region`, from the sums of noise-corrected radiance in both bands: each pixel's clipped-noise
        mean is subtracted. Per-pixel noise sd = that mean * sqrt(2 pi) (clipped zero-mean noise); the sum's noise grows
        as cells / sqrt(native samples) because gridding copies samples. Area = M10 radiant intensity / Planck(M10, T),
        heat = sigma T^4 area (one blackbody; no atmospheric correction)."""
        m = model.get("m11")
        ok = region & np.isfinite(value) & np.isfinite(m11)
        if not ok.any() or not m or not m["bands"]:
            return {}
        b10, b11 = self._bias_of(deg[ok], model), self._bias_of(deg[ok], m)
        s10, s11 = float(np.sum(value[ok] - b10)), float(np.sum(m11[ok] - b11))
        k = int(ok.sum()) / math.sqrt(max(1, int((ok & rep).sum()))) * math.sqrt(2 * math.pi)
        sd10, sd11 = float(np.mean(b10)) * k, float(np.mean(b11)) * k
        result = dict(snr10=s10 / sd10, snr11=s11 / sd11, cells=int(ok.sum()))
        tb = two_band_temperature(s10, s11, sd10, sd11)
        if tb:
            t, dt = tb
            area = s10 * abs(self.profile["transform"].a * self.profile["transform"].e) / float(planck(M10_WAVELENGTH_UM, t))
            result.update(temperature_k=t, temperature_sd_k=dt, area_m2=area, heat_mw=STEFAN_BOLTZMANN * t ** 4 * area / 1e6)
        return result

    def _legacy_array(self, date):
        """The previous mosaic: the saved provenance selection, else the first valid pass in inventory order,
        reprojected. Used only when a night's passes lack the geometry layers that layers() needs."""
        if date not in self.days:
            raise ValueError("אין נתונים ללילה הזה.")
        with LOCK:
            lock = self.locks.setdefault(date, threading.Lock())
        with lock:
            target = self.cache / (date + ".npy")
            if not target.exists():
                day = self.days[date]
                p = self.profile
                dest = np.full((p["height"], p["width"]), np.nan, np.float32)
                selection = None
                if day["provenance"] and day["provenance"].exists():
                    with np.load(day["provenance"], allow_pickle=False) as z:
                        if "source_index" in z:
                            selection = z["source_index"]
                for s in day["sources"]:
                    with rasterio.open(s["path"]) as ds:
                        values = ds.read(1, masked=True).filled(np.nan)
                        warped = np.full(dest.shape, np.nan, np.float32)
                        reproject(values, warped, src_transform=ds.transform, src_crs=ds.crs, 
                                  dst_transform=p["transform"], dst_crs=p["crs"], 
                                  src_nodata=np.nan, dst_nodata=np.nan, 
                                  resampling=Resampling.nearest, num_threads=2)
                    use = np.isfinite(warped) & ((selection == s["index"]) if selection is not None else ~np.isfinite(dest))
                    dest[use] = warped[use]
                # Keep genuine selection gaps as NoData; no interpolation or brightness selection.
                temp = target.with_suffix(".partial.npy")
                np.save(temp, dest, allow_pickle=False)
                temp.replace(target)
                print("RAW CACHE", date, flush=True)
            return np.load(target, mmap_mode="r", allow_pickle=False)

    def composite(self, date):
        """M10+M11 composite on the night's corrections: brightness = combined significance (M10 and M11 each in noise
        sd for the pixel's view zenith, summed / sqrt 2; M10 alone where M11 is missing), noise below COMPOSITE_FLOOR
        dark; grey-white where significant, coloured by two-band temperature where both bands are >= 10 sigma."""
        s, temp, valid, _ = self.combo_layers(date)
        return self.combo_png(s, temp, valid)

    def combo_layers(self, date):
        """The night's combined significance, its two-band source temperature (K) where both bands are >= 10 sigma
        (NaN elsewhere), where it was observed, and its M10 radiance."""
        layers = self.layers(date)
        model = layers["noise"]
        v10 = np.asarray(layers["value"], dtype=np.float32)
        v11 = np.asarray(layers["m11"], dtype=np.float32)
        deg = self._deg(layers["vza"])
        z10 = self.significance(model, deg, v10)
        z11 = self.significance(model.get("m11"), deg, v11)
        both = np.isfinite(z10) & np.isfinite(z11)
        s = np.where(both, (z10 + z11) / math.sqrt(2), z10)
        temp = np.full(s.shape, np.nan, np.float32)
        hot = both & (z10 >= 10) & (z11 >= 10)
        if hot.any():
            c10 = v10[hot] - self._bias_of(deg[hot], model)
            c11 = v11[hot] - self._bias_of(deg[hot], model["m11"])
            temp[hot] = np.interp(c10 / c11, _R_TABLE, _T_TABLE)
        return s, temp, np.isfinite(v10), v10

    def combo_png(self, s, temp, valid):
        """The combined view as a PNG (a night's, or a period's strongest nights): grey by significance, coloured by
        source temperature where it was measured; at most 1800 pixels a side."""
        s, temp, valid = np.asarray(s, np.float32), np.asarray(temp, np.float32), np.asarray(valid, bool)
        stride = max(1, int(np.ceil(max(s.shape) / 1800)))
        if stride > 1:
            # Shrink by keeping the most significant pixel of each block, so a one-pixel source never drops out.
            H, W = s.shape
            hb, wb = -(-H // stride), -(-W // stride)
            pad = np.full((hb * stride, wb * stride), -np.inf, np.float32)
            pad[:H, :W] = np.where(np.isfinite(s), s, -np.inf)
            k = pad.reshape(hb, stride, wb, stride).transpose(0, 2, 1, 3).reshape(hb, wb, stride * stride).argmax(axis=2)
            rows = np.minimum(np.arange(hb)[:, None] * stride + k // stride, H - 1)
            cols = np.minimum(np.arange(wb)[None, :] * stride + k % stride, W - 1)
            s, temp, valid = s[rows, cols], temp[rows, cols], valid[rows, cols]
        t = np.clip(np.arcsinh(np.maximum(0, np.nan_to_num(s) - COMPOSITE_FLOOR) / 4) / np.arcsinh((COMPOSITE_TOP - COMPOSITE_FLOOR) / 4), 0, 1)
        grey = 18 + 237 * t
        rgb = np.stack([grey, grey, grey], axis=-1)
        hot = np.isfinite(temp)
        if hot.any():
            ks, cs = [k for k, _ in TEMPERATURE_RAMP], np.array([c for _, c in TEMPERATURE_RAMP], float)
            colour = np.stack([np.interp(temp[hot], ks, cs[:, i]) for i in range(3)], axis=-1)
            rgb[hot] = colour * np.maximum(t[hot], .6)[:, None]
        rgba = np.empty((*s.shape, 4), np.uint8)
        rgba[..., :3] = np.clip(rgb, 0, 255).astype(np.uint8)
        rgba[..., 3] = valid.astype(np.uint8) * 255
        stream = io.BytesIO()
        Image.fromarray(rgba).save(stream, format="PNG")
        return stream.getvalue()

    def thermal_image(self, date):
        """M15 brightness temperature on a fixed scale (THERMAL_LOW_K..THERMAL_HIGH_K) in the infrared-satellite
        convention: warm ground dark, cold cloud tops white. Pixels flagged cloudy are tinted blue."""
        layers = self.layers(date)
        if layers["m15"] is None:
            raise ValueError("השכבה התרמית של הלילה הזה עדיין בהכנה.")
        stride = max(1, int(np.ceil(max(layers["m15"].shape) / 1800)))
        raw = np.asarray(layers["m15"][::stride, ::stride])
        t = np.clip((THERMAL_HIGH_K - raw * KELVIN_STEP) / (THERMAL_HIGH_K - THERMAL_LOW_K), 0, 1)
        grey = 20 + 235 * t
        rgb = np.stack([grey, grey, grey], axis=-1)
        cloud = self.cloud(date)
        if cloud is not None:
            flagged = self.cloudy(cloud[::stride, ::stride])[0]
            rgb[flagged] = rgb[flagged] * .55 + np.array([60, 140, 255]) * .45
        rgba = np.empty((*raw.shape, 4), np.uint8)
        rgba[..., :3] = np.clip(rgb, 0, 255).astype(np.uint8)
        rgba[..., 3] = (raw > 0).astype(np.uint8) * 255
        stream = io.BytesIO()
        Image.fromarray(rgba).save(stream, format="PNG")
        return stream.getvalue()

    def image(self, date, low, high, palette, band="m10"):
        if band == "combo":
            return self.composite(date)
        if band == "m15":
            return self.thermal_image(date)
        if not np.isfinite(low) or not np.isfinite(high) or high <= low:
            raise ValueError("המקסימום חייב להיות גדול מהמינימום.")
        layers = self.layers(date)
        a = layers["m11"] if band == "m11" else layers["value"]
        # asinh softening at about one quantisation step of the band, so noise and sources share one stretch
        soft = .00048 if band == "m11" else .001568
        stride = max(1, int(np.ceil(max(a.shape)/1800)))
        a = a[::stride, ::stride]
        good = np.isfinite(a)
        scaled = np.arcsinh(np.maximum(0, np.nan_to_num(a, nan=low)-low)/soft)
        scaled /= np.arcsinh((high-low)/soft)
        t = np.clip(scaled, 0, 1)
        if palette == "gray":
            color = np.stack([t, t, t], axis=-1)*255
        else:
            stops = np.array([[9, 12, 20], [38, 24, 56], [91, 32, 79], [158, 48, 70], [220, 79, 51], [250, 152, 67], [255, 237, 165]])
            color = np.stack([np.interp(t, np.linspace(0, 1, len(stops)), stops[:, i]) for i in range(3)], axis=-1)
        rgba = np.empty((*a.shape, 4), np.uint8)
        rgba[..., :3] = color.astype(np.uint8)
        rgba[..., 3] = good.astype(np.uint8) * 255
        stream = io.BytesIO()
        Image.fromarray(rgba).save(stream, format="PNG")
        return stream.getvalue()

    def pixel(self, date, x, y):
        """The raw value of one grid pixel and its view zenith, for the hover readout."""
        layers = self.layers(date)
        a = layers["value"]
        col, row = ~self.profile["transform"] * (x, y)
        r, c = math.floor(row), math.floor(col)
        if not (0 <= r < a.shape[0] and 0 <= c < a.shape[1]):
            return dict(inside=False, value=None)
        v = float(a[r, c])
        v = v if math.isfinite(v) else None
        z8 = int(layers["vza"][r, c])
        v11 = float(layers["m11"][r, c])
        v11 = v11 if math.isfinite(v11) and v is not None else None
        result = dict(inside=True, value=v, brightness_temperature_k=brightness_temperature(v), row=r, col=c, m11=v11, 
                      m11_brightness_temperature_k=brightness_temperature(v11, M11_WAVELENGTH_UM), 
                      view_zenith=None if z8 == 255 or v is None else z8 / 2)
        if v is not None:
            # Meaningful per-pixel metrics: distance above the noise in each band, whether the pixel clears the
            # night's detection threshold, and a two-band temperature when both bands are at least 10 sigma.
            model, deg = layers["noise"], np.float32(np.nan if z8 == 255 else z8 / 2)
            z10 = float(self.significance(model, deg, np.float32(v)))
            result.update(sigma10=z10 if math.isfinite(z10) else None, 
                          above_threshold=bool(v > float(self.limit(model, deg, hot_budget()))))
            if v11 is not None and model.get("m11") and model["m11"]["bands"]:
                z11 = float(self.significance(model["m11"], deg, np.float32(v11)))
                result["sigma11"] = z11
                b10, b11 = float(self._bias_of(deg, model)), float(self._bias_of(deg, model["m11"]))
                tb = two_band_temperature(v - b10, v11 - b11, b10 * SQRT_2PI, b11 * SQRT_2PI)
                if tb:
                    result.update(temperature_k=tb[0], temperature_sd_k=tb[1])
        # Thermal: M15 brightness temperature of the same sample (the ground, or the cloud top under cloud), and
        # whether the place is cloudy this night (drop below its clear-sky reference).
        if layers["m15"] is not None and v is not None:
            t15, t16 = int(layers["m15"][r, c]), int(layers["m16"][r, c])
            result.update(m15_k=t15 * KELVIN_STEP if t15 else None, m16_k=t16 * KELVIN_STEP if t16 else None)
            cloud = self.cloud(date)
            if cloud is not None and cloud[r, c] != -128:
                result.update(cloud=bool(cloud[r, c] <= -2 * CLOUD_DROP_K), cloud_drop_k=float(cloud[r, c]) / 2)
        return result

    def basemap(self):
        """Offline background map: Natural Earth 1:110m countries around the dataset, in the dataset's grid.
        Natural Earth countries lying (almost) wholly inside the dataset's own outline, and the outline's additions,
        are merged into the country it overlaps most, so the map shows one country where the analysis has one
        (Israel's outline includes the West Bank, a separate feature in Natural Earth, and Gaza, which 1:110m omits)."""
        if getattr(self, "_basemap", None) is None:
            data = json.loads(BASEMAP.read_text(encoding="utf-8"))
            corners = [self.to_lonlat.transform(x, y) for x in self.bounds[0::2] for y in self.bounds[1::2]]
            lons, lats = [c[0] for c in corners], [c[1] for c in corners]
            region = box(max(-180, min(lons) - 25), max(-85, min(lats) - 20), min(180, max(lons) + 25), min(85, max(lats) + 20))
            to_grid = Transformer.from_crs(4326, self.profile["crs"], always_xy=True)
            features = [(f, make_valid(shape(f["geometry"]))) for f in data["features"]]
            merged = {}
            if self.country:
                aoi = make_valid(shape(self.country))
                overlap = [g.intersection(aoi).area if g.intersects(aoi) else 0.0 for _, g in features]
                home = int(np.argmax(overlap))
                inside = [i for i, (_, g) in enumerate(features) if i != home and g.area > 0 and overlap[i] >= .9 * g.area]
                extra = outline_additions(self.root.name)   # areas Natural Earth 1:110m leaves out, e.g. Gaza
                if inside or extra:
                    merged = {i: None for i in inside}
                    merged[home] = merge_outlines([features[home][1]] + [features[i][1] for i in inside] + extra)
            countries = []
            for i, (f, whole) in enumerate(features):
                if i in merged and merged[i] is None:
                    continue
                g = (merged.get(i) or whole).intersection(region)
                if g.is_empty or g.geom_type not in ("Polygon", "MultiPolygon"):
                    continue
                p = f["properties"]
                label = to_grid.transform(p["LABEL_X"], p["LABEL_Y"]) if "LABEL_X" in p and region.contains(shape({"type": "Point", "coordinates": [p["LABEL_X"], p["LABEL_Y"]]})) else None
                countries.append(dict(name=p.get("NAME") or p.get("ADMIN", ""), name_he=p.get("NAME_HE"), 
                                      geometry=mapping(transform(segmentize(g, .5), to_grid.transform, interleaved=False)), label=label))
            self._basemap = dict(countries=countries, source="Natural Earth 1:110m countries (public domain)")
        return self._basemap

    def country_mask(self):
        if getattr(self, "_mask", None) is None:
            p = self.profile
            self._mask = (geometry_mask([projected(self.country, p["crs"])], (p["height"], p["width"]), p["transform"], invert=True)
                          if self.country else np.ones((p["height"], p["width"]), bool))
        return self._mask

    def hotspots(self, date, window=None):
        """The night's hot spots (_hot_core), each marked:
        measured  a two-band source temperature tonight, at least HOT_MIN_K
        known     faint tonight, but a source temperature was measured within two pixels on one of the `window`
                  nights before (their change summaries): the nights it was, of how many, and the latest value
        sure      measured or known. The rest are faint and unconfirmed: over 5 sample nights most recurred in Saudi
                  Arabia and Iran (86% / 78%), none in Israel."""
        window = window or change_context()
        budget, far = hot_budget(), m11_confirm_far()
        key = (date, window, budget, far)
        with LOCK:
            cached = getattr(self, "_hotlist", {}).get(key)
        if cached:
            return cached
        core = self._hot_core(date)
        context = self._context(date, window, build=False)
        H, W = self.profile["height"], self.profile["width"]
        t = self.profile["transform"]
        spots = []
        for s in core["spots"]:
            s = dict(s)
            known = None
            if not s["measured"] and context:
                col, row = ~t * (s["x"], s["y"])
                row, col = int(row), int(col)
                near = np.array([(row + a) * W + col + b for a in range(-2, 3) for b in range(-2, 3) if 0 <= row + a < H and 0 <= col + b < W])
                nights, last = 0, None
                for d, st in context:   # newest first
                    if not len(st["idx"]):
                        continue
                    pos = np.minimum(np.searchsorted(st["idx"], near), len(st["idx"]) - 1)
                    hit = st["idx"][pos] == near
                    measured = st["measured"][pos[hit]]
                    if measured.any():
                        nights += 1
                        if last is None:
                            last = dict(date=d, temperature_k=float(np.nanmax(st["measured_k"][pos[hit]][measured])))
                if nights:
                    known = dict(nights=nights, of=len(context), **last)
            s["known"] = known
            s["sure"] = bool(s["measured"] or known)
            spots.append(s)
        result = dict(core, spots=spots, window=window, context_nights=len(context))
        with LOCK:
            self._hotlist = getattr(self, "_hotlist", {})
            if len(self._hotlist) > 64:
                self._hotlist.clear()
            self._hotlist[key] = result
        return result

    def _context(self, date, window, build=True):
        """Change summaries of up to `window` nights before `date` that have one, newest first. build=False uses only
        summaries already prepared (the hot-spot list must stay quick; the worker prepares the rest)."""
        context = []
        for d in reversed(self.dates[:self.dates.index(date)]):
            s = self.change_state(d, build=build)
            if s is not None:
                context.append((d, s))
            if len(context) == window:
                break
        return context

    def _hot_core(self, date):
        """Every hot spot of the night inside the country, brightest peak first: 8-connected M10 pixels above the
        night's threshold (Heimdall's EVT in noise units, times the noise level for the pixel's view zenith), kept
        only if M11 also sees it (m11_confirmation). Where the pass has no M11 the spot is kept, marked unconfirmed.
        Confirmed spots strong in both bands get a two-band temperature, emitting area and radiant heat."""
        budget, far = hot_budget(), m11_confirm_far()
        with LOCK:
            cached = getattr(self, "_hot", {}).get((date, budget, far))
        if cached:
            return cached
        layers = self.layers(date)
        model = layers["noise"]
        if not model.get("fit"):
            raise ValueError("אין מספיק נתונים לחישוב סף בלילה הזה.")
        inside = self.country_mask()
        values = np.where(inside, np.asarray(layers["value"], dtype=np.float32), np.nan)
        m11 = np.where(inside, np.asarray(layers["m11"], dtype=np.float32), np.nan)
        rep = np.asarray(layers["rep"])
        deg = self._deg(layers["vza"])
        limit = self.limit(model, deg, budget)
        confirm = self.m11_confirmation(model, deg, m11)
        labels, count = ndimage.label(np.isfinite(values) & (values > limit), structure=np.ones((3, 3)))
        t = self.profile["transform"]
        H, W = values.shape
        spots, rejected = [], 0
        for i, box_ in enumerate(ndimage.find_objects(labels), 1):
            # The spot's bounding box grown by one pixel, so the ring around the spot is included.
            sl = (slice(max(0, box_[0].start - 1), min(H, box_[0].stop + 1)), slice(max(0, box_[1].start - 1), min(W, box_[1].stop + 1)))
            spot = labels[sl] == i
            ring = ndimage.binary_dilation(spot, structure=np.ones((3, 3)))
            seen11 = bool(np.isfinite(m11[sl][ring]).any())
            confirmed = bool((confirm[sl] & spot).any()) if confirm is not None and seen11 else None
            if confirmed is False:
                rejected += 1
                continue
            v = np.where(spot, values[sl], -np.inf)
            r, c = np.unravel_index(int(np.argmax(v)), v.shape)
            peak = float(v[r, c])
            r, c = r + sl[0].start, c + sl[1].start
            x, y = t * (c + .5, r + .5)
            lon, lat = self.to_lonlat.transform(x, y)
            spots.append(dict(x=x, y=y, lonlat=[lon, lat], value=peak, m11=float(m11[r, c]) if np.isfinite(m11[r, c]) else None, 
                              samples=int((rep[sl] & spot).sum()), threshold=float(limit[r, c]), confirmed=confirmed, 
                              view_zenith=None if np.isnan(deg[r, c]) else float(deg[r, c]), 
                              brightness_temperature_k=brightness_temperature(peak), 
                              **(self.source_physics(ring, values[sl], m11[sl], rep[sl], deg[sl], model, core=spot) if confirmed else {})))
        spots.sort(key=lambda s: -s["value"])
        for rank, s in enumerate(spots, 1):
            s["rank"] = rank
            s["measured"] = bool(s.get("temperature_k") and s["temperature_k"] >= HOT_MIN_K)
        z = evt.quantile(model["fit"], budget / model["fit"]["N"])
        low, high = z * min(model["bias"]), z * max(model["bias"])
        result = dict(date=date, threshold_low=low, threshold_high=high, threshold_low_k=brightness_temperature(low), 
                      threshold_high_k=brightness_temperature(high), spots=spots, rejected_by_m11=rejected, 
                      m11_coverage=model.get("m11_coverage", 0.0), 
                      method="Nearest-nadir mosaic; Heimdall EVT (tail above P%g, blobs <= %d px kept, GPD on the whole tail) on radiance / "
                             "clipped-noise mean per view-zenith band, each native sample once; budget %g background samples per night; "
                             "M11 confirmation at per-sample false-alarm rate %g within one pixel; two-band M10/M11 temperature"
                             % (evt.TAIL_PERCENTILE, evt.BLOBS_LIM, budget, far))
        with LOCK:
            self._hot = getattr(self, "_hot", {})
            self._hot[(date, budget, far)] = result
        return result

    # ---------- temporal change detection ----------
    def state_possible(self, date):
        return self.layers_version(date) == LAYERS and self.cloud_ready(date)

    def change_state(self, date, build=True):
        """A night's summary for change detection (~1 MB), built once: packed bitmaps of the observed, clear and
        confidently clear pixels inside the country, and the lit pixels (above the hot-spot threshold, confirmed by
        M11 where M11 exists, grown by one pixel) with their M10 radiance, 3x3 sum of corrected radiance and, where a
        hot spot had one, its measured source temperature. None until the night has current layers and its cloud
        layer; with build=False also None until the summary is prepared."""
        if not self.state_possible(date):
            return None
        if not build and not self._v2(date, CHANGE + ".npz").exists():
            return None
        key = (date, hot_budget(), m11_confirm_far())
        with LOCK:
            self._states = getattr(self, "_states", {})
            if key in self._states:
                return self._states[key]
            self._statelocks = getattr(self, "_statelocks", {})
            lock = self._statelocks.setdefault(date, threading.Lock())
        with lock:
            path = self._v2(date, CHANGE + ".npz")
            state = None
            if path.exists():
                with np.load(path, allow_pickle=False) as z:
                    state = {k: z[k] for k in z.files}
                if float(state["budget"]) != key[1] or float(state["far"]) != key[2] or str(state["outline"]) != self.outline_key:
                    state = None
            if state is None:
                state = self._build_state(date, *key[1:])
        with LOCK:
            if len(self._states) > 64:
                self._states.clear()
            self._states[key] = state
        return state

    def _build_state(self, date, budget, far):
        layers = self.layers(date)
        model = layers["noise"]
        v = np.asarray(layers["value"], dtype=np.float32)
        m11 = np.asarray(layers["m11"], dtype=np.float32)
        deg = self._deg(layers["vza"])
        obs = np.isfinite(v) & self.country_mask()
        core = obs & (v > self.limit(model, deg, budget))
        confirm = self.m11_confirmation(model, deg, m11)
        if confirm is not None:
            core &= confirm | ~np.isfinite(m11)
        lit = ndimage.binary_dilation(core, structure=np.ones((3, 3))) & obs
        corrected = np.where(obs, v - self._bias_of(deg, model), 0).astype(np.float32) if model["bands"] else np.where(obs, v, 0).astype(np.float32)
        box = ndimage.uniform_filter(corrected, size=3, mode="constant") * 9
        drop = np.asarray(self.cloud(date))
        known = obs & (drop != -128)
        # Where tonight's hot spots had a measured source temperature (peak and its ring), for "known flare" look-ups.
        H, W = obs.shape
        measured_k = np.full(H * W, np.nan, np.float32)
        try:
            spots = self._hot_core(date)["spots"]
        except ValueError:
            spots = []
        t = self.profile["transform"]
        for s in spots:
            if s["measured"]:
                col, row = ~t * (s["x"], s["y"])
                row, col = int(row), int(col)
                for a in (-1, 0, 1):
                    for b in (-1, 0, 1):
                        if 0 <= row + a < H and 0 <= col + b < W:
                            measured_k[(row + a) * W + col + b] = s["temperature_k"]
        idx = np.flatnonzero(lit)
        state = dict(obs=np.packbits(obs.ravel()), clear=np.packbits((known & (drop > -2 * CLOUD_DROP_K)).ravel()), 
                     confident=np.packbits((known & (drop >= -2 * CHANGE_CLEAR_K)).ravel()), 
                     idx=idx.astype(np.int64), core=core.ravel()[idx], value=v.ravel()[idx], box=box.ravel()[idx], 
                     measured=np.isfinite(measured_k[idx]), measured_k=measured_k[idx], 
                     budget=np.float64(budget), far=np.float64(far), outline=np.array(self.outline_key))
        temp = self._v2(date, "partial." + CHANGE + ".npz")
        with open(temp, "wb") as f:
            np.savez(f, **state)
        temp.replace(self._v2(date, CHANGE + ".npz"))
        return state

    def activity(self):
        """TEMPER's night-by-night activity at every detected site, from the nightly change summaries (no rasters
        read). Sites: 8-connected groups of pixels detected on at least SIMILAR_SITE_NIGHTS nights, each at its most
        often detected pixel. Per night: the 3x3 sum of corrected M10 radiance there where it was lit (a flare seen
        through cloud counts), 0 where it was observed and clear but not lit, NaN where it was not seen (no pass, or
        cloud). Rebuilt when more nights are summarised. A night still in the previous summary format (s3, while the
        background worker rebuilds) is read from it: the values used here are the same in both."""
        dates = [d for d in self.dates if self._v2(d, CHANGE + ".npz").exists() or self._v2(d, "s3.npz").exists()]
        key = (tuple(dates), tuple(self._v2(d, CHANGE + ".npz").exists() for d in dates), self.outline_key)
        cached = getattr(self, "_activity", None)
        if cached and cached["key"] == key:
            return cached
        H, W = self.profile["height"], self.profile["width"]
        states, count = [], np.zeros(H * W, np.int32)
        for d in dates:
            st = self.change_state(d, build=False) if self._v2(d, CHANGE + ".npz").exists() else self._older_state(d)
            if st is not None:
                states.append((d, st))
                count[st["idx"][st["core"].astype(bool)]] += 1
        labels, n = ndimage.label((count >= SIMILAR_SITE_NIGHTS).reshape(H, W), structure=np.ones((3, 3)))
        flat = labels.ravel()
        sel = np.flatnonzero(flat)
        order = np.lexsort((-count[sel], flat[sel]))   # by group, most often detected first
        first = np.r_[True, flat[sel][order][1:] != flat[sel][order][:-1]] if len(sel) else np.zeros(0, bool)
        sites = sel[order][first]
        Y = np.full((len(sites), len(states)), np.nan, np.float32)
        byte, bit = sites >> 3, (7 - (sites & 7)).astype(np.uint8)
        for j, (d, st) in enumerate(states):
            seen = ((st["obs"][byte] >> bit) & 1) & ((st["clear"][byte] >> bit) & 1)
            column = np.where(seen.astype(bool), 0.0, np.nan).astype(np.float32)
            if len(st["idx"]):
                pos = np.minimum(np.searchsorted(st["idx"], sites), len(st["idx"]) - 1)
                lit = st["idx"][pos] == sites
                column[lit] = st["box"][pos[lit]]
            Y[:, j] = column
        # Compared as residuals: each site's asinh activity standardised, less the night's median over all sites (a
        # hazier night, or one where much of the country was at the swath edge, dims every flare) and less the site's
        # own median for its day of the 16-day orbit cycle (its viewing-angle pattern).
        Z = np.arcsinh(Y / SIMILAR_SCALE)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            Z = (Z - np.nanmean(Z, 1)[:, None]) / np.where(np.nanstd(Z, 1) > 0, np.nanstd(Z, 1), 1)[:, None]
            Z -= np.nan_to_num(np.nanmedian(Z, 0))[None]
            phase = np.array([datetime.fromisoformat(d).toordinal() % 16 for d, _ in states])
            for g in range(16):
                sel = phase == g
                if sel.any():
                    Z[:, sel] -= np.nan_to_num(np.nanmedian(Z[:, sel], 1))[:, None]
        result = dict(key=key, dates=[d for d, _ in states], sites=sites, counts=count[sites], Y=Y, R=Z.astype(np.float32))
        self._activity = result
        return result

    def _older_state(self, date):
        """A night's summary in the previous format, if it was built with the current settings."""
        try:
            with np.load(self._v2(date, "s3.npz"), allow_pickle=False) as z:
                st = {k: z[k] for k in ("obs", "clear", "idx", "core", "box", "budget", "far", "outline")}
        except (OSError, KeyError, ValueError):
            return None
        if float(st["budget"]) != hot_budget() or float(st["far"]) != m11_confirm_far() or str(st["outline"]) != self.outline_key:
            return None
        return st

    def activity_site(self, x, y):
        """The TEMPER site at a point: the most often detected site within two pixels."""
        A = self.activity()
        col, row = ~self.profile["transform"] * (x, y)
        sr, sc = np.divmod(A["sites"], self.profile["width"])
        near = np.flatnonzero((np.abs(sr - int(row)) <= 2) & (np.abs(sc - int(col)) <= 2))
        if not near.size:
            raise ValueError("TEMPER לא זיהה כאן מקור חום בשני לילות לפחות, כך שאין התנהגות להשוות. בחרו מוקד או חפשו ב־LIGHT ROAST.")
        return int(near[np.argmax(A["counts"][near])])

    def changes(self, date, window=None):
        """What changed tonight against the context window of `window` nights before it (default change_context();
        see CHANGE_*): places that lit up, went off on a clear night, or got much brighter or dimmer. One entry per
        connected group of changed pixels."""
        if date not in self.days:
            raise ValueError("אין נתונים ללילה הזה.")
        window, budget, far = window or change_context(), hot_budget(), m11_confirm_far()
        with LOCK:
            cached = getattr(self, "_changes", {}).get((date, window, budget, far))
        if cached:
            return cached
        tonight = self.change_state(date)
        if tonight is None:
            raise ValueError("הלילה הזה עדיין בהכנה.")
        context = self._context(date, window)
        if len(context) < CHANGE_MIN_INFORMATIVE:
            raise ValueError("אין מספיק לילות קודמים להשוואה.")
        H, W = self.profile["height"], self.profile["width"]
        bits = lambda packed, at: np.unpackbits(packed, count=H * W).view(bool)[at]

        def find(s, at):   # which candidates are lit in summary s, and where
            pos = np.minimum(np.searchsorted(s["idx"], at), max(0, len(s["idx"]) - 1))
            return (s["idx"][pos] == at) if len(s["idx"]) else np.zeros(len(at), bool), pos

        cand = np.unique(np.concatenate([tonight["idx"]] + [s["idx"] for _, s in context]))
        n_lit, n_inf = np.zeros(len(cand), np.int16), np.zeros(len(cand), np.int16)
        ctx_value = np.full((len(context), len(cand)), np.nan, np.float32)
        ctx_box = np.full((len(context), len(cand)), np.nan, np.float32)
        for j, (_, s) in enumerate(context):
            hit, pos = find(s, cand)
            n_lit += hit
            n_inf += bits(s["obs"], cand) & (bits(s["clear"], cand) | hit)
            ctx_value[j, hit] = s["value"][pos[hit]]
            ctx_box[j, hit] = s["box"][pos[hit]]
        freq = n_lit / np.maximum(n_inf, 1)
        hit, pos = find(tonight, cand)
        core = np.zeros(len(cand), bool)
        value_t = np.full(len(cand), np.nan, np.float32)
        box_t = np.full(len(cand), np.nan, np.float32)
        core[hit], value_t[hit], box_t[hit] = tonight["core"][pos[hit]], tonight["value"][pos[hit]], tonight["box"][pos[hit]]
        obs_t, confident_t = bits(tonight["obs"], cand), bits(tonight["confident"], cand)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)   # all-NaN columns: never lit in the context
            usual, usual_box = np.nanmedian(ctx_value, axis=0), np.nanmedian(ctx_box, axis=0)
            # Each place's own night-to-night variability: robust spread of its log brightness while lit.
            logs = np.log(np.where(ctx_box > 0, ctx_box, np.nan))
            centre = np.nanmedian(logs, axis=0)
            spread = 1.4826 * np.nanmedian(np.abs(logs - centre), axis=0)
            step_z = (np.log(np.where(box_t > 0, box_t, np.nan)) - centre) / np.maximum(spread, 1e-3)
        layers = self.layers(date)
        model = layers["noise"]
        deg = self._deg(np.asarray(layers["vza"]).ravel()[cand])
        limit = self.limit(model, deg, budget)
        enough = n_inf >= CHANGE_MIN_INFORMATIVE
        steady = n_lit >= CHANGE_MIN_LIT
        kinds = dict(new=core & enough & (freq <= CHANGE_NEW_MAX_FREQ), 
                     off=enough & (freq >= CHANGE_OFF_MIN_FREQ) & obs_t & confident_t & ~hit & (usual >= CHANGE_OFF_MARGIN * limit), 
                     brighter=core & steady & (usual_box > 0) & (box_t >= CHANGE_STEP * usual_box) & (step_z >= CHANGE_STEP_Z), 
                     dimmer=core & steady & (usual_box > 0) & (box_t <= usual_box / CHANGE_STEP) & (step_z <= -CHANGE_STEP_Z))
        t = self.profile["transform"]
        events = []
        for kind, flagged in kinds.items():
            grid = np.zeros(H * W, np.int32)
            grid[cand[flagged]] = np.flatnonzero(flagged) + 1   # candidate number + 1 at each flagged pixel
            grid = grid.reshape(H, W)
            labels, count = ndimage.label(grid > 0, structure=np.ones((3, 3)))
            for k, box_ in enumerate(ndimage.find_objects(labels), 1):
                members = grid[box_][labels[box_] == k] - 1
                strength = value_t[members] if kind in ("new", "brighter") else usual[members]
                c = members[int(np.nanargmax(np.where(np.isfinite(strength), strength, -np.inf)))]
                row, col = divmod(int(cand[c]), W)
                x, y = t * (col + .5, row + .5)
                lon, lat = self.to_lonlat.transform(x, y)
                events.append(dict(kind=kind, x=x, y=y, lonlat=[lon, lat], pixels=int(len(members)), 
                                   value=float(value_t[c]) if np.isfinite(value_t[c]) else None, 
                                   usual=float(usual[c]) if np.isfinite(usual[c]) else None, 
                                   ratio=float(box_t[c] / usual_box[c]) if np.isfinite(box_t[c]) and usual_box[c] > 0 else None, 
                                   lit_nights=int(n_lit[c]), informative_nights=int(n_inf[c]), 
                                   threshold=float(limit[c]), view_zenith=None if np.isnan(deg[c]) else float(deg[c])))
        # Follow-up for past nights: on the next CHANGE_FOLLOW informative nights, was the place lit (within one pixel)?
        # Tells a new source that continues from a one-night fire, and an "off" that stayed off from one that came back.
        later = []
        for d in self.dates[self.dates.index(date) + 1:]:
            s = self.change_state(d)
            if s is not None:
                later.append(s)
            if len(later) == 2 * CHANGE_FOLLOW:
                break
        if events and later:
            unpacked = [(s, bits(s["obs"], slice(None)), bits(s["clear"], slice(None))) for s in later]
            for e in events:
                col, row = ~t * (e["x"], e["y"])
                row, col = int(row), int(col)
                near = np.array([(row + dr) * W + col + dc for dr in (-1, 0, 1) for dc in (-1, 0, 1)
                                 if 0 <= row + dr < H and 0 <= col + dc < W])
                lit_after = informative = 0
                for s, obs, clear in unpacked:
                    lit = bool(len(s["idx"])) and bool(np.isin(near, s["idx"]).any())
                    if obs[row * W + col] and (clear[row * W + col] or lit):
                        informative += 1
                        lit_after += lit
                        if informative == CHANGE_FOLLOW:
                            break
                e.update(after_lit=lit_after, after_informative=informative)
        order = {"new": 0, "off": 1, "brighter": 2, "dimmer": 3}
        events.sort(key=lambda e: (order[e["kind"]], -(e["value"] if e["kind"] in ("new", "brighter") else e["usual"] or 0)))
        result = dict(date=date, events=events, context=[d for d, _ in context], window=window, 
                      counts={k: sum(e["kind"] == k for e in events) for k in order}, 
                      method="Each place against the %d nights before it (informative: observed and clear, or lit). new: lit "
                             "tonight, M11-confirmed, lit on <= %g of informative nights. off: lit on >= %g, not within one "
                             "pixel tonight, tonight's M15 within %g K of clear sky, usual brightness >= %gx tonight's threshold. "
                             "brighter/dimmer: 3x3 corrected sum >= %gx / <= 1/%gx its context median over >= %d lit nights."
                             % (window, CHANGE_NEW_MAX_FREQ, CHANGE_OFF_MIN_FREQ, CHANGE_CLEAR_K, CHANGE_OFF_MARGIN, 
                                CHANGE_STEP, CHANGE_STEP, CHANGE_MIN_LIT))
        with LOCK:
            self._changes = getattr(self, "_changes", {})
            if len(self._changes) > 64:
                self._changes.clear()
            self._changes[(date, window, budget, far)] = result
        return result

    def window_cells(self, x, y, size_km, polygon=None):
        """The grid cells of a sampling window (pixel centers inside the square, optionally only inside polygons):
        (requested bounds, r0, r1, c0, c1, roi). Shared by TEMPER and LIGHT ROAST, which use the same grid."""
        if not all(np.isfinite(v) for v in (x, y, size_km)) or not .75 <= size_km <= 500:
            raise ValueError("גודל החלון: 0.75 עד 500 ק״מ.")
        half = size_km*500
        requested = [x-half, y-half, x+half, y+half]
        p = self.profile
        w = from_bounds(*requested, transform=p["transform"])
        # Include pixel centers inside the requested window, with stable support on all dates.
        c0, c1 = max(0, int(np.ceil(w.col_off - .5))), min(p["width"], int(np.ceil(w.col_off + w.width - .5)))
        r0, r1 = max(0, int(np.ceil(w.row_off - .5))), min(p["height"], int(np.ceil(w.row_off + w.height - .5)))
        if c1 <= c0 or r1 <= r0:
            raise ValueError("החלון מחוץ לתמונה.")
        roi = np.ones((r1-r0, c1-c0), bool)
        if polygon:
            geometries = polygon if isinstance(polygon, list) else [polygon]
            if len(geometries) > 50:
                raise ValueError("עד 50 פוליגונים פעילים.")
            roi = geometry_mask(geometries, roi.shape, 
                                rasterio.windows.transform(Window(c0, r0, c1-c0, r1-r0), p["transform"]), invert=True)
        return requested, r0, r1, c0, c1, roi

    def series(self, x, y, size_km, polygon=None):
        requested, r0, r1, c0, c1, roi = self.window_cells(x, y, size_km, polygon)
        # Nights still being prepared by the background worker are left out and counted in "pending";
        # the viewer asks again when they are ready.
        budget = hot_budget()
        points, pending, thermal_pending, total = [], 0, 0, int(roi.sum())
        for date in self.dates:
            if not self.layers_ready(date):
                pending += 1
                continue
            layers = self.layers(date)
            cloud = self.cloud(date)
            thermal_pending += cloud is None
            model = layers["noise"]
            values = np.asarray(layers["value"][r0:r1, c0:c1], dtype=np.float32)
            m11 = np.asarray(layers["m11"][r0:r1, c0:c1], dtype=np.float32)
            deg = self._deg(layers["vza"][r0:r1, c0:c1])
            good = np.isfinite(values) & roi
            n = int(good.sum())
            if not n:
                points.append(dict(date=date, mean=None, corrected=None, m11_corrected=None, detected=False, confirmed=None, 
                                   view_zenith=None, count=0, eligible_pixels=total, coverage=0, zero_percent=None, 
                                   m15_k=None, cloud_percent=None))
                continue
            v, d = values[good], deg[good]
            m11ok = good & np.isfinite(m11)
            point = dict(date=date, mean=float(np.mean(v, dtype=np.float64)), 
                         corrected=float(np.mean(v - self._bias_of(d, model), dtype=np.float64)) if model["bands"] else None, 
                         m11_corrected=float(np.mean(m11[m11ok] - self._bias_of(deg[m11ok], model["m11"]), dtype=np.float64))
                         if model.get("m11") and model["m11"]["bands"] and m11ok.any() else None, 
                         m11_mean=float(np.mean(m11[m11ok], dtype=np.float64)) if m11ok.any() else None, 
                         detected=False, confirmed=None, 
                         view_zenith=float(np.mean(d[np.isfinite(d)])) if np.isfinite(d).any() else None, 
                         count=n, eligible_pixels=total, coverage=100 * n / total if total else 0, 
                         zero_percent=float(100 * np.mean(v == 0)), m15_k=None, cloud_percent=None)
            # Thermal: median M15 brightness temperature of the window (ground, or cloud tops where cloudy) and the
            # share of its pixels flagged cloudy.
            if layers["m15"] is not None:
                t15 = np.asarray(layers["m15"][r0:r1, c0:c1])
                warm = good & (t15 > 0)
                if warm.any():
                    point["m15_k"] = float(np.median(t15[warm])) * KELVIN_STEP
            if cloud is not None:
                flagged, known = self.cloudy(cloud[r0:r1, c0:c1])
                known &= good
                if known.any():
                    point["cloud_percent"] = float(100 * flagged[known].mean())
            # A source in the window this night: M10 above the hot-spot threshold, confirmed by M11 where M11 exists.
            hot = good & (values > self.limit(model, deg, budget))
            if hot.any():
                ring = ndimage.binary_dilation(hot, structure=np.ones((3, 3))) & roi
                confirm = self.m11_confirmation(model, deg, m11)
                if confirm is not None and np.isfinite(m11[ring]).any():
                    point["confirmed"] = bool((confirm & hot).any())
                point["detected"] = point["confirmed"] is not False
                if point["confirmed"]:
                    rep = np.asarray(layers["rep"][r0:r1, c0:c1])
                    point.update(self.source_physics(ring, values, m11, rep, deg, model, core=hot & roi))
            points.append(point)
        lon, lat = self.to_lonlat.transform(x, y)
        return dict(points=points, bounds=requested, size_km=size_km, center=[x, y], lonlat=[lon, lat], grid_window=[c0, r0, c1, r1], 
                    pending=pending, thermal_pending=thermal_pending, nights=len(self.dates), 
                    method="Nearest-nadir mosaic. mean: valid grid pixels, zeros (clipped negative noise) included. "
                           "corrected / m11_corrected: M10 / M11 mean minus the night's clipped-noise mean for each pixel's view "
                           "zenith, so a place without sources averages ~0. detected: M10 above the night's hot-spot threshold and "
                           "confirmed by M11 (confirmed=None where M11 is missing). temperature_k, area_m2, heat_mw: two-band "
                           "M10/M11 estimate for the detected pixels and a one-pixel ring, when both bands are at least 10 sigma. "
                           "m15_k: median M15 brightness temperature (ground, or cloud tops). cloud_percent: pixels whose M15 "
                           "is at least %g K below their clear-sky reference (%d-th warmest of +-%d nights, 5x5 median)."
                           % (CLOUD_DROP_K, CLOUD_RANK, CLOUD_NIGHTS))


# ---------- rendered map images ----------
# A night's map takes 0.5 s (TEMPER) to 3 s (LIGHT ROAST's change view, which compares the whole country) to render.
# The newest are kept in memory, and after each one the nights either side are rendered in the background, so
# stepping through nights shows them at once.
PNG_CACHE_BYTES = 256 * 2 ** 20
_PNG, _PNG_LOCK, _PNG_SIZE = {}, threading.Lock(), [0]
_AHEAD, _AHEAD_WAKE = [], threading.Event()


def _png_key(product, d, params):
    """The image and what it was drawn from: the open dataset object, the night, the display settings, and the
    night's layers that the background worker may still be adding (cloud flags, newer layers, typical lights)."""
    if product == "temper" and params[0] != "composite":
        return ("temper", id(DATASET), d, params, DATASET.cloud_ready(d), DATASET.layers_version(d))
    if params[0] == "steady":   # without the constant lights: the frame's nights and the period's decide
        return ("lightroast", id(LIGHTS), d, params, len(LIGHTS.dates), param_sig())
    if params[0] == "composite":   # a period's: its nights' files decide (composite checks them)
        return (product, id(DATASET if product == "temper" else LIGHTS), d, params, len(DATASET.dates), len(LIGHTS.dates) if LIGHTS else 0)
    return ("lightroast", id(LIGHTS), d, params, LIGHTS.clouds_ready(d), LIGHTS.typical_ready() if params[0] == "typical" else None)


def map_image(product, d, params, ahead=True):
    """PNG of one night's map: from memory, else rendered and kept (oldest dropped past PNG_CACHE_BYTES)."""
    key = _png_key(product, d, params)
    with _PNG_LOCK:
        png = _PNG.pop(key, None)
        if png is not None:
            _PNG[key] = png   # newest last
    if png is None:
        png = (composite_png(product, d, params[1]) if params[0] == "composite" else steady_png(d, *params[1:]) if params[0] == "steady"
               else DATASET.image(d, *params) if product == "temper" else LIGHTS.cloud_image(d) if params == ("clouds",) else LIGHTS.image(d, *params))
        with _PNG_LOCK:
            if key not in _PNG:
                _PNG[key] = png
                _PNG_SIZE[0] += len(png)
            while _PNG_SIZE[0] > PNG_CACHE_BYTES and len(_PNG) > 1:
                _PNG_SIZE[0] -= len(_PNG.pop(next(iter(_PNG))))
    if ahead:
        nights = DATASET.dates if product == "temper" else LIGHTS.dates
        if d in nights:
            i = nights.index(d)
            with _PNG_LOCK:
                _AHEAD[:] = [j for j in _AHEAD if j[2] != params] + [(product, nights[j], params) for j in (i - 1, i + 1) if 0 <= j < len(nights)]
            _AHEAD_WAKE.set()
    return png


def ahead_worker():
    """Render the nights either side of the last one shown (see map_image); a newer request replaces the queue."""
    while True:
        _AHEAD_WAKE.wait()
        with _PNG_LOCK:
            job = _AHEAD.pop(0) if _AHEAD else None
            if not _AHEAD:
                _AHEAD_WAKE.clear()
        if job:
            wait_tour()
            try:
                map_image(*job, ahead=False)
            except Exception:   # a night that cannot be drawn yet is drawn when it is asked for
                pass


# ---------- the HTTP server: the page's files, and the API it calls ----------
NO_COUNTRY = "עדיין לא נבחרה מדינה."
NO_LIGHTS = "אין נתוני אורות למדינה הזו."
CSP = ("default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; connect-src 'self'; "
       "object-src 'none'; frame-ancestors 'none'")


class NotFound(Exception):
    """No such page or API route (404)."""


def temper_image(q):
    """TEMPER's map image of a night (one band, or the combination, on a display range and palette), or of the
    period ending with it (the combination; see composites)."""
    band = q.get("band", ["m10"])[0]
    if band not in ("m10", "m11", "combo", "m15"):
        raise ValueError("ערוץ לא מוכר.")
    days = composite_days(q)
    composites_ahead(q["date"][0])
    if days > 1:
        if band != "combo":
            raise ValueError("הרכב של תקופה יש רק בתצוגה המשולבת.")
        return map_image("temper", period_span(q["date"][0], days)[0], ("composite", days), ahead=False), "image/png"
    params = (float(q.get("low", [0])[0]), float(q.get("high", [.025])[0]), q.get("palette", ["ember"])[0], band)
    return map_image("temper", q["date"][0], params), "image/png"


def progress(q):
    """How many of the open country's nights are prepared: current layers and their cloud layer."""
    ds = DATASET
    if not ds:
        return {}
    return dict(id=ds.id, built=sum(ds.layers_version(d) == LAYERS and ds.cloud_ready(d) for d in ds.dates), total=len(ds.dates))


def lights_get(path, q):
    """LIGHT ROAST: the open country's night lights, on the same grid, windows and nights as TEMPER."""
    L, ds = LIGHTS, DATASET
    if not L or not ds:
        raise ValueError(NO_LIGHTS)
    if path == "/api/lr/progress":
        R = L.repo
        return dict(id=L.id, built=sum(L.ready(d) for d in L.dates), clouds=sum(L.clouds_ready(d) for d in L.dates), total=len(L.dates),
                    sfac=dict(fitted=R.fitted(), done=R.done, blocks=R.total, nights=sum(R.corrected_ready(d) for d in L.dates)))
    window = lights_window(q)
    method = q.get("method", ["weekly"])[0]
    if method not in ("weekly", "rx"):
        raise ValueError("שיטה לא מוכרת.")
    if method == "rx" and not rx_enabled():
        raise ValueError("שיטת RX מושהית.")
    if method == "rx" and not L.repo.fitted():
        raise ValueError("RX: כיול SFAC עדיין בהכנה" + (f" ({L.repo.done}/{L.repo.total})" if L.repo.total else "") + ".")
    days = composite_days(q)
    if path == "/api/lr/image":
        composites_ahead(q["date"][0])
    if path == "/api/lr/image" and q.get("steady", [""])[0] == "1":   # without the constant lights (see steady_counts)
        if q.get("view", ["lights"])[0] != "lights":
            raise ValueError("בלי האורות הקבועים: רק בתצוגת האורות.")
        d = period_span(q["date"][0], days)[0] if days > 1 else q["date"][0]
        return map_image("lightroast", d, ("steady", days, q.get("from", [""])[0], q.get("to", [""])[0]), ahead=False), "image/png"
    if path == "/api/lr/image" and days > 1:
        if q.get("view", ["lights"])[0] != "lights":
            raise ValueError("הרכב של תקופה יש רק בתצוגת האורות.")
        return map_image("lightroast", period_span(q["date"][0], days)[0], ("composite", days), ahead=False), "image/png"
    if path == "/api/lr/pixel" and days > 1:
        return composite_pixel("lightroast", q["date"][0], days, float(q["x"][0]), float(q["y"][0]))
    if path == "/api/lr/image":
        view = q.get("view", ["lights"])[0]
        if view not in ("lights", "change", "typical"):
            raise ValueError("תצוגה לא מוכרת.")
        return map_image("lightroast", q["date"][0], (view, window, method)), "image/png"
    if path == "/api/lr/clouds":
        return map_image("lightroast", q["date"][0], ("clouds",)), "image/png"
    if path == "/api/lr/pixel":
        col, row = ~ds.profile["transform"] * (float(q["x"][0]), float(q["y"][0]))
        r, c = math.floor(row), math.floor(col)
        if not (0 <= r < ds.profile["height"] and 0 <= c < ds.profile["width"]):
            return dict(inside=False)
        out = dict(inside=True, **L.pixel(q["date"][0], r, c, window, method))
        if q.get("steady", [""])[0] == "1":   # the constant lights: this pixel's, when they are ready
            S = steady_ready(q.get("from", [""])[0], q.get("to", [""])[0])
            if S is not None:
                out["steady"] = dict(constant=bool(S["constant"][r, c]), usual_nw=round(float(S["usual"][r, c]), 2), share=round(float(S["share"][r, c]), 3), nights=S["nights"])
        return out
    if path == "/api/lr/changes":
        d = q["date"][0]
        changes = L.repo.changes(d, window, ds.to_lonlat) if method == "rx" else L.changes(d, window, ds.to_lonlat)
        return annotate_heat(changes, ds)
    raise NotFound()


# ---------- export: one night's mosaic as a GeoTIFF ----------
# The night as the viewer reads it, over the rectangle around the country (the grid): every pass joined, per pixel
# the pass with the smallest view zenith (TEMPER), or the Black Marble tiles averaged to the grid (LIGHT ROAST). Not the
# raw swaths. float32, NaN = no data. "native" keeps the grid (EPSG:6933, 750 m, equal area); "wgs84" resamples it to
# latitude/longitude (nearest neighbour, so no value is invented).
EXPORT_BANDS = {
    "temper": {
        "m10": "M10 radiance, 1.61 um, W m-2 um-1 sr-1",
        "m11": "M11 radiance, 2.25 um, W m-2 um-1 sr-1",
        "m15": "M15 brightness temperature, 10.76 um, K",
        "m16": "M16 brightness temperature, 12.01 um, K",
        "vza": "view zenith of the pass used, degrees",
        "cloud": "M15 drop below the clear-sky reference, K (cloud at -8 K or less)",
    },
    "lightroast": {
        "dnb": "night lights, VIIRS DNB (NASA Black Marble VNP46A2), nW cm-2 sr-1",
        "cloud": "share of the cell under cloud (VIIRS cloud mask), 0-1",
    },
}


# ---------- composites: a period of nights in one layer ----------
# The map, the pixel readout and the GeoTIFF can show the period holding the shown night instead of the night alone,
# a calendar block: its week (Monday to Sunday), its 16-day cycle (one cycle of Suomi NPP's ground track: every viewing
# angle once; blocks of 16 days from 2 Jan 2012), its month or its year. Every night of a block shows the same
# composite, so moving between them asks for nothing new; only leaving the block does.
# - TEMPER: per pixel its strongest night (the combined M10/M11 significance, as on a night's map), coloured by that
#   night's source temperature where both bands were >= 10 sigma; on how many nights it was clearly hot (combined
#   significance >= COMPOSITE_HOT_SIGMA) out of the nights it was seen; and its highest M10 radiance.
# - LIGHT ROAST: per pixel the median of its usable nights (cloud and poor quality left out, as in each night's
#   layer), and how many usable nights it had.
# Built once per (country, night, period) and kept in the country's cache (the COMPOSITE_KEEP latest per product);
# meanwhile a request is answered with how far it got (Preparing: HTTP 202), and the page asks again. Two things keep
# that wait off the user:
# - TEMPER's period is made of calendar months: every month the period covers whole (and that is over) is read from a
#   month block, its own composite, built once and kept (compressed, cache/blocks/); only the nights at the period's
#   two ends are read one by one. All the parts combine exactly (the strongest night wins, the counts add up), so a
#   year from blocks equals a year night by night: ~15 s for Saudi Arabia instead of ~2 minutes. (LIGHT ROAST's
#   median does not split into parts, and is quick enough anyway.)
# - ahead: the night the page looks at gets all its periods, of both products, built in the background (and the
#   latest night when a country opens), then every month block of the record; so choosing a period is instant.
COMPOSITE_DAYS = (7, 16, 30, 365)
COMPOSITE_HOT_SIGMA = 10.0
COMPOSITE_KEEP = 8
COMPOSITE_BLOCK_MIN = 8   # a month with fewer of its nights in the period is read night by night
_COMP_JOBS, _COMP_MEM, _COMP_LOCK = {}, {}, threading.Lock()


class Preparing(Exception):
    """A composite still being built: done of total (nights, or rows for LIGHT ROAST)."""
    def __init__(self, done, total):
        super().__init__(f"{done}/{total}")
        self.done, self.total = done, total


def composite_days(q):
    days = int(q.get("days", ["1"])[0])
    if days != 1 and days not in COMPOSITE_DAYS:
        raise ValueError("תקופה לא מוכרת.")
    return days


COMPOSITE_CYCLE_EPOCH = 734504   # 2012-01-02, a Monday: the 16-day blocks count from it


def period_span(night, days):
    """The calendar block of `days` (7, 16, 30 or 365) holding the night: (first day, last day), ISO dates."""
    import datetime as dt
    d = dt.date.fromisoformat(night)
    if days == 7:
        s = d - dt.timedelta(days=d.weekday())
        e = s + dt.timedelta(days=6)
    elif days == 16:
        s = dt.date.fromordinal(COMPOSITE_CYCLE_EPOCH + (d.toordinal() - COMPOSITE_CYCLE_EPOCH) // 16 * 16)
        e = s + dt.timedelta(days=15)
    elif days == 30:
        s = d.replace(day=1)
        e = (s + dt.timedelta(days=32)).replace(day=1) - dt.timedelta(days=1)
    else:
        s, e = d.replace(month=1, day=1), d.replace(month=12, day=31)
    return s.isoformat(), e.isoformat()


def period_label(night, days):
    """The block's name in file names: 2026-W07, 2026-02-02_16d, 2026-02, 2026."""
    import datetime as dt
    s, _ = period_span(night, days)
    if days == 7:
        y, w, _ = dt.date.fromisoformat(s).isocalendar()
        return f"{y}-W{w:02d}"
    return {16: s + "_16d", 30: s[:7], 365: s[:4]}[days]


def period_nights(dates, night, days):
    """The nights of the block holding the night."""
    s, e = period_span(night, days)
    return [d for d in dates if s <= d <= e]


def composite(product, end, days, ahead=False):
    """The period's arrays (see above), or Preparing while they are built. ahead: asked by the background (kept on disk,
    not in memory)."""
    obj = DATASET if product == "temper" else LIGHTS
    if obj is None:
        raise ValueError(NO_LIGHTS)
    ver = LAYERS if product == "temper" else lightroast.LAYERS
    nights = period_nights(obj.dates, end, days)
    if not nights:
        raise ValueError("אין לילות בתקופה הזו.")
    sig = hashlib.sha256(("|".join(obj.night_signature(d) for d in nights) + f"|hot{COMPOSITE_HOT_SIGMA:g}").encode()).hexdigest()[:16]
    start = period_span(end, days)[0]
    key = (obj.id, start, days, sig)
    with _COMP_LOCK:
        if key in _COMP_MEM:
            return _COMP_MEM[key]
    path = obj.cache / f"{start}.{ver}.block{days}.npz"
    if path.exists():
        if ahead:   # there already: nothing to build (not read, to spare the memory)
            return None
        try:
            with np.load(path, allow_pickle=False) as z:
                if str(z["sig"]) == sig:
                    arrays = {k: z[k] for k in z.files if k != "sig"}
                    arrays["nights"] = len(nights)
                    _remember(key, arrays)
                    return arrays
        except (OSError, ValueError, KeyError):
            pass
    with _COMP_LOCK:
        job = _COMP_JOBS.get(key)
        if job and job.get("error"):
            del _COMP_JOBS[key]
            raise ValueError(job["error"])
        if job is None:
            job = _COMP_JOBS[key] = dict(done=0, total=len(nights), ahead=ahead)
            threading.Thread(target=_build_composite, args=(product, obj, ver, nights, path, sig, key, job), daemon=True).start()
        elif not ahead:
            job["ahead"] = False   # the page waits for it too: keep it in memory when done
    raise Preparing(job["done"], job["total"])


def _remember(key, arrays):
    with _COMP_LOCK:
        _COMP_MEM[key] = arrays
        while len(_COMP_MEM) > 3:   # a year of TEMPER is ~80 MB
            _COMP_MEM.pop(next(iter(_COMP_MEM)))


def _build_composite(product, obj, ver, nights, path, sig, key, job):
    try:
        arrays = _temper_composite(obj, nights, job) if product == "temper" else _lights_composite(obj, nights, job)
        temp = path.with_name(path.name + ".partial.npz")
        np.savez(temp, sig=np.array(sig), **arrays)
        temp.replace(path)
        arrays["nights"] = len(nights)
        if not job.get("ahead"):   # built ahead: kept on disk only, so it does not push out what is being looked at
            _remember(key, arrays)
        for old in list(obj.cache.glob(f"*.{ver}.comp*.npz")) + sorted(obj.cache.glob(f"*.{ver}.block*.npz"), key=lambda f: f.stat().st_mtime)[:-COMPOSITE_KEEP]:
            try:
                old.unlink()
            except OSError:
                pass
        with _COMP_LOCK:
            _COMP_JOBS.pop(key, None)
        print("COMPOSITE", product, nights[-1], len(nights), "nights", flush=True)
    except Exception as exc:   # said to the next request, which may try again
        job["error"] = f"ההרכב לא נבנה: {exc}"
        print("COMPOSITE FAILED", product, nights[-1], exc, flush=True)


def _temper_empty(ds):
    H, W = ds.profile["height"], ds.profile["width"]
    return dict(best=np.full((H, W), -np.inf, np.float32), temp=np.full((H, W), np.nan, np.float32), m10=np.full((H, W), np.nan, np.float32),
                seen=np.zeros((H, W), np.uint16), hot=np.zeros((H, W), np.uint16))


def _temper_add_night(acc, ds, d):
    s, t, valid, v10 = ds.combo_layers(d)
    ok = np.isfinite(s)
    acc["seen"] += ok
    acc["hot"] += ok & (s >= COMPOSITE_HOT_SIGMA)
    acc["m10"] = np.fmax(acc["m10"], v10)
    better = ok & (s > acc["best"])
    acc["best"][better] = s[better]
    acc["temp"][better] = t[better]


def _temper_add_part(acc, part):
    """A later part (a month block) into the period: its strongest night wins only where stronger, as night by night."""
    better = part["best"] > acc["best"]
    acc["best"][better] = part["best"][better]
    acc["temp"][better] = part["temp"][better]
    acc["m10"] = np.fmax(acc["m10"], part["m10"])
    acc["seen"] += part["seen"]
    acc["hot"] += part["hot"]


def _month_block(ds, month, job=None):
    """A calendar month's TEMPER composite, built once (from its nights) and kept compressed in cache/blocks/, with
    the signature of its nights' files (a changed night rebuilds it)."""
    nights = [d for d in ds.dates if d[:7] == month]
    sig = hashlib.sha256(("|".join(ds.night_signature(d) for d in nights) + f"|hot{COMPOSITE_HOT_SIGMA:g}").encode()).hexdigest()[:16]
    path = ds.cache / "blocks" / f"{month}.{LAYERS}.month.npz"
    if path.exists():
        try:
            with np.load(path, allow_pickle=False) as z:
                if str(z["sig"]) == sig:
                    return {k: z[k] if k != "temp" else z[k].astype(np.float32) for k in ("best", "temp", "m10", "seen", "hot")}
        except (OSError, ValueError, KeyError):
            pass
    acc = _temper_empty(ds)
    for d in nights:
        _temper_add_night(acc, ds, d)
        if job is not None:
            job["done"] += 1
    path.parent.mkdir(exist_ok=True)
    temp = path.with_name(path.name + ".partial.npz")
    np.savez_compressed(temp, sig=np.array(sig), best=acc["best"], temp=acc["temp"].astype(np.float16), m10=acc["m10"], seen=acc["seen"], hot=acc["hot"])
    temp.replace(path)
    return acc


def _whole_months(ds, nights):
    """The months of the period it covers whole (all their nights in it), and over (before the latest night's month)."""
    current = ds.dates[-1][:7] if ds.dates else ""
    count = {}
    for d in ds.dates:
        count[d[:7]] = count.get(d[:7], 0) + 1
    inside = {}
    for d in nights:
        inside[d[:7]] = inside.get(d[:7], 0) + 1
    return {m for m, n in inside.items() if m < current and n == count[m] and n >= COMPOSITE_BLOCK_MIN}


def _temper_composite(ds, nights, job):
    acc, blocks = _temper_empty(ds), _whole_months(ds, nights)
    job["done"] = 0
    for m in sorted({d[:7] for d in nights}):   # in time order, so the earliest of equal nights wins, as night by night
        if m in blocks:
            before = job["done"]
            _temper_add_part(acc, _month_block(ds, m, job))
            job["done"] = before + sum(1 for d in nights if d[:7] == m)
        else:
            for d in nights:
                if d[:7] == m:
                    _temper_add_night(acc, ds, d)
                    job["done"] += 1
    best = acc["best"]
    best[~np.isfinite(best)] = np.nan
    return dict(sig_max=best, temperature_k=acc["temp"].astype(np.float16), m10_max=acc["m10"], hot_nights=acc["hot"], seen_nights=acc["seen"])


# ---------- ahead: a night's periods, built while the user looks at it ----------
_COMP_AHEAD = dict(want=None, event=threading.Event())


def composites_ahead(end):
    """The page shows this night: build its periods in the background (after a moment, in case it is only passing)."""
    if DATASET is not None:
        _COMP_AHEAD["want"] = (DATASET.id, end)
        _COMP_AHEAD["event"].set()


def ahead_composites_worker():
    done = set()
    while True:
        _COMP_AHEAD["event"].wait()
        _COMP_AHEAD["event"].clear()
        time.sleep(2)   # stepping through nights: only the one that stays
        wait_tour()
        want = _COMP_AHEAD["want"]
        ds = DATASET
        if not want or ds is None or want[0] != ds.id or want in done:
            continue
        end, stale = want[1], False
        for days in COMPOSITE_DAYS:
            for product in ("temper", "lightroast"):
                obj = ds if product == "temper" else LIGHTS
                if obj is None or end not in obj.dates or _COMP_AHEAD["want"] != want:
                    stale = stale or _COMP_AHEAD["want"] != want
                    continue
                try:
                    composite(product, end, days, ahead=True)
                except Preparing:
                    while True:   # one at a time: wait for it before the next
                        time.sleep(.5)
                        try:
                            composite(product, end, days, ahead=True)
                            break
                        except Preparing:
                            continue
                        except Exception:
                            break
                except Exception as e:
                    print("ahead", product, end, days, type(e).__name__, e, flush=True)
        if stale or _COMP_AHEAD["want"] != want:
            _COMP_AHEAD["event"].set()
            continue
        done.add(want)
        # then every month of the record that is over, so any night's year is quick
        current = ds.dates[-1][:7] if ds.dates else ""
        for m in sorted({d[:7] for d in ds.dates if d[:7] < current}, reverse=True):
            wait_tour()
            if _COMP_AHEAD["want"] != want or DATASET is not ds:
                break
            try:
                _month_block(ds, m)
            except Exception as e:
                print("month block", m, type(e).__name__, e, flush=True)
                break


def _lights_composite(L, nights, job):
    H, W = L.profile["height"], L.profile["width"]
    layers = [L.layer(d) for d in nights]   # memory-mapped: read a band of rows at a time
    med = np.full((H, W), np.nan, np.float16)
    clear = np.zeros((H, W), np.uint16)
    rows = max(8, int(30e6 // (len(layers) * W)))
    job["total"] = H
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        for r0 in range(0, H, rows):
            stack = np.stack([np.asarray(a[r0:r0 + rows], np.float32) for a in layers])
            med[r0:r0 + rows] = np.nanmedian(stack, 0)
            clear[r0:r0 + rows] = np.isfinite(stack).sum(0)
            job["done"] = min(H, r0 + rows)
    return dict(median_nw=med, clear_nights=clear)


def composite_png(product, end, days):
    c = composite(product, end, days)
    if product == "temper":
        return DATASET.combo_png(c["sig_max"], c["temperature_k"], c["seen_nights"] > 0)
    return LIGHTS.lights_png(np.asarray(c["median_nw"], np.float32))


# ---------- the constant lights, and the map without them ----------
# Over a time frame (all the nights when not given), for each pixel of the grid: its clear nights, the nights it was
# lit (LIT_NW+) and its usual level (the geometric mean of radiance + 1, less 1). A pixel lit on CONSTANT_LIT_SHARE of
# its clear nights or more (CONSTANT_MIN_SEEN of them at least) is constant: a city, a road, a site that is always
# there. The map without them (the toggle in the legend) dims those pixels to a trace, so what is left is what is not
# always there: new lights, lights that come and go, fires and flares, boats. A constant pixel shows again when the
# night (or the period's composite) is off its usual level by STEADY_OFF or more, so a blackout in a city stands out.
# The counts add up, so they are kept per month (in the lights' cache, compressed) and a frame sums its whole months
# and reads the nights of the months it cuts; built in the background, the page waits for them as for a composite.
STEADY_OFF = math.log(2)
_STEADY = dict(mem={}, jobs={})


def _steady_nights(lo, hi):
    L = LIGHTS
    nights = [d for d in L.dates if (not lo or d >= lo) and (not hi or d <= hi)]
    if not nights:
        raise ValueError("אין לילות אורות בתקופה הזו.")
    return nights


def _steady_key(nights):
    return (LIGHTS.id, nights[0], nights[-1], len(nights), hashlib.sha256("|".join(LIGHTS.night_signature(d) for d in nights).encode()).hexdigest()[:16])


def steady_ready(lo, hi):
    """The frame's constant lights when already worked out, else None (nothing started)."""
    try:
        key = _steady_key(_steady_nights(lo, hi))
    except ValueError:
        return None
    S = _STEADY["mem"].get(key)
    return S and dict(S, constant=(S["n"] >= CONSTANT_MIN_SEEN) & (S["lit"] >= CONSTANT_LIT_SHARE * S["n"]))


def steady_counts(lo, hi):
    """The frame's per-pixel counts (n, lit, share, usual, nights), or Preparing while they are built."""
    nights = _steady_nights(lo, hi)
    key = _steady_key(nights)
    if key in _STEADY["mem"]:
        return _STEADY["mem"][key]
    job = _STEADY["jobs"].get(key)
    if job and job.get("error"):
        del _STEADY["jobs"][key]
        raise ValueError(job["error"])
    if job is None:
        job = _STEADY["jobs"][key] = dict(done=0, total=len(nights))
        threading.Thread(target=_build_steady, args=(LIGHTS, nights, key, job), daemon=True, name="steady").start()
    raise Preparing(job["done"], job["total"])


def _build_steady(L, nights, key, job):
    try:
        shape = L.layer(nights[0]).shape
        n, lit, slog = np.zeros(shape, np.int32), np.zeros(shape, np.int32), np.zeros(shape, np.float32)
        months = {}
        for d in nights:
            months.setdefault(d[:7], []).append(d)
        for m, ds in months.items():
            whole = ds == [d for d in L.dates if d[:7] == m]   # the frame holds all the month's nights: its block
            part = _steady_month(L, m, ds, job) if whole else _steady_add(L, ds, job)
            n += part["n"]
            lit += part["lit"]
            slog += part["slog"]
        with np.errstate(invalid="ignore", divide="ignore"):
            S = dict(n=n, lit=lit, share=np.where(n > 0, lit / np.maximum(n, 1), 0).astype(np.float32),
                     usual=np.where(n > 0, np.expm1(slog / np.maximum(n, 1)), np.nan).astype(np.float32), nights=len(nights), frame=[nights[0], nights[-1]])
        _STEADY["mem"][key] = S
        while len(_STEADY["mem"]) > 2:   # a big country's counts are ~60 MB
            _STEADY["mem"].pop(next(iter(_STEADY["mem"])))
        _STEADY["jobs"].pop(key, None)
    except Exception as e:
        job["error"] = str(e)


def _steady_add(L, ds, job):
    """The counts over some nights, read night by night."""
    shape = L.layer(ds[0]).shape
    n, lit, slog = np.zeros(shape, np.int32), np.zeros(shape, np.int32), np.zeros(shape, np.float32)
    for d in ds:   # asked for by the page: not held by the tour
        a = np.asarray(L.layer(d), np.float32)
        ok = np.isfinite(a)
        n += ok
        lit += ok & (a >= lightroast.LIT_NW)
        slog += np.where(ok, np.log1p(np.maximum(np.nan_to_num(a), 0)), 0).astype(np.float32)
        job["done"] += 1
    return dict(n=n, lit=lit, slog=slog)


def _steady_month(L, month, ds, job):
    """A whole month's counts: from the lights' cache, else read and kept (uint8 counts, float16 sums, compressed)."""
    sig = hashlib.sha256("|".join(L.night_signature(d) for d in ds).encode()).hexdigest()[:16]
    path = L.cache / f"{month}.{lightroast.LAYERS}.steady.npz"
    if path.exists():
        try:
            with np.load(path, allow_pickle=False) as z:
                if str(z["sig"]) == sig:
                    job["done"] += len(ds)
                    return dict(n=z["n"].astype(np.int32), lit=z["lit"].astype(np.int32), slog=z["slog"].astype(np.float32))
        except (OSError, ValueError, KeyError):
            pass
    part = _steady_add(L, ds, job)
    np.savez_compressed(path, n=part["n"].astype(np.uint8), lit=part["lit"].astype(np.uint8), slog=part["slog"].astype(np.float16), sig=np.array(sig))
    return part


def steady_png(d, days, lo, hi):
    """The lights view of the night (or the period's composite) with the frame's constant lights dimmed to a trace,
    unless the map is off their usual level by STEADY_OFF or more."""
    S = steady_counts(lo, hi)
    a = np.asarray(composite("lightroast", d, days)["median_nw"] if days > 1 else LIGHTS.layer(d), np.float32).copy()
    constant = (S["n"] >= CONSTANT_MIN_SEEN) & (S["lit"] >= CONSTANT_LIT_SHARE * S["n"])
    with np.errstate(invalid="ignore"):
        usual = np.abs(np.log1p(np.maximum(np.nan_to_num(a), 0)) - np.log1p(np.nan_to_num(S["usual"]))) < STEADY_OFF
    hide = constant & np.isfinite(a) & usual
    a[hide] *= .04
    return LIGHTS.lights_png(a)


def composite_pixel(product, end, days, x, y):
    """What the period says at one pixel, for the readout."""
    ds = DATASET
    col, row = ~ds.profile["transform"] * (x, y)
    r, c = math.floor(row), math.floor(col)
    if not (0 <= r < ds.profile["height"] and 0 <= c < ds.profile["width"]):
        return dict(inside=False)
    try:
        a = composite(product, end, days)
    except Preparing as p:
        return dict(inside=True, preparing=True, done=p.done, total=p.total)
    num = lambda v: None if v is None or not np.isfinite(v) else round(float(v), 6)
    if product == "temper":
        out = dict(days=days, span=period_span(end, days), nights=a["nights"], sig_max=num(a["sig_max"][r, c]), temperature_k=num(a["temperature_k"][r, c]),
                   m10_max=num(a["m10_max"][r, c]), hot_nights=int(a["hot_nights"][r, c]), seen_nights=int(a["seen_nights"][r, c]))
    else:
        out = dict(days=days, span=period_span(end, days), nights=a["nights"], median_nw=num(a["median_nw"][r, c]), clear_nights=int(a["clear_nights"][r, c]))
    return dict(inside=True, composite=out)


def temper_pixel(q):
    days = composite_days(q)
    if days > 1:
        return composite_pixel("temper", q["date"][0], days, float(q["x"][0]), float(q["y"][0]))
    return DATASET.pixel(q["date"][0], float(q["x"][0]), float(q["y"][0]))


# A period's GeoTIFF: the composite's own layers (see composites).
EXPORT_PERIOD_BANDS = {
    "temper": {
        "sig_max": "strongest night: combined M10/M11 significance, noise standard deviations",
        "temperature_k": "two-band source temperature on that night, K (where both bands were >= 10 sigma)",
        "m10_max": "highest M10 radiance in the period, W m-2 um-1 sr-1",
        "hot_nights": "nights with combined significance >= 10",
        "seen_nights": "nights observed",
    },
    "lightroast": {
        "median_nw": "median of the usable nights, nW cm-2 sr-1",
        "clear_nights": "usable (cloud-free, good quality) nights",
    },
}


def export_arrays(product, d, names):
    """The night's layers for export, float32 on the grid, NaN where there is no data."""
    if product == "temper":
        L = DATASET.layers(d)
        thermal = lambda a: None if a is None else np.where(np.asarray(a) > 0, np.asarray(a, np.float32) * KELVIN_STEP, np.nan).astype(np.float32)
        cloud = DATASET.cloud(d)
        vza = np.asarray(L["vza"])
        make = dict(
            m10=lambda: np.asarray(L["value"], np.float32),
            m11=lambda: np.asarray(L["m11"], np.float32),
            m15=lambda: thermal(L["m15"]),
            m16=lambda: thermal(L["m16"]),
            vza=lambda: np.where(vza == 255, np.nan, vza.astype(np.float32) / 2).astype(np.float32),
            cloud=lambda: None if cloud is None else np.where(np.asarray(cloud) == -128, np.nan, np.asarray(cloud, np.float32) / 2).astype(np.float32))
    else:
        if not LIGHTS:
            raise ValueError(NO_LIGHTS)
        make = dict(dnb=lambda: np.asarray(LIGHTS.layer(d), np.float32),
                    cloud=lambda: np.asarray(LIGHTS.clouds(d), np.float32) / 255)
    shape = (DATASET.profile["height"], DATASET.profile["width"])
    out = []
    for n in names:
        a = make[n]()
        out.append((n, a if a is not None else np.full(shape, np.nan, np.float32)))
    return out


def export_night(q):
    """GET /api/export?product=temper|lightroast&date=YYYY-MM-DD&crs=native|wgs84&bands=m10,m11,...&days=1|7|16|30|365:
    the GeoTIFF of the night, or of the period ending with it (its composite's layers)."""
    product = q.get("product", ["temper"])[0]
    if product not in EXPORT_BANDS:
        raise ValueError("מוצר לא מוכר.")
    d = q["date"][0]
    nights = DATASET.dates if product == "temper" else (LIGHTS.dates if LIGHTS else [])
    if d not in nights:
        raise ValueError("אין נתונים ללילה הזה." if product == "temper" else "אין נתוני אורות ללילה הזה.")
    crs = q.get("crs", ["native"])[0]
    if crs not in ("native", "wgs84"):
        raise ValueError("היטל לא מוכר.")
    days = composite_days(q)
    known = EXPORT_PERIOD_BANDS[product] if days > 1 else EXPORT_BANDS[product]
    asked = [b for b in q.get("bands", [""])[0].split(",") if b]
    names = [b for b in known if b in asked] if asked else list(known)
    if not names:
        raise ValueError("לא נבחרו שכבות.")
    if days > 1:   # Preparing (HTTP 202) while the composite is built; the page asks again
        c = composite(product, d, days)
        layers = [(n, np.asarray(c[n], np.float32)) for n in names]
    else:
        layers = export_arrays(product, d, names)
    p = DATASET.profile
    src_crs, src_t, H, W = p["crs"], p["transform"], p["height"], p["width"]
    bounds, area = DATASET.bounds, None
    clip = q.get("clip", [""])[0]
    if clip:   # an area of the user's (its ring on the grid): cropped to its rectangle, NaN outside it
        try:
            ring = [(float(a), float(b)) for a, b in json.loads(clip)]
        except (ValueError, TypeError):
            raise ValueError("האזור לא תקין.") from None
        if not 4 <= len(ring) <= 20000:
            raise ValueError("האזור לא תקין.")
        geom = mapping(Polygon(ring))
        xs, ys = [a for a, _ in ring], [b for _, b in ring]
        w = from_bounds(min(xs), min(ys), max(xs), max(ys), transform=src_t)
        c0, r0 = max(0, int(math.floor(w.col_off))), max(0, int(math.floor(w.row_off)))
        c1, r1 = min(W, int(math.ceil(w.col_off + w.width))), min(H, int(math.ceil(w.row_off + w.height)))
        if c1 <= c0 or r1 <= r0:
            raise ValueError("האזור מחוץ לתמונה.")
        src_t = rasterio.windows.transform(Window(c0, r0, c1 - c0, r1 - r0), src_t)
        H, W = r1 - r0, c1 - c0
        outside = geometry_mask([geom], (H, W), src_t, all_touched=True)
        layers = [(n, np.where(outside, np.nan, a[r0:r1, c0:c1]).astype(np.float32)) for n, a in layers]
        bounds = rasterio.transform.array_bounds(H, W, src_t)
        bounds = (bounds[0], bounds[1], bounds[2], bounds[3])
        area = (q.get("area", [""])[0] or "area")[:80]
    if crs == "wgs84":
        dst_crs = rasterio.crs.CRS.from_epsg(4326)
        dst_t, dw, dh = calculate_default_transform(src_crs, dst_crs, W, H, *bounds)
        moved = []
        for n, a in layers:
            b = np.full((dh, dw), np.nan, np.float32)
            reproject(a, b, src_transform=src_t, src_crs=src_crs, dst_transform=dst_t, dst_crs=dst_crs,
                      src_nodata=np.nan, dst_nodata=np.nan, resampling=Resampling.nearest)
            moved.append((n, b))
        layers, out_crs, out_t, H, W = moved, dst_crs, dst_t, dh, dw
    else:
        out_crs, out_t = src_crs, src_t
    profile = dict(driver="GTiff", dtype="float32", count=len(layers), width=W, height=H, crs=out_crs, transform=out_t,
                   nodata=float("nan"), compress="deflate", predictor=3, tiled=True, blockxsize=256, blockysize=256, BIGTIFF="IF_SAFER")
    with rasterio.MemoryFile() as mem:
        with mem.open(**profile) as dst:
            for i, (n, a) in enumerate(layers, 1):
                dst.write(a, i)
                dst.set_band_description(i, n)
                dst.update_tags(i, name=n, description=known[n])
            dst.update_tags(product="TEMPER" if product == "temper" else "LIGHT ROAST", night=d, country=DATASET.root.name,
                            period_days=str(days), period=" to ".join(period_span(d, days)) if days > 1 else d,
                            period_nights=str(len(period_nights((DATASET if product == "temper" else LIGHTS).dates, d, days)) if days > 1 else 1),
                            sensor="Suomi NPP VIIRS",
                            source="the night's passes joined on the viewer's grid (per pixel the smallest view zenith), not raw swaths"
                            if product == "temper" else "the night's Black Marble tiles, usable cells averaged to the viewer's grid",
                            generator="VIIRS · Analyze. Study. Observe. (offline viewer)")
            if area:
                dst.update_tags(area=area, area_note="cropped to the area's rectangle, NaN outside its polygon")
        data = mem.read()
    period = "_" + period_label(d, days) if days > 1 else ""
    if area:   # the header carries ASCII only: an area's own name (often Hebrew) is in the file's tags
        period += "_" + (re.sub(r"[^A-Za-z0-9]+", "_", area).strip("_")[:40] or "area")
    name = f"{'TEMPER' if product == 'temper' else 'LIGHTROAST'}_{re.sub(r'\W+', '_', DATASET.root.name)}_{d}{period}_{'wgs84' if crs == 'wgs84' else 'epsg6933'}.tif"
    return data, "image/tiff", name


def connect(body):
    """Open a country folder (inside the data root) for everything that follows."""
    global DATASET, LIGHTS
    target = Path(body["path"]).expanduser().resolve()
    if not target.is_relative_to(data_root().expanduser().resolve()):
        raise ValueError("התיקייה מחוץ לתיקיית הנתונים.")
    candidate = open_dataset(target)
    lights = open_lights(candidate)
    with LOCK:
        DATASET, LIGHTS = candidate, lights
    remember_country(target)
    warm()
    return dict(candidate.metadata(), lightroast=lights_meta())


# ---------- start-up: the last country, open and warm before the page asks ----------
# The country opened last is remembered (beside the user's areas) and opened again when the server starts, in the
# background; then what the page asks for first (each product's change log, and the behaviour search's shapes) is
# prepared, so the workspace and the tour open on data that is already loaded.
def last_country_file():
    return AREAS / ".last_country"


def remember_country(path):
    try:
        AREAS.mkdir(parents=True, exist_ok=True)
        last_country_file().write_text(str(path), encoding="utf-8")
    except OSError:
        pass


def warm():
    ds = DATASET

    def run():
        wait_tour()
        for product in ("temper", "lightroast"):
            if DATASET is not ds or (product == "lightroast" and not LIGHTS):
                continue
            try:
                event_log(product)
                shapes(product)
            except Exception as e:   # only a head start: the requests themselves build what is missing
                print("warm-up", product, type(e).__name__, e, flush=True)
        warm_story(ds)
        if DATASET is ds:
            lab_get({})   # made now if missing, so the tour finds it ready
    threading.Thread(target=run, daemon=True, name="warm").start()


def preload():
    """Open the country used last (when it is still under the data root), unless the page connects one first."""
    global DATASET, LIGHTS, PRELOADING
    try:
        target = Path(last_country_file().read_text(encoding="utf-8").strip())
        if not target.is_dir() or not target.resolve().is_relative_to(data_root().expanduser().resolve()):
            return
    except (OSError, ValueError):
        return
    PRELOADING = True

    def run():
        global DATASET, LIGHTS, PRELOADING
        try:
            candidate = open_dataset(target)
            lights = open_lights(candidate)
            with LOCK:
                if DATASET is None:
                    DATASET, LIGHTS = candidate, lights
            if DATASET is candidate:
                print("Opened the last country:", target.name, flush=True)
                warm()
        except (ValueError, OSError) as e:
            print("Could not open the last country", target, e, flush=True)
        finally:
            PRELOADING = False
    threading.Thread(target=run, daemon=True, name="preload").start()


def lights_series(body):
    """LIGHT ROAST: a window's nightly series."""
    if not LIGHTS:
        raise ValueError(NO_LIGHTS)
    x, y, size = float(body["x"]), float(body["y"]), float(body["size_km"])
    requested, r0, r1, c0, c1, roi = DATASET.window_cells(x, y, size, body.get("polygons"))
    lon, lat = DATASET.to_lonlat.transform(x, y)
    return dict(LIGHTS.series(r0, r1, c0, c1, roi), bounds=requested, size_km=size, center=[x, y], lonlat=[lon, lat])


# ---------- the user's files: points, polygons ----------
def import_vectors(body):
    """POST /api/import {files: [{name, data (base64)}]}: GeoJSON, a CSV of points, or a shapefile (a .zip, or the
    .shp with its .dbf, .prj and .cpg; vectors.py), on the grid: its points (each inside the image or not) and its
    polygons; lines are left out and counted."""
    import base64
    import vectors
    from pyproj import CRS
    files = {f["name"]: base64.b64decode(f["data"]) for f in body.get("files", [])}
    if not files:
        raise ValueError("לא נבחר קובץ.")
    feats, crs = vectors.read(files)
    if not crs:
        raise ValueError("לא ידוע באיזו מערכת קואורדינטות הקובץ: חסר קובץ ה־prj של ה־shapefile.")
    try:
        src = CRS.from_user_input(crs)
    except Exception:
        raise ValueError("מערכת הקואורדינטות בקובץ ה־prj לא מוכרת.") from None
    grid, b = DATASET.profile["crs"], DATASET.bounds
    to_grid = Transformer.from_crs(src, grid, always_xy=True).transform
    to_ll = Transformer.from_crs(grid, 4326, always_xy=True).transform
    points, polygons, lines, outside = [], [], 0, 0
    for f in feats:
        g = f["geometry"]
        if f["kind"] == "point":
            coords = [g["coordinates"]] if g["type"] == "Point" else g["coordinates"]
            for k, c in enumerate(coords):
                x, y = to_grid(float(c[0]), float(c[1]))
                if not (np.isfinite(x) and np.isfinite(y)):
                    continue
                inside = b[0] <= x <= b[2] and b[1] <= y <= b[3]
                outside += not inside
                lon, lat = to_ll(x, y)
                points.append(dict(name=f["name"] + (f" ({k + 1})" if len(coords) > 1 else ""), x=round(x, 1), y=round(y, 1), lonlat=[round(lon, 6), round(lat, 6)], inside=inside))
        elif f["kind"] == "polygon":
            geom = make_valid(shape(g))
            if src.is_geographic:
                geom = segmentize(geom, .05)
            geom = transform(geom, lambda xs, ys: to_grid(xs, ys), interleaved=False)
            if not geom.is_empty and geom.geom_type in ("Polygon", "MultiPolygon"):
                polygons.append(dict(name=f["name"], geometry=mapping(geom)))
        else:
            lines += 1
    if not points and not polygons:
        raise ValueError("בקובץ אין נקודות או פוליגונים" + (" (רק קווים)." if lines else "."))
    return dict(points=points[:2000], polygons=polygons[:200], lines=lines, outside=outside, crs=src.name)


# ---------- a layer of points: each point's behaviour ----------
# For every point of the user's layer, its two nightly series over a small window (default 2.25 km: 3 x 3 cells),
# read for all the points at once, night by night (one opening of each night's layers for the whole layer), and the
# shape of its year as the area analysis finds it (seed_series, series_profile). TEMPER: the window's mean M10 less the
# night's noise mean for each pixel's view zenith (as the place's graph: "corrected"), and whether a source burned in
# it (M10 above the night's threshold, with M11 above its own noise in the window where M11 exists). LIGHT ROAST: the
# window's mean radiance.
def points_series(body):
    ds, L = DATASET, LIGHTS
    pts = body.get("points") or []
    if not pts:
        raise ValueError("אין נקודות.")
    if len(pts) > 500:
        raise ValueError("עד 500 נקודות בבקשה אחת.")
    size = float(body.get("size_km") or 2.25)
    k = max(1, min(15, round(size / .75)))
    off = np.arange(-(k // 2), k - k // 2)
    T, H, W = ds.profile["transform"], ds.profile["height"], ds.profile["width"]
    rows, cols = [], []
    for x, y in ((float(p[0]), float(p[1])) for p in pts):
        c, r = ~T * (x, y)
        r, c = int(math.floor(r)), int(math.floor(c))
        rr, cc = np.meshgrid(r + off, c + off, indexing="ij")
        rows.append(np.clip(rr.ravel(), 0, H - 1))
        cols.append(np.clip(cc.ravel(), 0, W - 1))
    rows, cols = np.array(rows), np.array(cols)
    bx = ds.bounds
    inside = np.array([bx[0] <= float(p[0]) <= bx[2] and bx[1] <= float(p[1]) <= bx[3] for p in pts])
    budget, far = hot_budget(), m11_confirm_far()
    t_dates = [d for d in ds.dates if ds.layers_ready(d)]
    t_val = np.full((len(pts), len(t_dates)), np.nan, np.float32)
    t_hot = np.zeros((len(pts), len(t_dates)), bool)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        for j, d in enumerate(t_dates):
            layers = ds.layers(d)
            model = layers["noise"]
            v = np.asarray(layers["value"][rows, cols], np.float32)
            deg = ds._deg(np.asarray(layers["vza"][rows, cols]))
            if model["bands"]:
                t_val[:, j] = np.nanmean(v - ds._bias_of(deg, model), 1)
            hot = (v > ds.limit(model, deg, budget)).any(1)
            m = model.get("m11")
            if m and m.get("fit"):
                m11 = np.asarray(layers["m11"][rows, cols], np.float32)
                seen = np.isfinite(m11).any(1)
                hit = (np.nan_to_num(m11) > ds.limit(m, deg, far * m["fit"]["N"])).any(1)
                hot &= hit | ~seen
            t_hot[:, j] = hot
        l_dates, l_val = [], None
        if L:
            l_dates = [d for d in L.dates if L.ready(d)]
            l_val = np.full((len(pts), len(l_dates)), np.nan, np.float32)
            for j, d in enumerate(l_dates):
                l_val[:, j] = np.nanmean(np.asarray(L.layer(d)[rows, cols], np.float32), 1)
    num = lambda a: [None if not np.isfinite(v) else float(f"{v:.4g}") for v in a]
    if L:   # the lit blocks (the behaviour search's places), to tell a lit point from a dark one without reading again
        bx, by = (np.asarray(v) for v in L.block_centres(L.blocks()["blocks"]))
    out, half = [], size * 500
    for i, p in enumerate(pts):
        x, y = float(p[0]), float(p[1])
        item = dict(inside=bool(inside[i]), temper=num(t_val[i]), hot=[int(j) for j in np.flatnonzero(t_hot[i])])
        try:
            series, _, info = seed_series("temper", x, y, size)
            item["temper_shape"] = series_profile(series, "temper", info)
        except ValueError as e:
            item["temper_shape"] = dict(none=str(e))
        if L:
            item["lightroast"] = num(l_val[i])
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", RuntimeWarning)
                med = float(np.nanmedian(l_val[i])) if np.isfinite(l_val[i]).any() else 0.0
            if ((np.abs(bx - x) <= half) & (np.abs(by - y) <= half)).any():   # a lit block inside: as the area analysis
                series, _, info = seed_series("lightroast", x, y, size)
                item["lightroast_shape"] = series_profile(series, "lightroast", info)
            elif med < lightroast.LIT_NW:
                item["lightroast_shape"] = dict(none="חשוך: ברוב הלילות פחות מ־%g nW" % lightroast.LIT_NW, median_nw=round(med, 2))
            else:   # lit, between the blocks: its own nights (log radiance)
                series = {d: float(np.log(v)) for d, v in zip(l_dates, l_val[i]) if np.isfinite(v) and v > 0}
                item["lightroast_shape"] = series_profile(series, "lightroast")
        out.append(item)
    return dict(dates=dict(temper=t_dates, lightroast=l_dates), size_km=round(k * .75, 2), points=out)


# path -> (needs a country open, the answer: JSON, (bytes, MIME type) for an image, or (bytes, MIME type, file name) for
# a download). GET takes the query string,
# POST the JSON body. /api/lr/... is LIGHT ROAST (lights_get).
GET_ROUTES = {
    "/api/metadata": (False, lambda q: dict(DATASET.metadata(), lightroast=lights_meta()) if DATASET else {"error": NO_COUNTRY}),
    "/api/countries": (False, lambda q: list_countries(data_root())),
    "/api/progress": (False, progress),
    "/api/health": (False, lambda q: dict(ok=True, offline=True, connected=DATASET is not None, preloading=PRELOADING)),
    "/api/image": (True, temper_image),
    "/api/pixel": (True, temper_pixel),
    "/api/basemap": (True, lambda q: DATASET.basemap()),
    "/api/hotspots": (True, lambda q: DATASET.hotspots(q["date"][0], window_param(q))),
    "/api/changes": (True, lambda q: DATASET.changes(q["date"][0], window_param(q))),
    "/api/events": (True, events),
    "/api/sites": (True, lambda q: sites()),
    "/api/areas": (True, lambda q: get_areas()),
    "/api/export": (True, export_night),
}
POST_ROUTES = {
    "/api/connect": (False, connect),
    "/api/series": (True, lambda b: DATASET.series(float(b["x"]), float(b["y"]), float(b["size_km"]), b.get("polygons"))),
    "/api/lr/series": (True, lights_series),
    "/api/related": (True, related),
    "/api/behaviour": (True, behaviour),
    "/api/area": (True, area),
    "/api/areas": (True, save_areas),
    "/api/import": (True, import_vectors),
    "/api/network": (True, network),
    "/api/points": (True, points_series),
}


class Handler(BaseHTTPRequestHandler):
    def reply(self, body, status=200, mime="application/json", headers=None):
        if mime == "application/json" and not isinstance(body, (bytes, bytearray)):   # a .json file is sent as it is
            body = json.dumps(body, allow_nan=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", CSP)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def answer(self, result):
        """A route's answer: JSON, (bytes, MIME type), or (bytes, MIME type, file name) for a download."""
        if isinstance(result, tuple):
            extra = {"Content-Disposition": f'attachment; filename="{result[2]}"'} if len(result) > 2 else None
            return self.reply(result[0], mime=result[1], headers=extra)
        return self.reply(result)

    def verify_origin(self, path=""):
        """Only this viewer's own pages may use the API. The Host must be the local address or in TEMPER_ALLOWED_HOSTS
        (guards against DNS rebinding), and a browser Origin must match the Host (no cross-site requests).
        The health check is exempt so platform probes, which call the pod IP, pass."""
        if path == "/api/health":
            return
        host = self.headers.get("Host", "").lower()
        name = host[1:host.find("]")] if host.startswith("[") else host.rsplit(":", 1)[0]
        local = host in (f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}")
        if not local and "*" not in ALLOWED_HOSTS and name not in ALLOWED_HOSTS:
            raise ValueError("יש לפתוח את המציג בכתובת שלו.")
        origin = self.headers.get("Origin")
        if origin and urlparse(origin).netloc.lower() != host:
            raise ValueError("בקשות ממקור אחר חסומות.")

    def static_file(self, path):
        """The page's own files (static/), index.html for /. A byte range (Range: bytes=a-b) is answered with just
        that part, as the opening screen's video asks for it."""
        relative = path.lstrip("/") or "index.html"
        file = (STATIC / relative).resolve()
        if not file.is_relative_to(STATIC) or not file.is_file():
            raise NotFound()
        mime = mimetypes.guess_type(str(file))[0] or "application/octet-stream"
        asked = re.fullmatch(r"bytes=(\d*)-(\d*)", self.headers.get("Range", "").strip())
        if asked and (asked.group(1) or asked.group(2)):
            size = file.stat().st_size
            a, b = asked.groups()
            start, end = (int(a), min(size - 1, int(b) if b else size - 1)) if a else (max(0, size - int(b)), size - 1)
            if start >= size or start > end:
                return self.reply(b"", 416, mime, {"Content-Range": f"bytes */{size}"})
            with open(file, "rb") as f:
                f.seek(start)
                part = f.read(end - start + 1)
            return self.reply(part, 206, mime, {"Content-Range": f"bytes {start}-{end}/{size}", "Accept-Ranges": "bytes"})
        return self.reply(file.read_bytes(), mime=mime, headers={"Accept-Ranges": "bytes"})

    def do_GET(self):
        try:
            parsed = urlparse(self.path)
            self.verify_origin(parsed.path)
            q = parse_qs(parsed.query)
            if parsed.path.startswith("/api/lr/"):
                return self.answer(lights_get(parsed.path, q))
            if parsed.path not in GET_ROUTES:
                return self.static_file(parsed.path)
            needs_country, route = GET_ROUTES[parsed.path]
            if needs_country and not DATASET:
                raise ValueError(NO_COUNTRY)
            return self.answer(route(q))
        except Preparing as p:
            self.reply({"preparing": True, "done": p.done, "total": p.total}, 202)
        except NotFound:
            self.reply({"error": "Not found"}, 404)
        except (ValueError, KeyError, OSError) as exc:
            self.reply({"error": str(exc)}, 400)

    def do_POST(self):
        try:
            self.verify_origin()
            size = int(self.headers.get("Content-Length", 0))
            if size > (80_000_000 if self.path == "/api/import" else 2_000_000):   # a shapefile may be large
                raise ValueError("הבקשה גדולה מדי.")
            body = json.loads(self.rfile.read(size))
            if self.path not in POST_ROUTES:
                raise NotFound()
            needs_country, route = POST_ROUTES[self.path]
            if needs_country and not DATASET:
                raise ValueError(NO_COUNTRY)
            return self.answer(answered(self.path, body, route))
        except NotFound:
            self.reply({"error": "Not found"}, 404)
        except (ValueError, KeyError, OSError, TypeError) as exc:
            self.reply({"error": str(exc)}, 400)

    def log_message(self, fmt, *args):
        if "/api/image" not in args[0]:
            print(fmt % args, flush=True)


# ---------- answers kept: the same question, answered again at once ----------
# A place's series, its area analysis, what is related to it and a behaviour search take seconds on a large country.
# Asked again (the tour's story, a place opened again), they come from memory, as long as nothing has changed since:
# the same country and nights, and the background workers idle all the while (when one starts on new data, every
# answer kept is dropped). Answers about nights still being prepared are not kept.
ANSWER_PATHS = {"/api/series", "/api/lr/series", "/api/area", "/api/related", "/api/behaviour"}
ANSWERS_MAX = 160
_ANSWERS, _ANSWER_LOCK = {}, threading.Lock()
_WORK = dict(epoch=0, temper=True, lights=True)   # busy until each worker first finds nothing to do


def worker_state(name, busy):
    if busy and not _WORK[name]:
        _WORK["epoch"] += 1
        with _ANSWER_LOCK:
            _ANSWERS.clear()
    _WORK[name] = busy


def _answer_key(path, body):
    def norm(v):
        if v is None or isinstance(v, (bool, str)):
            return v
        if isinstance(v, (int, float)):
            return round(float(v), 3)
        if isinstance(v, dict):
            return {k: norm(x) for k, x in v.items() if x is not None}
        if isinstance(v, list):
            return [norm(x) for x in v]
        return str(v)
    b = norm(body)
    if path == "/api/behaviour":   # what is on the map, and the user's areas, only when the query asks for them
        q = str(b.get("query", ""))
        if "view" not in q:
            b.pop("view", None)
        if "within" not in q:
            b.pop("areas", None)
    ds, L = DATASET, LIGHTS
    return (path, ds.id if ds else None, len(ds.dates) if ds else 0, L.id if L else None, len(L.dates) if L else 0,
            _WORK["epoch"], change_context(), json.dumps(b, sort_keys=True))


def answered(path, body, route):
    if path not in ANSWER_PATHS or not isinstance(body, dict):
        return route(body)
    key = _answer_key(path, body)
    with _ANSWER_LOCK:
        if key in _ANSWERS:
            _ANSWERS[key] = _ANSWERS.pop(key)   # the latest at the end
            return _ANSWERS[key]
    out = route(body)
    if not (_WORK["temper"] or _WORK["lights"]) and key[5] == _WORK["epoch"] and isinstance(out, dict) \
            and not any(out.get(k) for k in ("pending", "thermal_pending", "cloud_pending")):
        with _ANSWER_LOCK:
            _ANSWERS[key] = out
            while len(_ANSWERS) > ANSWERS_MAX:
                _ANSWERS.pop(next(iter(_ANSWERS)))
    return out


# ---------- the tour's story: a place chosen per country, its answers prepared ahead ----------
# static/story.json holds, per country, the place the tour walks through (a point, its change, a place related to it,
# a step), chosen from the data. When the country opens and the background workers are idle, its questions are asked
# once, so the tour's answers are already kept (see answers kept).
def story_for(name):
    try:
        return json.loads((STATIC / "story.json").read_text(encoding="utf-8")).get(name)
    except (OSError, ValueError):
        return None


def story_requests(s):
    out = []
    for p in (s["seed"], s["partner"]):
        place = dict(x=p["x"], y=p["y"], size_km=p["size_km"])
        out += [("/api/series", place), ("/api/lr/series", place), ("/api/area", place)]
    out.append(("/api/related", s["related"]))
    out.append(("/api/behaviour", dict(product=s["search"]["product"], query=s["search"]["query"])))
    return out


def warm_story(ds):
    s = story_for(ds.root.name)
    if not s:
        return
    for _ in range(1200):   # until the workers are idle (answers are kept only then), at most an hour
        if DATASET is not ds:
            return
        if not (_WORK["temper"] or _WORK["lights"]):
            break
        time.sleep(3)
    for path, body in story_requests(s):
        if DATASET is not ds:
            return
        try:
            answered(path, body, POST_ROUTES[path][1])
        except Exception as e:
            print("story", path, type(e).__name__, e, flush=True)
    print("Story ready:", ds.root.name, flush=True)


# ---------- the parameters the math panel can change ----------
# A few of the thresholds the methods use (METHODS.md gives each), changeable from the math page (a secret: three clicks
# on the product's emblem) and kept in config.json ("params", only those changed). Each has its range and its group, which says
# what is made again when it changes: the event log is linked again (events), the behaviour shapes are worked out
# again (shapes); every kept answer is dropped, and the tour's lab is made again (its stamp names the changed ones).
PARAMS = {   # name: (lowest, highest, step, group)
    "EVENT_LINK_KM": (.5, 5, .25, "events"), "EVENT_GAP_DAYS": (1, 21, 1, "events"), "EVENT_FLARE_KM": (.5, 10, .5, "events"),
    "EVENT_FIELD_KM": (2, 30, 1, "events"), "EVENT_STEADY_SHARE": (.05, .8, .05, "events"), "EVENT_AREA_MIN": (2, 20, 1, "events"),
    "EVENT_AREA_KM": (5, 100, 5, "events"), "EVENT_AREA_DAYS": (1, 7, 1, "events"), "EVENT_OUTAGE_RATIO": (.1, .9, .05, "events"),
    "SHAPE_STEP_R2": (.2, .9, .05, "shapes"), "SHAPE_STEP_EFF": (1, 6, .25, "shapes"), "SHAPE_STEP_BEAT": (0, .4, .05, "shapes"),
    "SHAPE_TREND_R2": (.1, .9, .05, "shapes"), "SHAPE_FLUCT_SWITCHES": (2, 20, 1, "shapes"), "SHAPE_SPIKE_MAX": (.01, .2, .01, "shapes"),
    "CONSTANT_HOT_SHARE": (.1, .95, .05, "shapes"), "CONSTANT_LIT_SHARE": (.5, 1, .05, "shapes"),
    "SIMILAR_MIN_R": (.1, .9, .05, "related"), "CO_Z": (2, 10, .5, "related"),
    "ACTIVE_HEAT": (.01, .5, .01, "area"), "COMPOSITE_HOT_SIGMA": (3, 50, 1, "composites"),
}
PARAM_DEFAULTS = {k: globals()[k] for k in PARAMS}


def param_sig():
    changed = {k: globals()[k] for k in PARAMS if globals()[k] != PARAM_DEFAULTS[k]}
    return hashlib.sha256(json.dumps(changed, sort_keys=True).encode()).hexdigest()[:10] if changed else ""


def params_get(q):
    return dict(params=[dict(name=k, value=globals()[k], default=PARAM_DEFAULTS[k], min=lo, max=hi, step=st, group=g) for k, (lo, hi, st, g) in PARAMS.items()])


def _apply_params(values):
    groups = set()
    for k, v in values.items():
        if k not in PARAMS:
            continue
        lo, hi, _, g = PARAMS[k]
        v = min(hi, max(lo, float(v)))
        if isinstance(PARAM_DEFAULTS[k], int):
            v = int(round(v))
        if globals()[k] != v:
            globals()[k] = v
            groups.add(g)
    if "events" in groups:
        _EVENT_CACHE.clear()
    if "shapes" in groups:
        _SHAPES.clear()
    if groups:
        _WORK["epoch"] += 1
        with _ANSWER_LOCK:
            _ANSWERS.clear()
        if "_LAB" in globals():   # defined below; at start-up there is nothing kept yet
            _LAB["mem"] = None
    return groups


def params_set(body):
    """POST /api/params {values: {name: value}} or {reset: true}: applied at once and kept in config.json."""
    values = dict(PARAM_DEFAULTS) if body.get("reset") else body.get("values") or {}
    groups = _apply_params(values)
    try:
        config = json.loads(CONFIG.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        config = {}
    config["params"] = {k: globals()[k] for k in PARAMS if globals()[k] != PARAM_DEFAULTS[k]}
    if not config["params"]:
        del config["params"]
    CONFIG.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
    return dict(params_get({}), changed=sorted(groups))


def load_params():
    try:
        _apply_params(json.loads(CONFIG.read_text(encoding="utf-8")).get("params") or {})
    except (OSError, ValueError):
        pass


GET_ROUTES["/api/params"] = (False, params_get)
POST_ROUTES["/api/params"] = (False, params_set)
load_params()


# ---------- the lab: the tour's places, worked out ahead ----------
# The tour shows real places of the open country (its story, its strongest changes, an example of each phenomenon) as in
# a lab: every graph and answer it shows is worked out ahead and kept in one file, so the tour never waits. The file
# holds each place's two series and its area analysis (as /api/series, /api/lr/series and /api/area answer them), the
# changes it points at, the related places it asks for and the behaviour searches it runs. It is made for the data as
# they are (its stamp: the country, its nights, the layers' versions and the story), shipped for the countries on this
# computer in static/lab/. It is a sandbox: new nights do not touch it (the tour shows it at its own night), and it is
# made in the background (into the country's cache) only for a country without one, or after its story changes.
LAB_VERSION = 2
LAB_EXAMPLES = (   # one of each phenomenon, the first (most significant) in the change log; as help.js names them
    ("flare", "temper", lambda e: e.get("cause") == "flare" and e["kind"] in ("brighter", "new")),
    ("fire", "temper", lambda e: e.get("cause") == "fire"),
    ("newlight", "lightroast", lambda e: e["kind"] == "new" and e["nights"] >= 5 and e.get("cause") == "lighting"),
    ("outage", "lightroast", lambda e: e.get("cause") == "outage"),
    ("offlight", "lightroast", lambda e: e["kind"] == "off" and e.get("cause") == "lighting"),
    ("field", "lightroast", lambda e: e.get("cause") == "field"),
    ("regional", "lightroast", lambda e: e.get("cause") == "regional"))
_LAB = dict(mem=None, building=None)


def lab_stamp(ds, L):
    s = story_for(ds.root.name)
    data = {k: s[k] for k in ("night", "seed", "change", "partner", "related", "search")} if s else None   # not its texts
    story = hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()[:12] if s else ""
    span = lambda dates: f"{len(dates)}:{dates[0] if dates else ''}:{dates[-1] if dates else ''}"
    params = param_sig()
    return f"{LAB_VERSION}|{ds.root.name}|{LAYERS}|{span(ds.dates)}|{lightroast.LAYERS if L else ''}|{span(L.dates) if L else ''}|{story}" + (f"|p{params}" if params else "")


def _cluster_km(e):
    """The window the page opens around a change (places.js: clusterSize)."""
    a = ((e.get("detail") or {}).get("area_km2") or e.get("area_km2") or 0)
    return max(2.25, math.ceil((math.sqrt(a) + 1.5) / .75) * .75)


LAB_NAMES = dict(flare=["להבת גז", "Gas flare"], fire=["שריפה", "Fire"], newlight=["אור חדש שנשאר", "New lights that stayed"],
                 outage=["הפסקת חשמל", "Blackout"], offlight=["אור שכבה", "Lights that went out"], field=["שדה נפט וגז", "Oil and gas field"],
                 regional=["שינוי אזורי", "Regional shift"])


def build_lab(ds, L):
    out = dict(stamp=lab_stamp(ds, L), country=ds.root.name, made=datetime.now().isoformat(timespec="seconds"), night=ds.dates[-1],
               places={}, first={}, related={}, search={}, examples=[], story=None)

    def place(key, x, y, size):
        if key not in out["places"]:
            body = dict(x=float(x), y=float(y), size_km=float(size))
            p = dict(body)
            for k, f in (("temper", lambda: ds.series(body["x"], body["y"], body["size_km"])), ("lightroast", lambda: lights_series(body)), ("area", lambda: area(body))):
                if k == "lightroast" and not L:
                    continue
                try:
                    p[k] = f()
                except Exception as e:   # a place outside a product's data: the page shows the other
                    p[k + "_error"] = str(e)
            out["places"][key] = p
        return key

    def ask(body):
        try:
            return related(body)
        except Exception as e:
            return dict(error=str(e))

    products = ["temper"] + (["lightroast"] if L else [])
    lists = {p: events({"product": [p]})["events"] for p in products}
    for p in products:   # the strongest changes (the tour without a story opens them), and what is related to the first
        firm = [e for e in lists[p] if (e.get("sig") or {}).get("level") != "weak"] or lists[p]
        out["first"][p] = []
        for e in firm[:2]:
            out["first"][p].append(dict(event=e, place=place(e["id"], e["x"], e["y"], _cluster_km(e))))
            out["related"][e["id"]] = ask(dict(x=e["x"], y=e["y"], size_km=_cluster_km(e), seed=p, target=p, onset=e["onset"], last=e["last"], kind=e["kind"], regional=False))
        q = "shape = step"
        r = behaviour(dict(product=p, query=q))
        if not r["total"]:   # no step: the shape this country has most of
            best = max(("trend", "fluct", "spike"), key=lambda s: r["counts"].get(s, 0))
            if r["counts"].get(best):
                q = "shape = " + best
                r = behaviour(dict(product=p, query=q))
        out["search"][p] = dict(query=q, data=r)
    firsts = {x["event"]["id"] for p in products for x in out["first"][p][:1]}
    for name, p, match in LAB_EXAMPLES:
        if p not in lists:
            continue
        e = next((e for e in lists[p] if match(e) and e["id"] not in firsts), None)
        if e:
            out["examples"].append(dict(kind=name, product=p, event=e, place=place(e["id"], e["x"], e["y"], _cluster_km(e))))
    s = story_for(ds.root.name)
    if s:
        change = next((e for e in lists.get(s["change"]["product"], []) if e["id"] == s["change"]["id"]), None)
        out["story"] = dict(seed=place("story-seed", s["seed"]["x"], s["seed"]["y"], s["seed"]["size_km"]),
                            partner=place("story-partner", s["partner"]["x"], s["partner"]["y"], s["partner"]["size_km"]),
                            change=change, related=ask(dict(s["related"])),
                            search=dict(query=s["search"]["query"], data=behaviour(dict(product=s["search"]["product"], query=s["search"]["query"]))))
    # The tour's period step: the 16-day cycle holding the lab's night, rendered once for each product (the tour shows
    # it on the map without building anything).
    import base64
    night = ds.dates[-1]
    out["period"] = dict(days=16, span=period_span(night, 16), images={})
    try:
        n = period_nights(ds.dates, night, 16)
        a = _temper_composite(ds, n, dict(done=0, total=len(n)))
        out["period"]["images"]["temper"] = base64.b64encode(ds.combo_png(a["sig_max"], a["temperature_k"], a["seen_nights"] > 0)).decode()
        if L:
            n = period_nights(L.dates, night, 16)
            a = _lights_composite(L, n, dict(done=0, total=1))
            out["period"]["images"]["lightroast"] = base64.b64encode(L.lights_png(np.asarray(a["median_nw"], np.float32))).decode()
    except Exception as e:
        out["period"]["error"] = str(e)
    # The network tab, for the story's place (else the strongest change in light, or in heat).
    if s:
        r = s["related"]
        at = dict(x=r["x"], y=r["y"], size_km=r["size_km"], product=r["seed"])
    else:
        p = "lightroast" if out["first"].get("lightroast") else "temper"
        e = out["first"][p][0]["event"] if out["first"].get(p) else None
        at = dict(x=e["x"], y=e["y"], size_km=_cluster_km(e), product=p) if e else None
    if at:
        try:
            out["network"] = dict(network(dict(at, nodes=25)), at=at)
        except Exception as e:
            out["network"] = dict(error=str(e), at=at)
    # The point layer, shown with the lab's places as points (the story's two, an example of each phenomenon).
    demo = []
    if s:
        demo += [(["המקום של הסיפור", "The story's place"], s["seed"]), (["המקום שזז איתו", "The place moving with it"], s["partner"])]
    for ex in out["examples"]:
        demo.append((LAB_NAMES.get(ex["kind"], [ex["kind"], ex["kind"]]), out["places"][ex["place"]]))
    if demo:
        xy = [[float(p["x"]), float(p["y"])] for _, p in demo]
        out["points"] = dict(names=[n for n, _ in demo], xy=xy, lonlat=[list(ds.to_lonlat.transform(x, y)) for x, y in xy],
                             data=points_series(dict(points=xy, size_km=2.25)))
    return out


def _lab_files(ds):
    return [ds.cache / "lab.json", STATIC / "lab" / f"{ds.root.name}.json"]


def lab_get(q):
    """GET /api/lab: the open country's lab. A sandbox: it is kept for its country and its story, whatever nights have
    arrived since (the tour shows what it holds, at its own night); made in the background only when the country has
    none (the tour meanwhile works live)."""
    ds, L = DATASET, LIGHTS
    stamp = lab_stamp(ds, L)
    key = lambda s: (lambda p: (p[0], p[1], p[6], p[7:]) if len(p) >= 7 else None)(s.split("|"))
    want = key(stamp)   # its version, the country, the story (and changed thresholds, if any): not the nights
    if _LAB["mem"] and _LAB["mem"][0] == want:
        return _LAB["mem"][1]
    found = []
    for f in _lab_files(ds):   # the one made here (cache) first, then the shipped one; one made for these data wins
        try:
            d = json.loads(f.read_bytes())   # read once: kept in memory after
            if key(d.get("stamp", "")) == want:
                found.append(d)
        except (OSError, ValueError):
            continue
    if found:
        d = next((x for x in found if x["stamp"] == stamp), found[0])
        d.setdefault("night", d["stamp"].split("|")[3].split(":")[-1])
        d["current"] = d["stamp"] == stamp
        _LAB["mem"] = (want, (json.dumps(d, allow_nan=False).encode(), "application/json"))
        return _LAB["mem"][1]
    if _LAB["building"] != stamp:
        _LAB["building"] = stamp
        threading.Thread(target=_make_lab, args=(ds, L, stamp), daemon=True, name="lab").start()
    return dict(ready=False)


GET_ROUTES["/api/lab"] = (True, lab_get)


def _make_lab(ds, L, stamp):
    try:
        wait_tour()
        for _ in range(1200):   # when the workers have nothing to do (the series then have every night)
            if DATASET is not ds:
                return
            if not (_WORK["temper"] or _WORK["lights"]):
                break
            time.sleep(3)
        t = time.time()
        lab = build_lab(ds, L)
        if lab["stamp"] != stamp or DATASET is not ds:
            return
        path = ds.cache / "lab.json"
        temp = path.with_name("lab.json.partial")
        temp.write_text(json.dumps(lab, allow_nan=False), encoding="utf-8")
        temp.replace(path)
        print(f"Lab ready: {ds.root.name}, {len(lab['places'])} places, {path.stat().st_size / 1e6:.1f} MB in {time.time() - t:.0f}s", flush=True)
    except Exception as e:
        print("lab", type(e).__name__, e, flush=True)
    finally:
        _LAB["building"] = None


# ---------- the tour: a sandbox ----------
# While the tour runs (the page says so, /api/tour), the background waits: no night is prepared, nothing is built
# ahead or made again, so the tour shows its lab and nothing loads behind it; when the tour ends, everything starts.
# A hold the page never ends (closed during the tour) lapses after TOUR_HOLD_S.
TOUR_HOLD_S = 900
_TOUR = dict(until=0.0)


def tour_hold():
    return time.time() < _TOUR["until"]


def wait_tour():
    while tour_hold():
        time.sleep(1)


def tour_set(body):
    _TOUR["until"] = time.time() + TOUR_HOLD_S if body.get("active") else 0.0
    return dict(hold=tour_hold())


POST_ROUTES["/api/tour"] = (False, tour_set)


# ---------- background workers, and start-up ----------
def build_worker():
    """Prepare every night of the open country in the background, newest first, so time series and hot spots
    read ready layers: first each night's layers (rebuilding older formats), then the cloud layers, which need
    the neighbouring nights, then the change-detection summaries. Switching country switches the work to it."""
    failed, swept = set(), set()
    while True:
        ds = DATASET
        if not ds or tour_hold():
            time.sleep(1 if ds else 3)
            continue
        todo = [d for d in reversed(ds.dates) if (ds.id, d) not in failed and ds.layers_version(d) != LAYERS]
        clouds = [] if todo else [d for d in reversed(ds.dates) if (ds.id, d, CLOUD) not in failed and not ds.cloud_ready(d) and ds.cloud_possible(d)]
        states = [] if todo or clouds else [d for d in reversed(ds.dates) if (ds.id, d, CHANGE) not in failed
                                            and ds.state_possible(d) and not ds._v2(d, CHANGE + ".npz").exists()]
        logged = [] if todo or clouds or states else [d for d in reversed(ds.dates) if (ds.id, d, "events") not in failed
                                                       and ds._v2(d, CHANGE + ".npz").exists() and not ds._v2(d, f"events.{CHANGE}.w{change_context()}.json").exists()]
        if logged:   # the event log's store: each night's changes, once
            worker_state("temper", True)
            try:
                if ds is DATASET:
                    night_events("temper", logged[0])
            except Exception as exc:
                failed.add((ds.id, logged[0], "events"))
                print("EVENTS FAILED", logged[0], exc, flush=True)
            continue
        if todo or clouds or states:
            worker_state("temper", True)
            job = (ds.id, todo[0]) if todo else (ds.id, clouds[0], CLOUD) if clouds else (ds.id, states[0], CHANGE)
            try:
                ds.upgrade_layers(todo[0]) if todo else ds.prepare_cloud(clouds[0]) if clouds else ds.change_state(states[0])
            except Exception as exc:   # one unreadable night must not stop the rest
                failed.add(job)
                print("LAYERS FAILED", job[1:], exc, flush=True)
            continue
        if ds.id not in swept and ds.sweep_older_layers() == 0:
            swept.add(ds.id)
        worker_state("temper", False)
        time.sleep(3)


def lights_worker():
    """Prepare LIGHT ROAST's nights for the open country in the background, newest first: the lights, then the cloud
    layers (the chart's cloudy nights), then the second method's SFAC calibration (once, over all nights) and each
    night after SFAC."""
    failed = set()
    while True:
        wait_tour()
        L = LIGHTS
        todo = [d for d in reversed(L.dates) if (L.id, d) not in failed and not L.ready(d)] if L else []
        clouds = [] if todo or not L else [d for d in reversed(L.dates) if (L.id, d, "cloud") not in failed and not L.clouds_ready(d)]
        rx = rx_enabled()
        fit = rx and bool(L) and not todo and not clouds and not L.repo.fitted() and (L.id, "sfac") not in failed
        sfac = [] if not rx or todo or clouds or fit or not L or not L.repo.fitted() else [d for d in reversed(L.dates) if (L.id, d, "sfac") not in failed and not L.repo.corrected_ready(d)]
        if not todo and not clouds and not fit and not sfac and L:
            # The viewer's list reads each night's stored changes: those first, newest first.
            logged = [d for d in reversed(L.dates) if (L.id, d, "events") not in failed and L.ready(d)
                      and not L._path(d, f"events.w{lightroast.DEFAULT_WINDOW}.json").exists()]
            if logged and DATASET:
                worker_state("lights", True)
                try:
                    if L is LIGHTS:
                        night_events("lightroast", logged[0])
                except Exception as exc:
                    failed.add((L.id, logged[0], "events"))
                    print("EVENTS FAILED", logged[0], exc, flush=True)
                continue
            # The related-places blocks, rebuilt when more nights are ready (requests meanwhile use the last ones).
            if not L.blocks_ready() and (L.id, "blocks", len(L.dates)) not in failed:
                worker_state("lights", True)
                try:
                    L.blocks(fresh=True)
                except Exception as exc:
                    failed.add((L.id, "blocks", len(L.dates)))
                    print("LIGHTS FAILED", "blocks", exc, flush=True)
                continue
            if (L.id, "shapes", len(L.dates)) not in failed and not any(k[0] == "lightroast" and k[1] == id(L) for k in _SHAPES):
                worker_state("lights", True)
                try:
                    shapes("lightroast")   # the behaviour search's profiles
                except Exception as exc:
                    failed.add((L.id, "shapes", len(L.dates)))
                    print("LIGHTS FAILED", "shapes", exc, flush=True)
                continue
            if not L.typical_ready() and (L.id, "typical") not in failed:
                worker_state("lights", True)
                try:
                    L.typical()
                except Exception as exc:
                    failed.add((L.id, "typical"))
                    print("LIGHTS FAILED", "typical", exc, flush=True)
                continue
            # Nights stored before the comparison summary was kept: their shared shift for the list's context line
            # and the pixel readout.
            calib = [d for d in reversed(L.dates) if (L.id, d, "calib") not in failed and L.ready(d)
                     and L._path(d, f"events.w{lightroast.DEFAULT_WINDOW}.json").exists() and not L._calib_path(d, lightroast.DEFAULT_WINDOW).exists()]
            if calib:
                worker_state("lights", True)
                try:
                    L.calibration(calib[0], lightroast.DEFAULT_WINDOW)
                except Exception:   # too few nights before it to compare
                    failed.add((L.id, calib[0], "calib"))
                continue
        if not todo and not clouds and not fit and not sfac:
            worker_state("lights", False)
            time.sleep(3)
            continue
        worker_state("lights", True)
        job = (L.id, todo[0]) if todo else (L.id, clouds[0], "cloud") if clouds else (L.id, "sfac") if fit else (L.id, sfac[0], "sfac")
        try:
            L.layer(todo[0]) if todo else L.clouds(clouds[0]) if clouds else L.repo.fit() if fit else L.repo.corrected(sfac[0])
        except Exception as exc:   # one unreadable night must not stop the rest
            failed.add(job)
            print("LIGHTS FAILED", job[1:], exc, flush=True)


def main():
    global DATASET, LIGHTS, LOCAL_ONLY
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=HOST, help="Listen address; 0.0.0.0 in a container (TEMPER_HOST).")
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--data", help="Open this country folder at start; by default the viewer asks for a country.")
    parser.add_argument("--root", help="Use and save this folder of countries as the data root.")
    parser.add_argument("--make-lab", action="store_true", help="Write the --data country's lab to static/lab/ and stop.")
    args = parser.parse_args()
    if args.root:   # keep the other settings in config.json
        try:
            config = json.loads(CONFIG.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            config = {}
        config["data_root"] = str(Path(args.root).resolve())
        CONFIG.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
    if args.data and args.make_lab:   # the lab shipped with the viewer, for the data on this computer
        DATASET = open_dataset(args.data)
        LIGHTS = open_lights(DATASET)
        _WORK.update(temper=False, lights=False)
        lab = build_lab(DATASET, LIGHTS)
        (STATIC / "lab").mkdir(exist_ok=True)
        out = STATIC / "lab" / f"{DATASET.root.name}.json"
        out.write_text(json.dumps(lab, allow_nan=False), encoding="utf-8")
        print(f"{out}: {len(lab['places'])} places, {len(lab['examples'])} examples, story {'yes' if lab['story'] else 'no'}, {out.stat().st_size / 1e6:.1f} MB", flush=True)
        return
    if args.data:
        try:
            DATASET = open_dataset(args.data)
            LIGHTS = open_lights(DATASET)
            warm()
        except (ValueError, OSError) as e:
            print("Could not open", args.data, e, flush=True)
    else:
        preload()
    threading.Thread(target=build_worker, daemon=True, name="layers").start()
    threading.Thread(target=lights_worker, daemon=True, name="lights").start()
    threading.Thread(target=ahead_worker, daemon=True, name="ahead").start()
    threading.Thread(target=ahead_composites_worker, daemon=True, name="composites").start()
    LOCAL_ONLY = args.host in ("127.0.0.1", "localhost", "::1")
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"TEMPER viewer: http://{args.host}:{args.port}  data: {data_root()}  cache: {CACHE}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
