"use strict";
// נקודות: a layer of the user's points, each with the behaviour of its year. A file (a Shapefile: .zip, or .shp with its
// .dbf and .prj; GeoJSON; or a CSV with lat and lon) is read by the server (/api/import): its points come here, its
// polygons join the map's layers. Every point gets its two nightly series over a small window (server: /api/points, all
// the points read together night by night, about a second per hundred), drawn small (light, and heat with its
// burning nights), and the shape of its year in light and in heat as the area analysis finds it. A click opens the
// point in the graphs (Shift adds it). The points are kept per country on this computer; their series are read again
// when the country opens.
const pts = { list: [], data: [], dates: null, busy: false, seq: 0, sort: "file", filter: null, size: 2.25, active: -1, error: null };
const SHAPE_ORDER = { step: 0, trend: 1, fluct: 2, spike: 3, stable: 4 };
function pointsKey() {
  return "viewer-points-" + state.meta.id;
}
function loadPoints() {
  pts.list = [];
  pts.data = [];
  pts.active = -1;
  try {
    pts.list = JSON.parse(localStorage.getItem(pointsKey()) || "[]");
  } catch { }
  renderPoints();
  if (pts.list.length) runPoints();
}
function savePoints() {
  try {
    localStorage.setItem(pointsKey(), JSON.stringify(pts.list));
  } catch {
    toast("השכבה גדולה מכדי להישמר במחשב; היא תישאר עד שהדף ייסגר.");
  }
}
function fileB64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}
// A file, or a shapefile's parts chosen together: its points to this layer, its polygons to the map's layers.
async function importFiles(fileList) {
  if (!state.meta || !fileList.length) return;
  let total = 0;
  const files = [];
  for (const f of fileList) {
    total += f.size;
    if (total > 60e6) throw Error("הקבצים גדולים מ־60MB.");
    files.push({ name: f.name, data: await fileB64(f) });
  }
  const r = await api("/api/import", { files });
  for (const p of r.polygons) addPolygon(p.name, p.geometry);
  const seen = new Set(pts.list.map(p => p.name + "|" + p.x + "|" + p.y)), added = [];
  for (const p of r.points) if (!seen.has(p.name + "|" + p.x + "|" + p.y)) added.push(p);
  pts.list.push(...added);
  if (added.length) {
    savePoints();
    showSide("points");
    setSideMin(false);
    runPoints();
  }
  const parts = [];
  if (added.length) parts.push(added.length + " נקודות");
  if (r.polygons.length) parts.push(r.polygons.length + " פוליגונים לשכבות");
  if (r.outside) parts.push(r.outside + " מחוץ לתמונה");
  if (r.lines) parts.push(r.lines + " קווים לא נכללו");
  toast("יובא (" + r.crs + "): " + (parts.join(" · ") || "אין חדש"));
}
async function runPoints() {
  if (!state.meta || !pts.list.length) return;
  const seq = ++pts.seq, id = state.meta.id;
  pts.busy = true;
  pts.error = null;
  renderPoints();
  try {
    const out = [];
    let dates = null;
    for (let i = 0; i < pts.list.length; i += 500) {   // up to 500 a request
      const r = await api("/api/points", { points: pts.list.slice(i, i + 500).map(p => [p.x, p.y]), size_km: pts.size });
      if (seq !== pts.seq || state.meta?.id !== id) return;
      dates = r.dates;
      out.push(...r.points);
    }
    pts.data = out;
    pts.dates = dates;
  } catch (e) {
    if (seq === pts.seq) pts.error = e.message;
  } finally {
    if (seq === pts.seq) pts.busy = false;
  }
  renderPoints();
  renderMap();
}
function shapeWords(s, product) {
  if (!s) return "";
  if (s.none) return product === LR ? "חשוך" : "אין מקור חום";
  if (!s.shape) return "מעט מדי לילות";
  const dir = s.direction > 0 ? " ↑" : s.direction < 0 ? " ↓" : "";
  return SHAPE_LABELS[s.shape] + dir + (s.when ? " · " + displayDate(s.when) : "");
}
function lightShape(i) {
  const s = pts.data[i]?.lightroast_shape;
  return !s ? null : s.none ? "dark" : s.shape || "none";
}
function pointOrder() {
  const idx = pts.list.map((_, i) => i).filter(i => !pts.filter || lightShape(i) === pts.filter);
  const d = i => pts.data[i] || {};
  if (pts.sort === "light") idx.sort((a, b) => Math.abs(d(b).lightroast_shape?.change ?? 0) - Math.abs(d(a).lightroast_shape?.change ?? 0));
  if (pts.sort === "heat") idx.sort((a, b) => (d(b).hot?.length ?? 0) - (d(a).hot?.length ?? 0));
  if (pts.sort === "shape") idx.sort((a, b) => (SHAPE_ORDER[lightShape(a)] ?? 9) - (SHAPE_ORDER[lightShape(b)] ?? 9));
  return idx;
}
// A point's year, small: light (LIGHT ROAST's blue) on a log scale; where it burned on 2+ nights, heat (TEMPER's orange)
// too, and a tick on each night it burned (without a source, heat is only noise and is left out).
function drawSpark(cv, item) {
  const w = 150, h = 34, dpr = window.devicePixelRatio || 1, c = cv.getContext("2d");
  cv.width = w * dpr;
  cv.height = h * dpr;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const line = (vals, color, tx) => {
    const v = vals.map(x => x == null ? null : tx(x)), fin = v.filter(x => x != null);
    if (fin.length < 3) return;
    const sorted = [...fin].sort((a, b) => a - b), lo = sorted[Math.floor(sorted.length * .02)], hi = sorted[Math.ceil(sorted.length * .98) - 1];
    c.strokeStyle = color;
    c.lineWidth = 1.2;
    c.beginPath();
    let pen = false;
    v.forEach((x, i) => {
      if (x == null) return;
      const px = i / Math.max(1, v.length - 1) * w, py = h - 3 - (Math.min(hi, Math.max(lo, x)) - lo) / Math.max(1e-9, hi - lo) * (h - 8);
      pen ? c.lineTo(px, py) : c.moveTo(px, py);
      pen = true;
    });
    c.stroke();
  };
  if (item.lightroast) line(item.lightroast, "#5b9bff", x => Math.log(Math.max(x, 0) + 1));
  if (item.temper && (item.hot?.length || 0) >= 2) line(item.temper, "rgba(255,138,61,.75)", x => x);
  c.fillStyle = "#ff8a3d";
  const n = item.temper?.length || 1;
  for (const j of item.hot || []) c.fillRect(j / Math.max(1, n - 1) * w - .5, h - 3, 1.5, 3);
}
function openPoint(i, add) {
  const p = pts.list[i];
  pts.active = i;
  flyTo(p.x, p.y, 8);
  openPlace([p.x, p.y], { size: pts.size, add });
  if (lrMeta() && !state.compare) setCompare(true);
  renderPoints();
}
function renderPoints() {
  if (!$("pointsList")) return;
  const list = $("pointsList"), n = pts.list.length;
  $("pointsCount").textContent = n ? String(n) : "";
  $("pointsEmpty").hidden = n > 0;
  $("pointsStatus").textContent = pts.busy ? "קורא את הלילות…" : pts.error || (n ? n + " נקודות" : "");
  $("pointsCsv").disabled = $("pointsClear").disabled = !n;
  // the light shapes, as chips that filter
  const chips = $("pointsShapes");
  chips.replaceChildren();
  if (pts.data.length) {
    const count = {};
    pts.list.forEach((_, i) => {
      const s = lightShape(i);
      count[s] = (count[s] || 0) + 1;
    });
    for (const s of ["step", "trend", "fluct", "spike", "stable", "dark"]) if (count[s]) {
      chips.append(chip(s === "dark" ? "חשוך" : SHAPE_LABELS[s], count[s], pts.filter && pts.filter !== s, "האור: " + (s === "dark" ? "חשוך" : SHAPE_LABELS[s]), () => {
        pts.filter = pts.filter === s ? null : s;
        renderPoints();
        renderMap();
      }, s === "dark" ? "#71717a" : shapeColor({ shape: s, direction: 1 })));
    }
  }
  list.replaceChildren();
  if (state.side !== "points") return;
  for (const i of pointOrder().slice(0, 400)) {
    const p = pts.list[i], d = pts.data[i], li = mk("li"), go = mk("button", "ev-item point-row" + (i === pts.active ? " active" : ""));
    const top = mk("span", "ev-top"), name = mk("b", null, p.name);
    name.dataset.i18nSkip = "";
    top.append(name);
    if (!p.inside) top.append(mk("span", "ev-kind", "מחוץ לתמונה"));
    const sub = mk("span", "ev-sub");
    sub.append(mk("span", "ev-where", ltr(coordText(p.lonlat, 4))));
    go.append(top);
    if (d) {
      const shapes = mk("span", "point-shapes");
      shapes.append(mk("span", "pt-l", "אור: " + shapeWords(d.lightroast_shape, LR)), mk("span", "pt-t", "חום: " + shapeWords(d.temper_shape, "temper") + (d.hot?.length ? " · " + d.hot.length + " לילות בוער" : "")));
      const cv = mk("canvas", "point-spark");
      go.append(shapes, cv);
      requestAnimationFrame(() => drawSpark(cv, d));
    }
    go.append(sub);
    go.title = "לחיצה: הנקודה בגרפים · Shift+לחיצה: להוסיף ליד האחרים";
    go.onclick = e => openPoint(i, e.shiftKey);
    li.append(go);
    list.append(li);
  }
}
// On the map: the points, small; the one opened last ringed; names when the tab is open and the map is close enough.
function drawPoints() {
  if (!pts.list.length) return;
  ctx.save();
  const named = state.side === "points" && state.zoom > state.fitZoom * 4;
  ctx.font = "600 10.5px 'Segoe UI',system-ui,sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  pts.list.forEach((p, i) => {
    if (pts.filter && lightShape(i) !== pts.filter) return;
    const [x, y] = screen(p.x, p.y);
    if (x < -10 || y < -10 || x > state.width + 10 || y > state.height + 10) return;
    const s = lightShape(i), color = s && s !== "dark" && s !== "none" ? shapeColor({ shape: s, direction: pts.data[i]?.lightroast_shape?.direction || 1 }) : "#e4e4e7";
    ctx.beginPath();
    ctx.arc(x, y, i === pts.active ? 6 : 3.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(8,8,10,.85)";
    ctx.stroke();
    if (named) {
      ctx.lineWidth = 3;
      ctx.strokeText(p.name, x, y - 6);
      ctx.fillStyle = INK;
      ctx.fillText(p.name, x, y - 6);
    }
  });
  ctx.restore();
}
$("pointsImport").onclick = () => $("vectorFile").click();
$("vectorFile").onchange = async e => {
  const files = [...e.target.files];
  e.target.value = "";
  try {
    await importFiles(files);
  } catch (err) {
    toast(err.message);
  }
};
$("pointsSize").onchange = () => {
  pts.size = Number($("pointsSize").value) || 2.25;
  runPoints();
};
$("pointsSort").onchange = () => {
  pts.sort = $("pointsSort").value;
  renderPoints();
};
$("pointsClear").onclick = () => {
  pts.list = [];
  pts.data = [];
  pts.filter = null;
  pts.active = -1;
  savePoints();
  renderPoints();
  renderMap();
};
$("pointsCsv").onclick = () => {
  const rows = [["name", "longitude", "latitude", "light_shape", "light_direction", "light_when", "heat_shape", "heat_nights_burning", "light_median_nw"]];
  pts.list.forEach((p, i) => {
    const d = pts.data[i] || {}, l = d.lightroast_shape || {}, t = d.temper_shape || {}, lv = (d.lightroast || []).filter(v => v != null).sort((a, b) => a - b);
    rows.push([JSON.stringify(p.name), p.lonlat[0], p.lonlat[1], l.none ? "dark" : l.shape || "", l.direction ?? "", l.when || "", t.none ? "no heat source" : t.shape || "", d.hot?.length ?? "", lv.length ? lv[Math.floor(lv.length / 2)] : ""]);
  });
  download("points_" + state.meta.name.replace(/\W+/g, "_") + ".csv", rows.map(r => r.join(",")).join("\r\n"), "text/csv");
};
