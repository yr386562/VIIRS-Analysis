"""VIIRS_algo's night-lights method, as a second LIGHT ROAST method next to the weekly comparison.

Re-implemented from the repository's source (sfac.py, detection/rx_temporal_detector.py,
wrapper_unstable_stable_rx.py, detection/anomaly_vectorizer.py and config.yaml), which was read but not run or
imported: the viewer runs offline and standalone, and the repository is outside it.

SFAC (once per country, over all its nights; sfac.apply_sfac and calibrate_single_image):
 1. outliers: radiance above the pixel's mean + 3 std over all nights
 2. mismatch: ntl_fix = the mean of the pixel's non-outlier values at or below their 5th percentile; each night minus
    ntl_fix is averaged over 3 x 3 pixels (ignoring NaN) and added back to ntl_fix; outlier values are kept as they are
 3. angle: the nights fall into 16 groups by day mod 16; a_i = the group's mean / the mean of all nights (outliers out);
    each night is divided by its group's a_i
RX (per night; the unstable-vs-stable wrapper with config.yaml's rx_temporal settings):
 - unstable: the shown night; stable: the nights of the chosen period before the shown night's week
 - per pixel over the stable nights: values above their 98th percentile left out (unless fewer than 8 would remain),
   then mean and std (ddof 1); with fewer than 8 valid nights mean = std = 0, as in the repository
 - std floor: the 95th percentile of the stds of lit pixels (stable mean >= 0.5 nW) around each pixel, at least 0.5 nW;
   unlit and outside pixels count as the country-wide 95th percentile
 - score = max(night - mean, 0) / max(std, floor); anomaly where 3 < score < 20. Brightening only.
 - clusters: binary closing with a disk of radius 1, then 8-connected components
Differences, forced by the viewer:
 - 750 m cells (the mean of the usable 15" cells) instead of 15" pixels
 - the floor's sliding window (50 pixels of 15", ~23 km) is computed on 23 km tiles from every second row and column
   and interpolated between tile centres: the sliding window takes ~60 s a night here, the tiles ~0.1 s
 - the stable period follows the shown night instead of being two fixed folders
"""
import math
import threading
import warnings
from datetime import date as Date, timedelta

import numpy as np
from scipy import ndimage

TAG = "sf1"
GROUPS = 16
OUTLIER_SIGMA = 3.0
FIX_PERCENTILE = 5.0
RX_SIGMA = 3.0              # config.yaml rx_temporal.threshold_sigma
RX_MAX = 20.0               # config.yaml rx_temporal.max_rx_score
MIN_SAMPLES = 8             # config.yaml rx_temporal.min_samples
CLIP_PERCENTILE = 98.0      # RXTemporalDetector default (the wrapper does not set it)
FLOOR_NW = 0.5              # RXTemporalDetector.PHYSICAL_RADIANCE_FLOOR
FLOOR_PERCENTILE = 95.0     # std_floor_percentile
FLOOR_KM = 23.0             # std_floor_kernel_size: 50 pixels of 15" (~460 m)
FLOOR_STRIDE = 2
CLOSING = np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]], bool)   # skimage disk(1); vectorization closing_radius 1
RECENT, REPEAT, FOLLOW = 7, 16, 7
LIT_NW, DARK_NW, OFFSET = 5.0, 2.0, 1.0   # for sorting its brightenings into the board's two upward columns


def nan_mean3(a):
    """3 x 3 mean ignoring NaN, per 2-D slice (the repository's nan_aware_spatial_filter); NaN where none is valid."""
    valid = np.isfinite(a)
    size = (1, 3, 3) if a.ndim == 3 else 3
    num = ndimage.uniform_filter(np.where(valid, a, 0).astype(np.float32), size=size, mode="reflect")
    cnt = ndimage.uniform_filter(valid.astype(np.float32), size=size, mode="reflect")
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(cnt > 1e-6, num / cnt, np.nan)


