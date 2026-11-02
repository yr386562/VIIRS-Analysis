"""The user's vector files, read without any other library: GeoJSON, CSV of points, and ESRI shapefiles (a .zip, or
the .shp with its .dbf, .prj and .cpg). Each gives features {name, kind ("point" | "polygon" | "line"), geometry
(GeoJSON, in the file's own coordinates)} and the file's CRS (WKT or EPSG), for server.py to put on the grid.

Shapefile: the .shp records (points, multipoints, polylines, polygons, with or without Z/M), the .dbf attributes
(dBase III; the text encoding from the .cpg, else UTF-8, else Windows-1255 for Hebrew), the .prj CRS (WKT; none: WGS84
when the coordinates fit in degrees). Polygon rings: clockwise ones are outer rings, the others holes of the outer
ring holding them (the shapefile convention)."""
import csv
import io
import json
import re
import struct
import zipfile

NAME_FIELDS = ("name", "Name", "NAME", "שם", "label", "Label", "title", "id", "ID", "Id")
LAT_FIELDS = ("lat", "latitude", "y", "lat_dd", "נ.צ. רוחב", "רוחב")
LON_FIELDS = ("lon", "lng", "long", "longitude", "x", "lon_dd", "נ.צ. אורך", "אורך")
MAX_FEATURES = 5000


def read(files):
    """files: {file name: bytes}. Returns (features, crs) where crs is WKT text, "EPSG:4326", or None (unknown)."""
    files = dict(files)
    for name in [n for n in files if n.lower().endswith(".zip")]:
        with zipfile.ZipFile(io.BytesIO(files.pop(name))) as z:
            for info in z.infolist():
                if not info.is_dir() and info.file_size < 200_000_000:
                    files[info.filename.split("/")[-1]] = z.read(info)
    lower = {n.lower(): n for n in files}
    shp = [n for n in files if n.lower().endswith(".shp")]
    if shp:
        out, crs = [], None
        for name in shp:
            base = name[:-4].lower()
            dbf, prj, cpg = (files.get(lower.get(base + ext, "")) for ext in (".dbf", ".prj", ".cpg"))
            feats, c = read_shapefile(files[name], dbf, prj, cpg)
            out += feats
            crs = crs or c
        return out[:MAX_FEATURES], crs
    for name, data in files.items():
        low = name.lower()
        if low.endswith((".geojson", ".json")):
            return read_geojson(data), "EPSG:4326"
        if low.endswith((".csv", ".txt", ".tsv")):
            return read_csv(data), "EPSG:4326"
    raise ValueError("לא זיהיתי קובץ: GeoJSON, CSV של נקודות, או Shapefile (zip, או shp עם dbf ו־prj).")


def _kind(geometry):
    t = geometry.get("type", "")
    return "point" if "Point" in t else "polygon" if "Polygon" in t else "line" if "LineString" in t else None


def _name(props, i, prefix):
    for k in NAME_FIELDS:
        v = props.get(k)
        if v not in (None, ""):
            return str(v).strip()[:100]
    return f"{prefix} {i + 1}"


def read_geojson(data):
    obj = json.loads(data.decode("utf-8-sig") if isinstance(data, bytes) else data)
    if obj.get("type") == "FeatureCollection":
        features = obj.get("features", [])
    elif obj.get("type") == "Feature":
        features = [obj]
    else:
        features = [dict(type="Feature", geometry=obj, properties={})]
    out = []
    for i, f in enumerate(features[:MAX_FEATURES]):
        g = f.get("geometry") or {}
        if g.get("type") == "GeometryCollection":
            parts = g.get("geometries", [])
        else:
            parts = [g]
        for g in parts:
            k = _kind(g)
            if k:
                out.append(dict(name=_name(f.get("properties") or {}, i, "#"), kind=k, geometry=g, properties=f.get("properties") or {}))
    return out


def read_csv(data):
    text = data.decode("utf-8-sig", errors="replace")
    try:
        dialect = csv.Sniffer().sniff(text[:4000], delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    rows = list(csv.DictReader(io.StringIO(text), dialect=dialect))
    if not rows:
        raise ValueError("הקובץ ריק.")
    fields = {f.strip().lower(): f for f in rows[0].keys() if f}
    lat = next((fields[f] for f in LAT_FIELDS if f in fields), None)
    lon = next((fields[f] for f in LON_FIELDS if f in fields), None)
    if not lat or not lon:
        raise ValueError("ב־CSV צריך עמודות lat ו־lon (או latitude ו־longitude), בקווי רוחב ואורך.")
    out = []
    for i, r in enumerate(rows[:MAX_FEATURES]):
        try:
            y, x = float(str(r[lat]).replace(",", ".")), float(str(r[lon]).replace(",", "."))
        except (TypeError, ValueError):
            continue
        out.append(dict(name=_name(r, i, "#"), kind="point", geometry=dict(type="Point", coordinates=[x, y]), properties=r))
    if not out:
        raise ValueError("לא נמצאו שורות עם קווי רוחב ואורך.")
    return out


# ---------- shapefiles ----------
def _ring_area(ring):
    """Twice the signed area: negative for a clockwise ring (outer, in shapefiles)."""
    return sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(ring, ring[1:] + ring[:1]))


