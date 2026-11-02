"use strict";
// Places: up to four sampled windows (their colours, numbers and chips), their nightly series, and the area card
// (how consistent the place is, light against heat).

function colorOf(w) {
  return w.color || WINDOW_COLORS[w.slot];
}
// The places' colours, chosen by the user: a palette for all four, and any place's own colour (its chip's dot: a swatch,
// or any colour from the picker). Kept on this computer. No orange and no blue in any palette or swatch: those are the
// products' own colours (TEMPER heat, LIGHT ROAST light). Every palette is checked on the dark surface for every pair
// (dataviz validate_palette.js, --pairs all): default, jewel, berry, pastel and contrast pass colour-blind separation
// (ΔE >= 8) and the normal-vision floor (>= 15); rainbow, soft and neon are in the 6-8 band, legal because each line
// also carries its #n label.
const GRAPH_PALETTES = {
  default: { colors: ["#22c55e", "#ec4899", "#a855f7", "#facc15"] },
  jewel: { colors: ["#10b981", "#e11d48", "#8b5cf6", "#eab308"] },
  rainbow: { colors: ["#ef4444", "#facc15", "#22c55e", "#a855f7"] },
  soft: { colors: ["#fb7185", "#fde047", "#4ade80", "#c084fc"] },
  berry: { colors: ["#f43f5e", "#d946ef", "#84cc16", "#f8fafc"] },
  pastel: { colors: ["#4ade80", "#f472b6", "#c4b5fd", "#fef9c3"] },
  neon: { colors: ["#ff2e88", "#f5ff52", "#2eff8c", "#c04dff"] },
  contrast: { colors: ["#ffffff", "#ff3b6b", "#b6ff3b", "#d580ff"] }
};
const RAINBOW = ["#ef4444", "#e11d48", "#f43f5e", "#fb7185", "#ec4899", "#f472b6", "#d946ef", "#c026d3", "#a855f7", "#8b5cf6", "#c4b5fd",
  "#facc15", "#fde047", "#d9f99d", "#a3e635", "#84cc16", "#22c55e", "#4ade80", "#10b981", "#86efac", "#f3f4f6", "#a1a1aa"];
