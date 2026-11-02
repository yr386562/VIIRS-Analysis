"""LIGHT ROAST: change analysis of night lights, on the same 750 m grid as TEMPER so the two share the map, the
sampling windows and the time axis.

Source: NASA Black Marble VNP46A2 (Collection 2, NRT fallback), daily DNB radiance in nW cm-2 sr-1, already corrected
for moonlight, atmosphere and surface BRDF; the folder holds full 10x10 degree tiles at 15 arc-seconds with their QA.

Each night is reduced once to the country grid (EPSG:6933, 750 m, TEMPER's grid). VIIRS DNB itself sees ~742 m
whatever the scan angle, so the 15" Black Marble grid oversamples it and averaging to 750 m keeps the information.
- usable 15" cell: finite radiance, Mandatory_Quality_Flag 0 or 1 (high quality, persistent or ephemeral lights),
  cloud mask bits 6-7 confident or probably clear, no snow (the masks of VIIRS_algo's mask_loader)
- 750 m cell: the mean of its usable 15" cells, kept when they are at least MIN_USABLE_SHARE of it

Changes compare, per pixel, the RECENT_NIGHTS ending at the shown night with the `window` nights before them
(medians of log(radiance + LOG_OFFSET); a single night is too noisy: lit pixels vary ~0.43 in log units night to
night even when clear). Kinds: new lights, lights out, brighter, dimmer (see classify)."""
import hashlib
import json
import math
import re
import threading
import warnings
from datetime import date as Date, timedelta
from pathlib import Path

import numpy as np
import rasterio
from rasterio.warp import reproject, Resampling, transform_bounds
from rasterio.windows import from_bounds, Window
from scipy import ndimage

import rxmethod

LAYERS = "n1"
MIN_USABLE_SHARE = 0.5
LOG_OFFSET = 1.0          # nW cm-2 sr-1: y = log(radiance + 1) keeps dark pixels (noise ~0.3-1 nW) from dominating
RECENT_NIGHTS = 7         # calendar nights ending at the shown one
MIN_RECENT, MIN_BASELINE = 3, 8
CHANGE_Z = 4.0            # robust standard errors between the recent and baseline medians (after calibration)
CHANGE_Z_SINGLE = 6.0     # a change one pixel wide must reach this
CHANGE_STEP = math.log(1.5)   # brighter / dimmer: at least x1.5 / x1/1.5 in (radiance + 1)
LIT_NW, DARK_NW = 5.0, 2.0    # new lights: baseline below DARK, recent at least LIT; lights out: the reverse
SPREAD_FLOOR = 0.10       # log units: the smallest per-pixel night-to-night spread trusted
CANDIDATE_NW = 2.0        # a pixel is examined only if some night of the windows reached this
WINDOW_RANGE = (7, 63)
DEFAULT_WINDOW = 28       # baseline nights: 4 orbit cycles of the 7 recent nights
REPEAT_DAYS = 16          # Suomi-NPP repeats its ground track (and viewing angles) every 16 days
LIGHTS_TOP_NW = 100.0
LIGHTS_FLOOR_NW = 0.5
LIGHTS_RAMP = [(0.0, (8, 12, 30)), (0.25, (22, 48, 128)), (0.5, (44, 104, 228)), (0.78, (255, 196, 77)), (1.0, (255, 246, 221))]
CHANGE_UP, CHANGE_DOWN = (255, 190, 60), (70, 150, 255)
# Related places (server.similar): lit blocks of BLOCK x BLOCK cells (2.25 km), a night's value when at least
# BLOCK_MIN_CELLS of them are usable.
BLOCK, BLOCK_MIN_CELLS, BLOCKS = 3, 7, "b2"
# Moonlit glow. On full-moon weeks dark ground can light up in large patches that move from night to night and that the
# cloud mask calls confidently clear: Yemen's Al Mahra slopes, 10-100 km inland, in the Jul-Sep monsoon (2,000-23,000 km2
# a night; most likely moonlit fog). They passed as "new lights", almost none lasting a week; on clear ground elsewhere
# the moon leaves -0.2 to -0.4 nW, harmless. Glow comes in bursts (94% of these had 5+ other new lights within 25 km
# that night), real new lights almost never (0-2%). So a new light is area-wide when at least AREA_MIN other new lights
# are within AREA_KM that night, and an area-wide one must also be lit (median >= CONFIRM_NW over its pixels) on at
# least CONFIRM_NIGHTS moon-free nights (moonlight < MOON_FREE): those of its week, else the next ones, up to
# CONFIRM_DAYS after it. Lit there: kept (confirmed). Dark there: removed as moonlit glow. Too few such nights yet:
# pending. CONFIRM_NW: dark is below DARK_NW, and the glow read 1.2 nW without the moon (90th percentile 2.2) in Yemen;
# at 5 nW the check removed dim real lights too (Saudi Arabia's read ~3.5 nW without the moon); 3 nW kept 76% of those
# and let back 1.6% of Yemen's glow.
AREA_KM, AREA_MIN = 25.0, 5
# a new light this close to one removed as glow that night gets the same check (patch edges are sparse)
GLOW_NEAR_KM = 50.0
MOON_FREE, CONFIRM_NIGHTS, CONFIRM_DAYS, CONFIRM_NW = 0.3, 2, 21, 3.0
# a block is lit when it reaches LIT_NW on at least a quarter of nights (so lights that came on count)
BLOCK_LIT_QUANTILE = 75
REGIONAL_KM = 30   # the regional night-to-night swing (haze, weather) is a Gaussian average over lit blocks this wide


def bundle_path(raw_root, recorded):
    p = Path(recorded)
    return p if p.exists() else Path(raw_root) / re.split(r"[\\/]", str(recorded).rstrip("\\/"))[-1]


CLOUD_TOP, CLOUD_BASE = np.array([246, 248, 252], np.float32), np.array([112, 124, 148], np.float32)


