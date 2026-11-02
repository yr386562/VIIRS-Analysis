"use strict";
// Shared by every part of the page: its elements, the state, constants, and small helpers (numbers and dates,
// the server API, toasts, the small menus). Loaded first of js/. The files are classic scripts that share one global
// scope, in the order index.html loads them: core, map, geo, coords, places, list, related, chart, search, areas,
// export, guide, main. i18n.js (Hebrew | English) and intro.js run before them.

const $ = id => document.getElementById(id);
const canvas = $("mapCanvas"), ctx = canvas.getContext("2d"), chart = $("seriesCanvas"), chartCtx = chart.getContext("2d");
const state = {
  meta: null, date: null, image: null, zoom: 1, cx: 0, cy: 0, fitZoom: 1, hover: null, shift: false,
  windows: [], windowCount: 0, polygons: [], countryOn: true, basemap: null, basemapOn: true,
  drawing: false, vertices: [], width: 1, height: 1, chartWidth: 1, chartHeight: 1, chartHoverDate: null, chartDates: [], chartX: null,
  chartLow: null, chartHigh: null, rangeFrom: "", rangeTo: "", metric: "corrected", band: "combo", prepBuilt: 0, hot: null, hotAll: null, hotWeak: false, hotThreshold: null, hotActive: null, menuPoint: null, countries: null, connecting: false,
  imageNonce: 0, drag: null, space: false, low: 0, high: 100, palette: "ember", // low/high: image display only, raw radiance
  // Two products share the country, map view, layers, places and night. Each keeps its own map view and chart metric,
  // and its own chart scale (scales), so switching or comparing never rescales the other.
  // events: the side panel's list. days: 1 = the shown night, else the period of that many days up to it (0: all);
  // mode (TEMPER): "changes", or "hot" (what burns tonight); active: the row chosen. marks: the list on the map.
  focus: null, pinned: null, labelFocus: false, labelHits: [], chartT: null, sitesOn: false, sites: null, marks: true,
  events: {
    days: 1, mode: "changes", hideCauses: new Set(), hideKinds: new Set(), hideMixed: false, showWeak: false, data: null, busy: false, error: null, active: null
  },
  // areas: the user's named areas (personal analysis); side: the panel's view ("list" or "areas"); popped: the graph's
  // own window while open; cloudImage: LIGHT ROAST's cloud layer, drawn smooth over the lights.
  areas: [], side: "list", renaming: null, drawFor: null, popped: null, cloudImage: null, chartPanels: [],
  product: "temper", lr: { view: "lights", metric: "weekly", method: "weekly", sfac: false }, compare: true, scales: {}
};
try {
  state.compare = localStorage.getItem("viewer-compare") !== "0";
  state.lr.method = localStorage.getItem("lightroast-method") === "rx" ? "rx" : "weekly";
  const days = localStorage.getItem("viewer-list-days");
  if (days !== null && [1, 7, 30, 0].includes(Number(days))) state.events.days = Number(days);
} catch { }
// The graph in its own browser tab (index.html?chart=1) mirrors this page's windows and settings over a BroadcastChannel.
const CHART_TAB = new URLSearchParams(location.search).has("chart"), channel = "BroadcastChannel" in window ? new BroadcastChannel("temper-chart") : null;
// A sampled window keeps one colour everywhere: the map, its chip and both graphs. The four pass the colour checks on
// both themes' dark surfaces (every pair, colour-blind separation, contrast at least 3:1).
const WINDOW_COLORS = ["#e0702a", "#3987e5", "#199e70", "#c95fb0"], MAX_WINDOWS = 4;
const RADIANCE = "W m⁻² µm⁻¹ sr⁻¹", DAY = 864e5, dayTime = d => Date.parse(d + "T00:00:00Z");
let LOCALE = I18N.locale();   // dates in the language shown (i18n.js); main.js follows a switch
const HOT = "#ffd27a", FONT = "11px 'Segoe UI',system-ui,sans-serif";
// Canvas colours follow the product's theme (the CSS tokens of app.css).
const THEMES = { temper: { ink: "#ececef", muted: "#6e6e78", surface: "#131316", land: "#17171c" }, lightroast: { ink: "#eaeefa", muted: "#6b7592", surface: "#0d1322", land: "#0f1628" } };
let INK = THEMES.temper.ink, MUTED = THEMES.temper.muted, SURFACE = THEMES.temper.surface, LAND = THEMES.temper.land;
function applyTheme() {
  ({ ink: INK, muted: MUTED, surface: SURFACE, land: LAND } = THEMES[state.product]);
}
const LR = "lightroast", NW = "nW cm⁻² sr⁻¹";
// A country's name in the language shown (Natural Earth's English name, or its Hebrew one).
function countryName(c) {
  return (I18N.lang === "en" ? c?.name : c?.name_he || c?.name) || "";
}
function lrMeta() {
  return state.meta?.lightroast?.available ? state.meta.lightroast : null;
}
function isLR() {
  return state.product === LR;
}
function productDates(product = state.product) {
  return product === LR ? (lrMeta()?.dates || []) : (state.meta?.dates || []);
}
function nearestDate(dates, d) {
  if (!dates.length) return null;
  if (!d) return dates[dates.length - 1];
  const t = dayTime(d);
  return dates.reduce((best, x) => Math.abs(dayTime(x) - t) < Math.abs(dayTime(best) - t) ? x : best, dates[0]);
}
function nw(v) {
  return v == null || !Number.isFinite(v) ? "—" : ltr((v >= 100 ? Math.round(v).toLocaleString("en-US") : v >= 10 ? v.toFixed(1) : v.toFixed(2)) + " nW");
}
function pct(ratio) {
  return ratio == null || !Number.isFinite(ratio) ? "—" : ltr((ratio >= 1 ? "+" : "−") + Math.round(Math.abs(ratio - 1) * 100) + "%");
}
let toastTimer, resizeObserver, pixelBusy = false, pixelNext = null, pixelSeq = 0, pixelShown = 0;
function toast(text) {
  $("toast").textContent = text;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").hidden = true, 5000);
}
async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok || result.error) throw Error(result.error || "שגיאה בשרת המקומי");
  return result;
}
// Row actions: a small graph (open the place over time) and two linked dots (related places).
const ICONS = { graph: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M1.5 12.5h11M2 10l3-4 2.5 2.5L12 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  related: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="3.5" cy="10" r="2" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="10.5" cy="4" r="2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5 8.7 9 5.3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-dasharray="1.5 1.8"/></svg>',
  pin: '<svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true"><path d="M5.2 1.8h3.6M6 1.8v3.6L3.8 7.9h6.4L8 5.4V1.8M7 7.9v4.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>' };
