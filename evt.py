"""Extreme-value threshold, ported from Heimdall (21.12.25_HeimdallCode/Sentinel-2/src/
MissionClusterEVTAndCHICreatorMerger/EVT.py) with its default.json settings.

Method, unchanged from Heimdall:
1. The tail is every valid value above the TAIL_PERCENTILE percentile. With blob removal on, tail pixels
   in 8-connected blobs larger than BLOBS_LIM pixels are left out, so large bright areas do not shape
   the background tail.
2. A Generalized Pareto distribution (location 0) is fitted to the tail minus the cutoff. In Heimdall the
   largest points are first dropped one block at a time while that lowers the Kolmogorov-Smirnov statistic
   (doubling search, then quadratic refinement), so the fit describes the background rather than the events.
3. The threshold is the GPD quantile where the expected share of background pixels above it equals FAR:
   p = 1 - N * FAR / n, threshold = cutoff + GPD^-1(p).
Only scikit-image's regionprops is replaced, by scipy.ndimage component sizes (same result).

The KS trimming of step 2 is OFF by default here (TRIM). On night-time M10 it deletes the noise's own upper
tail, not just the events:
- The tail has only ~55-80 distinct radiance levels (steps ~0.0008-0.0016), and KS assumes continuous data.
- The noise is not the same everywhere: it rises towards swath edges.
On Saudi nights 13-20 Oct 2026 it deleted 1,400-1,900 values from about 0.033 up. The bounded GPD fitted to the
rest put the threshold right there (0.025-0.037), and 23,091 of 23,589 spots did not repeat on other nights.
Fitted to the whole tail (95th-percentile cutoff and blob rule unchanged), the shape is ~0, and with
1 expected false pixel per night 335 of 350 spots repeated (threshold 0.071-0.092).
Set TRIM = True to reproduce Heimdall exactly.
"""
import numpy as np
import scipy.linalg
from scipy.ndimage import label
from scipy.stats import genpareto, kstest

TAIL_PERCENTILE = 95.0    # Heimdall default.json EVTTailPer
FAR = 1e-3                # Heimdall default.json EVTFar
REMOVE_BLOBS = True       # RemoveBlobs
BLOBS_CON = 8             # BlobsCon
BLOBS_MIN = 0             # BlobsMin
BLOBS_LIM = 5             # BlobsLim
MAX_ITERATIONS = 500      # as called in MissionClusterEVTAndCHICreatorMerger
TRIM = False              # Heimdall's KS trimming; off for M10, see the module notes


def blob_filter(bw, min_blob=BLOBS_MIN, max_blob=BLOBS_LIM, connectivity=BLOBS_CON):
    """Keep only connected blobs whose size is within [min_blob, max_blob]."""
    structure = np.ones((3, 3)) if connectivity == 8 else np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]])
    labels, _ = label(bw, structure=structure)
    sizes = np.bincount(labels.ravel())
    keep = (sizes >= min_blob) & (sizes <= max_blob)
    keep[0] = False
    return keep[labels]


def fit_gpd(tail):
    shape, _, scale = genpareto.fit(tail, floc=0)
    return shape, scale


def ks_statistic(tail):
    shape, scale = fit_gpd(tail)

    def cdf(x):
        values = genpareto.cdf(x, c=shape, scale=scale)
        for i in np.where(np.diff(values) < 0)[0]:   # keep the CDF non-decreasing, as in Heimdall
            values[i + 1] = values[i]
        return values

    return kstest(tail, cdf)[0]


def _initial_indices(tail):
    ks = ks_statistic(tail)
    ks1 = ks2 = ks3 = ks
    idx1, idx2, idx3 = 0, 0, 1
    while ks3 <= ks2:
        if ks3 < ks2:
            idx1, ks1 = idx2, ks2
            idx2, ks2 = idx3, ks3
        idx3 = min(len(tail) - 2, max(2 * idx3, 1))
        ks3 = ks_statistic(tail[:-idx3])
        if idx3 == len(tail) - 2:
            break
    return [idx1, idx2, idx3], [ks1, ks2, ks3]


