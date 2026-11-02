"use strict";
// עבודה בתוך אזור: one of the user's named areas (a drawn polygon, or a kept square) as the frame for everything.
// The map shows the night (or the period's composite) only inside it and fits to it; the changes and the hot spots are
// the ones inside it, with their counts; the behaviour search and the related places look only inside it; the GeoTIFF
// is cropped to it and masked outside it; the area itself opens in the graphs with its area analysis. A bar over the
// map names it with its numbers; ✕ (or Esc) goes back to the whole country. Kept per country on this computer.

// ---------- the area as a frame ----------
function areaGeometry(a) {
  if (a.geometry) return a.geometry;
  const h = a.size_km * 500, [x, y] = a.center;
  return { type: "Polygon", coordinates: [[[x - h, y - h], [x + h, y - h], [x + h, y + h], [x - h, y + h], [x - h, y - h]]] };
}
// The tour shows it on an area of its own (temp: not saved, not in the personal analysis).
function focusArea() {
  return state.focusTemp || state.focusId && state.areas.find(a => a.id === state.focusId) || null;
}
function inFocus(p) {
  const a = focusArea();
  return !a || inRing([p.x, p.y], areaGeometry(a).coordinates[0]);
}
// EPSG:6933 is an equal-area grid, so the ring's own area is the true one.
function ringKm2(ring) {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return Math.abs(s) / 2e6;
}
// The changes inside the area, with their counts by kind and cause (the server counts the whole country).
function clipEvents(r) {
  if (!r || !focusArea()) return r;
  const events = r.events.filter(inFocus), pend = e => e.detail?.moon === "pending", kinds = ["new", "off", "brighter", "dimmer"];
  return {
    ...r, events, outside: r.events.length - events.length, counts: Object.fromEntries(kinds.map(k => [k, events.filter(e => e.kind === k && !pend(e)).length])), pending: Object.fromEntries(kinds.map(k => [k, events.filter(e => e.kind === k && pend(e)).length])), causes: Object.fromEntries(Object.keys(CAUSE_LABELS).map(c => [c, events.filter(e => e.cause === c).length])), intermittent: events.filter(e => e.pattern === "intermittent").length
  };
}
function clipRelated(r) {
  if (!r || !focusArea() || !r.positive) return r;
  return { ...r, positive: r.positive.filter(inFocus), negative: r.negative.filter(inFocus) };
}
// What the lists hold now, inside the area (after a new night, a new period or a change of area).
function applyFocus() {
  const s = state.events;
  if (s.raw) s.data = clipEvents(s.raw);
  if (s.active && s.data && !s.data.events.some(e => e.id === s.active.id)) s.active = null;
  if (state.hotRaw) {
    state.hotAll = state.hotRaw.filter(inFocus);
    state.hotActive = null;
    filterHot();
  }
  if (state.similar?.raw) {
    state.similar.result = clipRelated(state.similar.raw);
    state.similar.active = null;
  }
}
function fitArea(a) {
  const [x0, y0, x1, y1] = geomBounds(areaGeometry(a));
  state.cx = (x0 + x1) / 2;
  state.cy = (y0 + y1) / 2;
  state.zoom = Math.max(state.fitZoom, Math.min(state.fitZoom * 400, .78 * Math.min(state.width / Math.max(x1 - x0, 750), state.height / Math.max(y1 - y0, 750))));
}
function setWorkArea(a, opts = {}) {
  if (!state.meta) return;
  const was = focusArea();
  state.focusTemp = a && opts.temp ? a : null;
  state.focusId = a && !opts.temp ? a.id : null;
  if (!opts.temp) try {
    if (a) localStorage.setItem("viewer-focus-" + state.meta.id, a.id); else localStorage.removeItem("viewer-focus-" + state.meta.id);
  } catch { }
  applyFocus();
  if (a) {
    fitArea(a);
    if (opts.open !== false && !opts.temp) {
      openArea(a);
      const w = areaWindow(a);
      if (w?.hidden) toggleArea(a, false);
    }
  } else if (was && opts.fit !== false) fitMap();
  if (srch.data && was !== focusArea()) runSearch();   // the search asks again, inside the area (or everywhere)
  renderFocus();
  renderList();
  renderAreas();
  if (state.similar) renderSimilar();
  renderMap();
}
function toggleFocus(a) {
  setWorkArea(state.focusId === a.id ? null : a);
}
// After the areas load: the area worked in last time on this computer, if it is still there.
function restoreFocus() {
  let id = null;
  try {
    id = localStorage.getItem("viewer-focus-" + state.meta.id);
  } catch { }
  const a = id && state.areas.find(x => x.id === id);
  state.focusId = null;
  if (a) setWorkArea(a, { open: false }); else renderFocus();
}
// Started from the map's ◎ button: draw the area, name it (the areas pane opens on its name), then work inside it.
function drawFocus() {
  if (!areasReady()) return;
  if (state.drawing && state.drawFor === "focus") {
    toggleDrawing(false);
    return;
  }
  toggleDrawing(true);
  state.drawFor = "focus";
  $("drawButton").textContent = "ציור פוליגון";
  toast("לחיצה לכל נקודה של האזור · Enter לסיום · אחר כך נותנים לו שם");
}
// ---------- the bar over the map ----------
function focusCounts() {
  const parts = [];
  if (hotMode()) {
    if (state.hotAll) parts.push(state.hotAll.filter(s => s.sure).length + " מוקדים הלילה");
  } else if (state.events.data) {
    const n = shownEvents().length;
    parts.push(n.toLocaleString("en-US") + (state.events.days === 1 ? " שינויים הלילה" : " שינויים"));
  }
  if (srch.data && state.side === "search") parts.push(srch.data.total.toLocaleString("en-US") + " בחיפוש");
  return parts;
}
function renderFocus() {
  const a = focusArea(), bar = $("focusBar");
  bar.hidden = !a;
  $("mapWrap").classList.toggle("focused", !!a);
  $("focusDraw").classList.toggle("active", !!a);
  $("focusDraw").setAttribute("aria-pressed", !!a);
  if (!a) return;
  $("focusName").textContent = a.name;
  $("focusStats").textContent = [ltr(fmtArea(ringKm2(areaGeometry(a).coordinates[0]))), ...focusCounts()].join(" · ");
}
function fmtArea(km2) {
  return (km2 >= 100 ? Math.round(km2).toLocaleString("en-US") : km2.toFixed(km2 >= 10 ? 0 : 1)) + " km²";
}
// On the map: the area's outline over everything, and its name.
function drawFocusOutline() {
  const a = focusArea();
  if (!a) return;
  const g = areaGeometry(a);
  ctx.save();
  ctx.lineJoin = "round";
  ctx.beginPath();
  drawPath(ctx, g);
  ctx.lineWidth = 5;
  ctx.strokeStyle = "rgba(8,8,10,.75)";
  ctx.stroke();
  ctx.lineWidth = 1.8;
  ctx.strokeStyle = "#f3f4f6";
  ctx.stroke();
  ctx.restore();
}
$("focusDraw").onclick = () => {
  if (focusArea()) setWorkArea(null); else drawFocus();
};
$("focusExit").onclick = () => setWorkArea(null);
$("focusFit").onclick = () => {
  const a = focusArea();
  if (a) {
    fitArea(a);
    renderMap();
  }
};
$("focusExport").onclick = () => openExport();