def _inside(p, ring):
    x, y, inside = p[0], p[1], False
    for (x0, y0), (x1, y1) in zip(ring, ring[1:] + ring[:1]):
        if (y0 > y) != (y1 > y) and x < (x1 - x0) * (y - y0) / (y1 - y0) + x0:
            inside = not inside
    return inside


def _polygons(rings):
    outers = [[r] for r in rings if _ring_area(r) <= 0]
    holes = [r for r in rings if _ring_area(r) > 0]
    if not outers:   # written the other way round: every ring is a polygon
        outers, holes = [[r] for r in rings], []
    for h in holes:
        for poly in outers:
            if _inside(h[0], poly[0]):
                poly.append(h)
                break
    rings_out = [[[list(p) for p in r] + [list(r[0])] if r[0] != r[-1] else [list(p) for p in r] for r in poly] for poly in outers]
    return dict(type="Polygon", coordinates=rings_out[0]) if len(rings_out) == 1 else dict(type="MultiPolygon", coordinates=rings_out)


def _dbf(data, encoding):
    if not data or len(data) < 32:
        return []
    n, header, length = struct.unpack("<IHH", data[4:12])
    fields, pos = [], 32
    while pos < header - 1 and data[pos] != 0x0D:
        name = data[pos:pos + 11].split(b"\0")[0].decode("ascii", errors="replace")
        fields.append((name, chr(data[pos + 11]), data[pos + 16]))
        pos += 32
    out = []
    for i in range(n):
        rec = data[header + i * length: header + (i + 1) * length]
        if not rec or rec[:1] == b"*":
            out.append(None)
            continue
        row, p = {}, 1
        for name, typ, size in fields:
            raw = rec[p:p + size]
            p += size
            text = None
            for enc in (encoding, "utf-8", "cp1255", "latin-1"):
                if not enc:
                    continue
                try:
                    text = raw.decode(enc).strip()
                    break
                except (UnicodeDecodeError, LookupError):
                    continue
            if typ in "NF" and text:
                try:
                    text = float(text) if any(c in text for c in ".eE") else int(text)
                except ValueError:
                    pass
            row[name] = text
        out.append(row)
    return out


def read_shapefile(shp, dbf=None, prj=None, cpg=None):
    if len(shp) < 100 or struct.unpack(">i", shp[:4])[0] != 9994:
        raise ValueError("קובץ ה־shp פגום.")
    encoding = cpg.decode("ascii", errors="ignore").strip() if cpg else None
    if encoding and re.fullmatch(r"\d{3,4}", encoding):
        encoding = "cp" + encoding
    rows = _dbf(dbf, encoding)
    out, pos, i = [], 100, 0
    while pos + 8 <= len(shp) and len(out) < MAX_FEATURES:
        length = struct.unpack(">i", shp[pos + 4:pos + 8])[0] * 2
        rec = shp[pos + 8:pos + 8 + length]
        pos += 8 + length
        props = (rows[i] if i < len(rows) else None) or {}
        i += 1
        if len(rec) < 4:
            continue
        t = struct.unpack("<i", rec[:4])[0]
        g = None
        if t in (1, 11, 21):
            x, y = struct.unpack("<2d", rec[4:20])
            g = dict(type="Point", coordinates=[x, y])
        elif t in (8, 18, 28):
            n = struct.unpack("<i", rec[36:40])[0]
            pts = [list(struct.unpack("<2d", rec[40 + 16 * k:56 + 16 * k])) for k in range(n)]
            g = dict(type="MultiPoint", coordinates=pts) if n > 1 else dict(type="Point", coordinates=pts[0]) if n else None
        elif t in (3, 13, 23, 5, 15, 25):
            nparts, npts = struct.unpack("<2i", rec[36:44])
            parts = list(struct.unpack(f"<{nparts}i", rec[44:44 + 4 * nparts])) + [npts]
            base = 44 + 4 * nparts
            pts = [struct.unpack("<2d", rec[base + 16 * k:base + 16 * k + 16]) for k in range(npts)]
            rings = [pts[parts[k]:parts[k + 1]] for k in range(nparts) if parts[k + 1] - parts[k] >= 2]
            if t in (5, 15, 25):
                rings = [r for r in rings if len(r) >= 3]
                g = _polygons(rings) if rings else None
            else:
                g = dict(type="LineString", coordinates=[list(p) for p in rings[0]]) if len(rings) == 1 else dict(type="MultiLineString", coordinates=[[list(p) for p in r] for r in rings])
        if g:
            out.append(dict(name=_name(props, len(out), "#"), kind=_kind(g), geometry=g, properties=props))
    crs = prj.decode("utf-8", errors="replace").strip() if prj else None
    if not crs and out:   # no .prj: degrees when every coordinate fits in them
        sample = json.dumps([f["geometry"]["coordinates"] for f in out[:200]])
        nums = [abs(float(v)) for v in re.findall(r"-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?", sample)]
        crs = "EPSG:4326" if nums and max(nums) <= 360 else None
    return out, crs