def _refine(indices, ks_values, tail, max_iterations):
    idx1, idx2, idx3 = indices
    ks1, ks2, ks3 = ks_values
    iteration = 0
    while idx3 - idx1 > 2 and iteration < max_iterations:
        iteration += 1
        A = np.array([[idx1 ** 2, idx1, 1], [idx2 ** 2, idx2, 1], [idx3 ** 2, idx3, 1]])
        try:
            (a, b, _), *_ = scipy.linalg.lstsq(A, np.array([ks1, ks2, ks3]))
        except np.linalg.LinAlgError:
            break
        if a == 0:
            break
        estimated = -b / (2 * a)
        if not idx1 <= estimated <= idx3:
            break
        low, high = idx1 + 1, idx3 - 1
        if idx2 == low:
            low += 1
        if idx2 == high:
            high -= 1
        nxt = int(min(max(round(estimated), low), high))
        if nxt == idx2:
            step = int(np.sign(estimated - nxt))
            nxt += step if step != 0 else 1
        if nxt <= 0 or nxt >= len(tail):
            break
        new_ks = ks_statistic(tail[:-nxt])
        if new_ks == ks2:
            if abs(nxt - idx2) == 1:
                break
            mid = int(round((nxt + idx2) / 2))
            if mid <= 0 or mid >= len(tail):
                break
            mid_ks = ks_statistic(tail[:-mid])
            if mid_ks == new_ks:
                break
            if mid_ks > new_ks:
                idx1, ks1 = mid, mid_ks
                idx2 = max(idx2, nxt)
                if idx1 == nxt:
                    ks2 = new_ks
            else:
                idx1, idx3 = min(idx2, nxt), max(idx2, nxt)
                if idx1 == idx2:
                    ks1, ks3 = ks2, new_ks
                else:
                    ks1, ks3 = new_ks, ks2
                idx2, ks2 = mid, mid_ks
            continue
        if nxt < idx2:
            if new_ks > ks2:
                idx1, ks1 = nxt, new_ks
            else:
                idx3, ks3 = idx2, ks2
                idx2, ks2 = nxt, new_ks
        else:
            if new_ks > ks2:
                idx3, ks3 = nxt, new_ks
            else:
                idx1, ks1 = idx2, ks2
                idx2, ks2 = nxt, new_ks
    return idx2


def threshold(values_map, tail_percentile=TAIL_PERCENTILE, far=FAR, max_iterations=MAX_ITERATIONS, max_tail=None, trim=TRIM, samples=None):
    """EVT threshold of a 2-D map; NaN marks pixels outside the analysis. Returns (threshold, details).
    Additions to Heimdall:
    - max_tail: fit on that many evenly spaced order statistics of the tail instead of all of it;
      counts are scaled back to the full tail.
    - samples: a boolean map of the pixels that count in the statistics (percentile, tail, N). Blobs are
      still judged on all valid pixels. Used to count each native satellite sample once when gridding
      copied it into several pixels."""
    valid_mask = np.isfinite(values_map)
    use = valid_mask if samples is None else valid_mask & samples
    valid = values_map[use]
    if valid.size == 0:
        raise ValueError("no valid pixels")
    cutoff = float(np.percentile(valid.astype(np.float32), tail_percentile))
    if REMOVE_BLOBS:
        tail = np.sort(values_map[blob_filter(valid_mask & (values_map > cutoff)) & use])
    else:
        tail = np.sort(valid[valid > cutoff])
    if tail.size < 10:
        raise ValueError("too few tail values for a fit")
    centered = (tail - cutoff).astype(np.float64)
    full = len(centered)
    if max_tail and full > max_tail:
        centered = centered[np.linspace(0, full - 1, max_tail).round().astype(int)]
    cut = 0
    if trim:
        indices, ks_values = _initial_indices(centered)
        cut = min(_refine(indices, ks_values, centered, max_iterations), len(centered) - 1)
    fitted = centered[:-cut] if cut > 0 else centered
    shape, scale = fit_gpd(fitted)
    dropped = cut * full / len(centered)
    n = full - dropped
    N = len(valid) - full + n
    details = dict(cutoff=cutoff, shape=float(shape), scale=float(scale), tail=int(full), dropped=int(round(dropped)), 
                   valid=int(len(valid)), n=float(n), N=float(N))
    return quantile(details, far), details


def quantile(details, far):
    """Threshold for another false-alarm rate from an existing fit."""
    p = 1 - details["N"] * far / details["n"]
    return float(genpareto.ppf(p, c=details["shape"], loc=details["cutoff"], scale=details["scale"]))