// Near TEMPER's orange or LIGHT ROAST's blue (by hue): allowed from the picker, with a word of warning.
function productHue(hex) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (d < .12) return null;
  const h = (mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60;
  return h >= 14 && h <= 46 ? "temper" : h >= 192 && h <= 238 ? "lightroast" : null;
}
let graphPalette = "default";
function setGraphPalette(name, save = true) {
  graphPalette = GRAPH_PALETTES[name] ? name : "default";
  WINDOW_COLORS.splice(0, WINDOW_COLORS.length, ...GRAPH_PALETTES[graphPalette].colors);
  if (save) try {
    localStorage.setItem("viewer-graph-palette", graphPalette);
  } catch { }
}
try {
  setGraphPalette(localStorage.getItem("viewer-graph-palette") || "default", false);
} catch { }
function renderPalettes() {
  const box = $("paletteList");
  box.replaceChildren();
  for (const [key, p] of Object.entries(GRAPH_PALETTES)) {
    const b = mk("button", "palette-row" + (key === graphPalette ? " active" : ""));
    b.type = "button";
    const sw = mk("span", "swatches");
    for (const c of p.colors) {
      const i = mk("i");
      i.style.setProperty("--c", c);
      sw.append(i);
    }
    b.append(sw);
    b.onclick = () => {
      setGraphPalette(key);
      for (const w of state.windows) delete w.color;   // a palette for all: the places' own colours give way
      renderPalettes();
      windowsChanged();
    };
    box.append(b);
  }
}
$("paletteButton").onclick = e => {
  e.stopPropagation();
  const pop = $("palettePop");
  pop.hidden = !pop.hidden;
  if (!pop.hidden) {
    renderPalettes();
    const r = $("paletteButton").getBoundingClientRect();
    pop.style.top = Math.round(r.bottom + 6) + "px";
    pop.style.left = Math.round(Math.max(8, Math.min(innerWidth - pop.offsetWidth - 8, r.left))) + "px";
  }
};
// One place's own colour, from its chip's dot.
function pickColor(w, dot) {
  const pop = $("swatchPop");
  pop.replaceChildren();
  for (const c of [...new Set([...RAINBOW, ...WINDOW_COLORS])]) {
    const b = mk("button", "swatch" + (colorOf(w) === c ? " active" : ""));
    b.type = "button";
    b.style.setProperty("--c", c);
    b.title = c;
    b.onclick = () => {
      w.color = c;
      pop.hidden = true;
      windowsChanged();
    };
    pop.append(b);
  }
  const custom = mk("label", "swatch-custom"), input = mk("input"), warn = mk("small", "swatch-warn");
  input.type = "color";
  input.value = /^#[0-9a-f]{6}$/i.test(colorOf(w)) ? colorOf(w) : "#22c55e";
  const hue = () => {
    const p = productHue(input.value);
    warn.textContent = p ? (p === "temper" ? "קרוב לכתום של TEMPER" : "קרוב לכחול של LIGHT ROAST") : "";
  };
  input.oninput = () => {
    w.color = input.value;
    hue();
    windowsChanged();
  };
  custom.append(input, mk("span", null, "צבע אחר…"));
  custom.title = "כל צבע, מבוחר הצבעים";
  pop.append(custom, warn);
  const reset = mk("button", "link swatch-reset", "צבע הפלטה");
  reset.type = "button";
  reset.onclick = () => {
    delete w.color;
    pop.hidden = true;
    windowsChanged();
  };
  pop.append(reset);
  pop.hidden = false;
  const r = dot.getBoundingClientRect();
  pop.style.top = Math.round(r.bottom + 8) + "px";
  pop.style.left = Math.round(Math.max(8, Math.min(innerWidth - pop.offsetWidth - 8, r.left - 12))) + "px";
}
document.addEventListener("pointerdown", e => {
  if (!$("palettePop").hidden && !e.target.closest("#palettePop, #paletteButton")) $("palettePop").hidden = true;
  if (!$("swatchPop").hidden && !e.target.closest("#swatchPop, .win-chip > i") && e.target.type !== "color") $("swatchPop").hidden = true;
});
// A place's number on the map, its chip and the graphs: its colour's slot, so the numbers follow the places shown.
function num(w) {
  return w.slot + 1;
}
// Showing one window: hovering its chip or its #n in the graph (focus), or clicking either (pinned, until clicked again
// or Esc). The other windows' lines are hidden and their squares on the map faded.
function focused() {
  return state.focus ?? state.pinned;
}
// A personal area toggled off stays loaded but hidden (hidden): out of the graphs, the chips and the map.
function shownWindows() {
  return state.windows.filter(w => !w.hidden);
}
function visibleWindows() {
  const f = focused(), list = shownWindows();
  return f == null ? list : list.filter(w => w.n === f);
}
function markChips() {
  renderAreaCard();
  syncSize();
  const f = focused();
  for (const el of document.querySelectorAll("#seriesLegend .win-chip")) {
    const n = Number(el.dataset.n);
    el.classList.toggle("muted", f != null && n !== f);
    el.classList.toggle("pinned", state.pinned === n);
    el.setAttribute("aria-pressed", state.pinned === n);
  }
}
function setFocus(n) {
  if (state.focus === n) return;
  state.focus = n;
  markChips();
  renderChart();
  renderMap();
}
function togglePin(n) {
  state.pinned = state.pinned === n ? null : n;
  state.focus = null;
  state.labelFocus = false;
  markChips();
  renderChart();
  renderMap();
}
// Places: up to four at once, each in its own colour on the map, its chip and both graphs. A click (on the map, a row
// or a mark) shows that place in place of the one shown last, unless that one was kept; Shift+click adds a place and
// keeps the others, so a hot place and a cold one sit on one chart.
function nextSlot() {
  return state.windows.length >= MAX_WINDOWS ? state.windows[0].slot : [0, 1, 2, 3].find(i => !state.windows.some(w => w.slot === i));
}
let placeKm = 15;
function placeSize() {
  return placeKm;
}
// A fifth place replaces a hidden one first, else the oldest. An area's series are kept (areaCache), so opening it again
// is instant; a place worked out ahead (opts.prepared: its two series and its area analysis, the tour's lab) is too.
const areaCache = new Map();
function cacheStamp() {
  return state.meta?.id + ":" + productDates("temper").length + ":" + productDates(LR).length;
}
function addWindow(center, size, opts = {}) {
  let slot = opts.slot;
  if (state.windows.length >= MAX_WINDOWS) {
    const i = Math.max(0, state.windows.findIndex(w => w.hidden)), [gone] = state.windows.splice(i, 1);
    slot ??= gone.slot;
  }
  slot ??= nextSlot();
  const w = {
    n: opts.n ?? ++state.windowCount, slot, center: [...center], size: size || placeSize(), kept: !!opts.kept, areaId: opts.areaId || null, name: opts.name || null, geometry: opts.geometry || null, lonlat: projectedLonLat(center), result: null, byDate: null, loading: true, nonce: 0
  };
  const ready = opts.prepared, kept = ready ? { size: w.size, stamp: cacheStamp(), result: ready.temper || null, lr: ready.lightroast || null, area: ready.area || null, clipped: false } : w.areaId && areaCache.get(w.areaId);
  if (kept && kept.size === w.size && kept.stamp === cacheStamp()) {
    Object.assign(w, { result: kept.result, lr: kept.lr, clipped: kept.clipped, area: kept.area, loading: false });
    if (w.result) {
      w.byDate = new Map(w.result.points.map(p => [p.date, p]));
      w.lonlat = w.result.lonlat;
    }
    if (w.lr) {
      w.lrByDate = new Map(w.lr.points.map(p => [p.date, p]));
      w.lrWeekly = weekly(w.lrByDate);
      w.lonlat = w.lonlat || w.lr.lonlat;
    }
    state.windows.push(w);
    if (state.chartHigh === null || state.chartAuto) fitChart(true);
    windowsChanged();
    if (!w.area) analyzeArea(w);
    return w;
  }
  state.windows.push(w);
  windowsChanged();
  sampleWindow(w);
  return w;
}
function openPlace(center, opts = {}) {
  if (!inImage(center)) {
    toast("הנקודה מחוץ לתמונה.");
    return;
  }
  const last = state.windows[state.windows.length - 1], a = opts.area, area = a ? { areaId: a.id, name: a.name, geometry: a.geometry || null } : {};
  if (opts.prepared) area.prepared = opts.prepared;   // worked out ahead (the tour's lab): nothing to ask the server
  if (opts.add) {
    for (const w of state.windows) w.kept = true;
    addWindow(center, opts.size, { kept: true, ...area });
    return;
  }
  if (last && !last.kept) {
    state.windows.pop();
    if (state.pinned === last.n) state.pinned = null;
    if (state.focus === last.n) state.focus = null;
    addWindow(center, opts.size, { slot: last.slot, n: last.n, ...area });
    return;
  }
  addWindow(center, opts.size, area);
}
// A cluster from the list (a change or a hot spot): a window just around it, in both graphs.
function clusterSize(e) {
  return Math.max(2.25, Math.ceil((Math.sqrt(e?.area_km2 || 0) + 1.5) / .75) * .75);
}
function openCluster(e, add) {
  openPlace([e.x, e.y], { size: clusterSize(e.detail || e), add });
  if (lrMeta() && !state.compare) setCompare(true);
}
function removeWindow(w) {
  state.windows = state.windows.filter(x => x !== w);
  if (state.chartAuto && state.windows.length) fitChart(true);
  if (state.pinned === w.n) state.pinned = null;
  if (state.focus === w.n) state.focus = null;
  windowsChanged();
}
// The size control follows the place shown (pinned or hovered, else the last); changing it resizes that place.
function syncSize() {
  const w = cardWindow(), v = String(w ? w.size : placeKm), sel = $("windowSize");
  if (![...sel.options].some(o => o.value === v)) {
    sel.querySelector("option.extra")?.remove();
    const o = document.createElement("option");
    o.className = "extra";
    o.value = v;
    o.textContent = (+(+v).toFixed(2)) + " ק״מ";
    sel.append(o);
  }
  sel.value = v;
}
// A window holds both products' series for the same cells: TEMPER (result, byDate) and LIGHT ROAST (lr, lrByDate,
// and lrWeekly: the median of the reliable nights among the 7 calendar nights ending at each night, since one night
// varies ~±50%; see reliable). Only on nights that were themselves observed, and from at least WEEK_MIN of them, as
// the server's change detection (lightroast.MIN_RECENT). Drawn on a cloudy night, the median was made only of the
// nights before it: on 12-14 Sep 2026 near 17.48 N 47.16 E it rose to its highest (25.9 nW, from 2-3 nights) while
// the place was under cloud, just before the lights there dropped to ~4 nW.
const WEEK_MIN = 3;
function weekly(byDate) {
  const out = new Map(), dates = [...byDate.keys()].sort();
  for (const d of dates) {
    if (!reliable(byDate.get(d))) {
      out.set(d, null);
      continue;
    }
    const t = dayTime(d), v = [];
    for (const x of dates) {
      const dt = t - dayTime(x);
      if (dt < 0) break;
      if (dt < 7 * DAY) {
        const p = byDate.get(x), m = p.mean_nw;
        if (m != null && reliable(p)) v.push(m);
      }
    }
    v.sort((a, b) => a - b);
    out.set(d, v.length >= WEEK_MIN ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null);
  }
  return out;
}
async function sampleWindow(w) {
  const nonce = ++w.nonce, first = !w.result && !w.lr;
  w.loading = true;
  renderLegend();
  try {
    const polygons = w.geometry ? [w.geometry] : $("sampleClip").checked ? activeGeometries() : null;
    if (polygons && polygons.length === 0) throw Error("אין שכבה פעילה. הפעילו שכבה או כבו את ׳רק בתוך השכבות׳.");
    const body = { x: w.center[0], y: w.center[1], size_km: w.size, polygons };
    const [temper, lights] = await Promise.allSettled([api("/api/series", body), lrMeta() ? api("/api/lr/series", body) : Promise.resolve(null)]);
    if (nonce !== w.nonce) return;
    w.clipped = !!polygons;
    if (temper.status === "fulfilled") {
      const result = temper.value;
      w.result = result;
      w.lonlat = result.lonlat;
      w.byDate = new Map(result.points.map(p => [p.date, p]));
    } else {
      w.result = null;
      w.byDate = null;
    }
    if (lights.status === "fulfilled" && lights.value) {
      w.lr = lights.value;
      w.lonlat = w.lonlat || w.lr.lonlat;
      w.lrByDate = new Map(w.lr.points.map(p => [p.date, p]));
      w.lrWeekly = weekly(w.lrByDate);
    } else {
      w.lr = null;
      w.lrByDate = null;
      w.lrWeekly = null;
    }
    const failed = [temper, lights].find(r => r.status === "rejected");
    if (!w.result && !w.lr) throw failed ? failed.reason : Error("אין נתונים לחלון.");
    if (failed) toast(failed.reason.message);
    if (w.areaId) areaCache.set(w.areaId, { size: w.size, stamp: cacheStamp(), result: w.result, lr: w.lr, clipped: w.clipped, area: null });
    if (state.chartHigh === null || state.chartAuto) fitChart(true);
    analyzeArea(w);
  } catch (e) {
    if (nonce !== w.nonce) return;
    toast(e.message);
    if (first) state.windows = state.windows.filter(x => x !== w);
  }
  w.loading = false;
  windowsChanged();
}
// The value a window shows on a night for a product's chart metric.
function seriesOf(w, product = state.product) {
  return product === LR ? w.lrByDate : w.byDate;
}
function valueAt(w, d, product = state.product) {
  if (product === LR) {
    const p = w.lrByDate?.get(d);
    if (!p) return null;
    return state.lr.metric === "weekly" ? (w.lrWeekly?.get(d) ?? null) : p.mean_nw;
  }
  return metricOf(w.byDate?.get(d));
}
function valueText(v, product = state.product) {
  return product === LR ? nw(v) : metricText(v);
}
function unitsFor(product = state.product) {
  return product === LR ? NW : state.metric === "temperature" ? "°C" : RADIANCE;
}
function resampleAll() {
  for (const w of state.windows) sampleWindow(w);
}
// The place drawer under the map shows while a place is open; the map takes the whole stage otherwise.
function windowsChanged() {
  windowsVersion++;
  queueMicrotask(renderAreaCard);
  for (const p of ["temper", LR]) if (state.scales[p]?.auto) state.scales[p] = null;
  state.chartHoverDate = null;
  const has = shownWindows().length > 0;
  if (!CHART_TAB) document.querySelector(".stage").classList.toggle("no-place", !has);
  $("chartEmpty").hidden = has;
  $("mapTip").hidden = has || state.drawing || !!state.popped;
  if (state.side === "areas") renderAreas();
  $("exportCsv").disabled = !state.windows.some(w => seriesOf(w));
  syncSize();
  renderLegend();
  renderMap();
  renderChart();
}
// The row above the graph is its readout: the night being read (under the pointer, or the shown night) and a chip per
// window with its values that night, fixed in place so nothing covers the graph.
function flagText(p, product) {
  if (!p) return "";
  if (product === LR) {
    if (p.mean_nw == null) return isCloudy(p) ? "ענן" : "אין תצפית";
    return reliable(p) ? "" : isCloudy(p) ? "מעונן" : "חלקי " + Math.round(p.coverage) + "%";
  }
  if (p.mean == null) return "אין תצפית";
  return [p.detected ? "זוהה" : "", isCloudy(p) ? "מעונן" : reliable(p) ? "" : "חלקי"].filter(Boolean).join(" · ");
}
function renderLegend() {
  const box = $("seriesLegend");
  box.replaceChildren();
  if (!state.windows.length) {
    if (typeof renderNextSteps === "function") renderNextSteps();
    return;
  }
  const date = state.chartHoverDate || state.date, products = chartProducts(), f = focused();
  if (date) {
    const pill = document.createElement("span");
    pill.className = "read-date" + (state.chartHoverDate ? " hover" : "");
    pill.textContent = displayDate(date, true);
    pill.title = state.chartHoverDate ? "הלילה שמתחת לסמן" : "הלילה המוצג";
    box.append(pill);
  }
  for (const w of shownWindows()) {
    const chip = document.createElement("span"), dot = document.createElement("i"), id = document.createElement("b"), where = document.createElement("span"), remove = document.createElement("button"), tips = [];
    chip.className = "win-chip" + (w.loading ? " loading" : "") + (state.pinned === w.n ? " pinned" : "") + (f != null && f !== w.n ? " muted" : "");
    chip.dataset.n = w.n;
    chip.style.setProperty("--c", colorOf(w));
    chip.tabIndex = 0;
    chip.setAttribute("role", "button");
    chip.setAttribute("aria-pressed", state.pinned === w.n);
    id.textContent = "#" + num(w);
    where.textContent = w.name || km(w.size) + (w.clipped ? " · בשכבות" : "");
    chip.append(dot, id, where);
    if (!CHART_TAB) {
      dot.title = "צבע המקום";
      dot.onclick = e => {
        e.stopPropagation();
        pickColor(w, dot);
      };
    }
    for (const p of products) {
      if (!seriesOf(w, p) && !w.loading) continue;
      const part = document.createElement("em"), val = document.createElement("b"), flag = document.createElement("small");
      if (products.length > 1) {
        const name = document.createElement("small");
        name.textContent = p === LR ? "LIGHT ROAST · חשמל" : "TEMPER · חום";
        part.append(name);
      }
      val.textContent = w.loading ? "…" : ltr(valueText(valueAt(w, date, p), p));
      flag.textContent = w.loading || !date ? "" : flagText(seriesOf(w, p)?.get(date), p);
      part.append(val, flag);
      chip.append(part);
      if (!w.loading && date && seriesOf(w, p)) tips.push(tipNote(w, date, p, products.length > 1));
    }
    chip.title = (w.lonlat ? coordText(w.lonlat, 4) + "\n" : "") + (tips.length ? tips.join("\n") + "\n" : "") + "מעבר: רק החלון הזה בגרפים · לחיצה: להשאיר כך";
    // Pinned: the place stays in the graphs when another is opened, without being saved to the personal analysis.
    if (!CHART_TAB && !w.loading && !w.areaId) {
      const pin = mk("button", "chip-pin" + (w.kept ? " on" : ""));
      pin.type = "button";
      pin.innerHTML = ICONS.pin;
      pin.title = w.kept ? "נעוץ בגרף: נשאר כשפותחים מקום אחר, ולא נשמר בניתוח האישי · לחיצה: שחרור" : "נעיצה בגרף: המקום נשאר כשפותחים מקום אחר, בלי לשמור אותו";
      pin.setAttribute("aria-label", pin.title);
      pin.setAttribute("aria-pressed", !!w.kept);
      pin.onclick = e => {
        e.stopPropagation();
        w.kept = !w.kept;
        renderLegend();
        renderChart();
      };
      chip.append(pin);
    }
    const star = document.createElement("button");
    star.type = "button";
    star.className = "chip-save" + (w.areaId ? " on" : "");
    star.textContent = w.areaId ? "★" : "☆";
    star.title = w.areaId ? "בניתוח האישי: " + w.name : "שמירה בניתוח האישי, בשם משלכם";
    star.setAttribute("aria-label", star.title);
    star.onclick = e => {
      e.stopPropagation();
      if (w.areaId) showSide("areas"); else saveArea(w);
    };
    if (!CHART_TAB && !w.loading) chip.append(star);
    remove.type = "button";
    remove.textContent = "×";
    remove.title = "הסרת מקום " + num(w);
    remove.setAttribute("aria-label", remove.title);
    remove.onclick = e => {
      e.stopPropagation();
      removeWindow(w);
    };
    if (!CHART_TAB) chip.append(remove);
    chip.onmouseenter = () => setFocus(w.n);
    chip.onmouseleave = () => setFocus(null);
    chip.onclick = () => togglePin(w.n);
    chip.onkeydown = e => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        togglePin(w.n);
      }
    };
    box.append(chip);
  }
  if (chartProducts().some(p => state.windows.some(w => seriesOf(w, p) && [...seriesOf(w, p).values()].some(x => !reliable(x))))) {
    const key = document.createElement("span");
    key.className = "cloud-key";
    key.textContent = "חלקי / מעונן";
    key.title = "עיגול חלול, מחוץ לקו: לילה שבו נמדד פחות מ־" + RELIABLE + "% מהחלון או שרובו מתחת לענן; בלילות כאלה גם החלק הנמדד נקרא נמוך. קו קטן בתחתית: לילה בלי מדידה בגלל ענן";
    box.append(key);
  }
  if (typeof renderNextSteps === "function") renderNextSteps();
}
// Area analysis (server: /api/area) for a window: light (VIIRS DNB, LIGHT ROAST) against heat (SWIR, TEMPER) inside it,
// and the places related to its lights and to its heat. Runs when the window is sampled and when the period changes;
// the card shows the window that is pinned or hovered, else the last one added.
function cardWindow() {
  const f = focused(), list = shownWindows();
  return list.find(w => w.n === f) || list[list.length - 1] || null;
}
async function analyzeArea(w) {
  if (!state.meta || CHART_TAB) return;
  const seq = (w.areaSeq || 0) + 1;
  w.areaSeq = seq;
  w.areaBusy = true;
  renderAreaCard();
  try {
    const r = await api("/api/area", { x: w.center[0], y: w.center[1], size_km: w.size, from: state.rangeFrom, to: state.rangeTo });
    if (w.areaSeq !== seq) return;
    w.area = r;
    const kept = w.areaId && areaCache.get(w.areaId);
    if (kept && kept.size === w.size) kept.area = r;
  } catch (e) {
    if (w.areaSeq !== seq) return;
    w.area = { error: e.message };
  } finally {
    if (w.areaSeq === seq) w.areaBusy = false;
  }
  renderAreaCard();
  renderChart();   // the shape found for the place is drawn over its line (chart.js: drawShape)
}
function crossWords(c) {
  if (!c.clear) return "אין קשר ברור";
  return c.r > 0 ? "נעים יחד" : "נעים הפוך";
}
function renderAreaCard() {
  const card = $("areaCard"), w = cardWindow();
  card.hidden = !w || CHART_TAB;
  if (!w || CHART_TAB) return;
  card.replaceChildren();
  card.style.setProperty("--c", colorOf(w));
  const head = mk("header"), dot = mk("i");
  head.append(dot, mk("b", null, "#" + num(w)), mk("span", null, w.name || km(w.size)), mk("small", null, "ניתוח אזור"));
  card.append(head);
  const a = w.area;
  if ((w.areaBusy || w.loading) && !a) {
    card.append(mk("p", "ac-note", "מנתח את האזור…"));
    return;
  }
  if (!a) return;
  if (a.error) {
    card.append(mk("p", "ac-note", a.error));
    return;
  }
  {
    const sec = mk("section", "ac-profile");
    sec.append(mk("h4", null, "עקביות המקום"));
    sec.title = "מתאם נבדק רק במקום שמשתנה: עם מדרגה, מגמה, תנודות או קפיצות. במקום עקבי, או כמעט בלי אור או חום, הוא ימצא רק רעש";
    for (const [p, label] of [[LR, "אור"], ["temper", "חום"]]) {
      const q = a[p], row = mk("div", "ac-prof");
      row.append(mk("b", null, label));
      if (!q || q.error || !q.profile) {
        row.append(mk("span", "ac-sub", p === LR ? "חשוך מדי" : "אין מקור חום"));
        sec.append(row);
        continue;
      }
      const f = q.profile, head = p === LR ? (f.consistency != null ? Math.round(f.consistency * 100) + "% מהלילות ברמה הרגילה" : "—") : "דלוק ב־" + Math.round((f.lit_share || 0) * 100) + "% מהלילות";
      row.append(mk("span", null, head), mk("span", "ac-shape " + (f.variable ? "var" : "steady"), profileText(f, p)));
      sec.append(row);
    }
    card.append(sec);
  }
  // light against heat inside the window
  const sec = mk("section", "ac-cross"), c = a.cross;
  sec.append(mk("h4", null, "אור מול חום בחלון"), mk("small", "ac-sub", "VIIRS (אורות, LIGHT ROAST) מול SWIR (חום, TEMPER)"));
  if (c.error) sec.append(mk("p", "ac-note", c.error)); else {
    const row = mk("div", "ac-r"), word = mk("span", c.clear ? (c.r > 0 ? "pos" : "neg") : "none", crossWords(c));
    row.append(mk("b", null, ltr("r " + c.r.toFixed(2))), word);
    sec.append(row);
    let note = c.n + " לילות שבהם שני המוצרים ראו את המקום";
    if (c.lead) note += " · " + (c.lead.lag > 0 ? "האור מגיב אחרי החום ב־" + c.lead.lag : "החום מגיב אחרי האור ב־" + (-c.lead.lag)) + " לילות (" + ltr("r " + c.lead.r.toFixed(2)) + ")";
    sec.append(mk("small", "ac-sub", note));
    const cv = mk("canvas", "ac-scatter");
    cv.setAttribute("role", "img");
    cv.setAttribute("aria-label", "כל לילה נקודה: חום (ימינה) מול אור (למעלה)");
    sec.append(cv);
    requestAnimationFrame(() => drawScatter(cv, c.pairs, colorOf(w)));
  }
  card.append(sec);
  // the places related to its lights and to its heat
  const rel = mk("section", "ac-rel");
  rel.append(mk("h4", null, "מקומות קשורים"));
  const cols = mk("div", "ac-cols");
  for (const [p, label] of [[LR, "לפי האור"], ["temper", "לפי החום"]]) {
    const col = mk("div", "ac-col"), m = a.related?.[p];
    col.append(mk("h5", null, label));
    if (!m) {
      col.append(mk("p", "ac-note", (a[p] && a[p].error) || "—"));
      cols.append(col);
      continue;
    }
    if (m.error) {
      col.append(mk("p", "ac-note", m.error));
      cols.append(col);
      continue;
    }
    const ol = mk("ol");
    for (const it of m.positive.slice(0, 5)) ol.append(areaRow(it, w, 1));
    for (const it of m.negative.slice(0, 2)) ol.append(areaRow(it, w, -1));
    if (!m.positive.length && !m.negative.length) ol.append(mk("li", "none", "אין התאמה ברורה"));
    col.append(ol);
    const all = mk("button", "link", "כל הרשימה");
    all.onclick = () => findSimilar({ x: w.center[0], y: w.center[1], size_km: w.size, product: p, label: "מקום #" + num(w) });
    col.append(all);
    cols.append(col);
  }
  rel.append(cols);
  card.append(rel);
}
function areaRow(it, w, sign) {
  const li = mk("li"), go = mk("button", "ac-item"), add = mk("button", "hot-add");
  go.append(mk("b", sign > 0 ? "pos" : "neg", ltr((sign > 0 ? "" : "") + "r " + it.r.toFixed(2))), mk("span", null, ltr(it.distance_km + " ק״מ")));
  go.title = (sign > 0 ? "נע יחד עם האזור" : "נע הפוך מהאזור") + " · " + it.nights + " לילות · " + coordText(it.lonlat, 3);
  go.onclick = () => {
    state.areaMark = { x: it.x, y: it.y };
    state.cx = it.x;
    state.cy = it.y;
    state.zoom = Math.max(state.zoom, state.fitZoom * 6);
    renderMap();
  };
  add.dataset.add = "";   // the A key adds this row's place
  add.innerHTML = ICONS.graph;
  add.title = "המקום הזה בגרפים, ליד המקום";
  add.setAttribute("aria-label", add.title);
  add.onclick = () => openPlace([it.x, it.y], { size: w.size, add: true });
  li.append(go, add);
  return li;
}
// Light against heat, one dot a night (residuals: each night against the place's usual).
function drawScatter(cv, pairs, color) {
  const w = cv.clientWidth || 270, h = cv.clientHeight || 110;
  setCanvasSize(cv, cv.getContext("2d"), w, h);
  const c = cv.getContext("2d");
  c.clearRect(0, 0, w, h);
  if (!pairs?.length) return;
  const q = (v, p) => {
    const s = [...v].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
  }, xs = pairs.map(p => p[1]), ys = pairs.map(p => p[2]);
  const x0 = q(xs, .02), x1 = q(xs, .98), y0 = q(ys, .02), y1 = q(ys, .98), pad = 8, X = v => pad + (Math.max(x0, Math.min(x1, v)) - x0) / Math.max(1e-9, x1 - x0) * (w - 2 * pad), Y = v => h - pad - (Math.max(y0, Math.min(y1, v)) - y0) / Math.max(1e-9, y1 - y0) * (h - 2 * pad);
  c.strokeStyle = "rgba(255,255,255,.12)";
  c.lineWidth = 1;
  c.beginPath();
  if (x0 < 0 && x1 > 0) {
    c.moveTo(X(0), pad);
    c.lineTo(X(0), h - pad);
  }
  if (y0 < 0 && y1 > 0) {
    c.moveTo(pad, Y(0));
    c.lineTo(w - pad, Y(0));
  }
  c.stroke();
  c.fillStyle = color + "aa";
  for (const p of pairs) {
    c.beginPath();
    c.arc(X(p[1]), Y(p[2]), 2.2, 0, Math.PI * 2);
    c.fill();
  }
  c.fillStyle = MUTED;
  c.font = "10px 'Segoe UI',system-ui,sans-serif";
  c.textBaseline = "top";
  c.direction = "rtl";
  c.textAlign = "right";
  c.fillText("אור ↑", w - 4, 2);
  c.textAlign = "left";
  c.textBaseline = "bottom";
  c.fillText("חום →", 4, h - 2);
}
// Window size: of the place shown (sampled again at the new size) and of the next place picked on the map.
$("windowSize").onchange = () => {
  const size = Number($("windowSize").value);
  placeKm = size;
  try {
    localStorage.setItem("viewer-window-km", size);
  } catch { }
  const w = cardWindow();
  if (w && w.size !== size) {
    w.size = size;
    w.area = null;
    sampleWindow(w);
    windowsChanged();
  }
  renderMap();
};
{
  let saved = 0;
  try {
    saved = Number(localStorage.getItem("viewer-window-km")) || 0;
  } catch { }
  if (saved > 0) placeKm = saved;
}
$("sampleClip").onchange = resampleAll;
$("placeClose").onclick = () => {
  state.windows = [];
  state.pinned = state.focus = null;
  state.events.active = null;
  state.hotActive = null;
  setChartMax(false);
  windowsChanged();
  renderList();
};
$("exportCsv").onclick = () => {
  if (isLR()) return exportLightCsv();
  const done = shownWindows().filter(w => w.result), dates = focusDates();
  if (!done.length || !dates.length) return;
  const rows = [[
      "window", "name", "center_longitude", "center_latitude", "window_km", "only_inside_layers", "night", "mean_raw_radiance_W_m-2_um-1_sr-1", "corrected_mean_W_m-2_um-1_sr-1", "m11_mean_W_m-2_um-1_sr-1", "m11_corrected_mean_W_m-2_um-1_sr-1", "detected", "m11_confirmed", "temperature_k", "temperature_noise_sd_k", "emitting_area_m2", "radiant_heat_mw", "mean_view_zenith_deg", "valid_pixels", "eligible_pixels", "coverage_percent", "zero_percent", "m15_median_brightness_temperature_k", "cloud_percent"
    ]];
  for (const w of done) for (const d of dates) {
    const p = w.byDate.get(d);
    if (p) rows.push([num(w), csvText(w.name), ...w.result.lonlat, w.result.size_km, w.clipped, p.date, p.mean ?? "", p.corrected ?? "", p.m11_mean ?? "", p.m11_corrected ?? "", p.detected, p.confirmed ?? "", p.temperature_k ?? "", p.temperature_sd_k ?? "", p.area_m2 ?? "", p.heat_mw ?? "", p.view_zenith ?? "", p.count, p.eligible_pixels, p.coverage, p.zero_percent ?? "", p.m15_k ?? "", p.cloud_percent ?? ""]);
  }
  const blob = new Blob([rows.map(r => r.join(",")).join("\r\n")], { type: "text/csv" });
  const a = document.createElement("a"), url = URL.createObjectURL(blob);
  a.href = url;
  a.download = "TEMPER_M10_" + state.meta.name.replace(/\W+/g, "_") + "_" + dates[0] + "_" + dates[dates.length - 1] + ".csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
function exportLightCsv() {
  const done = shownWindows().filter(w => w.lr), dates = focusDates();
  if (!done.length || !dates.length) return;
  const rows = [[
      "window", "name", "center_longitude", "center_latitude", "window_km", "only_inside_layers", "night_utc", "mean_radiance_nW_cm-2_sr-1", "median_7_nights_nW_cm-2_sr-1", "coverage_percent", "lit_area_km2_at_least_5nW"
    ]];
  for (const w of done) for (const d of dates) {
    const p = w.lrByDate.get(d);
    if (p) rows.push([num(w), csvText(w.name), ...w.lr.lonlat, w.lr.size_km, w.clipped, d, p.mean_nw ?? "", w.lrWeekly.get(d) ?? "", p.coverage, p.lit_km2 ?? ""]);
  }
  const blob = new Blob([rows.map(r => r.join(",")).join("\r\n")], { type: "text/csv" });
  const a = document.createElement("a"), url = URL.createObjectURL(blob);
  a.href = url;
  a.download = "LIGHTROAST_DNB_" + state.meta.name.replace(/\W+/g, "_") + "_" + dates[0] + "_" + dates[dates.length - 1] + ".csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
