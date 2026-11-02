"""M11, M15 and M16 on each M10 bundle's grid, from the archived VIIRS granule.

Each raw bundle's provenance.npz records, per grid cell, the native swath sample it took: native_index, a flat
index into the granule's observation arrays (3200 columns). The other M-bands are in the same VNP02MOD granule, so
the same index gives each band for exactly the same sample. No new gridding is needed.

M11 (2.25 um, reflective band) follows the M10 conversion (POSTPROCCESOR/postprocessor/sensors/viirs.py):
- radiance = stored integer * radiance_scale_factor + radiance_add_offset;
- any defined quality flag makes a sample invalid, except a raw 0 flagged only Out_of_Range, which is kept
  as a below-range (censored) 0.
M15 (10.76 um) and M16 (12.0 um) are thermal bands: brightness temperature from the granule's own lookup table
(Mxx_brightness_temperature_lut, indexed by the stored integer), any defined quality flag invalid. Stored as
uint16 hundredths of a kelvin, 0 = no data.

Each build also re-derives M10 and requires it to match the bundle's M10.tif, which checks the mapping.
Writes <band>.tif (same grid as M10.tif) and <band>.json (source, calibration, checks) for each band.

Backfill every bundle under a data root:  python bands.py [data_root] [country ...]
The granule is found at the path in the bundle's manifest, else by file name under TEMPER_ARCHIVE
(os.pathsep-separated folders; default POSTPROCCESOR/archive on this machine)."""
import hashlib
import json
import os
import sys
import time
import warnings
from pathlib import Path

import numpy as np
import rasterio

REFLECTIVE = ("M11",)
THERMAL = ("M15", "M16")
BANDS = REFLECTIVE + THERMAL
METHOD = dict(M11="viirs_m11_on_m10_bundle_grid_v1", M15="viirs_thermal_bt_on_m10_bundle_grid_v1", M16="viirs_thermal_bt_on_m10_bundle_grid_v1")
RADIANCE = "W m-2 um-1 sr-1"
KELVIN_STEP = 0.01   # thermal TIFFs: kelvin = stored * KELVIN_STEP, 0 = no data
ARCHIVES = [Path(p) for p in os.environ.get("TEMPER_ARCHIVE", os.path.join(os.path.expanduser("~"), "Desktop", "POSTPROCCESOR", "archive")).split(os.pathsep) if p]
_INDEX = None


def _sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 22), b""):
            h.update(block)
    return h.hexdigest()


def find_granule(manifest):
    """The bundle's source VNP02MOD file: the recorded path, else the same file name in an archive folder."""
    global _INDEX
    recorded = manifest["configuration"]["source"]["observation"]["path"]
    if Path(recorded).is_file():
        return Path(recorded)
    if _INDEX is None:
        _INDEX = {p.name: p for root in ARCHIVES if root.is_dir() for p in root.rglob("*.nc")}
    name = recorded.replace("\\", "/").rsplit("/", 1)[-1]
    if name not in _INDEX:
        raise FileNotFoundError(f"source granule not found: {name}")
    return _INDEX[name]


def _open_var(granule, name):
    return rasterio.open(f"netcdf:{granule}:/observation_data/{name}")


def read_band(granule, band):
    """Raw stored integers, quality flags and calibration of one VNP02MOD band (as the M10 conversion reads them).
    Reflective bands carry radiance_scale_factor/radiance_add_offset; thermal bands scale_factor/add_offset."""
    # GDAL's netCDF driver flips rows of non-georeferenced arrays unless told not to; native_index counts from
    # the first stored row, so read the arrays as stored.
    with warnings.catch_warnings(), rasterio.Env(GDAL_NETCDF_BOTTOMUP="NO"):
        warnings.simplefilter("ignore", rasterio.errors.NotGeoreferencedWarning)
        with _open_var(granule, band) as ds:
            raw, tags = ds.read(1), ds.tags(1)
        with _open_var(granule, band + "_quality_flags") as ds:
            flags, qtags = ds.read(1), ds.tags(1)
    prefix = "" if band in THERMAL else "radiance_"
    units = tags.get(prefix + "units", "")
    if units not in ("Watts/meter^2/steradian/micrometer", "Watts/m^2/micrometer/steradian"):
        raise ValueError(f"{band}: unexpected radiance units {units!r}")
    masks = [int(v) for v in qtags["flag_masks"].strip("{}").split(",")]
    coeff = dict(band=band, scale=float(np.float32(tags[prefix + "scale_factor"])), offset=float(np.float32(tags[prefix + "add_offset"])), 
                 valid_min=int(tags["valid_min"]), valid_max=int(tags["valid_max"]), defined_quality_mask=int(np.bitwise_or.reduce(masks)), 
                 flag_meanings=qtags.get("flag_meanings", ""))
    return raw, flags, coeff


