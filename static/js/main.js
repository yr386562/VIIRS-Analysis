"use strict";
// Around it all: the product switch, the side panel's tabs, the background progress, the country picker and
// connecting a country, the keys, and start-up. Loaded last.

// Product switch: the workspace (country, view, layers, windows, night) stays; theme, panel, map and chart follow.
// The product's look: theme, title and tab icon, switch buttons, legend and chart units.
function applyProductUI() {
  const p = state.product;
  document.body.dataset.product = p;
  applyTheme();
  document.title = "VIIRS · " + (p === LR ? "LIGHT ROAST" : "TEMPER") + " · Analyze. Study. Observe.";
  document.querySelector("link[rel=icon]").href = p === LR ? "brand/lightroast-icon.png" : "brand/temper-icon.png";
  for (const [id, v] of [["productTemper", "temper"], ["productLight", LR]]) {
    $(id).classList.toggle("active", p === v);
    $(id).setAttribute("aria-selected", p === v);
  }
  bandLegend();
  $("seriesUnits").textContent = axisUnits();
}
// The product chosen on the opening: the country opened behind it switches to it (or opens in it, if still opening).
document.addEventListener("intro-done", e => {
  const p = e.detail?.product;
  if (p !== "temper" && p !== LR) return;
  if (state.connecting) state.wantProduct = p;   // applied once the country is open
  else if (state.meta) setProduct(p);
  else {
    state.product = p;
    applyProductUI();
  }
});
function setProduct(p) {
  if (state.product === p) return;
  if (p === LR && !lrMeta()) {
    toast("אין נתוני אורות למדינה הזו.");
    return;
  }
  state.scales[state.product] = state.chartHigh === null ? null : { lo: state.chartLow, hi: state.chartHigh };
  state.product = p;
  applyProductUI();
  const sc = state.scales[p];
  state.scales[p] = null;
  state.chartLow = sc ? sc.lo : null;
  state.chartHigh = sc ? sc.hi : null;
  $("chartLow").value = sc ? +sc.lo.toPrecision(6) : "";
  $("chartHigh").value = sc ? +sc.hi.toPrecision(6) : "";
  clearPixel();
  updateDays();
  state.events.data = state.events.raw = null;
  state.events.active = null;
  state.hot = state.hotAll = state.hotRaw = null;
  srch.data = null;
  srch.group = null;
  renderList();
  if (state.side === "search") renderSearch();
  if (state.chartHigh === null) fitChart(true);
  windowsChanged();
  setDay(state.date);
}
$("productTemper").onclick = () => setProduct("temper");
$("productLight").onclick = () => setProduct(LR);
// The server prepares every night in the background; while it runs, show progress and refresh windows that miss nights.
// The server prepares every night in the background: progress in the top bar; places that miss nights are sampled
// again as nights arrive, and the list is reloaded now and then while its nights are still being stored.
let pollCount = 0;
async function pollProgress() {
  if (!state.meta || CHART_TAB) return;
  if (state.events.data && state.events.data.ready < state.events.data.total && !state.events.busy && ++pollCount % 3 === 0) loadEvents();
  try {
    const p = await api("/api/progress");
    if (p.id !== state.meta.id) return;
    const l = lrMeta() ? await api("/api/lr/progress").catch(() => null) : null;
    // LIGHT ROAST: the lights, then each night's cloud layer.
    const lb = l ? l.built + (l.clouds ?? l.total) : 0, lt = l ? 2 * l.total : 0;
    const parts = [];
    if (p.built < p.total) parts.push("TEMPER " + ltr(p.built + "/" + p.total));
    if (l && lb < lt) parts.push((l.built < l.total ? "אורות " : "עננים ") + ltr((l.built < l.total ? l.built : l.clouds) + "/" + l.total));
    if (l?.sfac && !l.sfac.fitted && l.sfac.blocks) parts.push("SFAC " + ltr(l.sfac.done + "/" + l.sfac.blocks));
    if (l?.sfac) {
      const was = state.lr.sfac;
      state.lr.sfac = l.sfac.fitted;
      if (!was && l.sfac.fitted && isLR() && state.lr.method === "rx") setDay(state.date);
    }
    const note = $("prepNote");
    note.hidden = !parts.length;
    note.textContent = parts.length ? "מכין " + parts.join(" · ") : "";
    const built = p.built + lb, total = p.total + lt;
    if (state.windows.some(w => w.result?.pending > 0 || w.result?.thermal_pending > 0 || w.lr?.pending > 0 || w.lr?.cloud_pending > 0) && (built >= total || built - state.prepBuilt >= Math.max(5, Math.round(total / 10)))) {
      state.prepBuilt = built;
      resampleAll();
    }
  } catch { }
}
setInterval(pollProgress, 4000);
// ---------- the side panel: the list, or the personal analysis; folded to a strip ----------
function showSide(view) {
  state.side = view;
  for (const [id, v] of [["sideList", "list"], ["sideAreas", "areas"], ["sideSearch", "search"], ["sidePoints", "points"]]) {
    $(id).classList.toggle("active", view === v);
    $(id).setAttribute("aria-selected", view === v);
  }
  $("areasView").hidden = view !== "areas";
  $("searchView").hidden = view !== "search";
  $("pointsView").hidden = view !== "points";
  if (view === "search") renderSearch();
  if (view === "points") renderPoints();
  $("findingsView").hidden = view !== "list" || !!state.similar;
  $("similarView").hidden = view !== "list" || !state.similar;
  if (view === "areas") renderAreas();
  renderMap();
}
$("sideList").onclick = () => showSide("list");
$("sideAreas").onclick = () => showSide("areas");
$("sideSearch").onclick = () => showSide("search");
$("sidePoints").onclick = () => showSide("points");
// The network tab (network.html): a click on a node opens that place here.
if (!CHART_TAB && "BroadcastChannel" in window) new BroadcastChannel("viirs-network").onmessage = e => {
  const m = e.data;
  if (m?.type !== "open" || !state.meta) return;
  flyTo(m.x, m.y, 8);
  openPlace([m.x, m.y], { size: m.size_km || 2.25, add: !!m.add });
  if (lrMeta() && !state.compare) setCompare(true);
};
function setSideMin(on) {
  document.querySelector("main").classList.toggle("side-min", on);
  try {
    localStorage.setItem("viewer-side-min", on ? "1" : "0");
  } catch { }
}
$("sideMin").onclick = () => setSideMin(true);
$("sideExpand").onclick = () => setSideMin(false);
try {
  if (localStorage.getItem("viewer-side-min") === "1") document.querySelector("main").classList.add("side-min");
} catch { }
// Countries: the picker lists the country folders under the configured data root. At start a country opens by itself
// (preloadCountry); the picker is for switching, or opens when none could.
function sameFolder(a, b) {
  return String(a).replace(/[\\/]+$/, "").toLowerCase() === String(b).replace(/[\\/]+$/, "").toLowerCase();
}
function afterIntro() {
  const intro = $("intro");
  return !intro || intro.classList.contains("done") ? Promise.resolve() : new Promise(r => document.addEventListener("intro-done", r, { once: true }));
}
async function loadCountries() {
  try {
    state.countries = await api("/api/countries");
  } catch (e) {
    state.countries = { root: "", countries: [], error: e.message };
  }
  return state.countries;
}
async function openCountries() {
  await loadCountries();
  const dialog = $("countryDialog");
  if (!dialog.open) dialog.showModal();
  renderCountries();
}
function drawOutline(cv, g) {
  const w = cv.clientWidth || 170, h = cv.clientHeight || 96, dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  const c = cv.getContext("2d");
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (!g) return;
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of polys) for (const pt of p[0]) {
    x0 = Math.min(x0, pt[0]);
    x1 = Math.max(x1, pt[0]);
    y0 = Math.min(y0, pt[1]);
    y1 = Math.max(y1, pt[1]);
  }
  const k = Math.cos((y0 + y1) / 2 * Math.PI / 180), s = Math.min((w - 12) / ((x1 - x0) * k), (h - 12) / (y1 - y0)), ox = (w - (x1 - x0) * k * s) / 2, oy = (h - (y1 - y0) * s) / 2;
  c.beginPath();
  for (const p of polys) for (const ring of p) {
    ring.forEach((pt, i) => {
      const X = ox + (pt[0] - x0) * k * s, Y = oy + (y1 - pt[1]) * s;
      i ? c.lineTo(X, Y) : c.moveTo(X, Y);
    });
    c.closePath();
  }
  const lr = isLR();
  c.fillStyle = lr ? "rgba(245,184,61,.14)" : "rgba(224,112,42,.14)";
  c.fill("evenodd");
  c.strokeStyle = lr ? "#f5b83d" : "#e0702a";
  c.lineWidth = 1.4;
  c.lineJoin = "round";
  c.stroke();
}
function rangeText(c) {
  const d = s => new Date(s + "T12:00:00").toLocaleDateString(LOCALE, { day: "numeric", month: "short", year: "numeric" }), first = isLR() ? c.lightroast_first : c.first, last = isLR() ? c.lightroast_last : c.last;
  return !first ? (isLR() ? "אין נתוני אורות" : "אין לילות זמינים") : first === last ? d(first) : d(first) + " – " + d(last);
}
function renderCountries() {
  const list = state.countries, grid = $("countryGrid");
  grid.replaceChildren();
  $("countryClose").hidden = !state.meta;
  $("countryError").textContent = list?.error || (list && !list.countries.length ? "לא נמצאו מדינות בתיקייה." : "");
  if (!list) return;
  for (const c of list.countries) {
    const card = document.createElement("button"), cv = document.createElement("canvas"), name = document.createElement("b"), info = document.createElement("small");
    card.className = "country-card" + (state.meta && sameFolder(state.meta.root, c.path) ? " current" : "");
    name.textContent = countryName(c);
    info.textContent = rangeText(c);
    card.title = c.path;
    card.append(cv, name, info);
    card.onclick = () => chooseCountry(c, card);
    grid.append(card);
    requestAnimationFrame(() => drawOutline(cv, c.outline));
  }
}
async function chooseCountry(c, card) {
  if (state.connecting) return;
  if (state.pickFresh && state.meta && sameFolder(state.meta.root, c.path)) {   // after the start: the country open already, as it is
    state.pickFresh = false;
    $("countryDialog").close();
    return;
  }
  state.pickFresh = false;
  state.connecting = true;
  $("countryError").textContent = "";
  const cards = [...$("countryGrid").children];
  for (const b of cards) b.disabled = b !== card;
  const spin = document.createElement("span");
  spin.className = "spinner";
  card.append(spin);
  try {
    const meta = await api("/api/connect", { path: c.path });
    $("countryDialog").close();
    await connectMetadata(meta);
  } catch (e) {
    $("countryError").textContent = e.message;
  } finally {
    state.connecting = false;
    spin.remove();
    for (const b of cards) b.disabled = false;
  }
}
$("countryButton").onclick = openCountries;
$("countryClose").onclick = () => $("countryDialog").close();
$("countryDialog").addEventListener("cancel", e => {
  if (!state.meta) e.preventDefault();
});
$("countryDialog").addEventListener("close", () => {
  if (!state.meta && !state.connecting) setTimeout(openCountries, 50);
}); // without a country there is nothing to show behind it
async function connectMetadata(meta) {
  // Reconnecting the same dataset (a refresh) keeps the view, the night and the places, and samples them again.
  const same = state.meta?.id === meta.id;
  state.meta = meta;
  // LIGHT ROAST is offered when the country has night-lights data; otherwise the viewer stays on TEMPER.
  $("productLight").disabled = !lrMeta();
  if (isLR() && !lrMeta()) {
    state.product = "temper";
    toast("אין נתוני אורות למדינה הזו; נפתח TEMPER.");
  }
  applyProductUI();
  // Both graphs when the country has both products (the switch is remembered, not turned off here).
  compareUI();
  if (!rxAvailable()) state.lr.method = "weekly";
  renderMethod();
  {
    const select = $("lrWindow");
    let saved = null;
    try {
      saved = localStorage.getItem("lightroast-window");
    } catch { }
    select.value = [...select.options].some(o => o.value === saved) ? saved : String(lrMeta()?.window || 28);
    if (!select.value) select.value = "28";
  }
  {
    const r = meta.change_window_range || [7, 60], input = $("changeWindow");
    let saved = null;
    try {
      saved = Number(localStorage.getItem("temper-change-window"));
    } catch { }
    input.min = r[0];
    input.max = r[1];
    input.value = saved >= r[0] && saved <= r[1] ? saved : (meta.change_window || 14);
  }
  if (!same) {
    srch.data = null;
    srch.group = null;
    state.events.data = state.events.raw = null;
    state.events.active = null;
    state.hot = state.hotAll = state.hotRaw = null;
    state.hotActive = null;
    state.focusId = state.focusTemp = null;
    renderFocus();
    state.scales = {};
    state.sites = null;
    if (state.sitesOn) loadSites();
    if (state.similar) closeSimilar();
    state.areas = [];
    state.renaming = null;
    loadAreas();
  }
  // A country opens on its latest night.
  // the tour's night (its lab's) when the tour is about to run; else the latest
  const dates = productDates(), date = same && dates.includes(state.date) ? state.date : dates.includes(state.startDate) ? state.startDate : dates[dates.length - 1];
  state.startDate = null;
  state.date = date;
  if (state.image) state.image.close();
  state.image = null;
  state.imageNonce++;
  if (!same) {
    state.windows = [];
    state.windowCount = 0;
    state.pinned = state.focus = null;
    state.basemap = null;
    state.countryOn = true;
    state.fitZoom = 0;
    state.polygons = [];
    try {
      state.polygons = JSON.parse(localStorage.getItem("temper-polygons-" + meta.id) || "[]");
    } catch { }
    state.chartLow = state.chartHigh = null;
    state.rangeFrom = state.rangeTo = "";
    for (const id of ["chartLow", "chartHigh", "rangeFrom", "rangeTo"]) $(id).value = "";
  }
  {
    const span = [...meta.dates, ...(lrMeta()?.dates || [])].sort();
    for (const id of ["rangeFrom", "rangeTo"]) {
      $(id).min = span[0];
      $(id).max = span[span.length - 1];
    }
  }
  $("datasetName").textContent = countryName(meta);
  $("countryButton").title = "החלפת מדינה · " + meta.root;
  clearPixel();
  state.prepBuilt = 0;
  updateDays();
  renderPolygons();
  if (!same) loadPoints();
  renderList();
  windowsChanged();
  resize();
  if (!same) {
    fitMap();
    loadBasemap();
  } else resampleAll();
  pollProgress();
  await setDay(date);
  document.dispatchEvent(new CustomEvent("country-open"));   // help.js: the tour opens the first time
}
window.addEventListener("keydown", e => {
  if (e.key === "Shift" && !state.shift) {
    state.shift = true;
    if (state.hover) renderMap();
  }
  if (e.key === "Escape" && state.pinned != null) {
    togglePin(state.pinned);
    if (CHART_TAB) return;
  }
  if (CHART_TAB) {
    const ahead = document.documentElement.dir === "ltr" ? "ArrowRight" : "ArrowLeft";
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") chooseDate(e.key === ahead ? 1 : -1);
    return;
  }
  if (["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName) || $("countryDialog").open) return;
  if (e.key === "Escape" && !$("mapMenu").hidden) {
    closeMenu();
    return;
  }
  if (!state.meta) return;
  if (e.code === "Space") {
    e.preventDefault();
    state.space = true;
  }
  if (e.key.toLowerCase() === "f") fitMap();
  if (e.code === "KeyA" && !e.ctrlKey && !e.altKey && !e.metaKey) {
    e.preventDefault();
    addUnderPointer();
  }
  if (e.key === "Escape") {
    if (state.drawing) toggleDrawing(false); else if (state.similar) closeSimilar(); else if (focusArea() && !document.querySelector("dialog[open], .tour:not([hidden])")) setWorkArea(null);
  }
  if (e.key === "Enter" && state.drawing) finishDrawing();
  // Right to left (in both languages): the left arrow moves forward in time, like the "next" button on the left.
  const ahead = document.documentElement.dir === "ltr" ? "ArrowRight" : "ArrowLeft";
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") chooseDate(e.key === ahead ? 1 : -1);
});
// Hebrew | English (i18n.js): the page's text follows by itself; what is drawn or dated is drawn again.
document.addEventListener("langchange", () => {
  LOCALE = I18N.locale();
  if (state.meta) $("datasetName").textContent = countryName(state.meta);
  if (CHART_TAB) {
    renderChart();
    return;
  }
  renderCoordSystem();
  if (!state.meta) return;
  updateDays();
  renderList();
  if (state.similar) renderSimilar();
  if (state.side === "areas") renderAreas();
  if (state.side === "search") renderSearch();
  renderLegend();
  renderAreaCard();
  if (state.windows.length) syncSize();
  if ($("countryDialog").open) renderCountries();
  if ($("exportDialog").open) renderExport();
  bandLegend();
  $("seriesUnits").textContent = axisUnits();
  renderMap();
  renderChart();
});
// A (whatever the keyboard's language): add the place under the pointer to the graphs, beside the ones open, as
// Shift+click does: on the map, the mark there or the place itself; over a row of a list, that row's place.
let pointerAt = null;
addEventListener("pointermove", e => pointerAt = [e.clientX, e.clientY], { passive: true });
function addUnderPointer() {
  const el = pointerAt && document.elementFromPoint(...pointerAt);
  if (!el) return;
  if (el === canvas) {
    const r = canvas.getBoundingClientRect(), sx = pointerAt[0] - r.left, sy = pointerAt[1] - r.top, hit = markAt(sx, sy), p = world(sx, sy);
    if (hit) hit.select(true); else if (inImage(p)) openPlace(p, { add: true }); else toast("הנקודה מחוץ לתמונה.");
    return;
  }
  const row = el.closest("li"), add = row?.querySelector("[data-add]"), go = row?.querySelector("[data-add-shift]");
  if (add) add.click(); else if (go) go.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
  else toast("A מוסיף לגרפים את המקום שמתחת לסמן: הצביעו על המפה או על שורה ברשימה.");
}
window.addEventListener("keyup", e => {
  if (e.code === "Space") state.space = false;
  if (e.key === "Shift") {
    state.shift = false;
    if (state.hover) renderMap();
  }
});
window.addEventListener("blur", () => {
  state.space = state.shift = false;
});
resizeObserver = new ResizeObserver(resize);
resizeObserver.observe($("mapWrap"));
resizeObserver.observe($("chartWrap"));
// Start-up: a country opens behind the opening, so the workspace and the tour are ready when it ends: the one the
// server has open (it reopens the last one used at its start, server.py preload), else Israel, else the first with
// nights. Its map, night and changes load meanwhile; the opening's product choice then switches to it.
async function preloadCountry() {
  for (let i = 0; i < 480; i++) {   // the server may still be opening the last country
    const h = await api("/api/health");
    if (h.connected) return api("/api/metadata");
    if (!h.preloading) break;
    await new Promise(r => setTimeout(r, 250));
  }
  const list = await loadCountries(), ok = list.countries.filter(c => c.first);
  const pick = ok.find(c => /^israel$/i.test(c.name)) || ok[0];
  return pick ? api("/api/connect", { path: pick.path }) : null;
}
(async () => {
  if (CHART_TAB) {
    startChartTab();
    return;
  }
  // The tour is a sandbox: while it runs (and while the question whether to take it is open) the server's background
  // waits (nothing is prepared or built behind it), and the country opens at the night its lab was made for, whatever
  // nights have arrived since; after it, all starts. "Don't ask again" (help.js) skips both.
  let tourOff = false;
  try {
    tourOff = localStorage.getItem("viewer-tour-ask") === "0";
  } catch { }
  api("/api/tour", { active: !tourOff }).catch(() => { });   // without the question: a hold left by an earlier page goes too
  // Leaving the page while the question or the tour is open lets the background go at once (not after its 15 minutes).
  addEventListener("pagehide", () => {
    if (!tourOff || document.body.classList.contains("touring")) fetch("/api/tour", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ active: false }) }).catch(() => { });
  });
  const countries = loadCountries();
  let meta = null;
  try {
    meta = await preloadCountry();
  } catch { }
  if (meta && !meta.error) {
    if (!tourOff) try {
      const lab = await api("/api/lab");
      if (lab?.night) state.startDate = lab.night;
    } catch { }
    state.connecting = true;
    try {
      await connectMetadata(meta);
    } catch (e) {
      toast(e.message);
    } finally {
      state.connecting = false;
    }
    if (state.wantProduct) {
      const p = state.wantProduct;
      state.wantProduct = null;
      setProduct(p);
    }
  }
  await afterIntro();
  await countries;
  if (!state.meta) {
    api("/api/tour", { active: false }).catch(() => { });   // no country, no tour
    openCountries();
  } else if (tourOff) {   // no tour: the country is chosen right away (the one open is ready)
    state.pickFresh = true;
    openCountries();
  }
})();