def cloud_layer(cover, seed):
    """Cloud where it hid the lights (cover: the share of each cell, 0-1), drawn by the viewer over the lights with
    smooth scaling: heaps of a fixed per-night texture (five noise scales) with thinner gaps, lit from the upper left
    by the texture itself (white tops, blue-grey far sides), soft edges, and faint wisps just past them. A picture of
    where cloud was, not of the cloud itself. Returns rgb (0-255) and alpha (0-1)."""
    H, W = cover.shape
    rng = np.random.default_rng(seed)
    n, total = np.zeros((H, W), np.float32), 0.0
    for scale, weight in ((48, 1.0), (24, .55), (12, .32), (6, .2), (3, .12)):
        grid = rng.random((H // scale + 3, W // scale + 3)).astype(np.float32)
        n += weight * ndimage.zoom(grid, scale, order=3, grid_mode=True, mode="grid-wrap")[:H, :W]
        total += weight
    lo, hi = np.percentile(n, (2, 98))
    n = np.clip((n - lo) / max(hi - lo, 1e-6), 0, 1)   # summed octaves bunch near 0.5: stretch back
    puffs = np.clip((n - 0.25) / 0.6, 0, 1) ** 0.75
    field = ndimage.gaussian_filter(cover.astype(np.float32), 1.3)
    slope = n - ndimage.shift(n, (2, 2), order=1, mode="nearest")
    light = np.clip(0.55 + 5.0 * slope, 0, 1)
    tone = np.clip(0.18 + 0.82 * (0.35 * puffs + 0.65 * light * (0.5 + 0.5 * puffs)), 0, 1)
    rgb = CLOUD_BASE + (CLOUD_TOP - CLOUD_BASE) * tone[..., None]
    alpha = np.where(cover > 0.02, field * (0.62 + 0.33 * puffs), field * np.clip((puffs - 0.6) * 2.5, 0, 1) * 0.6)
    return rgb, np.clip(alpha, 0, 0.95)


def moon_light(dates):
    """Moonlight at VIIRS's ~01:30 overpass, 0-1, from the date alone (offline): the moon's illuminated fraction times
    how high it is (cosine of its hour angle; its transit moves ~50 min a night), 0 below the horizon. Mean synodic
    month from the new moon of 6 Jan 2000 18:14 UTC; the overpass is taken at 23:00 UTC of the night's date."""
    month, epoch = 29.530588853, Date(2000, 1, 6).toordinal() + (18 + 14 / 60) / 24
    out = []
    for d in dates:
        age = (Date.fromisoformat(d).toordinal() + 23 / 24 - epoch) % month
        lit = (1 - math.cos(2 * math.pi * age / month)) / 2
        hour_angle = ((1.5 - (12 + 24 * age / month)) % 24 + 12) % 24 - 12
        out.append(lit * max(0.0, math.cos(hour_angle * math.pi / 12)))
    return np.array(out, np.float32)


def remove_moon(R, moon):
    """Each row less its own linear response to moonlight (fitted over its finite nights): Black Marble removes most
    of the moon, but dim places on bright ground keep a lunar cycle that would make them all look related."""
    ok = np.isfinite(R)
    m = np.where(ok, moon[None], 0)
    n = np.maximum(ok.sum(1), 1)
    mc = np.where(ok, moon[None] - (m.sum(1) / n)[:, None], 0)
    with np.errstate(invalid="ignore", divide="ignore"):
        beta = np.where((mc * mc).sum(1) > 0, (np.where(ok, R, 0) * mc).sum(1) / (mc * mc).sum(1), 0)
    return np.where(ok, R - beta[:, None] * mc, np.nan)


def usable_mask(radiance, quality):
    mqf, cloud, snow = quality[0], quality[1], quality[2]
    return np.isfinite(radiance) & (mqf <= 1) & (cloud != 65535) & (((cloud >> 6) & 3) <= 1) & (snow == 0)


class NightLights:
    def __init__(self, folder, profile, mask, cache_root):
        """folder: a country under the LIGHT ROAST data root; profile: TEMPER's grid for the same country (crs,
        transform, width, height); mask: that country's pixels (bool, the grid's shape)."""
        self.root = Path(folder).resolve()
        raw = self.root / "raw_data"
        self.days = {}
        for inv in sorted(raw.glob("year_*_inventory.json")):
            for item in json.loads(inv.read_text(encoding="utf-8")).get("sources", []):
                b = bundle_path(raw, item["path"])
                if (b / "DNB.tif").is_file() and (b / "quality.tif").is_file():
                    self.days.setdefault(item["date"], [])
                    if b not in self.days[item["date"]]:
                        self.days[item["date"]].append(b)
        if not self.days:   # no inventory: every complete bundle by its manifest date
            for m in sorted(raw.glob("*/manifest.json")):
                rec = json.loads(m.read_text(encoding="utf-8"))
                if rec.get("phase") == "complete" and (m.parent / "DNB.tif").is_file():
                    self.days.setdefault(rec["date"], []).append(m.parent)
        if not self.days:
            raise ValueError("no Black Marble bundles")
        self.dates = sorted(self.days)
        self.profile = dict(crs=profile["crs"], transform=profile["transform"], width=profile["width"], height=profile["height"])
        self.mask = mask
        # Cached per night (see reconcile_nights): one folder per country and grid; the earlier key, over every
        # night's bundles, is moved over once.
        sig = [self.root.name, str(tuple(self.profile["transform"])[:6]), f"{self.profile['width']}x{self.profile['height']}", LAYERS]
        legacy = list(sig)
        for d in self.dates:
            for b in self.days[d]:
                st = (b / "DNB.tif").stat()
                legacy.append(f"{d}:{b.name}:{st.st_size}:{st.st_mtime_ns}")
        self.id = "l-" + hashlib.sha256("|".join(sig).encode()).hexdigest()[:16]
        self.cache = Path(cache_root) / self.id
        old = Path(cache_root) / ("lr-" + hashlib.sha256("|".join(legacy).encode()).hexdigest()[:16])
        if not self.cache.exists() and old.is_dir():
            try:
                old.rename(self.cache)
            except OSError:   # still open in another process: keep using it this time
                self.id, self.cache = old.name, old
        self.cache.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.locks = {}
        self._changes = {}
        self._calib = {}
        self.repo = rxmethod.RepoMethod(self)   # VIIRS_algo's SFAC + RX, the second method
        self.reconcile_nights()

    def night_signature(self, d):
        parts = []
        for b in self.days[d]:
            for f in ("DNB.tif", "quality.tif"):
                st = (b / f).stat()
                parts.append(f"{b.name}/{f}:{st.st_size}:{st.st_mtime_ns}")
        return hashlib.sha256("|".join(parts).encode()).hexdigest()[:16]

    def reconcile_nights(self):
        """Keep each night's cached files while its bundles are unchanged. A changed or removed night loses its
        files; stored change results that read it are rebuilt: those of the 25 days before it (their follow-up and moon
        check look ahead) and of the 70 days after it (their baseline cycles look back); SFAC (fitted on all nights) is dropped when the
        set of nights changes. The related-places blocks rebuild themselves when the nights differ."""
        path = self.cache / "nights.json"
        now = {d: self.night_signature(d) for d in self.dates}
        try:
            before = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            before = None
        if before is not None:
            touched = [d for d in set(before) | set(now) if before.get(d) != now.get(d)]
            stale = []
            for d in touched:
                if d in before:
                    stale += list(self.cache.glob(f"{d}.*"))
            if touched:
                days = [Date.fromisoformat(d).toordinal() for d in touched]
                for e in self.dates:
                    k = Date.fromisoformat(e).toordinal()
                    # night k reads nights k-70 (baseline) to k+21 (moon check)
                    if any(-70 <= t - k <= 25 for t in days):
                        stale += list(self.cache.glob(f"{e}.{LAYERS}.events*.json")) + list(self.cache.glob(f"{e}.{LAYERS}.calib*.json"))
                stale += list(self.cache.glob("sfac.*")) + list(self.cache.glob(f"*.{rxmethod.TAG}.npy"))
            for f in stale:
                try:
                    f.unlink()
                except OSError:
                    pass
        if before != now:
            path.write_text(json.dumps(now, sort_keys=True), encoding="utf-8")

    # ---------- nightly layers ----------
    def _path(self, d, part):
        return self.cache / f"{d}.{LAYERS}.{part}"

    def ready(self, d):
        return self._path(d, "json").exists()

    def layer(self, d):
        """The night's radiance on the grid (float16, NaN where no usable observation), built on first use."""
        if d not in self.days:
            raise ValueError("אין נתוני אורות ללילה הזה.")
        with self.lock:
            lock = self.locks.setdefault(d, threading.Lock())
        with lock:
            if not self.ready(d):
                self._build(d)
        return np.load(self._path(d, "npy"), mmap_mode="r", allow_pickle=False)

    def _tile_window(self, src):
        """The part of the grid a tile covers: (r0, r1, c0, c1, transform), or None."""
        H, W, T, crs = self.profile["height"], self.profile["width"], self.profile["transform"], self.profile["crs"]
        left, bottom, right, top = transform_bounds(src.crs, crs, *src.bounds, densify_pts=21)
        win = from_bounds(left, bottom, right, top, T)
        r0, c0 = max(0, math.floor(win.row_off)), max(0, math.floor(win.col_off))
        r1, c1 = min(H, math.ceil(win.row_off + win.height)), min(W, math.ceil(win.col_off + win.width))
        if r1 <= r0 or c1 <= c0:
            return None
        return r0, r1, c0, c1, rasterio.windows.transform(Window(c0, r0, c1 - c0, r1 - r0), T)

    def _build(self, d):
        H, W, T, crs = self.profile["height"], self.profile["width"], self.profile["transform"], self.profile["crs"]
        out = np.full((H, W), np.nan, np.float32)
        for b in self.days[d]:
            with rasterio.open(b / "DNB.tif") as src:
                rad, st, scrs = src.read(1), src.transform, src.crs
                place = self._tile_window(src)
            with rasterio.open(b / "quality.tif") as src:
                q = src.read()
            usable = usable_mask(rad, q)
            if place is None:   # only the part of the grid this tile covers
                continue
            r0, r1, c0, c1, wt = place
            mean = np.full((r1 - r0, c1 - c0), np.nan, np.float32)
            share = np.zeros((r1 - r0, c1 - c0), np.float32)
            reproject(np.where(usable, rad, np.nan).astype(np.float32), mean, src_transform=st, src_crs=scrs, dst_transform=wt, dst_crs=crs, 
                      src_nodata=np.nan, dst_nodata=np.nan, resampling=Resampling.average)
            reproject(usable.astype(np.float32), share, src_transform=st, src_crs=scrs, dst_transform=wt, dst_crs=crs, 
                      resampling=Resampling.average)
            block = out[r0:r1, c0:c1]
            take = np.isfinite(mean) & (share >= MIN_USABLE_SHARE) & np.isnan(block)
            block[take] = mean[take]
        inside = self.mask & np.isfinite(out)
        rec = dict(date=d, tiles=[b.name for b in self.days[d]], usable_share=float(inside.sum() / max(1, self.mask.sum())), 
                   mean_nw=float(out[inside].mean()) if inside.any() else None)
        temp = self._path(d, "partial.npy")
        np.save(temp, out.astype(np.float16), allow_pickle=False)
        temp.replace(self._path(d, "npy"))
        self._path(d, "json").write_text(json.dumps(rec), encoding="utf-8")
        print("LIGHTS", self.root.name, d, f"usable {rec['usable_share']:.0%}", flush=True)

    def info(self, d):
        return json.loads(self._path(d, "json").read_text(encoding="utf-8")) if self.ready(d) else None

    # ---------- clouds ----------
    def clouds_ready(self, d):
        return self._path(d, "cloud.npy").exists()

    def clouds(self, d):
        """The share of each grid cell's 15" cells that the VIIRS cloud mask calls probably or confidently cloudy,
        uint8 0-255, built on first use. It says why a cell has no usable lights: cloud, not darkness."""
        if d not in self.days:
            raise ValueError("אין נתוני אורות ללילה הזה.")
        with self.lock:
            lock = self.locks.setdefault((d, "cloud"), threading.Lock())
        with lock:
            if not self.clouds_ready(d):
                H, W, crs = self.profile["height"], self.profile["width"], self.profile["crs"]
                out = np.zeros((H, W), np.float32)
                for b in self.days[d]:
                    with rasterio.open(b / "quality.tif") as src:
                        q, st, place = src.read(2), src.transform, self._tile_window(src)
                        scrs = src.crs
                    if place is None:
                        continue
                    r0, r1, c0, c1, wt = place
                    share = np.zeros((r1 - r0, c1 - c0), np.float32)
                    cloudy = (q != 65535) & (((q >> 6) & 3) >= 2)
                    reproject(cloudy.astype(np.float32), share, src_transform=st, src_crs=scrs, dst_transform=wt, dst_crs=crs, resampling=Resampling.average)
                    np.maximum(out[r0:r1, c0:c1], share, out=out[r0:r1, c0:c1])
                temp = self._path(d, "partial.cloud.npy")
                np.save(temp, np.round(out * 255).astype(np.uint8), allow_pickle=False)
                temp.replace(self._path(d, "cloud.npy"))
        return np.load(self._path(d, "cloud.npy"), mmap_mode="r", allow_pickle=False)

    # ---------- windows of nights ----------
    def periods(self, d, window):
        """The recent nights (calendar RECENT_NIGHTS ending at d) and their baseline: the same nights of the orbit's
        16-day repeat cycle one, two, ... cycles earlier (window // RECENT_NIGHTS cycles, so `window` nights). Each
        recent night is thus compared with nights seen from the same viewing geometry: a pixel's own angular
        signature cancels without estimating it (SFAC estimates it per pixel from ~14 noisy nights per angle)."""
        end = Date.fromisoformat(d)
        days = [end - timedelta(days=k) for k in range(RECENT_NIGHTS)]
        have = set(self.dates)
        recent = sorted(x.isoformat() for x in days if x.isoformat() in have)
        cycles = max(1, window // RECENT_NIGHTS)
        before = sorted(y for x in days for j in range(1, cycles + 1) if (y := (x - timedelta(days=REPEAT_DAYS * j)).isoformat()) in have)
        return recent, before

    def _gather(self, dates, idx):
        """Radiance of the flat pixel indices `idx` on each of `dates` (nights, pixels), NaN where unusable."""
        out = np.full((len(dates), len(idx)), np.nan, np.float32)
        for i, x in enumerate(dates):
            out[i] = np.asarray(self.layer(x)).ravel()[idx]
        return out

    @staticmethod
    def _stats(values):
        """Median and robust spread of log(radiance + LOG_OFFSET) per column, with counts."""
        y = np.log(np.maximum(values, 0) + LOG_OFFSET)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            med = np.nanmedian(y, axis=0)
            spread = 1.4826 * np.nanmedian(np.abs(y - med), axis=0)
        return med, spread, np.isfinite(y).sum(axis=0)

    def compare(self, d, window, idx=None, calibration=None):
        """Per pixel (candidates, or the given flat indices): recent and baseline medians, counts, z and kind.
        calibration: (shared shift, score scale) to use; computed from these pixels when None."""
        recent, before = self.periods(d, window)
        if len(before) < MIN_BASELINE:
            raise ValueError("אין מספיק לילות קודמים להשוואה.")
        H, W = self.profile["height"], self.profile["width"]
        if idx is None:   # pixels lit on any night of the two periods
            peak = np.zeros(H * W, np.float32)
            for x in recent + before:
                peak = np.fmax(peak, np.asarray(self.layer(x), dtype=np.float32).ravel())
            idx = np.flatnonzero((peak >= CANDIDATE_NW) & self.mask.ravel())
        m_r, _, n_r = self._stats(self._gather(recent, idx))
        m_b, s_b, n_b = self._stats(self._gather(before, idx))
        s = np.maximum(np.nan_to_num(s_b, nan=SPREAD_FLOOR), SPREAD_FLOOR)
        enough = (n_r >= MIN_RECENT) & (n_b >= MIN_BASELINE)
        se = 1.2533 * s * np.sqrt(1 / np.maximum(n_r, 1) + 1 / np.maximum(n_b, 1))
        delta = m_r - m_b
        before_nw, after_nw = np.exp(m_b) - LOG_OFFSET, np.exp(m_r) - LOG_OFFSET
        # Nights are not independent: a hazier week, or another part of the 16-day viewing-angle cycle, moves every
        # light together. That shared shift (median change of well-lit pixels) is reported, and each pixel is
        # tested against it; the scores are then rescaled by their own spread over lit pixels (most do not change).
        if calibration is None:
            lit = enough & ((before_nw >= DARK_NW) | (after_nw >= DARK_NW))
            well_lit = enough & (before_nw >= LIT_NW)
            common = float(np.median(delta[well_lit])) if well_lit.sum() >= 50 else 0.0
            zc = (delta - common) / se
            spread = 1.4826 * float(np.median(np.abs(zc[lit] - np.median(zc[lit])))) if lit.sum() >= 50 else 1.0
            calibration = (common, max(spread, 1.0))
        common, scale = calibration
        z = np.where(enough, (delta - common) / se / scale, np.nan)
        return dict(idx=idx, recent=recent, before=before, before_nw=before_nw, after_nw=after_nw, delta=delta, z=z, 
                    common=common, scale=scale, n_recent=n_r, n_before=n_b, kind=self.classify(before_nw, after_nw, delta - common, z))

    def _calib_path(self, d, window):
        return self._path(d, f"calib.w{window}.json")

    def _read_calib(self, d, window):
        try:
            return json.loads(self._calib_path(d, window).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def _keep_calib(self, d, window, c):
        """Keep a night's comparison summary (shared shift, score scale, the nights compared) in memory and on disk:
        without it, the first pixel read of a night ran the whole comparison (2-3 s for the largest country)."""
        rec = dict(common=float(c["common"]), scale=float(c["scale"]), recent=list(c["recent"]), before=list(c["before"]))
        with self.lock:
            self._calib[(d, window)] = (rec["common"], rec["scale"])
        path = self._calib_path(d, window)
        temp = path.with_name(path.name + ".partial")
        try:
            temp.write_text(json.dumps(rec), encoding="utf-8")
            temp.replace(path)
        except OSError:
            pass

    def calibration(self, d, window):
        """The night's shared shift and score scale (from the full comparison), cached in memory and on disk."""
        key = (d, window)
        with self.lock:
            cached = self._calib.get(key)
        if cached is None:
            s = self._read_calib(d, window)
            if s is None:
                c = self.compare(d, window)
                self._keep_calib(d, window, c)
                return c["common"], c["scale"]
            cached = (s["common"], s["scale"])
            with self.lock:
                self._calib[key] = cached
        return cached

    def night_summary(self, d, window):
        """The night's comparison country-wide: the shared shift and the nights compared; None until it has run."""
        s = self._read_calib(d, window)
        if s is None:
            return None
        return dict(shared_ratio=math.exp(s["common"]), recent=len(s["recent"]), context=len(s["before"]), 
                    context_first=s["before"][0] if s["before"] else None, context_last=s["before"][-1] if s["before"] else None)

    @staticmethod
    def classify(before, after, shift, z):
        """0 none, 1 new lights, 2 lights out, 3 brighter, 4 dimmer. shift: log change beyond the shared one."""
        sig_up, sig_down = np.nan_to_num(z) >= CHANGE_Z, np.nan_to_num(z) <= -CHANGE_Z
        kind = np.zeros(len(z), np.uint8)
        kind[sig_up & (shift >= CHANGE_STEP) & (before >= DARK_NW)] = 3
        kind[sig_down & (-shift >= CHANGE_STEP) & (after >= DARK_NW)] = 4
        kind[sig_up & (before < DARK_NW) & (after >= LIT_NW)] = 1
        kind[sig_down & (before >= LIT_NW) & (after < DARK_NW)] = 2
        return kind

    # ---------- changes ----------
    def changes(self, d, window, to_lonlat):
        key = (d, window)
        with self.lock:
            if key in self._changes:
                return self._changes[key]
        c = self.compare(d, window)
        self._keep_calib(d, window, c)
        H, W = self.profile["height"], self.profile["width"]
        T = self.profile["transform"]
        cell_km2 = abs(T.a * T.e) / 1e6
        names = {1: "new", 2: "off", 3: "brighter", 4: "dimmer"}
        # follow-up: the RECENT_NIGHTS after d against the same baseline
        later = [x for x in self.dates if x > d][:RECENT_NIGHTS]
        events = []
        for code, kind in names.items():
            flagged = c["kind"] == code
            if not flagged.any():
                continue
            grid = np.zeros(H * W, np.int32)
            grid[c["idx"][flagged]] = np.flatnonzero(flagged) + 1
            grid = grid.reshape(H, W)
            labels, count = ndimage.label(grid > 0, structure=np.ones((3, 3)))
            for k, box in enumerate(ndimage.find_objects(labels), 1):
                members = grid[box][labels[box] == k] - 1
                strongest = members[int(np.argmax(np.abs(c["z"][members])))]
                if len(members) < 2 and abs(c["z"][strongest]) < CHANGE_Z_SINGLE:
                    continue   # a lone pixel must be much stronger: most lone pixels are noise
                row, col = divmod(int(c["idx"][strongest]), W)
                x, y = T * (col + .5, row + .5)
                lon, lat = to_lonlat.transform(x, y)
                before = float(np.mean(c["before_nw"][members]))
                after = float(np.mean(c["after_nw"][members]))
                events.append(dict(kind=kind, x=x, y=y, lonlat=[lon, lat], pixels=int(len(members)), area_km2=round(len(members) * cell_km2, 2), 
                                   before_nw=before, after_nw=after, ratio=(after + LOG_OFFSET) / (before + LOG_OFFSET), 
                                   z=float(c["z"][strongest]), nights_recent=int(c["n_recent"][strongest]), 
                                   nights_before=int(c["n_before"][strongest]), _members=c["idx"][members]))
        if later and events:
            m_l, _, n_l = self._stats(self._gather(later, np.concatenate([e["_members"] for e in events])))
            pos = 0
            for e in events:
                n = len(e["_members"])
                after_later = float(np.nanmean(np.exp(m_l[pos:pos + n]) - LOG_OFFSET)) if np.isfinite(m_l[pos:pos + n]).any() else None
                e["after_later_nw"] = after_later
                e["later_nights"] = len(later)
                if after_later is not None:
                    up = e["kind"] in ("new", "brighter")
                    before = e["before_nw"] + LOG_OFFSET
                    # holds: still at least half of the change in the same direction
                    e["holds"] = bool((after_later + LOG_OFFSET) / before >= math.sqrt(e["ratio"]) if up else (after_later + LOG_OFFSET) / before <= math.sqrt(e["ratio"]))
                pos += n
        events, removed = self._moon_check(d, c, events)
        for e in events + removed:
            e.pop("_members")
        order = {"new": 0, "off": 1, "brighter": 2, "dimmer": 3}
        events.sort(key=lambda e: (order[e["kind"]], -abs(e["z"]) * e["pixels"]))
        shown = [e for e in events if e.get("moon") != "pending"]
        result = dict(date=d, window=window, recent=c["recent"], context=c["before"], events=events, 
                      counts={k: sum(e["kind"] == k for e in shown) for k in order}, 
                      pending={k: sum(e["kind"] == k and e.get("moon") == "pending" for e in events) for k in order}, 
                      moonlit_removed=removed, candidates=int(len(c["idx"])), 
                      shared_ratio=float(math.exp(c["common"])), score_scale=float(c["scale"]), 
                      method="Per pixel: median of log(radiance + %g nW) over the %d nights ending at this one against the %d nights "
                             "before them; z = difference / (1.25 x robust night-to-night spread x sqrt(1/n1 + 1/n2)), |z| >= %g. "
                             "new: baseline < %g nW, recent >= %g; off: the reverse; brighter / dimmer: at least x%.2g."
                             % (LOG_OFFSET, RECENT_NIGHTS, len(c["before"]), CHANGE_Z, DARK_NW, LIT_NW, math.exp(CHANGE_STEP)))
        with self.lock:
            if len(self._changes) > 32:
                self._changes.clear()
            self._changes[key] = result
        return result

    def _moon_check(self, d, c, events):
        """Area-wide new lights (see AREA_* and MOON_* above) checked on moon-free nights. Returns the events to show
        (area-wide ones marked moon="confirmed", with confirmed_on when the nights after confirmed them, or
        moon="pending") and those removed as moonlit glow."""
        new = [e for e in events if e["kind"] == "new"]
        if len(new) <= AREA_MIN:
            return events, []
        xy = np.array([[e["x"], e["y"]] for e in new])
        crowd = (np.hypot(xy[:, 0][:, None] - xy[:, 0][None], xy[:, 1][:, None] - xy[:, 1][None]) < AREA_KM * 1000).sum(1) - 1
        area = [e for e, n in zip(new, crowd) if n >= AREA_MIN]
        if not area:
            return events, []
        removed = self._moon_confirm(d, c, area)
        # Glow patches thin out at their edges: new lights near what was removed get the same check.
        if removed:
            gx = np.array([[e["x"], e["y"]] for e in removed])
            edge = [e for e in new if "moon" not in e and np.min(np.hypot(gx[:, 0] - e["x"], gx[:, 1] - e["y"])) < GLOW_NEAR_KM * 1000]
            removed += self._moon_confirm(d, c, edge)
        return [e for e in events if e.get("moon") != "glow"], removed

    def _moon_confirm(self, d, c, area):
        """The moon-free check for these new lights; marks each and returns those found dark (glow)."""
        if not area:
            return []
        moon = dict(zip(self.dates, moon_light(self.dates)))
        end = Date.fromisoformat(d)
        week = [x for x in c["recent"] if moon[x] < MOON_FREE]
        later = [x for x in self.dates if x > d and (Date.fromisoformat(x) - end).days <= CONFIRM_DAYS and moon[x] < MOON_FREE]
        nights = week + later
        vals = self._gather(nights, np.concatenate([e["_members"] for e in area])) if nights else None
        removed, pos = [], 0
        for e in area:
            e["area_wide"] = True
            k = len(e["_members"])
            if vals is None:
                e["moon"] = "pending"
                continue
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", RuntimeWarning)
                per_night = np.nanmean(vals[:, pos:pos + k], 1)
            pos += k
            seen = [(x, v) for x, v in zip(nights[:len(week)], per_night[:len(week)]) if np.isfinite(v)]
            for x, v in zip(nights[len(week):], per_night[len(week):]):
                if len(seen) >= CONFIRM_NIGHTS:
                    break
                if np.isfinite(v):
                    seen.append((x, v))
            if len(seen) < CONFIRM_NIGHTS:
                e["moon"] = "pending"
            elif float(np.median([v for _, v in seen])) >= CONFIRM_NW:
                e["moon"] = "confirmed"
                if seen[-1][0] > d:
                    e["confirmed_on"] = seen[-1][0]
            else:
                e["moon"] = "glow"
                e["moonfree_nw"] = float(np.median([v for _, v in seen]))
                removed.append(e)
        return removed

    # ---------- the usual lights (context) ----------
    def _typical_paths(self):
        return self.cache / f"typical.{LAYERS}.npy", self.cache / f"typical.{LAYERS}.json"

    def _typical_key(self):
        sample = [d for d in self.dates if self.ready(d)][::2]
        return sample, f"{len(sample)}:{sample[0] if sample else ''}:{sample[-1] if sample else ''}"

    def typical_ready(self):
        path, meta = self._typical_paths()
        try:
            return path.exists() and json.loads(meta.read_text(encoding="utf-8")).get("key") == self._typical_key()[1]
        except (OSError, ValueError):
            return False

    def typical(self):
        """Each cell's usual lights: the median over every other ready night (float16), rebuilt when the nights
        change. Shown as the map's "usual" view, so a change can be read against what is normally lit there."""
        path, meta = self._typical_paths()
        with self.lock:
            lock = self.locks.setdefault("typical", threading.Lock())
        with lock:
            if not self.typical_ready():
                sample, key = self._typical_key()
                if not sample:
                    raise ValueError("אין עדיין לילות מוכנים.")
                H, W = self.profile["height"], self.profile["width"]
                out = np.full((H, W), np.nan, np.float16)
                rows = max(8, int(30e6 // (len(sample) * W)))
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore", RuntimeWarning)
                    for r0 in range(0, H, rows):
                        out[r0:r0 + rows] = np.nanmedian(np.stack([np.asarray(self.layer(d)[r0:r0 + rows], np.float32) for d in sample]), 0)
                temp = self.cache / f"typical.{LAYERS}.partial.npy"
                np.save(temp, out, allow_pickle=False)
                temp.replace(path)
                meta.write_text(json.dumps(dict(key=key, nights=len(sample))), encoding="utf-8")
        return np.load(path, mmap_mode="r", allow_pickle=False)

    # ---------- related places ----------
    def _blocks_path(self):
        return self.cache / f"blocks.{BLOCKS}.npz"

    def blocks_ready(self):
        """Blocks are stored for the nights ready now (the background worker builds them when not)."""
        if getattr(self, "_block_dates", None) is None:
            try:
                with np.load(self._blocks_path(), allow_pickle=False) as z:
                    self._block_dates = [str(d) for d in z["dates"]]
            except (OSError, KeyError, ValueError):
                self._block_dates = []
        return self._block_dates == [d for d in self.dates if self.ready(d)]

    def _block_means(self, a):
        H, W = a.shape
        hb, wb = -(-H // BLOCK), -(-W // BLOCK)
        pad = np.full((hb * BLOCK, wb * BLOCK), np.nan, np.float32)
        pad[:H, :W] = a
        v = pad.reshape(hb, BLOCK, wb, BLOCK)
        n = np.isfinite(v).sum((1, 3))
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            return np.where(n >= BLOCK_MIN_CELLS, np.nansum(v, (1, 3)) / np.maximum(n, 1), np.nan)

    def blocks(self, fresh=False):
        """Every lit block (median at least LIT_NW over every 4th night, centre inside the country) and its
        night-by-night log(mean radiance + 1) (Y). R: the same less the night's country-wide median over the lit
        blocks (moon, atmosphere, calibration) and less the block's own median for its day of the 16-day orbit cycle
        (its viewing-angle signature), so what is left is the place's own variation. RL: R less the regional swing.
        Built by the background worker (~1 min for the largest country, fresh=True) and cached on disk with RL; a
        request while newer nights wait to be added gets the blocks already built, so it never waits for a rebuild."""
        ready = [d for d in self.dates if self.ready(d)]
        with self.lock:
            cached = getattr(self, "_blocks", None)
        if cached and (cached["dates"] == ready or not fresh):
            return cached
        with self.lock:
            lock = self.locks.setdefault("blocks", threading.Lock())
        with lock:
            with self.lock:
                cached = getattr(self, "_blocks", None)
            if cached and (cached["dates"] == ready or not fresh):
                return cached   # built while this call waited
            data = None
            if self._blocks_path().exists():
                with np.load(self._blocks_path(), allow_pickle=False) as z:
                    data = {k: z[k] for k in z.files}
                if fresh and [str(d) for d in data["dates"]] != ready:
                    data = None
            if data is None:
                H, W = self.profile["height"], self.profile["width"]
                hb, wb = -(-H // BLOCK), -(-W // BLOCK)
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore", RuntimeWarning)
                    med = np.nanpercentile(np.stack([self._block_means(np.asarray(self.layer(d), np.float32)) for d in ready[::4]]), BLOCK_LIT_QUANTILE, 0)
                rc, cc = np.minimum(np.arange(hb) * BLOCK + 1, H - 1), np.minimum(np.arange(wb) * BLOCK + 1, W - 1)
                lit = np.flatnonzero((np.nan_to_num(med) >= LIT_NW) & self.mask[rc[:, None], cc[None, :]])
                Y = np.full((len(lit), len(ready)), np.nan, np.float32)
                for j, d in enumerate(ready):
                    Y[:, j] = np.log(np.maximum(self._block_means(np.asarray(self.layer(d), np.float32)).ravel()[lit], 0) + LOG_OFFSET)
                data = dict(dates=np.array(ready), blocks=lit, shape=np.array([hb, wb]), Y=Y.astype(np.float16))
            dates = [str(d) for d in data["dates"]]
            Y = data["Y"].astype(np.float32)
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", RuntimeWarning)
                common = np.nanmedian(Y, 0) if len(Y) else np.zeros(Y.shape[1], np.float32)
            phase = np.array([Date.fromisoformat(d).toordinal() % REPEAT_DAYS for d in dates])
            shape = tuple(int(v) for v in data["shape"])
            moon = moon_light(dates)
            R = remove_moon(self._residual(Y, common, phase), moon)
            if "RL" not in data:   # the regional swing takes ~12 s for the largest country: computed once, stored
                data["RL"] = (R - self._regional(R, data["blocks"], shape)).astype(np.float16)
                temp = self.cache / f"blocks.{BLOCKS}.partial.npz"
                with open(temp, "wb") as f:
                    np.savez(f, **data)
                temp.replace(self._blocks_path())
            result = dict(dates=dates, blocks=data["blocks"], shape=shape, Y=data["Y"], common=common, phase=phase, moon=moon, R=R, 
                          RL=data["RL"].astype(np.float32))
            with self.lock:
                self._blocks, self._block_dates = result, dates
            return result

    @staticmethod
    def _residual(Y, common, phase):
        R = Y - common[None]
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            for g in range(REPEAT_DAYS):
                sel = phase == g
                if sel.any():
                    R[:, sel] -= np.nan_to_num(np.nanmedian(R[:, sel], 1))[:, None]
        return R

    def _regional(self, R, blocks, shape):
        """Per night, the Gaussian-weighted mean of R over the lit blocks around each block (sigma REGIONAL_KM / 2):
        the regional swing that haze and weather give every light in an area. Less this, a block keeps what is its
        own or shared only with close neighbours."""
        hb, wb = shape
        sigma = REGIONAL_KM / 2 * 1000 / (BLOCK * abs(self.profile["transform"].a))
        out = np.full(R.shape, np.nan, np.float32)
        rb, cb = np.divmod(blocks, wb)
        for j in range(R.shape[1]):
            v = R[:, j]
            ok = np.isfinite(v)
            num, wgt = np.zeros((hb, wb), np.float32), np.zeros((hb, wb), np.float32)
            num[rb[ok], cb[ok]], wgt[rb[ok], cb[ok]] = v[ok], 1
            num, wgt = ndimage.gaussian_filter(num, sigma, mode="constant"), ndimage.gaussian_filter(wgt, sigma, mode="constant")
            with np.errstate(invalid="ignore", divide="ignore"):
                field = np.where(wgt > 1e-3, num / wgt, np.nan)
            out[:, j] = field[rb, cb]
        return np.nan_to_num(out)

    def regional_at(self, row, col, R_seed):
        """The seed block's residual less the regional swing at its place (as RL in blocks)."""
        B = self.blocks()
        hb, wb = B["shape"]
        rb, cb = min(row // BLOCK, hb - 1), min(col // BLOCK, wb - 1)
        sigma = REGIONAL_KM / 2 * 1000 / (BLOCK * abs(self.profile["transform"].a))
        brb, bcb = np.divmod(B["blocks"], wb)
        w = np.exp(-((brb - rb) ** 2 + (bcb - cb) ** 2) / (2 * sigma ** 2)).astype(np.float32)
        R = B["R"]
        ok = np.isfinite(R)
        with np.errstate(invalid="ignore", divide="ignore"):
            field = (np.where(ok, R, 0) * w[:, None]).sum(0) / (ok * w[:, None]).sum(0)
        return R_seed - np.nan_to_num(field)

    def block_centres(self, blocks):
        hb, wb = self._blocks["shape"]
        rb, cb = np.divmod(blocks, wb)
        return self.profile["transform"] * (cb * BLOCK + BLOCK / 2, rb * BLOCK + BLOCK / 2)

    def block_series(self, row, col):
        """The residual series (as R in blocks) of the block holding a grid cell, its centre, and its radiance on a
        lit night (the BLOCK_LIT_QUANTILE-th percentile, nW)."""
        B = self.blocks()
        r0, c0 = (row // BLOCK) * BLOCK, (col // BLOCK) * BLOCK
        y = np.full(len(B["dates"]), np.nan, np.float32)
        for j, d in enumerate(B["dates"]):
            a = np.asarray(self.layer(d)[r0:r0 + BLOCK, c0:c0 + BLOCK], np.float32)
            if np.isfinite(a).sum() >= BLOCK_MIN_CELLS:
                y[j] = math.log(max(float(np.nanmean(a)), 0) + LOG_OFFSET)
        R = remove_moon(self._residual(y[None], B["common"], B["phase"]), B["moon"])[0]
        level = float(np.exp(np.nanpercentile(y, BLOCK_LIT_QUANTILE)) - LOG_OFFSET) if np.isfinite(y).any() else 0.0
        return R, tuple(float(v) for v in self.profile["transform"] * (c0 + BLOCK / 2, r0 + BLOCK / 2)), level

    # ---------- map, pixel, series ----------
    def image(self, d, view="lights", window=DEFAULT_WINDOW, method="weekly"):
        """PNG of the night on the grid. lights: radiance on a fixed log scale 0-LIGHTS_TOP_NW nW (navy -> blue -> gold
        -> white). change: the lights in grey with each pixel's change against the baseline over it (gold brighter,
        blue darker; strength by |z| from 2 to 6, colour depth by the size of the change); with method "rx", the
        repository's RX score instead (gold, strength from 2 to 6; it only scores brightening)."""
        a = np.asarray(self.typical() if view == "typical" else self.layer(d), dtype=np.float32)
        if view != "change":
            return self.lights_png(a)
        # Log scale from LIGHTS_FLOOR_NW: below it the DNB noise floor shows detector striping, kept dark.
        t = np.clip(np.log(np.maximum(np.nan_to_num(a, nan=0), LIGHTS_FLOOR_NW) / LIGHTS_FLOOR_NW) / math.log(LIGHTS_TOP_NW / LIGHTS_FLOOR_NW), 0, 1)
        if view == "change" and method == "rx":
            r = self.repo.internals(d, window)
            zz = np.zeros(a.size, np.float32)
            zz[r["cand"]] = r["score"]
            w = np.clip((zz.reshape(a.shape) - 2) / 4, 0, 1)[..., None]
            grey = 10 + 120 * t
            rgb = np.stack([grey, grey, grey], axis=-1) * (1 - w) + np.array(CHANGE_UP, np.float32) * w
        else:
            c = self.compare(d, window)
            self._keep_calib(d, window, c)
            H, W = a.shape
            dz = np.full(H * W, np.nan, np.float32)
            keep = np.abs(np.nan_to_num(c["z"])) >= 2
            dz[c["idx"][keep]] = c["delta"][keep]
            zz = np.zeros(H * W, np.float32)
            zz[c["idx"][keep]] = np.abs(c["z"][keep])
            dz, zz = dz.reshape(H, W), zz.reshape(H, W)
            grey = 10 + 120 * t
            rgb = np.stack([grey, grey, grey], axis=-1)
            w = (np.clip((zz - 2) / 4, 0, 1) * np.clip(np.abs(np.nan_to_num(dz)) / math.log(4), .35, 1))[..., None]
            colour = np.where((np.nan_to_num(dz) > 0)[..., None], np.array(CHANGE_UP, np.float32), np.array(CHANGE_DOWN, np.float32))
            rgb = rgb * (1 - w) + colour * w
        return self._png(a, t, rgb)

    def lights_png(self, a):
        """Radiance on the grid (nW cm-2 sr-1) as the lights view: a fixed log scale from LIGHTS_FLOOR_NW (below it the
        DNB noise floor shows detector striping, kept dark) to LIGHTS_TOP_NW. A night, the usual lights, or a period's
        median (server.py: composites)."""
        a = np.asarray(a, np.float32)
        t = np.clip(np.log(np.maximum(np.nan_to_num(a, nan=0), LIGHTS_FLOOR_NW) / LIGHTS_FLOOR_NW) / math.log(LIGHTS_TOP_NW / LIGHTS_FLOOR_NW), 0, 1)
        stops = np.array([s for s, _ in LIGHTS_RAMP]), np.array([c for _, c in LIGHTS_RAMP], np.float32)
        rgb = np.stack([np.interp(t, stops[0], stops[1][:, i]) for i in range(3)], axis=-1)
        return self._png(a, t, rgb)

    @staticmethod
    def _png(a, t, rgb):
        """The PNG, at most 1800 pixels a side: the brightest of each block kept, so a small light never drops out;
        transparent where there is no observation (cloud is its own layer, cloud_image)."""
        import io
        from PIL import Image
        stride = max(1, int(np.ceil(max(a.shape) / 1800)))
        if stride > 1:   # keep the brightest of each block, so a small light never drops out
            H, W = t.shape
            hb, wb = -(-H // stride), -(-W // stride)
            pad = np.full((hb * stride, wb * stride), -1, np.float32)
            pad[:H, :W] = np.where(np.isfinite(a), t, -1)
            k = pad.reshape(hb, stride, wb, stride).transpose(0, 2, 1, 3).reshape(hb, wb, stride * stride).argmax(axis=2)
            rows = np.minimum(np.arange(hb)[:, None] * stride + k // stride, H - 1)
            cols = np.minimum(np.arange(wb)[None, :] * stride + k % stride, W - 1)
            rgb, a = rgb[rows, cols], a[rows, cols]
        alpha = np.isfinite(a).astype(np.float32)   # cloud is its own layer (cloud_image), drawn smooth over this one
        rgba = np.empty((*a.shape, 4), np.uint8)
        rgba[..., :3] = np.clip(rgb, 0, 255).astype(np.uint8)
        rgba[..., 3] = np.clip(alpha * 255, 0, 255).astype(np.uint8)
        stream = io.BytesIO()
        Image.fromarray(rgba).save(stream, format="PNG")
        return stream.getvalue()

    def cloud_image(self, d):
        """PNG of the night's cloud where it hid the lights (see cloud_layer), the size of image(), so "covered" never
        reads as "dark". The viewer draws it over the lights with smooth scaling."""
        import io
        from PIL import Image
        a = np.asarray(self.layer(d), dtype=np.float32)
        hidden = ((np.asarray(self.clouds(d)) >= 128) & ~np.isfinite(a)).astype(np.float32)
        H, W = hidden.shape
        stride = max(1, int(np.ceil(max(H, W) / 1800)))
        hb, wb = -(-H // stride), -(-W // stride)
        pad = np.zeros((hb * stride, wb * stride), np.float32)
        pad[:H, :W] = hidden
        cover = pad.reshape(hb, stride, wb, stride).mean((1, 3))
        rgba = np.zeros((hb, wb, 4), np.uint8)
        if cover.any():
            rgb, alpha = cloud_layer(cover, seed=int(d.replace("-", "")))
            rgba[..., :3] = np.clip(rgb, 0, 255).astype(np.uint8)
            rgba[..., 3] = np.clip(alpha * 255, 0, 255).astype(np.uint8)
            rgba[rgba[..., 3] == 0] = 0   # no texture where nothing shows: the PNG shrinks ~10x
        stream = io.BytesIO()
        Image.fromarray(rgba).save(stream, format="PNG")
        return stream.getvalue()

    def pixel(self, d, row, col, window, method="weekly"):
        W = self.profile["width"]
        idx = np.array([row * W + col])
        v = float(np.asarray(self.layer(d))[row, col])
        out = dict(radiance_nw=v if math.isfinite(v) else None, cloud=bool(not math.isfinite(v) and self.clouds(d)[row, col] >= 128))
        try:
            c = self.compare(d, window, idx, self.calibration(d, window))
            if np.isfinite(c["z"][0]):
                out.update(recent_nw=float(c["after_nw"][0]), baseline_nw=float(c["before_nw"][0]), z=float(c["z"][0]), 
                           ratio=float((c["after_nw"][0] + LOG_OFFSET) / (c["before_nw"][0] + LOG_OFFSET)), 
                           kind={0: None, 1: "new", 2: "off", 3: "brighter", 4: "dimmer"}[int(c["kind"][0])])
        except ValueError:
            pass
        if method == "rx" and self.repo.fitted():
            try:
                out.update(self.repo.pixel(d, row, col, window))
            except ValueError:
                pass
        return out

    def series(self, r0, r1, c0, c1, roi):
        points, pending, cloud_pending = [], 0, 0
        cells = int(roi.sum())
        for d in self.dates:
            if not self.ready(d):
                pending += 1
                continue
            a = np.asarray(self.layer(d)[r0:r1, c0:c1], dtype=np.float32)
            good = roi & np.isfinite(a)
            n = int(good.sum())
            cloud = None
            if self.clouds_ready(d) and cells:   # the worker builds the cloud layers after the lights
                cloud = 100 * int((roi & ~np.isfinite(a) & (np.asarray(self.clouds(d)[r0:r1, c0:c1]) >= 128)).sum()) / cells
            else:
                cloud_pending += 1
            points.append(dict(date=d, mean_nw=float(a[good].mean()) if n else None, coverage=100 * n / cells if cells else 0, cloud_percent=cloud, 
                               lit_km2=float((a[good] >= LIT_NW).sum() * abs(self.profile["transform"].a) ** 2 / 1e6) if n else None))
        return dict(points=points, pending=pending, cloud_pending=cloud_pending, nights=len(self.dates))