def read_lut(granule, band):
    """The granule's brightness-temperature lookup table for a thermal band: kelvin for each stored integer."""
    with warnings.catch_warnings(), rasterio.Env(GDAL_NETCDF_BOTTOMUP="NO"):
        warnings.simplefilter("ignore", rasterio.errors.NotGeoreferencedWarning)
        with _open_var(granule, band + "_brightness_temperature_lut") as ds:
            lut, tags = ds.read(1).ravel().astype(np.float32), ds.tags(1)
    if tags.get("units") != "Kelvin" or lut.size != 65536:
        raise ValueError(f"{band}: unexpected brightness temperature table ({tags.get('units')!r}, {lut.size} entries)")
    return lut, dict(valid_min=float(tags["valid_min"]), valid_max=float(tags["valid_max"]))


def calibrate(raw, flags, coeff):
    """Same rules as POSTPROCCESOR calibrate(..., lower_range_policy='retain_as_censored', reflective_band=True)."""
    science = (raw >= coeff["valid_min"]) & (raw <= coeff["valid_max"])
    censored = science & (raw == 0) & (flags == 2) & (coeff["offset"] == 0)
    good = (science & ((flags & coeff["defined_quality_mask"]) == 0)) | censored
    values = raw.astype(np.float32) * np.float32(coeff["scale"]) + np.float32(coeff["offset"])
    values[~science] = np.nan
    return values, good, censored


def brightness(raw, flags, coeff, lut, lut_range):
    """Thermal band: brightness temperature in K from the lookup table; any defined quality flag invalid."""
    good = (raw >= coeff["valid_min"]) & (raw <= coeff["valid_max"]) & ((flags & coeff["defined_quality_mask"]) == 0)
    kelvin = lut[raw.astype(np.int64)]
    good &= (kelvin >= lut_range["valid_min"]) & (kelvin <= lut_range["valid_max"])
    return np.where(good, kelvin, np.nan).astype(np.float32), good


def present(bundle, band):
    return (Path(bundle) / f"{band}.tif").is_file() and (Path(bundle) / f"{band}.json").is_file()


