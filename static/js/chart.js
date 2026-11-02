"use strict";
// The graphs: one panel per product, the scale, hover and labels; the graph by mouse (zoom, pan, the wheel over a
// date); the period (From / To); the graph in its own tab.

function chartGeometry() {
  const w = state.chartWidth, h = state.chartHeight;
  return { left: 54, right: w - (state.windows.some(x => seriesOf(x)) ? 44 : 14), top: 10, bottom: h - 22 };
}
function focusDates(product = state.product) {
  const from = state.rangeFrom || "", to = state.rangeTo || "9999";
  return productDates(product).filter(d => d >= from && d <= to);
}
// Compare: TEMPER above LIGHT ROAST for the same windows, on one time axis, each with its own scale (no dual axis).
function comparing() {
  return state.compare && !!lrMeta();
}
function chartProducts() {
  return comparing() ? ["temper", LR] : [state.product];
}
// Both graphs: each graph in its product's tint (TEMPER orange, LIGHT ROAST blue); each window keeps its own colour
// in both, with its #n label at the line's end.
const PRODUCT_HUE = { temper: "#ff8a3d", lightroast: "#5b9bff" };
function setCompare(on) {
  state.compare = on;
  try {
    localStorage.setItem("viewer-compare", on ? "1" : "0");
  } catch { }
  compareUI();
  for (const p of ["temper", LR]) if (state.scales[p]?.auto) state.scales[p] = null;
  renderLegend();
  renderChart();
}
// Both graphs take a taller bottom panel (the chart redraws on resize).
function compareUI() {
  const on = comparing();
  document.body.classList.toggle("comparing", on);
  $("compareToggle").classList.toggle("active", on);
  $("compareToggle").setAttribute("aria-pressed", on);
  $("compareToggle").disabled = !lrMeta();
  document.querySelector(".stage").classList.toggle("tall", on);
}
function chartValues(product, dates) {
  const v = [];
  for (const w of shownWindows()) if (seriesOf(w, product)) for (const d of dates) {
    const m = valueAt(w, d, product);
    if (m != null) v.push(m);
  }
  return v;
}
// The same, as drawn (see chartMode): what a fitted scale spans.
function plottedValues(product, dates) {
  const v = [];
  for (const w of shownWindows()) if (seriesOf(w, product)) for (const d of dates) {
    const m = plotValue(w, d, product);
    if (m != null) v.push(m);
  }
  return v;
}
// The values axis. "fixed": Min/Max as set (from 0, or as zoomed with Shift+wheel), the same whatever the period.
// "view": fitted to the values in the period shown, so zooming in on a few weeks gives a small shift the whole height;
// with 30 or more values it spans their 2nd to 98th percentile, and a rare spike past it is pinned to the edge with an
// arrowhead instead of flattening the rest. "change": each place against its own median in the period shown, in percent
// where the values are radiances (both products' raw means), else as a difference (TEMPER's corrected mean and the
// temperature): places of very different brightness then share one axis. "noise": each place against its own usual
// level (its median in the period), in units of its own night-to-night noise (see noiseOf), on an axis that squeezes
// the noise band (within ±2) into a narrow strip and gives the rest of the height to what lies outside it (see
// squash): ordinary jitter stays flat, a real shift stands out, a dark place and a bright one alike.
// The reference (chartRef, in "change" and "noise"): every place against one of them, night by night (lights: their
// ratio; heat: their difference), so what moves both together (haze, the moon, a regional dip) cancels out and what
// is left is what the place did differently; the reference itself lies flat on 0.
let chartMode = "fixed", chartRef = null;
try {
  const m = localStorage.getItem("viewer-chart-mode");
  if (["fixed", "view", "change", "noise"].includes(m)) chartMode = m;
} catch { }
const NOISE_BAND = 2;   // within ±2 of a place's own noise: noise
// The noise axis: linear and narrow inside the band (±2 → ±0.7), then one unit for each doubling beyond it.
function squash(z) {
  const u = Math.abs(z);
  return Math.sign(z) * (u <= NOISE_BAND ? .35 * u : .35 * NOISE_BAND + Math.log2(u / NOISE_BAND));
}
// A place's values as compared: lights in log(L + 1) (their noise grows with their brightness), heat as they are;
// against the reference, the difference from its value on the same night (null where either is missing).
function relValue(w, d, product) {
  const v = valueAt(w, d, product);
  if (v == null) return null;
  const log = product === LR || state.metric === "mean", f = x => log ? Math.log1p(Math.max(x, 0)) : x;
  const ref = chartRef != null && w.n !== chartRef ? state.windows.find(x => x.n === chartRef && seriesOf(x, product)) : null;
  if (!ref) return w.n === chartRef ? 0 : f(v);
  const r = valueAt(ref, d, product);
  return r == null ? null : f(v) - f(r);
}
// A place's noise: the robust spread of its night-to-night differences (1.4826 × their median absolute value / √2), so
// a step, which moves the level once, does not count as noise; never below a floor (a flat line has none).
function noiseOf(values, product) {
  const diffs = [];
  for (let i = 1; i < values.length; i++) diffs.push(Math.abs(values[i] - values[i - 1]));
  const m = median(diffs), floor = product === LR || state.metric === "mean" ? .02 : 1e-6;
  return Math.max(floor, m == null ? floor : 1.4826 * m / Math.SQRT2);
}
function changeInPercent(product) {
  return product === LR || state.metric === "mean";
}
function median(values) {
  const s = values.filter(v => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
}
// Each shown place's median in the period, per product: the base of "change" and "noise", with (for "noise", or
// against a reference) its values as compared and their noise (set before each drawing).
function chartBases() {
  if (chartRef != null && !state.windows.some(w => w.n === chartRef)) chartRef = null;   // the reference was closed
  const rel = chartRef != null || chartMode === "noise";
  for (const w of shownWindows()) {
    w.base = {};
    w.rel = {};
    for (const p of ["temper", LR]) {
      if (!seriesOf(w, p)) continue;
      const dates = focusDates(p);
      w.base[p] = median(dates.map(d => valueAt(w, d, p)));
      if (!rel) continue;
      const vals = dates.map(d => relValue(w, d, p)).filter(v => v != null);
      w.rel[p] = { base: median(vals), noise: noiseOf(vals, p) };
    }
  }
}
function plotValue(w, d, product) {
  if (chartMode !== "change" && chartMode !== "noise") return valueAt(w, d, product);
  if (chartMode === "noise" || chartRef != null) {
    const r = w.rel?.[product], v = relValue(w, d, product);
    if (!r || r.base == null || v == null) return null;
    if (chartMode === "noise") return squash((v - r.base) / r.noise);
    return product === LR || state.metric === "mean" ? (Math.exp(v - r.base) - 1) * 100 : v - r.base;   // change, against the reference
  }
  const v = valueAt(w, d, product);
  if (v == null) return v;
  const b = w.base?.[product];
  if (b == null) return null;
  if (!changeInPercent(product)) return v - b;
  return b > 0 ? (v / b - 1) * 100 : null;
}
// The shape found for a place, drawn over its line (dashed, in its colour): what the behaviour search found it by, else
// what the area analysis found over the graph's period (server.py: series_profile). The shape's own numbers are fitted
// here to the values as drawn: a step's level before and after its night, a trend's straight line, a swing's low and
// high levels (20th and 80th percentiles), the spikes ringed above the place's median.
let showShapes = true;
try {
  showShapes = localStorage.getItem("viewer-show-shapes") !== "0";
} catch { }
function shapeOf(w, product) {
  if (w.shapes?.[product]) return w.shapes[product];
  if (w.found?.product === product) return w.found;
  const f = w.area?.[product]?.profile;
  return f?.shape && f.shape !== "stable" ? { shape: f.shape, when: f.when, direction: f.direction } : null;
}
function drawShape(c, s, product, dates, values, x, y, g) {
  const sh = showShapes && shapeOf(s, product);
  if (!sh) return;
  const pts = [];
  dates.forEach((d, i) => {
    if (values[i] != null && Number.isFinite(values[i])) pts.push([d, values[i]]);
  });
  if (pts.length < 6) return;
  const vs = pts.map(p => p[1]), first = pts[0][0], last = pts[pts.length - 1][0], color = colorOf(s);
  const seg = (d0, v0, d1, v1) => {
    c.moveTo(x(d0), y(v0));
    c.lineTo(x(d1), y(v1));
  };
  let label = SHAPE_LABELS[sh.shape] || sh.shape, ly = null;
  c.save();
  c.strokeStyle = color;
  c.lineWidth = 1.6;
  c.setLineDash([6, 4]);
  c.beginPath();
  if (sh.shape === "step" && sh.when) {
    const before = median(pts.filter(p => p[0] < sh.when).map(p => p[1])), after = median(pts.filter(p => p[0] >= sh.when).map(p => p[1]));
    if (before != null && after != null) {
      seg(first, before, sh.when, before);
      seg(sh.when, before, sh.when, after);
      seg(sh.when, after, last, after);
    } else if (before != null || after != null) seg(first, before ?? after, last, before ?? after);
    label += " · " + displayDate(sh.when);
    ly = after ?? before;
  } else if (sh.shape === "trend") {
    const t = pts.map(p => dayTime(p[0])), tm = t.reduce((a, b) => a + b, 0) / t.length, vm = vs.reduce((a, b) => a + b, 0) / vs.length;
    let sxy = 0, sxx = 0;
    t.forEach((ti, i) => {
      sxy += (ti - tm) * (vs[i] - vm);
      sxx += (ti - tm) ** 2;
    });
    const b = sxx ? sxy / sxx : 0, at = d => vm + b * (dayTime(d) - tm);
    seg(first, at(first), last, at(last));
    ly = at(last);
  } else if (sh.shape === "fluct") {
    const q = p => [...vs].sort((a, b) => a - b)[Math.round(p * (vs.length - 1))], lo = q(.2), hi = q(.8);
    seg(first, lo, last, lo);
    seg(first, hi, last, hi);
    ly = hi;
  } else {   // spikes, or steady (from the search): the usual level, and the spikes ringed above it
    const base = median(vs), mad = median(vs.map(v => Math.abs(v - base))) || 0;
    seg(first, base, last, base);
    ly = base;
    if (sh.shape === "spike") {
      c.stroke();
      c.setLineDash([]);
      c.beginPath();
      for (const [d, v] of pts) if (v - base > Math.max(4 * 1.4826 * mad, Math.abs(base) * .5)) {
        c.moveTo(x(d) + 7, y(v));
        c.arc(x(d), y(v), 7, 0, Math.PI * 2);
      }
    }
  }
  c.stroke();
  if (ly != null) {
    c.setLineDash([]);
    c.font = "600 10px 'Segoe UI',system-ui,sans-serif";
    c.textAlign = "right";
    c.textBaseline = "bottom";
    c.lineWidth = 3;
    c.strokeStyle = "rgba(8,8,10,.85)";
    const ty = Math.max(g.top + 12, Math.min(g.bottom - 2, y(ly) - 4));
    c.strokeText(label, g.right - 6, ty);
    c.fillStyle = color;
    c.fillText(label, g.right - 6, ty);
  }
  c.restore();
}
function renderShapeToggle() {
  $("shapeToggle").classList.toggle("active", showShapes);
  $("shapeToggle").setAttribute("aria-pressed", showShapes);
}
$("shapeToggle").onclick = () => {
  showShapes = !showShapes;
  try {
    localStorage.setItem("viewer-show-shapes", showShapes ? "1" : "0");
  } catch { }
  renderShapeToggle();
  renderChart();
};
renderShapeToggle();
function fittedScale(product) {
  const values = plottedValues(product, focusDates(product)).sort((a, b) => a - b);
  if (!values.length) return null;
  const q = p => values[Math.min(values.length - 1, Math.max(0, Math.round(p * (values.length - 1))))];
  let lo = values.length >= 30 ? q(.02) : values[0], hi = values.length >= 30 ? q(.98) : values[values.length - 1];
  if (chartMode === "change") {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }
  if (chartMode === "noise") {   // the noise band always shows, and a little room beyond it
    lo = Math.min(lo, squash(-NOISE_BAND * 1.6));
    hi = Math.max(hi, squash(NOISE_BAND * 1.6));
  }
  const pad = (hi - lo) * .08 || Math.max(Math.abs(hi) * .05, 1e-6);
  return { lo: lo - pad, hi: hi + pad };
}
function tickText(v, product) {
  const s = String(+v.toPrecision(6));
  if (chartMode !== "change") return s;
  const sign = v > 0 ? "+" : "";
  return changeInPercent(product) ? sign + Math.round(v) + "%" : sign + s;
}
function axisUnits(product = state.product) {
  const ref = chartRef != null ? " · מול #" + chartRef : "";
  if (chartMode === "noise") return "× הרעש של המקום" + ref;
  if (chartMode !== "change") return unitsFor(product);
  if (chartRef != null) return (product === LR || state.metric === "mean" ? "% מול #" : "Δ מול #") + chartRef + ", מנורמל לחציון בתקופה";
  return changeInPercent(product) ? "% מול החציון בתקופה" : "Δ " + unitsFor(product) + " מול החציון בתקופה";
}
function setChartMode(m) {
  chartMode = m;
  try {
    localStorage.setItem("viewer-chart-mode", m);
  } catch { }
  renderChartMode();
  $("seriesUnits").textContent = axisUnits();
  renderChart();
}
// The scale buttons; "view" is offered (highlighted) while the graph is zoomed in time on the fixed scale.
function renderChartMode() {
  for (const b of document.querySelectorAll("#chartMode button")) {
    b.classList.toggle("active", b.dataset.mode === chartMode);
    b.setAttribute("aria-pressed", b.dataset.mode === chartMode);
  }
  // the reference: offered in Change and Noise, once there are two places to compare
  const sel = $("chartRef"), wins = state.windows.filter(w => !w.loading);
  if (chartRef != null && !wins.some(w => w.n === chartRef)) chartRef = null;
  sel.hidden = !(chartMode === "change" || chartMode === "noise") || wins.length < 2;
  const opts = [["", "כל מקום מול עצמו"], ...wins.map(w => [String(w.n), "הכל מול #" + num(w)])];
  if (sel.options.length !== opts.length || [...sel.options].some((o, i) => o.value !== opts[i][0] || o.textContent !== opts[i][1])) {
    sel.replaceChildren(...opts.map(([v, t]) => Object.assign(document.createElement("option"), { value: v, textContent: t })));
  }
  sel.value = chartRef == null ? "" : String(chartRef);
  const zoomed = !!(state.rangeFrom || state.rangeTo);
  document.querySelector('#chartMode [data-mode="view"]').classList.toggle("suggest", zoomed && chartMode === "fixed");
}
for (const b of document.querySelectorAll("#chartMode button")) b.onclick = () => setChartMode(b.dataset.mode);
$("chartRef").onchange = () => {
  chartRef = $("chartRef").value ? Number($("chartRef").value) : null;
  $("seriesUnits").textContent = axisUnits();
  renderChart();
};
function scaleFor(values, product) {
  const low = Math.min(...values), high = Math.max(...values);
  return product !== LR && state.metric === "temperature" ? [Math.max(0, Math.floor(low * .9 / 100) * 100), niceCeil(high * 1.05)] : [low < 0 ? -niceCeil(-low * 1.05) : 0, niceCeil(high * 1.05)];
}
function panelScale(product) {
  if (chartMode !== "fixed") return fittedScale(product);
  if (product === state.product) return state.chartHigh === null ? null : { lo: state.chartLow, hi: state.chartHigh };
  const saved = state.scales[product];
  if (saved) return saved;
  let values = chartValues(product, focusDates(product));
  if (!values.length) values = chartValues(product, productDates(product));
  if (!values.length) return null;
  const [lo, hi] = scaleFor(values, product);
  return state.scales[product] = { lo, hi, auto: true };
}
function niceStep(span) {
  const rough = span / 4, e = 10 ** Math.floor(Math.log10(rough)), f = rough / e;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e;
}
function niceCeil(v) {
  if (!(v > 0)) return 1e-3;
  const e = 10 ** Math.floor(Math.log10(v)), f = v / e;
  return [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(n => n >= f - 1e-9) * e;
}
function setChartScale(lo, hi) {
  state.chartLow = lo;
  state.chartHigh = hi;
  $("chartLow").value = +lo.toPrecision(6);
  $("chartHigh").value = +hi.toPrecision(6);
  renderChart();
}
// Fit is a one-off: it sets Min/Max from the windows in the period, and the scale then stays put until changed.
function fitChart(quiet) {
  let values = chartValues(state.product, focusDates());
  if (!values.length && quiet) values = chartValues(state.product, productDates());
  if (!values.length) {
    if (!quiet) toast("אין ערכים בתקופה הזו.");
    return;
  }
  // Temperatures start just below the coolest value; radiance scales start at 0 (or below it, for negative corrected means).
  const [lo, hi] = scaleFor(values, state.product);
  setChartScale(lo, hi);
  state.chartAuto = true;
}
function timeTicks(t0, t1) {
  const span = (t1 - t0) / DAY, ticks = [];
  if (span <= 62) {
    const step = [1, 2, 3, 7, 14].find(s => span / s <= 9) || 14;
    for (let t = t0; t <= t1 + 1; t += step * DAY) ticks.push({ t, label: new Date(t).toLocaleDateString(LOCALE, { day: "numeric", month: "short", timeZone: "UTC" }) });
    return ticks;
  }
  const step = [1, 2, 3, 6].find(m => span / 30.44 / m <= 10) || 6, d = new Date(t0);
  let m = d.getUTCMonth() + (d.getUTCDate() > 1 ? 1 : 0);
  for (;; m++) {
    const t = Date.UTC(d.getUTCFullYear(), m, 1);
    if (t > t1) break;
    if (new Date(t).getUTCMonth() % step) continue;
    ticks.push({ t, label: new Date(t).toLocaleDateString(LOCALE, { month: "short", year: "2-digit", timeZone: "UTC" }) });
  }
  return ticks;
}
function marker(c, px, py, color, on) {
  c.beginPath();
  c.arc(px, py, on ? 5 : 4, 0, Math.PI * 2);
  c.fillStyle = color;
  c.fill();
  c.lineWidth = 2;
  c.strokeStyle = SURFACE;
  c.stroke();
}
// A night is cloudy for a window when at least half of its pixels are flagged (M15 well below their clear-sky reference).
const CLOUDY = 50;
function isCloudy(p) {
  return p?.cloud_percent != null && p.cloud_percent >= CLOUDY;
}
// A night is reliable for a window when at least RELIABLE % of its cells were measured and it is not mostly cloudy. On
// partly clouded nights even the measured cells read low (thin cloud and haze next to the cloud mask): 3 km windows over
// Tel Aviv, Beersheba and Haifa read 73-83% of their clear-night level there. Those nights stay off the line and out of
// the weekly median, drawn as hollow markers; nights with nothing measured under cloud get a tick at the bottom.
const RELIABLE = 80;
function reliable(p) {
  return !!p && !isCloudy(p) && !(p.coverage != null && p.coverage < RELIABLE);
}
function hollow(c, px, py, color, on) {
  c.save();
  c.globalAlpha = on ? 1 : .75;
  c.beginPath();
  c.arc(px, py, on ? 4.5 : 3, 0, Math.PI * 2);
  c.fillStyle = SURFACE;
  c.fill();
  c.lineWidth = 1.5;
  c.strokeStyle = color;
  c.stroke();
  c.restore();
}
function cloudTick(c, px, bottom, color) {
  c.save();
  c.globalAlpha = .55;
  c.strokeStyle = color;
  c.lineWidth = 1.5;
  c.beginPath();
  c.moveTo(px, bottom);
  c.lineTo(px, bottom - 5);
  c.stroke();
  c.restore();
}
function renderChart() {
  const c = chartCtx, w = state.chartWidth, h = state.chartHeight, g0 = chartGeometry(), products = chartProducts();
  c.clearRect(0, 0, w, h);
  if (chartMode === "change" || chartMode === "noise") chartBases();
  renderChartMode();
  c.font = FONT;
  c.lineWidth = 1;
  state.chartDates = [];
  state.labelHits = [];
  const mid = g0.top + (g0.bottom - g0.top) / 2, panels = products.length === 1 ? [{ product: products[0], g: g0 }] : [{ product: "temper", g: { ...g0, bottom: mid - 10 } }, { product: LR, g: { ...g0, top: mid + 12 } }];
  state.chartPanels = panels;
  const all = [...new Set(products.flatMap(p => productDates(p)))].sort(), dates = [...new Set(products.flatMap(p => focusDates(p)))].sort();
  if (!all.length) return;
  // Time runs left to right, proportionally across the chosen period, so gaps between nights show as gaps.
  const t0 = dayTime(state.rangeFrom || all[0]), t1 = dayTime(state.rangeTo || all[all.length - 1]), px = t => g0.left + (t1 > t0 ? (t - t0) / (t1 - t0) : .5) * (g0.right - g0.left), x = d => px(dayTime(d));
  const selected = dates.includes(state.date) ? state.date : null, sx = selected ? x(selected) : null;
  c.textAlign = "center";
  c.textBaseline = "alphabetic";
  c.strokeStyle = "rgba(255,255,255,.14)";
  for (const t of timeTicks(t0, t1)) {
    const tx = px(t.t);
    c.beginPath();
    c.moveTo(tx, g0.bottom);
    c.lineTo(tx, g0.bottom + 4);
    c.stroke();
    if (sx === null || Math.abs(tx - sx) > 46) {
      c.fillStyle = MUTED;
      c.fillText(t.label, tx, h - 6);
    }
  }
  if (selected) {
    c.fillStyle = INK;
    c.fillText(displayDate(selected), sx, h - 6);
  }
  state.chartDates = dates;
  state.chartX = x;
  state.chartT = [t0, t1];
  for (const panel of panels) drawPanel(c, panel, x, selected, panels.length > 1, px);
  shareChart();
}
// A metric with few or no values says so in the graph, in place of a near-empty plot that reads as zeros.
function sparseNote(c, g, product, series, dates) {
  const temp = product !== LR && state.metric === "temperature", have = series.reduce((n, s) => n + dates.filter(d => valueAt(s, d, product) !== null).length, 0), total = series.length * dates.length;
  if (!series.length || !dates.length) return;
  c.save();
  c.direction = "rtl";
  c.fillStyle = MUTED;
  if (!have) {
    c.textAlign = "center";
    c.textBaseline = "middle";
    const cx = (g.left + g.right) / 2, cy = (g.top + g.bottom) / 2;
    if (temp) {
      c.fillStyle = INK;
      c.fillText("אין טמפ׳ מקור בחלון הזה בתקופה הזו", cx, cy - 9);
      c.fillStyle = MUTED;
      c.fillText("היא נמדדת רק בלילות שבהם בחלון מקור חום מאומת, חזק בשני הערוצים. ׳מתוקן׳ מראה את הקרינה בכל לילה.", cx, cy + 9);
    } else c.fillText("אין ערכים בתקופה הזו", cx, cy);
  } else if (temp && have < total * .5) {
    c.textAlign = "right";
    c.textBaseline = "top";
    c.fillText("טמפ׳ מקור נמדדה ב־" + have + " מתוך " + total + " לילות", g.right - 6, g.top + 4);
  }
  c.restore();
}
function drawPanel(c, panel, x, selected, titled, px) {
  const { product, g } = panel, sc = panelScale(product), dates = focusDates(product);
  const gridLine = (py, strong) => {
    c.strokeStyle = strong ? "rgba(255,255,255,.14)" : "rgba(255,255,255,.06)";
    c.beginPath();
    c.moveTo(g.left, py);
    c.lineTo(g.right, py);
    c.stroke();
  };
  if (titled) {
    const hue = PRODUCT_HUE[product];
    c.save();
    c.fillStyle = hue + "0d";
    c.fillRect(g.left, g.top, g.right - g.left, g.bottom - g.top);
    c.fillStyle = hue;
    c.fillRect(g.left, g.top, 2, g.bottom - g.top);
    c.direction = "ltr";
    c.textAlign = "left";
    c.textBaseline = "top";
    c.font = "700 10px 'Segoe UI',system-ui,sans-serif";
    const name = product === LR ? "LIGHT ROAST · חשמל" : "TEMPER · חום";
    c.fillText(name, g.left + 8, g.top + 3);
    const nx = g.left + 8 + c.measureText(name).width;
    c.font = "10px 'Segoe UI',system-ui,sans-serif";
    c.fillStyle = MUTED;
    c.fillText("  " + (chartMode === "change" || chartMode === "noise" ? axisUnits(product) : product === LR ? NW : state.metric === "temperature" ? "°C" : "M10 · " + RADIANCE), nx, g.top + 3);
    c.restore();
  }
  if (!sc) {
    for (let i = 0; i < 5; i++) gridLine(g.top + (g.bottom - g.top) * i / 4, i === 4);
    sparseNote(c, g, product, visibleWindows().filter(s => seriesOf(s, product)), focusDates(product));
    return;
  }
  // The graph has its own fixed scale (Min/Max above it): independent of the image display and never refitted to the data.
  const { lo, hi } = sc, y = v => g.bottom - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo) * (g.bottom - g.top), step = niceStep(hi - lo);
  c.textAlign = "right";
  c.textBaseline = "middle";
  if (chartMode === "noise") {
    // the noise band, a grey strip, named; the ticks in multiples of the place's noise, not evenly spaced
    const top = y(squash(NOISE_BAND)), bottom = y(squash(-NOISE_BAND));
    c.save();
    c.fillStyle = "rgba(255,255,255,.07)";
    c.fillRect(g.left, top, g.right - g.left, bottom - top);
    c.fillStyle = MUTED;
    c.textAlign = "left";
    c.font = "10px 'Segoe UI',system-ui,sans-serif";
    c.fillText("רעש (±" + NOISE_BAND + ")", g.left + 6, (top + bottom) / 2);
    c.restore();
    const drawn = [];   // nearest 0 first; a tick too close to one already drawn is left out
    for (const z of [0, 2, -2, 5, -5, 10, -10, 20, -20, 50, -50, 100, -100]) {
      const v = squash(z);
      if (v < lo || v > hi) continue;
      const py = y(v);
      if (drawn.some(q => Math.abs(q - py) < 12)) continue;
      drawn.push(py);
      gridLine(py, z === 0);
      c.fillStyle = MUTED;
      c.fillText((z > 0 ? "+" : z < 0 ? "−" : "") + Math.abs(z) + (z ? "×" : ""), g.left - 10, py);
    }
  } else for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-6; v += step) {
    const py = y(v);
    gridLine(py, Math.abs(v - lo) < step * 1e-6);
    c.fillStyle = MUTED;
    c.fillText(tickText(v, product), g.left - 10, py);
  }
  // No data: before the product's first night, after its last, and gaps of more than 4 days, shaded and named, so an
  // empty stretch reads as "no data" rather than as a broken line.
  {
    const T = productDates(product).map(dayTime), [t0, t1] = state.chartT, spans = [];
    if (T.length) {
      if (T[0] - t0 > DAY) spans.push([t0, T[0]]);
      for (let i = 1; i < T.length; i++) if (T[i] - T[i - 1] > 4 * DAY) spans.push([T[i - 1], T[i]]);
      if (t1 - T[T.length - 1] > DAY) spans.push([T[T.length - 1], t1]);
    } else spans.push([t0, t1]);
    c.save();
    for (const [a, b] of spans) {
      const xa = Math.max(g.left, px(a)), xb = Math.min(g.right, px(b));
      if (xb - xa < 2) continue;
      c.fillStyle = "rgba(255,255,255,.04)";
      c.fillRect(xa, g.top, xb - xa, g.bottom - g.top);
      if (xb - xa > 70) {
        c.fillStyle = MUTED;
        c.textAlign = "center";
        c.textBaseline = "middle";
        c.fillText("אין נתונים", (xa + xb) / 2, (g.top + g.bottom) / 2);
      }
    }
    c.restore();
  }
  // "Where else": the days compared after the switch, and the switch itself (dashed).
  {
    const q = state.similar?.result;
    if (q?.mode === "event") {
      const [t0, t1] = state.chartT, a = dayTime(q.window.during[0]), b = dayTime(q.window.during[1]);
      if (b >= t0 && a <= t1) {
        const xa = Math.max(g.left, px(Math.max(a, t0))), xb = Math.min(g.right, px(Math.min(b, t1)));
        c.save();
        c.fillStyle = "rgba(236,236,239,.06)";
        c.fillRect(xa, g.top, xb - xa, g.bottom - g.top);
        if (a >= t0) {
          c.setLineDash([3, 3]);
          c.strokeStyle = "rgba(236,236,239,.45)";
          c.beginPath();
          c.moveTo(xa, g.top);
          c.lineTo(xa, g.bottom);
          c.stroke();
        }
        c.restore();
      }
    }
  }
  // The event chosen in the list: its nights, from first seen to last, shaded in its kind's colour.
  {
    const ev = state.events.active, [t0, t1] = state.chartT;
    if (ev && product === state.product && !hotMode()) {
      const a = dayTime(ev.onset), b = dayTime(ev.last || ev.onset);
      if (b >= t0 && a <= t1) {
        const xa = Math.max(g.left, px(Math.max(a, t0)) - 3), xb = Math.min(g.right, px(Math.min(b, t1)) + 3);
        c.save();
        c.fillStyle = CHANGE_KINDS[ev.kind].color + "26";
        c.fillRect(xa, g.top, xb - xa, g.bottom - g.top);
        c.restore();
      }
    }
  }
  if (!dates.length) {
    c.fillStyle = MUTED;
    c.textAlign = "center";
    c.fillText("אין לילות בתקופה הזו", (g.left + g.right) / 2, (g.top + g.bottom) / 2);
    return;
  }
  const all = shownWindows().filter(s => seriesOf(s, product)), series = visibleWindows().filter(s => seriesOf(s, product));
  if (!all.length) return;
  sparseNote(c, g, product, series, dates);
  const hover = state.chartHoverDate, dots = (g.right - g.left) / Math.max(1, dates.length - 1) >= 10, sx = selected ? x(selected) : null;
  const rule = (rx, color) => {
    c.strokeStyle = color;
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(rx, g.top);
    c.lineTo(rx, g.bottom);
    c.stroke();
  };
  if (selected) rule(sx, "rgba(236,236,239,.3)");
  if (hover && hover !== selected) rule(x(hover), "rgba(236,236,239,.14)");
  // Labels for every window (so they keep their place when one is shown alone), lines for the visible ones.
  const ends = [];
  for (const s of all) {
    const values = dates.map(d => plotValue(s, d, product)), last = values.findLastIndex(v => v !== null);
    if (last >= 0) ends.push({ s, y: y(values[last]), color: colorOf(s) });
  }
  for (const s of series) {
    const byDate = seriesOf(s, product), values = dates.map(d => plotValue(s, d, product)), color = colorOf(s), weeklyLR = product === LR && state.lr.metric === "weekly";
    // The line joins the reliable nights (a weekly median is made of reliable nights only) across partial ones; it
    // breaks where 10 days have none, and never crosses a stretch without data (more than 4 days without a night).
    const ok = dates.map((d, i) => values[i] !== null && (weeklyLR || reliable(byDate.get(d)))), holes = [0];
    for (let k = 1; k < dates.length; k++) holes.push(holes[k - 1] + (dayTime(dates[k]) - dayTime(dates[k - 1]) > 4 * DAY ? 1 : 0));
    const runs = [];
    let run = [];
    ok.forEach((good, i) => {
      if (!good) return;
      const last = run[run.length - 1];
      if (run.length && (dayTime(dates[i]) - dayTime(dates[last]) > 10 * DAY || holes[i] !== holes[last])) {
        runs.push(run);
        run = [];
      }
      run.push(i);
    });
    if (run.length) runs.push(run);
    const alone = new Set(runs.filter(r => r.length === 1).map(r => r[0])), X = i => x(dates[i]);
    if (series.length === 1) {
      const fill = c.createLinearGradient(0, g.top, 0, g.bottom);
      fill.addColorStop(0, color + "38");
      fill.addColorStop(1, color + "00");
      c.fillStyle = fill;
      for (const r of runs) {
        if (r.length < 2) continue;
        c.beginPath();
        c.moveTo(X(r[0]), g.bottom);
        r.forEach(i => c.lineTo(X(i), y(values[i])));
        c.lineTo(X(r[r.length - 1]), g.bottom);
        c.closePath();
        c.fill();
      }
    }
    c.strokeStyle = color;
    c.lineWidth = 2;
    c.lineJoin = "round";
    c.lineCap = "round";
    for (const r of runs) {
      c.beginPath();
      r.forEach((i, k) => k ? c.lineTo(X(i), y(values[i])) : c.moveTo(X(i), y(values[i])));
      c.stroke();
    }
    values.forEach((v, i) => {
      const p = byDate.get(dates[i]), on = dates[i] === selected || dates[i] === hover;
      if (v === null) {
        if (p && isCloudy(p) && (product === LR ? p.mean_nw == null || weeklyLR : p.mean == null)) cloudTick(c, X(i), g.bottom, color);
        return;
      }
      // Values past the graph's Min/Max are pinned to the edge and marked with an arrowhead.
      if (v > hi || v < lo) {
        const up = v > hi, edge = up ? g.top : g.bottom, tip = up ? -3 : 3, base = up ? 5 : -5;
        c.beginPath();
        c.moveTo(X(i), edge + tip);
        c.lineTo(X(i) - 4, edge + base);
        c.lineTo(X(i) + 4, edge + base);
        c.closePath();
        c.fillStyle = color;
        c.fill();
        return;
      }
      if (!ok[i]) {
        hollow(c, X(i), y(v), color, on);
        return;
      }
      if (dots || alone.has(i) || on) marker(c, X(i), y(v), color, on);
    });
    drawShape(c, s, product, dates, values, x, y, g);
  }
  // Direct labels at the right edge, nudged apart so they never overlap. Hovering one shows only that window; a click
  // keeps it so.
  ends.sort((a, b) => a.y - b.y);
  for (let k = 1; k < ends.length; k++) ends[k].y = Math.max(ends[k].y, ends[k - 1].y + 14);
  const over = ends.length ? ends[ends.length - 1].y - g.bottom : 0;
  if (over > 0) for (const e of ends) e.y -= over;
  const f = focused();
  c.save();
  c.textAlign = "left";
  c.textBaseline = "middle";
  for (const e of ends) {
    const shown = f == null || f === e.s.n;
    c.globalAlpha = shown ? 1 : .35;
    c.beginPath();
    c.arc(g.right + 10, e.y, shown && f != null ? 4 : 3, 0, Math.PI * 2);
    c.fillStyle = e.color;
    c.fill();
    c.fillStyle = INK;
    c.font = shown && f != null ? "700 " + FONT : FONT;
    c.fillText("#" + num(e.s), g.right + 17, e.y);
    state.labelHits.push({ n: e.s.n, x0: g.right + 2, x1: g.right + 44, y0: e.y - 8, y1: e.y + 8 });
  }
  c.restore();
}
canvas.addEventListener("wheel", e => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  zoomAt(Math.exp(-e.deltaY * .0013), e.clientX - r.left, e.clientY - r.top);
}, { passive: false });
canvas.addEventListener("pointerdown", e => {
  if (!state.meta || e.button === 2) return;
  const r = canvas.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
  state.drag = { sx, sy, lastX: sx, lastY: sy, moved: false, pan: !state.drawing || state.space || e.button === 1 };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointermove", e => {
  if (!state.meta) return;
  const r = canvas.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
  state.hover = world(sx, sy);
  state.shift = e.shiftKey;
  if (state.drag) {
    const d = state.drag;
    if (Math.hypot(sx - d.sx, sy - d.sy) > 4) d.moved = true;
    if (d.pan) {
      state.cx -= (sx - d.lastX) / state.zoom;
      state.cy += (sy - d.lastY) / state.zoom;
      if (d.moved) $("mapWrap").classList.add("panning");
    }
    d.lastX = sx;
    d.lastY = sy;
  } else {
    queryPixel(state.hover);
    canvas.classList.toggle("on-mark", !state.drawing && !!markAt(sx, sy));
  }
  coordHover(state.hover);
  renderMap();
});
// A click without dragging: a vertex while drawing; else the mark under it (as its row), or the place there.
canvas.addEventListener("pointerup", e => {
  if (!state.drag) return;
  const d = state.drag;
  state.drag = null;
  $("mapWrap").classList.remove("panning");
  if (!d.moved && !state.space) {
    const r = canvas.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top, p = world(sx, sy);
    if (state.drawing) state.vertices.push(p); else {
      const hit = markAt(sx, sy), area = state.side === "areas" ? areaAt(p) : null;
      if (hit) hit.select(e.shiftKey); else if (area) toggleArea(area, false); else {
        if (!e.shiftKey && state.events.active) {
          state.events.active = null;
          renderList();
        }
        openPlace(p, { add: e.shiftKey });
      }
    }
  }
  renderMap();
});
canvas.addEventListener("pointerleave", () => {
  state.hover = null;
  clearPixel();
  coordHover(null);
  renderMap();
});
canvas.addEventListener("pointercancel", () => {
  state.drag = null;
  state.hover = null;
  $("mapWrap").classList.remove("panning");
  clearPixel();
  renderMap();
});
canvas.addEventListener("dblclick", e => {
  e.preventDefault();
  if (state.drawing) finishDrawing();
});
// The mark under the pointer (a change, a hot spot or a related place), within 10 px.
function markAt(sx, sy) {
  let best = null, bd = 10;
  const near = (x, y, select) => {
    const [px, py] = screen(x, y), d = Math.hypot(px - sx, py - sy);
    if (d < bd) {
      bd = d;
      best = { select };
    }
  };
  if (state.side === "search" && srch.data) {
    for (const x of searchRows()) near(x.x, x.y, add => selectSearch(x, add, false));
    if (best) return best;
  }
  if (state.similar?.result) {
    const r = state.similar.result;
    for (const it of [...r.positive, ...r.negative]) near(it.x, it.y, () => {
      state.similar.active = it;
      renderSimilar();
      renderMap();
    });
  }
  if (hotMode()) {
    if (state.marks) for (const s of state.hot || []) near(s.x, s.y, add => selectHot(s, add, false));
  } else if (state.marks) for (const e of shownEvents().slice(0, 3000)) near(e.x, e.y, add => selectEvent(e, add, false));
  return best;
}
function tipNote(s, date, product, named) {
  const prefix = "#" + num(s) + (named ? " · " + (product === LR ? "LIGHT ROAST" : "TEMPER") : "") + " · ";
  if (product === LR) {
    const p = s.lrByDate.get(date);
    return prefix + (p?.mean_nw == null ? (isCloudy(p) ? "ענן, אין תצפית" : "אין תצפית שמישה") : "בלילה " + nw(p.mean_nw) + " · " + ltr(Math.round(p.coverage) + "%") + (isCloudy(p) ? " · מעונן" : ""));
  }
  const p = s.byDate.get(date);
  return prefix + (p?.mean == null ? "אין תצפית" : (p.detected ? (p.confirmed === null ? "זוהה (ללא M11) · " : "זוהה · ") : "") + (p.temperature_k ? celsius(p.temperature_k) + " · " : "") + ltr(Math.round(p.coverage) + "%") + (isCloudy(p) ? " · מעונן" : p.m15_k != null ? " · קרקע " + celsius(p.m15_k, 1) : ""));
}
// Hover: the night under the pointer is read in the row above (no box over the graph); over a #n label, only that
// window shows. Click: that night in the viewer, or on a label, keep only that window.
function labelAt(e) {
  const r = chart.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
  return state.labelHits.find(b => mx >= b.x0 && mx <= b.x1 && my >= b.y0 && my <= b.y1);
}
chart.addEventListener("mousemove", e => {
  const products = chartProducts(), dates = state.chartDates;
  if (!shownWindows().some(s => products.some(p => seriesOf(s, p))) || !dates.length) return;
  const hit = labelAt(e);
  if (hit) {
    chart.style.cursor = "pointer";
    if (state.focus !== hit.n) {
      state.labelFocus = true;
      setFocus(hit.n);
    }
    return;
  }
  if (state.labelFocus) {
    state.labelFocus = false;
    setFocus(null);
  }
  const mx = e.clientX - chart.getBoundingClientRect().left;
  let date = dates[0];
  for (const d of dates) if (Math.abs(state.chartX(d) - mx) < Math.abs(state.chartX(date) - mx)) date = d;
  chart.style.cursor = "crosshair";
  if (state.chartHoverDate !== date) {
    state.chartHoverDate = date;
    renderLegend();
    renderChart();
  }
});
chart.addEventListener("mouseleave", () => {
  if (state.labelFocus) {
    state.labelFocus = false;
    state.focus = null;
    renderMap();
  }
  state.chartHoverDate = null;
  renderLegend();
  renderChart();
});
// A click opens that night on the map, a moment later, so that a double-click (back to everything) does not.
let chartClickTimer = null;
chart.addEventListener("click", e => {
  if (chartDragged) {
    chartDragged = false;
    return;
  }
  const hit = labelAt(e);
  if (hit) {
    togglePin(hit.n);
    return;
  }
  const d = state.chartHoverDate;
  if (!d) return;
  clearTimeout(chartClickTimer);
  chartClickTimer = setTimeout(() => {
    if (CHART_TAB) channel?.postMessage({ type: "day", date: d }); else setDay(d);
  }, 230);
});
// The bottom panel's height: drag its top edge (or arrow keys on it; double-click resets), or ⤢ to give the graph the
// whole stage. Remembered on this computer.
function seriesHeight(px) {
  const stage = document.querySelector(".stage");
  if (px == null) {
    stage.style.removeProperty("--series-h");
    try {
      localStorage.removeItem("series-height");
    } catch { }
    return;
  }
  px = Math.round(Math.max(180, Math.min(stage.clientHeight - 140, px)));
  stage.style.setProperty("--series-h", px + "px");
  try {
    localStorage.setItem("series-height", px);
  } catch { }
}
{
  let saved = 0;
  try {
    saved = Number(localStorage.getItem("series-height")) || 0;
  } catch { }
  if (saved > 0) document.querySelector(".stage").style.setProperty("--series-h", saved + "px");
}
function setChartMax(on) {
  document.querySelector(".stage").classList.toggle("max", on);
  if (on) document.querySelector(".stage").classList.remove("min");
  $("chartMax").classList.toggle("active", on);
  $("chartMax").setAttribute("aria-pressed", on);
  $("chartMax").title = on ? "חזרה למפה" : "הגרף על כל השטח";
}
$("seriesResize").addEventListener("pointerdown", e => {
  e.preventDefault();
  setChartMax(false);
  const y0 = e.clientY, h0 = $("seriesPanel").getBoundingClientRect().height, move = ev => seriesHeight(h0 + y0 - ev.clientY), up = () => {
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", up);
    document.body.classList.remove("resizing");
  };
  document.body.classList.add("resizing");
  addEventListener("pointermove", move);
  addEventListener("pointerup", up);
});
$("seriesResize").ondblclick = () => seriesHeight(null);
$("seriesResize").onkeydown = e => {
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
  e.preventDefault();
  seriesHeight($("seriesPanel").getBoundingClientRect().height + (e.key === "ArrowUp" ? 40 : -40));
};
$("chartMax").onclick = () => setChartMax(!document.querySelector(".stage").classList.contains("max"));
// In its own window the graph leaves this page, and the map takes the space; it comes back when that window closes
// or with "החזרה לכאן".
let popTimer = null;
function setPopped(tab) {
  state.popped = tab || null;
  document.querySelector(".stage").classList.toggle("popped", !!tab);
  $("popBar").hidden = !tab;
  $("mapTip").hidden = !!tab || state.windows.length > 0 || state.drawing;
  clearInterval(popTimer);
  if (tab) popTimer = setInterval(() => {
    if (!state.popped || state.popped.closed) setPopped(null);
  }, 800);
}
$("chartPop").onclick = () => {
  const tab = window.open(location.pathname + "?chart=1", "temper-chart", "popup,width=980,height=480");
  if (!tab) {
    toast("הדפדפן חסם את פתיחת החלון.");
    return;
  }
  shareChart(true);
  tab.focus();
  setPopped(tab);
};
$("popBack").onclick = () => {
  const tab = state.popped;
  setPopped(null);
  try {
    tab?.close();
  } catch { }
};
// Minimized: only the row of values stays, under the map.
function setChartMin(on) {
  document.querySelector(".stage").classList.toggle("min", on);
  $("chartMin").classList.toggle("active", on);
  $("chartMin").setAttribute("aria-pressed", on);
  $("chartMin").title = on ? "החזרת הגרף" : "מזעור: רק שורת הערכים";
  if (on) setChartMax(false);
}
$("chartMin").onclick = () => setChartMin(!document.querySelector(".stage").classList.contains("min"));
// Mirror to the graph tab: what it needs to draw the same graph. Sent when something it shows changes.
let shareSig = "", shareTimer = null, windowsVersion = 0;
function snapshot() {
  return {
    type: "state", metaId: state.meta?.id, product: state.product, compare: state.compare, metric: state.metric, band: state.band, lrMetric: state.lr.metric, date: state.date,
    rangeFrom: state.rangeFrom, rangeTo: state.rangeTo, chartLow: state.chartLow, chartHigh: state.chartHigh, scales: state.scales, chartMode, chartRef, graphPalette, windowsVersion,
    windows: state.windows.map(w => ({
      n: w.n, slot: w.slot, center: w.center, size: w.size, name: w.name, kept: !!w.kept, hidden: !!w.hidden, color: w.color || null, shapes: { temper: shapeOf(w, "temper"), lightroast: shapeOf(w, LR) }, areaId: w.areaId, geometry: w.geometry, lonlat: w.lonlat, clipped: w.clipped, loading: w.loading, result: w.result, lr: w.lr
    }))
  };
}
function shareChart(force) {
  if (CHART_TAB || !channel || !state.meta) return;
  if (force) shareSig = "";
  clearTimeout(shareTimer);
  shareTimer = setTimeout(() => {
    const s = snapshot(), sig = JSON.stringify({ ...s, windows: s.windows.map(w => w.n + ":" + w.loading + ":" + (w.color || "")) });
    if (sig === shareSig) return;
    shareSig = sig;
    channel.postMessage(s);
  }, 150);
}
// From the graph's own window: a night, its window closing, and its zoom (period and scales).
if (channel && !CHART_TAB) channel.onmessage = e => {
  const m = e.data;
  if (m.type === "hello") shareChart(true);
  if (m.type === "day" && state.meta) setDay(m.date);
  if (m.type === "bye") setPopped(null);
  if (m.type === "range") {
    $("rangeFrom").value = m.from;
    $("rangeTo").value = m.to;
    setRange();
    clearTimeout(rangeTimer);
    rangeTimer = setTimeout(periodChanged, 600);
  }
  if (m.type === "scale") {
    if (m.product === state.product) {
      setChartScale(m.lo, m.hi);
      state.chartAuto = false;
    } else {
      state.scales[m.product] = { lo: m.lo, hi: m.hi, auto: false };
      renderChart();
    }
  }
  if (m.type === "fit") resetChartZoom(true);
};
// In the graph tab: everything comes from the main page; clicks on a night go back to it.
function startChartTab() {
  document.body.classList.add("chart-tab");
  let hide = false;   // how to read it, until closed (remembered)
  try {
    hide = localStorage.getItem("viewer-chart-guide") === "0";
  } catch { }
  $("chartGuide").hidden = hide;
  $("chartGuideClose").onclick = () => {
    $("chartGuide").hidden = true;
    try {
      localStorage.setItem("viewer-chart-guide", "0");
    } catch { }
  };
  document.querySelector(".stage").classList.remove("no-place");
  if (!channel) {
    toast("הדפדפן לא תומך בלשונית גרף.");
    return;
  }
  addEventListener("pagehide", () => channel.postMessage({ type: "bye" }));
  channel.onmessage = async (e) => {
    const s = e.data;
    if (s.type !== "state") return;
    if (!state.meta || state.meta.id !== s.metaId) {
      try {
        state.meta = await api("/api/metadata");
      } catch {
        return;
      }
      if (state.meta.id !== s.metaId) return;
    }
    applySnapshot(s);
  };
  channel.postMessage({ type: "hello" });
}
function applySnapshot(s) {
  state.product = s.product;
  applyProductUI();
  state.compare = s.compare;
  state.metric = s.metric;
  state.band = s.band;
  state.lr.metric = s.lrMetric;
  state.date = s.date;
  state.rangeFrom = s.rangeFrom;
  state.rangeTo = s.rangeTo;
  state.chartLow = s.chartLow;
  state.chartHigh = s.chartHigh;
  state.scales = { ...s.scales };
  chartMode = s.chartMode || "fixed";
  chartRef = s.chartRef ?? null;
  setGraphPalette(s.graphPalette || "default", false);
  state.windows = s.windows.map(w => {
    const x = { ...w, nonce: 0 };
    if (w.result) x.byDate = new Map(w.result.points.map(p => [p.date, p]));
    if (w.lr) {
      x.lrByDate = new Map(w.lr.points.map(p => [p.date, p]));
      x.lrWeekly = weekly(x.lrByDate);
    }
    return x;
  });
  compareUI();
  $("seriesUnits").textContent = axisUnits();
  document.title = countryName(state.meta) + " · " + (comparing() ? "TEMPER + LIGHT ROAST" : isLR() ? "LIGHT ROAST" : "TEMPER");
  const keep = { ...state.scales };
  windowsChanged();
  state.scales = keep;
  renderChart();
}
function setRange() {
  let from = $("rangeFrom").value, to = $("rangeTo").value;
  if (from && to && from > to) {
    [from, to] = [to, from];
    $("rangeFrom").value = from;
    $("rangeTo").value = to;
  }
  state.rangeFrom = from;
  state.rangeTo = to;
  state.chartHoverDate = null;
  renderChart();
}
$("rangeFrom").onchange = () => {
  setRange();
  if (state.similar) runSimilar();
  for (const w of state.windows) analyzeArea(w);
};
$("rangeTo").onchange = () => {
  setRange();
  if (state.similar) runSimilar();
  for (const w of state.windows) analyzeArea(w);
};
$("rangeAll").onclick = () => {
  $("rangeFrom").value = "";
  $("rangeTo").value = "";
  setRange();
  if (state.similar) runSimilar();
  for (const w of state.windows) analyzeArea(w);
};
function readChartScale() {
  const lowText = $("chartLow").value, highText = $("chartHigh").value, low = lowText === "" ? 0 : Number(lowText), high = Number(highText);
  const restore = () => {
    if (state.chartHigh !== null) {
      $("chartLow").value = +state.chartLow.toPrecision(6);
      $("chartHigh").value = +state.chartHigh.toPrecision(6);
    }
  };
  if (highText === "") {
    restore();
    return;
  }
  if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) {
    toast("המקסימום חייב להיות גדול מהמינימום.");
    restore();
    return;
  }
  setChartScale(low, high);
  state.chartAuto = false;
}
$("chartLow").onchange = readChartScale;
$("chartHigh").onchange = readChartScale;
$("chartFit").onclick = () => fitChart(false);
function setMetric(m) {
  if (state.metric === m) return;
  state.metric = m;
  $("metricCorrected").classList.toggle("active", m === "corrected");
  $("metricRaw").classList.toggle("active", m === "mean");
  $("metricTemp").classList.toggle("active", m === "temperature");
  $("seriesUnits").textContent = unitsFor();
  if (state.product === "temper") {
    state.chartLow = state.chartHigh = null;
    $("chartLow").value = $("chartHigh").value = "";
    fitChart(true);
  } else state.scales.temper = null;
  renderLegend();
  renderChart();
}
$("metricCorrected").onclick = () => setMetric("corrected");
$("metricRaw").onclick = () => setMetric("mean");
$("metricTemp").onclick = () => setMetric("temperature");
function setLightMetric(m) {
  if (state.lr.metric === m) return;
  state.lr.metric = m;
  $("lrMetricWeekly").classList.toggle("active", m === "weekly");
  $("lrMetricNightly").classList.toggle("active", m === "nightly");
  if (isLR()) {
    state.chartLow = state.chartHigh = null;
    $("chartLow").value = $("chartHigh").value = "";
    fitChart(true);
  } else state.scales[LR] = null;
  renderLegend();
  renderChart();
}
$("lrMetricWeekly").onclick = () => setLightMetric("weekly");
$("lrMetricNightly").onclick = () => setLightMetric("nightly");
$("compareToggle").onclick = () => {
  if (!lrMeta()) {
    toast("אין נתוני אורות למדינה הזו.");
    return;
  }
  setCompare(!state.compare);
};
// ---------- the graph by mouse ----------
// The wheel zooms time around the pointer (with Shift, the values of the panel under it), dragging pans in time and a
// double-click shows everything again. The time zoom is the period (From/To), so related places and the area
// analysis follow it once the zoom settles. In the graph's own window the zoom goes back to the page.
let rangeTimer = null, chartDrag = null, chartDragged = false;
function periodChanged() {
  if (state.similar) runSimilar();
  for (const w of state.windows) analyzeArea(w);
}
function chartSpanAll() {
  const all = [...new Set(chartProducts().flatMap(p => productDates(p)))].sort();
  return all.length ? [dayTime(all[0]), dayTime(all[all.length - 1])] : null;
}
function isoDay(t) {
  return new Date(Math.round(t / DAY) * DAY).toISOString().slice(0, 10);
}
function setChartWindow(t0, t1) {
  const span = chartSpanAll();
  if (!span) return;
  let a = t0, b = t1;
  const min = 5 * DAY;
  if (b - a < min) {
    const m = (a + b) / 2;
    a = m - min / 2;
    b = m + min / 2;
  }
  if (b - a >= span[1] - span[0]) {
    a = span[0];
    b = span[1];
  }
  if (a < span[0]) {
    b += span[0] - a;
    a = span[0];
  }
  if (b > span[1]) {
    a -= b - span[1];
    b = span[1];
  }
  const full = a <= span[0] + DAY / 2 && b >= span[1] - DAY / 2, from = full ? "" : isoDay(a), to = full ? "" : isoDay(b);
  if (from === state.rangeFrom && to === state.rangeTo) return;
  state.rangeFrom = from;
  state.rangeTo = to;
  $("rangeFrom").value = from;
  $("rangeTo").value = to;
  state.chartHoverDate = null;
  renderChart();
  if (CHART_TAB) {
    channel?.postMessage({ type: "range", from, to });
    return;
  }
  clearTimeout(rangeTimer);
  rangeTimer = setTimeout(periodChanged, 600);
}
function zoomValues(my, f) {
  const p = state.chartPanels.find(q => my >= q.g.top - 6 && my <= q.g.bottom + 6);
  if (!p) return;
  if (chartMode === "change") {
    toast("בתצוגת ׳שינוי׳ הסקאלה מתאימה את עצמה; לזום ידני בערכים עברו ל׳קבועה׳.");
    return;
  }
  const sc = panelScale(p.product);
  if (!sc) return;
  if (chartMode === "view") setChartMode("fixed");
  const { lo, hi } = sc, g = p.g;
  const vp = lo + (g.bottom - Math.max(g.top, Math.min(g.bottom, my))) / (g.bottom - g.top) * (hi - lo), nlo = vp - (vp - lo) * f, nhi = vp + (hi - vp) * f;
  if (!(nhi - nlo > 1e-12)) return;
  if (p.product === state.product) {
    setChartScale(nlo, nhi);
    state.chartAuto = false;
  } else {
    state.scales[p.product] = { lo: nlo, hi: nhi, auto: false };
    renderChart();
  }
  if (CHART_TAB) channel?.postMessage({ type: "scale", product: p.product, lo: nlo, hi: nhi });
}
function resetChartZoom(fromTab) {
  state.rangeFrom = state.rangeTo = "";
  $("rangeFrom").value = $("rangeTo").value = "";
  state.chartLow = state.chartHigh = null;
  for (const p of ["temper", LR]) if (p !== state.product) state.scales[p] = null;
  fitChart(true);
  renderChart();
  if (CHART_TAB) {
    channel?.postMessage({ type: "fit" });
    return;
  }
  if (!fromTab) {
    clearTimeout(rangeTimer);
    rangeTimer = setTimeout(periodChanged, 300);
  } else periodChanged();
}
chart.addEventListener("wheel", e => {
  if (!state.chartT || !state.windows.length) return;
  e.preventDefault();
  const r = chart.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top, dy = e.deltaY || e.deltaX, f = Math.exp(Math.max(-1, Math.min(1, dy * .0015)));
  {
    const g = chartGeometry(), [a, b] = state.chartT;
    if (my > g.bottom + 2) {
      const shift = Math.sign(dy) * (b - a) * .08;
      setChartWindow(a + shift, b + shift);
      return;
    }
  } // over the dates: move in time
  if (e.shiftKey) {
    zoomValues(my, f);
    return;
  }
  const g = chartGeometry(), [t0, t1] = state.chartT, tp = t0 + (Math.max(g.left, Math.min(g.right, mx)) - g.left) / (g.right - g.left) * (t1 - t0);
  setChartWindow(tp - (tp - t0) * f, tp + (t1 - tp) * f);
}, { passive: false });
chart.addEventListener("pointerdown", e => {
  if (e.button !== 0 || !state.chartT || labelAt(e)) return;
  chartDrag = { x: e.clientX, t: [...state.chartT], moved: false, id: e.pointerId };
});
chart.addEventListener("pointermove", e => {
  if (!chartDrag) return;
  const dx = e.clientX - chartDrag.x;
  if (!chartDrag.moved && Math.abs(dx) > 4) {
    chartDrag.moved = true;
    chart.setPointerCapture(chartDrag.id);
  }
  if (!chartDrag.moved) return;
  const g = chartGeometry(), [t0, t1] = chartDrag.t, dt = -dx / (g.right - g.left) * (t1 - t0);
  chart.style.cursor = "grabbing";
  setChartWindow(t0 + dt, t1 + dt);
});
chart.addEventListener("pointerup", () => {
  if (chartDrag?.moved) chartDragged = true;
  chartDrag = null;
});
chart.addEventListener("dblclick", () => {
  clearTimeout(chartClickTimer);
  resetChartZoom();
});
for (const id of ["rangeFrom", "rangeTo"]) wheelSteps($(id), (n, e) => {
  const el = $(id), span = state.chartT, base = el.value ? dayTime(el.value) : span ? span[id === "rangeFrom" ? 0 : 1] : null;
  if (base == null) return;
  el.value = isoDay(base + n * (e.shiftKey ? 7 : 1) * DAY);
  setRange();
  if (CHART_TAB) {
    channel?.postMessage({ type: "range", from: state.rangeFrom, to: state.rangeTo });
    return;
  }
  clearTimeout(rangeTimer);
  rangeTimer = setTimeout(periodChanged, 600);
});