const ltr = s => "⁦" + s + "⁩"; // keeps numbers, coordinates and units left to right inside Hebrew text
function displayDate(date, long = false) {
  return new Date(date + "T12:00:00").toLocaleDateString(LOCALE, long ? { day: "numeric", month: "long", year: "numeric" } : { day: "numeric", month: "short" });
}
function scientific(value) {
  return value === null || !Number.isFinite(value) ? "—" : value === 0 ? "0" : Math.abs(value) < .001 ? value.toExponential(3) : value.toFixed(5);
}
function fmt(value) {
  return value === null || value === undefined || !Number.isFinite(value) ? "—" : value === 0 ? "0" : Math.abs(value) < 1e-3 || Math.abs(value) >= 1e5 ? value.toExponential(2) : String(+value.toPrecision(3));
}
// Chart metric for the selected band (M10 or M11): "corrected" = window mean minus the night's clipped-noise mean
// (a place without sources is ~0), "mean" = the window mean as measured; "temperature" = two-band M10/M11 source
// temperature (confirmed nights only).
// Temperatures arrive in kelvin and are shown in °C. The temperature metric is in °C.
function metricOf(p) {
  const m11 = state.band === "m11", v = p ? (state.metric === "mean" ? (m11 ? p.m11_mean : p.mean) : state.metric === "temperature" ? (p.temperature_k == null ? null : p.temperature_k - C0) : (m11 ? p.m11_corrected : p.corrected)) : null;
  return v === undefined ? null : v;
}
const C0 = 273.15;
function degrees(c, step) {
  return c == null || !Number.isFinite(c) ? "—" : ltr((Math.round(c / step) * step).toLocaleString("en-US") + " °C");
}
function celsius(k, step = 10) {
  return k == null || !Number.isFinite(k) ? "—" : degrees(k - C0, step);
} // source temperatures to 10 °C: the angle and atmosphere effects are ~50–100 °C
function metricText(v) {
  return state.metric === "temperature" ? degrees(v, 10) : fmt(v);
}
function coordText(ll, digits = 5) {
  return ll[1].toFixed(digits) + ", " + ll[0].toFixed(digits);
} // latitude, longitude: the order map tools accept on paste
function km(size) {
  return (+size.toFixed(2)) + " ק״מ";
}
function mk(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function download(name, text, type) {
  const a = document.createElement("a"), url = URL.createObjectURL(new Blob([text], { type }));
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
// Small menus: the graph's scale and export (⋯), the map's layers and the settings (⚙). One open at a time; a click
// outside or Esc closes it.
const POPS = [["chartMore", "chartMoreMenu"], ["layersButton", "layersMenu"], ["settingsButton", "settingsMenu"]];
function setPop(button, open) {
  const menu = POPS.find(p => p[0] === button)[1];
  $(menu).hidden = !open;
  $(button).setAttribute("aria-expanded", open);
  $(button).classList.toggle("active", open);
}
for (const [b, m] of POPS) $(b).onclick = e => {
  e.stopPropagation();
  const open = $(m).hidden;
  for (const [o] of POPS) if (o !== b) setPop(o, false);
  setPop(b, open);
};
document.addEventListener("pointerdown", e => {
  for (const [b, m] of POPS) if (!$(m).hidden && !e.target.closest("#" + m + ",#" + b)) setPop(b, false);
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape") for (const [b] of POPS) setPop(b, false);
});
// The wheel over a date moves it, one step a notch (down: later): the night at the top, by a night; From/To in the
// graph's toolbar, by a day (Shift: a week).
function wheelSteps(el, step) {
  let acc = 0;
  el.addEventListener("wheel", e => {
    e.preventDefault();
    acc += e.deltaY || e.deltaX;
    if (Math.abs(acc) < 40) return;
    const n = Math.sign(acc);
    acc = 0;
    step(n, e);
  }, { passive: false });
}
function csvText(v) {
  return v == null ? "" : /[",\r\n]/.test(v) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
}
