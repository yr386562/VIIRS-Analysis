"use strict";
// ניתוח אישי: the user's named areas, kept by the server (user_areas/<country>.json); saved only after they load.

// ---------- personal analysis: the user's named areas ----------
// Areas of the user's own (a place kept with ☆, or a drawn polygon) under names of their own, kept by the server in
// user_areas/<country>.json. A click opens an area beside the others in the graphs and the area analysis (up to four
// at once); its row then gives its numbers for the shown night.
// A country's areas are saved only once they have loaded for it (areasFor): a save before that, or after a failed
// load, would write an empty list over them. Each save names its country; the server refuses another one.
async function loadAreas() {
  const id = state.meta?.id;
  state.areasFor = null;
  try {
    const r = await api("/api/areas");
    if (state.meta?.id !== id) return;
    state.areas = r.areas;
    state.areasFor = id;
    restoreFocus();
  } catch (e) {
    if (state.meta?.id !== id) return;
    state.areas = [];
    toast("האזורים האישיים לא נטענו: " + e.message);
  }
  renderAreas();
  renderMap();
}
let areasTimer = null;
function areasReady() {
  if (state.meta && state.areasFor === state.meta.id) return true;
  toast("האזורים האישיים עדיין נטענים. נסו שוב בעוד רגע.");
  return false;
}
function saveAreas() {
  clearTimeout(areasTimer);
  if (!state.meta || state.areasFor !== state.meta.id) {
    $("areasNote").textContent = "";
    toast("האזורים עדיין נטענים: לא נשמר. נסו שוב בעוד רגע.");
    renderAreas();
    return;
  }
  $("areasNote").textContent = "שומר…";
  const country = state.meta.name, list = state.areas;
  areasTimer = setTimeout(async () => {
    try {
      await api("/api/areas", { country, areas: list });
      $("areasNote").textContent = "נשמר במחשב";
    } catch (e) {
      $("areasNote").textContent = "";
      toast(e.message);
    }
  }, 300);
  renderAreas();
}
function areaWindow(a) {
  return state.windows.find(w => w.areaId === a.id);
}
function newAreaName() {
  let k = state.areas.length + 1;
  while (state.areas.some(a => a.name === "אזור " + k)) k++;
  return "אזור " + k;
}
function newArea(fields) {
  return {
    id: "a" + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36), name: newAreaName(), created: new Date().toISOString().slice(0, 19), ...fields
  };
}
// From the analytics: one click keeps a place (a change, a hot spot or a related place) in the personal analysis,
// named after what it is ("נדלק · תאורה · 18 בספט׳"), without leaving the list. Kept already (an area within 750 m of
// about the same size): ★, and a click opens the personal analysis.
function keptArea(x, y, size) {
  return state.areas.find(a => Math.hypot(a.center[0] - x, a.center[1] - y) < 750 && Math.abs(a.size_km - size) < 1) || null;
}
function uniqueName(name) {
  if (!state.areas.some(a => a.name === name)) return name;
  let k = 2;
  while (state.areas.some(a => a.name === name + " (" + k + ")")) k++;
  return name + " (" + k + ")";
}
function keepArea(x, y, size, name) {
  if (!areasReady()) return null;
  const a = newArea({ kind: "window", center: [x, y], size_km: size, geometry: null });
  a.name = uniqueName(name);
  state.areas.push(a);
  const w = state.windows.find(v => !v.areaId && !v.geometry && Math.hypot(v.center[0] - x, v.center[1] - y) < 1 && v.size === size);
  if (w) {
    w.areaId = a.id;
    w.name = a.name;
    w.kept = true;
    renderLegend();
    renderAreaCard();
  }
  saveAreas();
  renderMap();
  toast("עבר לניתוח האישי: " + a.name);
  return a;
}
function keepButton(x, y, size, name) {
  const b = mk("button", "hot-add keep-btn");
  const set = () => {
    const on = !!keptArea(x, y, size);
    b.textContent = on ? "★" : "☆";
    b.classList.toggle("on", on);
    b.title = on ? "כבר בניתוח האישי · לחיצה: פתיחתו" : "העברה לניתוח האישי, בשם אוטומטי";
    b.setAttribute("aria-label", b.title);
  };
  set();
  b.onclick = e => {
    e.stopPropagation();
    if (keptArea(x, y, size)) {
      showSide("areas");
      setSideMin(false);
      return;
    }
    keepArea(x, y, size, name());
    set();
    renderList();
    if (state.similar) renderSimilar();
  };
  return b;
}
function saveArea(w) {
  if (!areasReady()) return;
  const a = newArea({ kind: w.geometry ? "polygon" : "window", center: [...w.center], size_km: w.size, geometry: w.geometry || null });
  state.areas.push(a);
  w.areaId = a.id;
  w.name = a.name;
  w.kept = true;
  saveAreas();
  renderLegend();
  renderMap();
  showSide("areas");
  setSideMin(false);
  startRename(a);
}
// A drawn polygon: saved, and its name open for editing. Analysing it (working inside it, and it in the graphs) only
// when asked for: the "analyse the whole area" box under the name, off unless ticked; or ◎ on its row later.
function createPolygonArea(ring, opts = {}) {
  const xs = ring.map(p => p[0]), ys = ring.map(p => p[1]), x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (!areasReady()) return;
  const a = newArea({
    kind: "polygon", center: [(x0 + x1) / 2, (y0 + y1) / 2], size_km: Math.max(.75, Math.ceil(Math.max(x1 - x0, y1 - y0) / 750) * .75), geometry: { type: "Polygon", coordinates: [ring] }
  });
  state.areas.push(a);
  saveAreas();
  if (opts.open) openArea(a);
  showSide("areas");
  if (opts.rename !== false) {
    state.newArea = a.id;
    state.newAreaWhole = false;
    startRename(a);
  }
  return a;
}
function openArea(a) {
  const w = areaWindow(a);
  if (w) {
    if (w.hidden) {
      w.hidden = false;
      if (state.chartAuto) fitChart(true);
      windowsChanged();
    }
    return;
  }
  openPlace(a.center, { size: a.size_km, add: true, area: a });
  if (lrMeta() && !state.compare) setCompare(true);
}
function showArea(a) {
  state.cx = a.center[0];
  state.cy = a.center[1];
  const want = Math.min(state.width, state.height) * .3 / (a.size_km * 1000);
  state.zoom = Math.max(state.fitZoom, Math.min(state.fitZoom * 200, Math.max(state.zoom, want)));
  renderMap();
}
// A click shows or hides an area in the graphs; hidden, it stays loaded, so showing it again is instant.
function toggleArea(a, fly = true) {
  const w = areaWindow(a);
  if (w) {
    w.hidden = !w.hidden;
    if (state.pinned === w.n) state.pinned = null;
    if (state.focus === w.n) state.focus = null;
    if (!w.hidden && fly) showArea(a);
    if (state.chartAuto) fitChart(true);
    windowsChanged();
  } else {
    if (fly) showArea(a);
    openArea(a);
  }
  renderAreas();
}
function inRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function areaAt(p) {
  return state.areas.find(a => !(areaWindow(a) && !areaWindow(a).hidden) && (a.geometry ? inRing(p, a.geometry.coordinates[0]) : Math.abs(p[0] - a.center[0]) <= a.size_km * 500 && Math.abs(p[1] - a.center[1]) <= a.size_km * 500)) || null;
}
// On the map while the pane is open: the areas not in the graphs, dashed, with their names.
function drawAreas() {
  ctx.save();
  ctx.font = "600 11px 'Segoe UI',system-ui,sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.lineJoin = "round";
  for (const a of state.areas) {
    if (areaWindow(a) && !areaWindow(a).hidden) continue;
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.3;
    ctx.strokeStyle = "rgba(236,236,239,.6)";
    ctx.beginPath();
    if (a.geometry) drawPath(ctx, a.geometry); else ctx.rect(...windowRect(a.center, a.size_km));
    ctx.stroke();
    const top = a.geometry ? geomBounds(a.geometry)[3] : a.center[1] + a.size_km * 500, [px, py] = screen(a.center[0], top);
    ctx.setLineDash([]);
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(8,8,10,.85)";
    ctx.strokeText(a.name, px, py - 4);
    ctx.fillStyle = INK;
    ctx.fillText(a.name, px, py - 4);
  }
  ctx.restore();
}
// An open area's numbers on the shown night: the lights (the graph's metric) and how often TEMPER found heat in the period.
function areaStats(w) {
  if (w.loading) return "טוען…";
  const parts = [], f = w.area?.lightroast?.profile;
  if (f?.consistency != null) parts.push("עקביות " + Math.round(f.consistency * 100) + "%" + (f.variable ? "" : " · יציב"));
  if (w.lrByDate) {
    const v = valueAt(w, state.date, LR);
    parts.push("אורות " + (v == null ? "—" : nw(v)));
  }
  if (w.byDate) {
    const dates = focusDates("temper"), hit = dates.filter(d => w.byDate.get(d)?.detected).length;
    parts.push("חום ב־" + hit + "/" + dates.length + " לילות");
  }
  return parts.join(" · ");
}
function startRename(a) {
  state.renaming = a.id;
  renderAreas();
  const input = document.querySelector("#areasList .area-input");
  if (input) {
    input.focus();
    input.select();
  }
}
function myAreaRow(a) {
  const w = areaWindow(a), shown = w && !w.hidden, li = mk("li", "area-row" + (shown ? " open" : w ? " loaded" : "")), go = mk("button", "area-main"), dot = mk("i", "area-dot");
  if (w) dot.style.setProperty("--c", colorOf(w));
  const body = mk("span", "ev-body"), sub = mk("span", "ev-sub");
  let name = mk("b", "area-name", a.name), extra = null;
  if (state.renaming === a.id) {
    const input = mk("input", "area-input");
    input.value = a.name;
    input.maxLength = 80;
    input.setAttribute("aria-label", "שם האזור");
    const done = ok => {
      if (state.renaming !== a.id) return;
      state.renaming = null;
      const whole = ok && state.newArea === a.id && state.newAreaWhole;
      if (state.newArea === a.id) state.newArea = null;
      if (whole) setTimeout(() => setWorkArea(a));   // after the name is saved and the list drawn again
      const v = input.value.trim();
      if (ok && v && v !== a.name) {
        a.name = v;
        const ow = areaWindow(a);
        if (ow) ow.name = v;
        saveAreas();
        if (state.focusId === a.id) renderList();   // the list's line and the bar over the map name it
        renderLegend();
        renderMap();
        renderAreaCard();
        shareChart(true);
      } else renderAreas();
    };
    input.onkeydown = e => {
      if (e.key === "Enter") {
        e.preventDefault();
        done(true);
      }
      if (e.key === "Escape") {
        e.preventDefault();
        done(false);
      }
    };
    input.onblur = e => {
      if (!e.relatedTarget?.closest?.(".area-whole")) done(true);
    };
    input.onclick = e => e.stopPropagation();
    name = input;
    if (state.newArea === a.id) {   // just drawn: analyse the whole area too?
      const whole = mk("label", "area-whole"), box = mk("input");
      box.type = "checkbox";
      box.checked = !!state.newAreaWhole;
      box.onchange = () => {
        state.newAreaWhole = box.checked;
        input.focus();
      };
      box.onclick = e => e.stopPropagation();
      whole.onclick = e => e.stopPropagation();
      whole.onmousedown = e => e.preventDefault();   // the name keeps the focus while the box is ticked
      whole.title = "עבודה רק בתוך האזור: המפה, השינויים, מוקדי החום, החיפוש וההורדה; והאזור עצמו בגרפים, עם ניתוח האזור";
      whole.append(box, mk("span", null, "ניתוח כל האזור"));
      extra = whole;
    }
  }
  sub.append(mk("span", "ev-when", (a.kind === "polygon" ? "פוליגון · " : "ריבוע · ") + km(a.size_km)), mk("span", "ev-where", w ? areaStats(w) : "לחיצה: לגרפים"));
  body.append(name, sub);
  if (extra) body.append(extra);
  go.append(dot, body);
  go.title = (shown ? "בגרפים ובניתוח האזור · לחיצה: הסתרה (נשאר טעון)" : w ? "מוסתר, טעון · לחיצה: הצגה בגרפים" : "לחיצה: לגרפים ולניתוח האזור, לצד האחרים") + "\n" + coordText(projectedLonLat(a.center) || [0, 0], 4);
  go.onclick = () => {
    if (state.renaming !== a.id) toggleArea(a);
  };
  const acts = mk("span", "area-acts"), ren = mk("button", "hot-add", "✎"), del = mk("button", "hot-add del", "×");
  ren.title = "שינוי שם";
  ren.setAttribute("aria-label", ren.title);
  ren.onclick = () => startRename(a);
  del.title = "מחיקת האזור";
  del.setAttribute("aria-label", del.title);
  del.onclick = () => {
    if (del.dataset.armed) {
      if (state.focusId === a.id) setWorkArea(null);
      state.areas = state.areas.filter(x => x !== a);
      const ow = areaWindow(a);
      if (ow) {
        ow.areaId = null;
        ow.name = null;
      }
      saveAreas();
      renderLegend();
      renderMap();
      renderAreaCard();
      return;
    }
    del.dataset.armed = "1";
    del.textContent = "למחוק?";
    del.classList.add("armed");
    setTimeout(() => {
      if (del.isConnected && del.dataset.armed) {
        delete del.dataset.armed;
        del.textContent = "×";
        del.classList.remove("armed");
      }
    }, 3000);
  };
  const foc = mk("button", "hot-add focus-btn" + (state.focusId === a.id ? " on" : ""), "◎");
  foc.title = state.focusId === a.id ? "עובדים בתוך האזור · לחיצה: חזרה לכל המדינה" : "עבודה בתוך האזור: המפה, השינויים, מוקדי החום, החיפוש וההורדה רק בתוכו";
  foc.setAttribute("aria-label", foc.title);
  foc.setAttribute("aria-pressed", state.focusId === a.id);
  foc.onclick = () => toggleFocus(a);
  acts.append(foc, ren, similarButton({ x: a.center[0], y: a.center[1], size_km: a.size_km, product: state.product, label: a.name }), del);
  li.append(go, acts);
  return li;
}
function renderAreas() {
  const list = $("areasList");
  list.replaceChildren();
  $("areasCount").textContent = state.areas.length ? String(state.areas.length) : "";
  $("areasEmpty").hidden = state.areas.length > 0;
  const open = cardWindow();
  $("areaFromPlace").disabled = !open || !!open.areaId;
  $("areasHideAll").disabled = !state.windows.some(w => w.areaId && !w.hidden);
  $("areasDeleteAll").disabled = !state.areas.length;
  const inGraph = state.areas.filter(a => areaWindow(a) && !areaWindow(a).hidden).length;
  $("areasStatus").textContent = state.areas.length ? inGraph + "/" + state.areas.length + " בגרפים" : "";
  for (const a of state.areas) list.append(myAreaRow(a));
}
$("areaFromPlace").onclick = () => {
  const w = cardWindow();
  if (w && !w.areaId) saveArea(w);
};
$("areasHideAll").onclick = () => {
  let any = false;
  for (const w of state.windows) if (w.areaId && !w.hidden) {
    w.hidden = true;
    any = true;
  }
  if (any) {
    state.pinned = state.focus = null;
    if (state.chartAuto) fitChart(true);
    windowsChanged();
  }
  renderAreas();
};
$("areasDeleteAll").onclick = () => {
  const b = $("areasDeleteAll");
  if (!state.areas.length) return;
  if (!b.dataset.armed) {
    b.dataset.armed = "1";
    b.textContent = "למחוק את כל " + state.areas.length + "?";
    b.classList.add("armed");
    setTimeout(() => {
      if (b.dataset.armed) {
        delete b.dataset.armed;
        b.textContent = "מחיקת הכל";
        b.classList.remove("armed");
      }
    }, 3000);
    return;
  }
  delete b.dataset.armed;
  b.textContent = "מחיקת הכל";
  b.classList.remove("armed");
  for (const w of state.windows) if (w.areaId) {
    w.areaId = null;
    w.name = null;
  }
  if (state.focusId) setWorkArea(null);
  state.areas = [];
  saveAreas();
  renderLegend();
  renderMap();
  renderAreaCard();
};
$("areaDraw").onclick = () => {
  state.drawFor = "area";
  toggleDrawing(true);
  $("drawButton").textContent = "ציור פוליגון";
};
$("areasGeo").onclick = () => {
  if (!state.areas.length) return;
  const ll = p => (projectedLonLat(p) || [0, 0]).map(v => +v.toFixed(6));
  const fc = { type: "FeatureCollection", features: state.areas.map(a => {
      let ring;
      if (a.geometry) ring = a.geometry.coordinates[0]; else {
        const h = a.size_km * 500, [x, y] = a.center;
        ring = [[x - h, y - h], [x + h, y - h], [x + h, y + h], [x - h, y + h], [x - h, y - h]];
      }
      return { type: "Feature", geometry: { type: "Polygon", coordinates: [ring.map(ll)] }, properties: { name: a.name, kind: a.kind, size_km: a.size_km, created: a.created } };
    }) };
  download("areas_" + state.meta.name.replace(/\W+/g, "_") + ".geojson", JSON.stringify(fc), "application/geo+json");
};