def build(bundle, bands=BANDS, force=False):
    """Write <band>.tif and <band>.json into one raw bundle for each band not there yet.
    Returns 'built', 'present' or raises."""
    bundle = Path(bundle)
    todo = [b for b in bands if force or not present(bundle, b)]
    if not todo:
        return "present"
    manifest = json.loads((bundle / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("phase") != "complete":
        raise ValueError("bundle not complete")
    granule = find_granule(manifest)
    expected = manifest["configuration"]["source"]["observation"].get("sha256")
    if expected and _sha256(granule) != expected:
        raise ValueError(f"source granule differs from the one recorded: {granule}")
    with np.load(bundle / "provenance.npz", allow_pickle=False) as z:
        valid, native = z["valid"], z["native_index"]
    with rasterio.open(bundle / "M10.tif") as ds:
        profile, m10, start = ds.profile.copy(), ds.read(1), ds.tags().get("time_start_utc", "")
    cells = valid & (native >= 0)
    ids = native[cells]
    # Check the mapping: M10 re-derived from the granule must match the bundle's M10.tif.
    raw10, flags10, c10 = read_band(granule, "M10")
    v10, _, _ = calibrate(raw10.ravel()[ids], flags10.ravel()[ids], c10)
    stored = m10[cells]
    diff = np.abs(v10 - stored)
    tolerance = 1e-6 * np.maximum(1.0, np.abs(stored))
    if not np.all(np.isfinite(stored)) or np.any(diff > tolerance):
        raise ValueError(f"M10 re-derived from the granule does not match M10.tif (max diff {float(np.nanmax(diff)):.3g})")
    check = dict(m10_cells=int(cells.sum()), m10_max_abs_diff=float(diff.max()) if diff.size else 0.0, 
                 m10_exact_share=float(np.mean(v10 == stored)) if diff.size else 1.0)
    del raw10, flags10, v10, stored, diff, m10
    for band in todo:
        raw, flags, coeff = read_band(granule, band)
        raw, flags = raw.ravel()[ids], flags.ravel()[ids]
        if band in THERMAL:
            lut, lut_range = read_lut(granule, band)
            kelvin, good = brightness(raw, flags, coeff, lut, lut_range)
            array = np.zeros(cells.shape, np.uint16)
            array[cells] = np.where(good, np.round(kelvin / KELVIN_STEP), 0).astype(np.uint16)
            out = dict(profile, dtype="uint16", nodata=0, predictor=2)
            description, units = f"{band}_brightness_temperature", "K"
            calibration = dict(**coeff, formula="brightness temperature = granule lookup table[stored integer]", 
                               lookup_table=f"{band}_brightness_temperature_lut", lookup_valid=lut_range, 
                               storage=f"kelvin = stored * {KELVIN_STEP}, 0 = no data", rejected_cells=int((~good).sum()))
            k = kelvin[good]
            summary = dict(valid_cells=int(good.sum()), kelvin_p5_p50_p95=[round(float(q), 2) for q in np.percentile(k, [5, 50, 95])] if k.size else None)
        else:
            value, good, censored = calibrate(raw, flags, coeff)
            array = np.full(cells.shape, np.nan, np.float32)
            array[cells] = np.where(good, value, np.nan)
            out = profile
            description, units = f"{band}_calibrated_at_sensor_radiance", RADIANCE
            calibration = dict(**coeff, formula="radiance = stored_integer * scale + offset", lower_range_policy="retain_as_censored", 
                               rejected_cells=int((~good).sum()), censored_cells=int((good & censored).sum()))
            summary = dict(valid_cells=int(np.isfinite(array).sum()))
        # per process: the backfill and the viewer may build the same bundle
        temp = bundle / f".{band}.{os.getpid()}.partial.tif"
        with rasterio.open(temp, "w", **out) as ds:
            ds.write(array, 1)
            ds.set_band_description(1, description)
            ds.set_band_unit(1, units)
            if band in THERMAL:
                ds.scales = (KELVIN_STEP,)
            ds.update_tags(method=METHOD[band], units=units, source_observation=str(granule), time_start_utc=start)
        with rasterio.open(temp) as ds:
            np.testing.assert_array_equal(ds.read(1), array)
        temp.replace(bundle / f"{band}.tif")
        record = dict(schema="satellite-product/1.0", method=METHOD[band], 
                      source=dict(observation=str(granule), sha256=expected, mapping="provenance.npz native_index (same native samples as M10.tif)"), 
                      calibration=calibration, check=check, **summary, 
                      artifacts={f"{band}.tif": dict(sha256=_sha256(bundle / f"{band}.tif"), bytes=(bundle / f"{band}.tif").stat().st_size)})
        partial = bundle / f".{band}.{os.getpid()}.partial.json"
        partial.write_text(json.dumps(record, indent=2), encoding="utf-8")
        partial.replace(bundle / f"{band}.json")
    return "built"


def backfill(data_root, countries=()):
    bundles = sorted(p for country in Path(data_root).iterdir() if (country / "raw_data").is_dir() and (not countries or country.name in countries)
                     for p in (country / "raw_data").iterdir() if p.is_dir() and not p.name.startswith(".") and (p / "M10.tif").is_file())
    counts, start = {}, time.time()
    for i, bundle in enumerate(bundles, 1):
        for stale in bundle.glob(".*.partial.*"):   # left by an interrupted run of this process id or another
            if f".{os.getpid()}." not in stale.name and time.time() - stale.stat().st_mtime > 3600:
                stale.unlink(missing_ok=True)
        try:
            status = build(bundle)
        except Exception as exc:   # report and continue with the other bundles
            status = "failed"
            print(f"FAILED {bundle.parent.parent.name}/{bundle.name}: {exc}", flush=True)
        counts[status] = counts.get(status, 0) + 1
        if status == "built" or i % 25 == 0:
            print(f"{i}/{len(bundles)} {status:8s} {bundle.parent.parent.name}/{bundle.name}  {time.time() - start:.0f}s", flush=True)
    print("DONE", counts, flush=True)


if __name__ == "__main__":
    backfill(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.expanduser("~"), "Desktop", "ARD", "VIIRS_NIGHT_SWIR"), sys.argv[2:])