def bottom_mean(values, percentile):
    """Per column: the mean of the values at or below the column's percentile (linear, as numpy's nanpercentile)."""
    s = np.sort(values, axis=0)   # NaN last
    n = np.isfinite(s).sum(0)
    rank = percentile / 100 * np.maximum(n - 1, 0)
    f = np.floor(rank).astype(np.int64)
    frac = (rank - f).astype(np.float32)
    lo = np.take_along_axis(s, f[None], 0)[0]
    hi = np.take_along_axis(s, np.minimum(f + 1, len(s) - 1)[None], 0)[0]
    q = np.where(frac > 0, lo + frac * (hi - lo), lo)
    keep = s <= q[None]
    count = keep.sum(0)
    return np.where(count > 0, np.where(keep, s, 0).sum(0) / np.maximum(count, 1), np.nan).astype(np.float32)


class RepoMethod:
    def __init__(self, lights):
        self.L = lights
        self.lock = threading.Lock()
        self.fit_lock = threading.Lock()
        self.locks = {}
        self.done = self.total = 0
        self._results = {}

    # ---------- SFAC ----------
    def _params_path(self):
        return self.L.cache / f"sfac.{TAG}.npy"

    def fitted(self):
        return self._params_path().exists()

    def params(self):
        """Per pixel: mean, std, ntl_fix, then a_i for the 16 groups; float16 (19, H, W)."""
        if not self.fitted():
            self.fit()
        return np.load(self._params_path(), mmap_mode="r", allow_pickle=False)

    def fit(self):
        with self.fit_lock:
            if self.fitted():
                return
            L = self.L
            H, W = L.profile["height"], L.profile["width"]
            dates = [d for d in L.dates if L.ready(d)]
            if len(dates) < 2 * GROUPS:
                raise ValueError("SFAC צריך לפחות 32 לילות מוכנים.")
            groups = np.array([Date.fromisoformat(d).toordinal() % GROUPS for d in dates])
            layers = [L.layer(d) for d in dates]
            rows = max(4, int(24e6 // (len(dates) * W)) - 2)   # rows per block: ~24 M values in the stack
            temp = L.cache / f"sfac.{TAG}.partial.npy"
            out = np.lib.format.open_memmap(temp, mode="w+", dtype=np.float16, shape=(3 + GROUPS, H, W))
            starts = range(0, H, rows)
            self.total, self.done = len(starts), 0
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", RuntimeWarning)
                for r0 in starts:
                    r1 = min(H, r0 + rows)
                    a0, a1 = max(0, r0 - 1), min(H, r1 + 1)   # one row more each side for the 3 x 3 filter
                    x = np.stack([np.asarray(m[a0:a1], np.float32) for m in layers])
                    mean, std = np.nanmean(x, 0), np.nanstd(x, 0)
                    outlier = x > mean + OUTLIER_SIGMA * std
                    fix = bottom_mean(np.where(outlier, np.nan, x), FIX_PERCENTILE)
                    filtered = np.where(outlier, x, fix + nan_mean3(x - fix))
                    kept = np.where(outlier, np.nan, filtered)
                    del filtered, x
                    annual = np.nanmean(kept, 0)
                    keep = slice(r0 - a0, r0 - a0 + (r1 - r0))
                    out[0, r0:r1], out[1, r0:r1], out[2, r0:r1] = mean[keep], std[keep], fix[keep]
                    for i in range(GROUPS):
                        a = np.ones_like(annual)
                        if (groups == i).any():
                            with np.errstate(invalid="ignore", divide="ignore"):
                                a = np.where(annual != 0, np.nanmean(kept[groups == i], 0) / annual, 1.0)
                            a = np.where(np.isnan(a) | (a == 0), 1.0, a)
                        out[3 + i, r0:r1] = np.clip(a[keep], -6e4, 6e4)
                    self.done += 1
            out.flush()
            del out
            temp.replace(self._params_path())

    def _night_path(self, d):
        return self.L.cache / f"{d}.{TAG}.npy"

    def corrected_ready(self, d):
        return self._night_path(d).exists()

    def corrected(self, d):
        """The night after SFAC (calibrate_single_image), float16, NaN where the night has no usable observation."""
        with self.lock:
            lock = self.locks.setdefault(d, threading.Lock())
        with lock:
            if not self.corrected_ready(d):
                P = self.params()
                x = np.asarray(self.L.layer(d), np.float32)
                mean, std, fix = (np.asarray(P[k], np.float32) for k in range(3))
                a = np.asarray(P[3 + Date.fromisoformat(d).toordinal() % GROUPS], np.float32)
                with np.errstate(invalid="ignore", divide="ignore", over="ignore"):
                    c = np.where(x > mean + OUTLIER_SIGMA * std, x, fix + nan_mean3(x - fix)) / a
                c = np.where(np.isnan(x), np.nan, np.clip(c, -6e4, 6e4))
                temp = self.L.cache / f"{d}.{TAG}.partial.npy"
                np.save(temp, c.astype(np.float16), allow_pickle=False)
                temp.replace(self._night_path(d))
        return np.load(self._night_path(d), mmap_mode="r", allow_pickle=False)

    # ---------- RX ----------
    def stable(self, d, window):
        """The stable period: window // 7 orbit cycles of 16 days, ending the day before the shown night's week."""
        end = Date.fromisoformat(d) - timedelta(days=RECENT)
        start = end - timedelta(days=REPEAT * max(1, window // RECENT) - 1)
        return [x for x in self.L.dates if start.isoformat() <= x <= end.isoformat()]

    def _stats(self, nights, idx):
        """Over the stable nights, per flat pixel index: the repository's clipped mean and std, and the valid count.
        One pass: counts, sums and the four largest values, which is all the 98th-percentile clip can remove for up
        to 151 nights."""
        k = len(idx)
        n = np.zeros(k, np.int32)
        s1, s2 = np.zeros(k), np.zeros(k)
        top = np.full((4, k), -np.inf, np.float32)
        for x in nights:
            v = np.asarray(self.corrected(x)).ravel()[idx].astype(np.float32)
            ok = np.isfinite(v) & (v >= 0)   # negative values are no data
            v = np.where(ok, v, 0)
            n += ok
            s1 += v
            s2 += v.astype(np.float64) ** 2
            w = np.where(ok, v, -np.inf)
            for j in range(4):
                hi = np.maximum(top[j], w)
                w = np.minimum(top[j], w)
                top[j] = hi
        m = np.maximum(n - 1, 0).astype(np.float64)
        rank = CLIP_PERCENTILE / 100 * m
        f = np.floor(rank)
        frac = rank - f
        j = (m - f).astype(np.int64)   # values above position f: always among the 4 largest here
        if j.size and j.max() > 3:
            raise ValueError("תקופה יציבה ארוכה מדי.")
        sf = np.take_along_axis(top, np.clip(j, 0, 3)[None], 0)[0].astype(np.float64)
        sf1 = np.take_along_axis(top, np.clip(j - 1, 0, 3)[None], 0)[0].astype(np.float64)
        with np.errstate(invalid="ignore"):
            bound = np.where(frac > 0, sf + frac * (sf1 - sf), sf)
        t3 = top[:3].astype(np.float64)
        out = (np.arange(3)[:, None] < j[None]) & (t3 > bound[None])
        ex_n = out.sum(0)
        ex1 = np.where(out, t3, 0).sum(0)
        ex2 = np.where(out, t3 ** 2, 0).sum(0)
        use = (n - ex_n) >= MIN_SAMPLES
        cn = np.where(use, n - ex_n, n)
        c1, c2 = np.where(use, s1 - ex1, s1), np.where(use, s2 - ex2, s2)
        mean = c1 / np.maximum(cn, 1)
        std = np.sqrt(np.maximum((c2 - cn * mean ** 2) / np.maximum(cn - 1, 1), 0))
        few = n < MIN_SAMPLES
        mean[few], std[few] = 0, 0
        return mean.astype(np.float32), std.astype(np.float32), n

    def _floor_at(self, coarse, tile, rows, cols):
        cy = (rows / FLOOR_STRIDE + .5) / tile - .5
        cx = (cols / FLOOR_STRIDE + .5) / tile - .5
        floor = ndimage.map_coordinates(coarse, [cy, cx], order=1, mode="nearest")
        return np.maximum(floor, FLOOR_NW).astype(np.float32)

    def internals(self, d, window):
        """The night's scores (cached): candidate pixels, their score, stable mean and std, the floor surface."""
        key = (d, window)
        with self.lock:
            if key in self._results:
                return self._results[key]
        L = self.L
        H, W = L.profile["height"], L.profile["width"]
        stable = self.stable(d, window)
        if len(stable) < MIN_SAMPLES:
            raise ValueError("אין מספיק לילות יציבים לפני הלילה הזה.")
        target = np.asarray(self.corrected(d), np.float32).ravel()
        inside = L.mask.ravel()
        # A score above 3 needs the night above mean + 3 x the floor (>= 0.5 nW): nothing below 1.5 nW can score.
        cand = np.flatnonzero(inside & np.isfinite(target) & (target > RX_SIGMA * FLOOR_NW))
        rs, cs = np.arange(0, H, FLOOR_STRIDE), np.arange(0, W, FLOOR_STRIDE)
        sub = (rs[:, None] * W + cs[None, :]).ravel()
        mean, std, n = self._stats(stable, np.concatenate([cand, sub]))
        k = len(cand)
        m_s, s_s, n_s = mean[k:], std[k:], n[k:]
        active = inside[sub] & (n_s >= MIN_SAMPLES) & (m_s >= FLOOR_NW)
        fill = float(np.percentile(s_s[active], FLOOR_PERCENTILE)) if active.any() else 0.0
        surface = np.where(active, s_s, fill).reshape(len(rs), len(cs))
        tile = max(1, round(FLOOR_KM * 1000 / abs(L.profile["transform"].a) / FLOOR_STRIDE))
        ny, nx = -(-surface.shape[0] // tile), -(-surface.shape[1] // tile)
        pad = np.full((ny * tile, nx * tile), fill, np.float32)
        pad[:surface.shape[0], :surface.shape[1]] = surface
        coarse = np.percentile(pad.reshape(ny, tile, nx, tile).transpose(0, 2, 1, 3).reshape(ny, nx, -1), FLOOR_PERCENTILE, axis=2)
        floor = self._floor_at(coarse, tile, cand // W, cand % W)
        mc, sc = mean[:k], std[:k]
        score = np.maximum(target[cand] - mc, 0) / np.maximum(sc, floor)
        result = dict(cand=cand, score=score.astype(np.float32), mean=mc, std=np.maximum(sc, floor), n=n[:k], 
                      night=target[cand], coarse=coarse, tile=tile, stable=stable, fill=fill)
        with self.lock:
            if len(self._results) > 16:
                self._results.clear()
            self._results[key] = result
        return result

    def changes(self, d, window, to_lonlat):
        r = self.internals(d, window)
        L = self.L
        H, W = L.profile["height"], L.profile["width"]
        T = L.profile["transform"]
        cell_km2 = abs(T.a * T.e) / 1e6
        hit = (r["score"] > RX_SIGMA) & (r["score"] < RX_MAX)
        grid = np.zeros(H * W, bool)
        grid[r["cand"][hit]] = True
        grid = grid.reshape(H, W)
        # skimage's binary_closing: dilation, then erosion that treats the border as set
        closed = ndimage.binary_erosion(ndimage.binary_dilation(grid, CLOSING), CLOSING, border_value=1)
        labels, _ = ndimage.label(closed, structure=np.ones((3, 3)))
        pos = np.full(H * W, -1, np.int64)
        pos[r["cand"]] = np.arange(len(r["cand"]))
        events = []
        for lab, box in enumerate(ndimage.find_objects(labels), 1):
            region = labels[box] == lab
            rr, cc = np.nonzero(region)
            flat = (rr + box[0].start) * W + (cc + box[1].start)
            members = flat[grid.ravel()[flat]]
            if not len(members):
                continue
            p = pos[members]
            best = int(np.argmax(r["score"][p]))
            row, col = divmod(int(members[best]), W)
            x, y = T * (col + .5, row + .5)
            lon, lat = to_lonlat.transform(x, y)
            before, after = float(np.mean(r["mean"][p])), float(np.mean(r["night"][p]))
            events.append(dict(kind="new" if before < DARK_NW and after >= LIT_NW else "brighter", x=x, y=y, lonlat=[lon, lat], 
                               pixels=int(len(flat)), area_km2=round(len(flat) * cell_km2, 2), before_nw=before, after_nw=after, 
                               ratio=(after + OFFSET) / (before + OFFSET), z=float(r["score"][p][best]), nights_recent=1, 
                               nights_before=int(r["n"][p][best]), _members=members))
        # Follow-up (not in the repository; added so the two methods can be compared): the next nights after SFAC.
        later = [x for x in L.dates if x > d][:FOLLOW]
        if later and events:
            idx = np.concatenate([e["_members"] for e in events])
            vals = np.stack([np.asarray(self.corrected(x)).ravel()[idx].astype(np.float32) for x in later])
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", RuntimeWarning)
                med = np.nanmedian(vals, axis=0)
            pos_e = 0
            for e in events:
                m = med[pos_e:pos_e + len(e["_members"])]
                pos_e += len(e["_members"])
                if np.isfinite(m).any():
                    e["after_later_nw"] = float(np.nanmean(m))
                    e["later_nights"] = len(later)
                    e["holds"] = bool((e["after_later_nw"] + OFFSET) / (e["before_nw"] + OFFSET) >= math.sqrt(e["ratio"]))
        for e in events:
            e.pop("_members")
        events.sort(key=lambda e: (e["kind"] != "new", -e["z"] * e["pixels"]))
        return dict(date=d, window=window, method="rx", recent=[d], context=r["stable"], events=events, 
                    counts=dict(new=sum(e["kind"] == "new" for e in events), off=None, brighter=sum(e["kind"] == "brighter" for e in events), dimmer=None), 
                    candidates=int(len(r["cand"])), shared_ratio=None, score_scale=None, floor_country_nw=r["fill"], 
                    description="VIIRS_algo: SFAC, then RX of the night against %d stable nights: score = max(night - mean, 0) / "
                                "max(std, floor), %g < score < %g; mean and std without values above the 98th percentile; "
                                "floor = 95th percentile of lit pixels' std within ~%g km, at least %g nW. Brightening only."
                                % (len(r["stable"]), RX_SIGMA, RX_MAX, FLOOR_KM, FLOOR_NW))

    def pixel(self, d, row, col, window):
        r = self.internals(d, window)
        W = self.L.profile["width"]
        p = row * W + col
        i = int(np.searchsorted(r["cand"], p))
        if i < len(r["cand"]) and r["cand"][i] == p:
            score, mean, std, n, night = (float(r[k][i]) for k in ("score", "mean", "std", "n", "night"))
        else:   # below 1.5 nW tonight, or outside: score it on its own
            night = float(np.asarray(self.corrected(d))[row, col])
            m, s, nn = self._stats(r["stable"], np.array([p]))
            floor = float(self._floor_at(r["coarse"], r["tile"], np.array([row]), np.array([col]))[0])
            mean, std, n = float(m[0]), max(float(s[0]), floor), float(nn[0])
            score = max(night - mean, 0) / std if math.isfinite(night) else None
        if score is None or not math.isfinite(night):
            return dict(rx_score=None, rx_stable_nights=int(n))
        return dict(rx_score=score, rx_night_nw=night, rx_mean_nw=mean, rx_std_nw=std, rx_stable_nights=int(n), 
                    rx_anomaly=bool(RX_SIGMA < score < RX_MAX))
