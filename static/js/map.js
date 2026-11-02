"use strict";
// The map: the night's image and its layers (basemap, clouds, the country, polygons), places and marks drawn on it,
// the pixel under the mouse, the night picker, the layers and display settings, and the right-click menu.

const colors = ["#3987e5", "#199e70", "#9085e9", "#d55181", "#c98500"]; // user polygons: a validated categorical order on the dark surface
function drawPath(context, geometry) {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.type === "MultiPolygon" ? geometry.coordinates : [];
  for (const polygon of polygons) for (const ring of polygon) {
    ring.forEach((p, i) => {
      const s = screen(p[0], p[1]);
      i ? context.lineTo(s[0], s[1]) : context.moveTo(s[0], s[1]);
    });
    context.closePath();
  }
}
function screen(x, y) {
  return [state.width / 2 + (x - state.cx) * state.zoom, state.height / 2 - (y - state.cy) * state.zoom];
}
function world(x, y) {
  return [state.cx + (x - state.width / 2) / state.zoom, state.cy - (y - state.height / 2) / state.zoom];
}
function inImage(p) {
  const b = state.meta.bounds;
  return p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];
}
function activeGeometries() {
  return [...(state.countryOn && state.meta.country ? [state.meta.country] : []), ...state.polygons.filter(p => p.enabled).map(p => p.geometry)];
}
function setCanvasSize(node, context, width, height) {
  const dpr = window.devicePixelRatio || 1;
  node.width = Math.round(width * dpr);
  node.height = Math.round(height * dpr);
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
}
function resize() {
  const box = $("mapWrap").getBoundingClientRect();
  state.width = box.width;
  state.height = box.height;
  setCanvasSize(canvas, ctx, box.width, box.height);
  const cb = $("chartWrap").getBoundingClientRect();
  state.chartWidth = cb.width;
  state.chartHeight = cb.height;
  setCanvasSize(chart, chartCtx, cb.width, cb.height);
  if (state.meta && !state.fitZoom) fitMap();
  renderMap();
  renderChart();
}
function fitMap() {
  if (!state.meta) return;
  const b = state.meta.bounds;
  state.cx = (b[0] + b[2]) / 2;
  state.cy = (b[1] + b[3]) / 2;
  state.zoom = .91 * Math.min(state.width / (b[2] - b[0]), state.height / (b[3] - b[1]));
  state.fitZoom = state.zoom;
  renderMap();
}
function zoomAt(factor, x = state.width / 2, y = state.height / 2) {
  if (!state.meta) return;
  closeMenu();
  const before = world(x, y);
  state.zoom = Math.max(state.fitZoom * .35, Math.min(state.fitZoom * 200, state.zoom * factor));
  const after = world(x, y);
  state.cx += before[0] - after[0];
  state.cy += before[1] - after[1];
  renderMap();
}
function windowRect(center, size) {
  const half = size * 500, p = screen(center[0] - half, center[1] + half), pixels = size * 1000 * state.zoom;
  return [p[0], p[1], pixels, pixels];
}
function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
function geomBounds(g) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of g.coordinates[0]) {
    x0 = Math.min(x0, p[0]);
    x1 = Math.max(x1, p[0]);
    y0 = Math.min(y0, p[1]);
    y1 = Math.max(y1, p[1]);
  }
  return [x0, y0, x1, y1];
}
function drawWindow(w) {
  let r;
  const p = screen(...w.center), color = colorOf(w);
  ctx.save();
  if (focused() != null && focused() !== w.n) ctx.globalAlpha = .3;
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = color;
  ctx.fillStyle = color + "29";
  if (w.geometry) {
    ctx.beginPath();
    drawPath(ctx, w.geometry);
    ctx.fill("evenodd");
    ctx.stroke();
    const b = geomBounds(w.geometry), tl = screen(b[0], b[3]), br = screen(b[2], b[1]);
    r = [tl[0], tl[1], br[0] - tl[0], br[1] - tl[1]];
  } else {
    r = windowRect(w.center, w.size);
    ctx.fillRect(...r);
    ctx.strokeRect(...r);
    ctx.beginPath();
    ctx.moveTo(p[0] - 5, p[1]);
    ctx.lineTo(p[0] + 5, p[1]);
    ctx.moveTo(p[0], p[1] - 5);
    ctx.lineTo(p[0], p[1] + 5);
    ctx.stroke();
  }
  const label = "#" + num(w) + " · " + (w.name || km(w.size));
  ctx.font = FONT;
  ctx.textAlign = "left";
  const tw = ctx.measureText(label).width, lx = r[0], ly = r[1] < 52 ? r[1] + r[3] + 5 : r[1] - 24; /* label below the window when it sits at the top edge */
  ctx.fillStyle = "rgba(11,11,13,.9)";
  roundRect(ctx, lx, ly, tw + 26, 19, 6);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(lx + tw + 16, ly + 9.5, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.fillStyle = INK;
  ctx.textBaseline = "middle";
  ctx.fillText(label, lx + 8, ly + 10);
  ctx.restore();
}
function drawHoverWindow(center, size) {
  const r = windowRect(center, size);
  ctx.save();
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = WINDOW_COLORS[nextSlot()];
  ctx.fillStyle = "rgba(236,236,239,.05)";
  ctx.fillRect(...r);
  ctx.strokeRect(...r);
  ctx.restore();
}
function drawLabels(countries) {
  // Country names over the image, largest first; a name that would collide or outgrow its country is skipped.
  ctx.save();
  ctx.font = "600 11px 'Segoe UI',system-ui,sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(8,8,10,.8)";
  ctx.fillStyle = "rgba(236,236,239,.5)";
  const placed = [];
  for (const c of countries) {
    if (!c.label) continue;
    const [sx, sy] = screen(...c.label), text = countryName(c), tw = ctx.measureText(text).width, box = [sx - tw / 2 - 6, sy - 9, sx + tw / 2 + 6, sy + 9];
    if (box[0] < 8 || box[2] > state.width - 8 || box[1] < 8 || box[3] > state.height - 8 || c.size * state.zoom < tw * .6) continue;
    if (placed.some(p => box[0] < p[2] && box[2] > p[0] && box[1] < p[3] && box[3] > p[1])) continue;
    placed.push(box);
    ctx.strokeText(text, sx, sy);
    ctx.fillText(text, sx, sy);
  }
  ctx.restore();
}
function drawHot() {
  // Hot spots above the EVT threshold: ring size and opacity grow with how far the peak is above the threshold;
  // numbers only on the 15 brightest and on the one opened from the list. Drawn faintest first.
  ctx.save();
  ctx.font = "700 10px 'Segoe UI',system-ui,sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  for (let i = state.hot.length - 1; i >= 0; i--) {
    const s = state.hot[i], [px, py] = screen(s.x, s.y);
    if (px < -20 || py < -20 || px > state.width + 20 || py > state.height + 20) continue;
    const on = s.rank === state.hotActive, strength = Math.min(1, Math.log10(Math.max(1, s.value / (s.threshold || state.hotThreshold))) / 2), r = on ? 11 : 2.5 + 5.5 * strength;
    ctx.globalAlpha = on ? 1 : .22 + .78 * strength;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.lineWidth = on ? 2.5 : 1.4;
    ctx.strokeStyle = HOT;
    ctx.stroke();
    if (on || s.rank <= 15) {
      const ty = py - r - 8;
      ctx.globalAlpha = 1;
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(8,8,10,.85)";
      ctx.strokeText(s.rank, px, ty);
      ctx.fillStyle = HOT;
      ctx.fillText(s.rank, px, ty);
    }
  }
  ctx.restore();
}
// Change marks: shape and colour by kind (validated categorical order on the dark surface). The list's night: each
// event where it was that night; a period: where it was strongest, ended ones faded. Waiting on the moon: dashed. The
// row chosen is drawn last, larger.
const CHANGE_KINDS = {
  new: { label: "חדש", mark: "▲", color: "#2fa36b" }, off: { label: "כבה", mark: "▽", color: "#5b8fea" }, brighter: { label: "התחזק", mark: "↑", color: "#d67a26" }, dimmer: { label: "נחלש", mark: "↓", color: "#a07ce8" }
};
function markShape(px, py, kind, r) {
  ctx.beginPath();
  if (kind === "new" || kind === "off") {
    const s = kind === "new" ? 1 : -1;
    ctx.moveTo(px, py - s * r);
    ctx.lineTo(px + r * .95, py + s * r * .7);
    ctx.lineTo(px - r * .95, py + s * r * .7);
    ctx.closePath();
  } else {
    const s = kind === "brighter" ? 1 : -1;
    ctx.moveTo(px - r * .9, py + s * r * .45);
    ctx.lineTo(px, py - s * r * .55);
    ctx.lineTo(px + r * .9, py + s * r * .45);
  }
}
function drawMarks() {
  const act = state.events.active, night = !!state.events.data?.night, list = shownEvents().slice(0, 3000).filter(e => e !== act);
  if (act) list.push(act);   // the change chosen, even from another list (the tour's)
  ctx.save();
  ctx.lineJoin = "round";
  for (const e of list) {
    const [px, py] = screen(e.x, e.y);
    if (px < -20 || py < -20 || px > state.width + 20 || py > state.height + 20) continue;
    const k = CHANGE_KINDS[e.kind], on = e === act, pend = e.detail?.moon === "pending", r = on ? 9 : 5.5;
    ctx.globalAlpha = on ? 1 : isWeak(e) ? .35 : pend ? .45 : night || e.status === "ongoing" ? .95 : .5;
    ctx.setLineDash((pend || e.pattern === "intermittent") && !on ? [2, 2] : []);
    markShape(px, py, e.kind, r);
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(8,8,10,.8)";
    ctx.stroke();
    ctx.lineWidth = on ? 2.5 : 1.7;
    ctx.strokeStyle = k.color;
    ctx.stroke();
    if (e.kind === "new") {
      ctx.fillStyle = k.color;
      ctx.fill();
    }
  }
  ctx.restore();
}
// The map's symbology, in the legend on its left: only the marks the map shows now, drawn as on the map (rebuilt only
// when what is shown changes).
let marksKeySig = "";
function keySvg(inner) {
  return '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">' + inner + "</svg>";
}
const KEY_SHAPES = {
  new: c => keySvg('<path d="M8 2.5 13.5 12.5H2.5Z" fill="' + c + '" stroke="' + c + '" stroke-width="1.4" stroke-linejoin="round"/>'),
  off: c => keySvg('<path d="M8 13.5 13.5 3.5H2.5Z" fill="none" stroke="' + c + '" stroke-width="1.6" stroke-linejoin="round"/>'),
  brighter: c => keySvg('<path d="M3 10.5 8 5l5 5.5" fill="none" stroke="' + c + '" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>'),
  dimmer: c => keySvg('<path d="M3 5.5 8 11l5-5.5" fill="none" stroke="' + c + '" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>')
};
function marksKeyItems() {
  const items = [], lr = isLR();
  if (state.similar?.result) {
    items.push([keySvg('<path d="M8 2.5 13.5 8 8 13.5 2.5 8Z" fill="rgba(236,236,239,.7)" stroke="#ececef" stroke-width="1.5"/>'), "מקום קשור: באותו כיוון"]);
    items.push([keySvg('<path d="M8 2.5 13.5 8 8 13.5 2.5 8Z" fill="none" stroke="#ececef" stroke-width="1.5" stroke-dasharray="2 2"/>'), "מקום קשור: בכיוון ההפוך"]);
  }
  if (state.side === "search" && srch.data) {
    for (const [shape, dir, label] of [["step", 1, "מדרגה למעלה"], ["step", -1, "מדרגה למטה"], ["trend", 1, "מגמה"], ["fluct", 0, "תנודתי"], ["spike", 1, "קפיצות"]])
      items.push([keySvg('<circle cx="8" cy="8" r="4.5" fill="' + shapeColor({ shape, direction: dir }) + '" stroke="rgba(8,8,10,.85)" stroke-width="1.2"/>'), label]);
  } else if (hotMode()) {
    if (state.marks && state.hot) items.push([keySvg('<circle cx="8" cy="8" r="5.5" fill="none" stroke="' + HOT + '" stroke-width="1.6"/>'), "מוקד חום: גדול ובהיר יותר = חזק יותר; מספר: 15 החזקים"]);
  } else if (state.marks && state.events.data) {
    for (const k of ["new", "off", "brighter", "dimmer"]) items.push([KEY_SHAPES[k](CHANGE_KINDS[k].color), CHANGE_LABELS[state.product][k][0]]);
    items.push([keySvg('<path d="M8 2.5 13.5 12.5H2.5Z" fill="none" stroke="#a1a1aa" stroke-width="1.5" stroke-dasharray="2 2"/>'), lr ? "מקווקו: ממתין ללילות בלי ירח, או לסירוגין" : "מקווקו: לסירוגין"]);
    items.push([keySvg('<path d="M8 2.5 13.5 12.5H2.5Z" fill="#a1a1aa" fill-opacity=".35" stroke="#a1a1aa" stroke-opacity=".45" stroke-width="1.4"/>'), "חיוור: חלש, או שכבר הסתיים"]);
  }
  if (state.sitesOn && state.sites) items.push([keySvg('<circle cx="8" cy="8" r="3.6" fill="none" stroke="rgba(255,138,61,.85)" stroke-width="1.4"/>'), "אתר להבה קבוע (TEMPER)"]);
  if (shownWindows().length) items.push([keySvg('<rect x="3" y="3" width="10" height="10" rx="1" fill="' + colorOf(shownWindows()[0]) + '33" stroke="' + colorOf(shownWindows()[0]) + '" stroke-width="1.4"/>'), "מקום בגרפים, במספר ובצבע שלו"]);
  if (coord.pin) items.push([keySvg('<circle cx="8" cy="8" r="4" fill="none" stroke="#fff" stroke-width="1.5"/><path d="M8 1v3.5M8 11.5V15M1 8h3.5M11.5 8H15" stroke="#fff" stroke-width="1.5"/>'), "נקודה מהחיפוש לפי קואורדינטות"]);
  return items;
}
function renderMarksKey() {
  if (typeof hotMode !== "function") return;   // before the page's scripts have all loaded
  const items = marksKeyItems(), sig = items.map(i => i[1]).join("|") + "|" + state.product + "|" + (I18N?.lang || "");
  if (sig === marksKeySig) return;
  marksKeySig = sig;
  const box = $("marksKey");
  box.replaceChildren();
  box.hidden = !items.length;
  for (const [svg, label] of items) {
    const row = mk("div", "key-row"), icon = mk("span", "key-icon");
    icon.innerHTML = svg;
    row.append(icon, mk("span", null, label));
    box.append(row);
  }
}
function renderMap() {
  ctx.clearRect(0, 0, state.width, state.height);
  if (!state.meta) return;
  const basemap = state.basemapOn && state.basemap;
  // Offline background map: land under the image, borders and names faintly over it.
  if (basemap) {
    ctx.save();
    ctx.fillStyle = LAND;
    ctx.beginPath();
    for (const c of basemap.countries) drawPath(ctx, c.geometry);
    ctx.fill("evenodd");
    ctx.restore();
  }
  ctx.save();
  ctx.lineWidth = .6;
  ctx.strokeStyle = "rgba(255,255,255,.04)";
  const grid = 250000;
  const tl = world(0, 0), br = world(state.width, state.height);
  ctx.beginPath();
  for (let x = Math.floor(tl[0] / grid) * grid; x < br[0]; x += grid) {
    const s = screen(x, 0);
    ctx.moveTo(s[0], 0);
    ctx.lineTo(s[0], state.height);
  }
  for (let y = Math.floor(br[1] / grid) * grid; y < tl[1]; y += grid) {
    const s = screen(0, y);
    ctx.moveTo(0, s[1]);
    ctx.lineTo(state.width, s[1]);
  }
  ctx.stroke();
  ctx.restore();
  if (state.image) {
    ctx.save();
    const focus = focusArea(), active = focus ? [areaGeometry(focus)] : activeGeometries();
    if ((focus || $("clipDisplay").checked) && active.length) {   // the area worked in: only inside it
      ctx.beginPath();
      for (const g of active) drawPath(ctx, g);
      ctx.clip();
    }
    const b = state.meta.bounds, tl = screen(b[0], b[3]), br = screen(b[2], b[1]);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(state.image, tl[0], tl[1], br[0] - tl[0], br[1] - tl[1]);
    if (state.cloudImage && isLR()) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(state.cloudImage, tl[0], tl[1], br[0] - tl[0], br[1] - tl[1]);
    }
    ctx.restore();
  }
  if (basemap) {
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,.16)";
    ctx.lineWidth = .7;
    ctx.beginPath();
    for (const c of basemap.countries) drawPath(ctx, c.geometry);
    ctx.stroke();
    ctx.restore();
    drawLabels(basemap.countries);
  }
  if (state.countryOn && state.meta.country) {
    ctx.save();
    ctx.strokeStyle = "rgba(236,236,239,.7)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    drawPath(ctx, state.meta.country);
    ctx.stroke();
    ctx.restore();
  }
  state.polygons.filter(p => p.enabled).forEach((p, i) => {
    ctx.save();
    ctx.strokeStyle = p.color || colors[i % colors.length];
    ctx.lineWidth = 1.7;
    ctx.fillStyle = ctx.strokeStyle + "12";
    ctx.beginPath();
    drawPath(ctx, p.geometry);
    ctx.fill("evenodd");
    ctx.stroke();
    ctx.restore();
  });
  if (state.sitesOn && state.sites) drawSites();
  if (hotMode()) {
    if (state.hot && state.marks) drawHot();
  } else if (state.marks && state.events.data) drawMarks();
  if (state.similar?.result) drawSimilar();
  drawFocusOutline();
  if (state.areaMark) {
    const [px, py] = screen(state.areaMark.x, state.areaMark.y);
    ctx.save();
    ctx.beginPath();
    ctx.arc(px, py, 11, 0, Math.PI * 2);
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(8,8,10,.8)";
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.strokeStyle = INK;
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.restore();
  }
  drawCoordPin();
  renderMarksKey();
  if (!state.hover) coordHover(null);   // the corner's coordinates follow the map's centre while the pointer is away
  if (state.side === "areas" && state.areas.length) drawAreas();
  if (typeof drawPoints === "function") drawPoints();   // the point layer (points.js, loaded after)
  if (state.side === "search" && srch.data) drawSearch();
  for (const w of shownWindows()) drawWindow(w);
  if (state.shift && state.hover && !state.drag && !state.drawing && inImage(state.hover)) drawHoverWindow(state.hover, placeSize()); // Shift: where a click adds a place
  if (state.drawing && state.vertices.length) {
    ctx.save();
    ctx.strokeStyle = "#8ec5ff";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    state.vertices.forEach((p, i) => {
      let s = screen(...p);
      i ? ctx.lineTo(...s) : ctx.moveTo(...s);
    });
    if (state.hover) ctx.lineTo(...screen(...state.hover));
    ctx.stroke();
    for (const p of state.vertices) {
      const s = screen(...p);
      ctx.beginPath();
      ctx.arc(...s, 3, 0, Math.PI * 2);
      ctx.fillStyle = "#8ec5ff";
      ctx.fill();
    }
    ctx.restore();
  }
  const desired = 100 / state.zoom;
  const exponent = 10 ** Math.floor(Math.log10(desired));
  const length = [1, 2, 5, 10].map(n => n * exponent).reduce((best, n) => Math.abs(n - desired) < Math.abs(best - desired) ? n : best, exponent);
  $("mapScale").style.width = length * state.zoom + "px";
  const label = document.createElement("span");
  label.textContent = km(length / 1000);
  $("mapScale").replaceChildren(label);
}
async function loadBasemap() {
  const id = state.meta?.id;
  try {
    const basemap = await api("/api/basemap");
    if (state.meta?.id !== id) return;
    for (const c of basemap.countries) {
      const g = c.geometry, rings = g.type === "Polygon" ? g.coordinates : g.coordinates.flat();
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const ring of rings) for (const p of ring) {
        x0 = Math.min(x0, p[0]);
        x1 = Math.max(x1, p[0]);
        y0 = Math.min(y0, p[1]);
        y1 = Math.max(y1, p[1]);
      }
      c.size = x1 - x0;
      c.area = (x1 - x0) * (y1 - y0);
    }
    basemap.countries.sort((a, b) => b.area - a.area);
    state.basemap = basemap;
  } catch { }
  renderMap();
}
// Hover readout: one pixel request in flight at a time; the newest position wins. Independent of the display range.
// Big value: the two-band source temperature where both bands are at least 10 sigma above the night's noise; otherwise
// whether the pixel clears the night's detection threshold. Small line: each band's radiance and distance above the
// noise for this viewing angle (sigma). A pixel brightness temperature of noise reads ~130-180 °C and means nothing.
// Without a source temperature the big value is M15 (10.8 µm): the ground, or the cloud top where the place is flagged cloudy.
function sigma(z) {
  return z == null || !Number.isFinite(z) ? "" : " (" + (Math.abs(z) >= 10 ? Math.round(z) : z.toFixed(1)) + "σ)";
}
function thermalText(r) {
  return r.m15_k == null ? "" : (r.cloud ? "ענן " : "קרקע ") + celsius(r.m15_k, 1);
}
// LIGHT ROAST: the night's radiance (or cloud), and the last 7 nights against the usual (median of each, change and z).
function showLightPixel(r) {
  const value = $("pixelValue"), status = $("pixelCelsius"), label = $("pixelLabel"), detail = $("pixelRaw");
  $("pixelRow").hidden = !r;
  value.textContent = "—";
  status.textContent = "";
  label.textContent = "";
  detail.textContent = "";
  value.parentElement.hidden = !(r && r.inside);
  if (!r) return;
  if (!r.inside) {
    detail.textContent = "מחוץ לתמונה";
    return;
  }
  if (r.radiance_nw != null) {
    value.textContent = nw(r.radiance_nw);
    label.textContent = "אורות הלילה";
  } else {
    value.textContent = r.cloud ? "ענן" : "—";
    label.textContent = r.cloud ? "אין תצפית הלילה" : "אין תצפית שמישה הלילה";
  }
  if (r.ratio != null) {
    const kinds = { new: "נדלק", off: "כבה", brighter: "התבהר", dimmer: "התעמעם" };
    status.textContent = (r.kind ? kinds[r.kind] + " · " : "") + pct(r.ratio) + " מהרגיל";
    detail.textContent = "השבוע " + nw(r.recent_nw) + " · בדרך כלל " + nw(r.baseline_nw) + " · " + ltr(r.z.toFixed(1) + "σ");
  } else detail.textContent = "אין מספיק לילות בלי ענן להשוואה";
  // Without the constant lights: whether this pixel is one of them, and its usual level over the frame.
  if (r.steady) detail.textContent += " · " + (r.steady.constant ? "אור קבוע: מואר ב־" + Math.round(r.steady.share * 100) + "% מהלילות, בדרך כלל " + nw(r.steady.usual_nw) : "לא קבוע: מואר ב־" + Math.round(r.steady.share * 100) + "% מהלילות");
  // The repository's method: the night after SFAC against the stable nights (score in its σ, brightening only).
  if (state.lr.method === "rx" && r.rx_score != null) {
    status.textContent = (r.rx_anomaly ? "חריג · " : "") + "RX " + ltr(r.rx_score.toFixed(1) + "σ");
    detail.textContent = "הלילה אחרי SFAC " + nw(r.rx_night_nw) + " · יציב " + nw(r.rx_mean_nw) + " ± " + nw(r.rx_std_nw) + " · " + r.rx_stable_nights + " לילות";
  }
}
// A period's pixel: TEMPER its strongest night (temperature where measured, else how far above the noise) and on how
// many nights it was clearly hot; LIGHT ROAST the median of its clear nights.
function showPeriodPixel(r) {
  const value = $("pixelValue"), status = $("pixelCelsius"), label = $("pixelLabel"), detail = $("pixelRaw"), c = r.composite;
  $("pixelRow").hidden = false;
  value.parentElement.hidden = !c;
  status.textContent = label.textContent = detail.textContent = "";
  value.textContent = "—";
  if (!c) {
    detail.textContent = "ההרכב עוד נבנה";
    return;
  }
  const span = periodName(c.days);
  if (isLR()) {
    value.textContent = nw(c.median_nw);
    label.textContent = "חציון " + span;
    detail.textContent = "לילות בהירים: " + c.clear_nights + " מתוך " + c.nights;
    return;
  }
  value.textContent = c.temperature_k != null ? celsius(c.temperature_k) : c.sig_max != null ? ltr(Math.round(c.sig_max) + "σ") : "—";
  label.textContent = "הלילה החזק, " + span;
  detail.textContent = "חם ב־" + c.hot_nights + " מתוך " + c.seen_nights + " לילות · " + "M10 מקס׳ " + ltr(scientific(c.m10_max) + " " + RADIANCE);
}
function showPixel(r) {
  if (r && r.inside && (r.composite || r.preparing)) return showPeriodPixel(r);
  if (isLR()) return showLightPixel(r);
  const value = $("pixelValue"), status = $("pixelCelsius"), label = $("pixelLabel"), detail = $("pixelRaw");
  $("pixelRow").hidden = !r;
  value.parentElement.hidden = !(r && r.inside && r.value !== null);
  value.textContent = "—";
  status.textContent = "";
  label.textContent = "";
  detail.textContent = "";
  if (!r) return;
  if (!r.inside) {
    detail.textContent = "מחוץ לתמונה";
    return;
  }
  if (r.value === null) {
    detail.textContent = "אין נתונים בלילה הזה";
    return;
  }
  const thermal = thermalText(r);
  let extra = thermal;
  if (r.temperature_k) {
    value.textContent = celsius(r.temperature_k);
    status.textContent = ltr("± " + Math.round(r.temperature_sd_k) + " °C");
    label.textContent = "טמפ׳ מקור M10/M11";
  } else {
    status.textContent = r.above_threshold ? "מעל סף הגילוי" : "ברמת הרעש";
    if (r.m15_k != null) {
      value.textContent = celsius(r.m15_k, 1);
      label.textContent = r.cloud ? "ענן · M15" : "קרקע · M15";
      extra = "";
    }
  }
  detail.textContent = ltr("M10 " + scientific(r.value) + sigma(r.sigma10) + (r.m11 != null ? " · M11 " + scientific(r.m11) + sigma(r.sigma11) : "") + " " + RADIANCE) + (r.view_zenith != null ? " · " + ltr(Math.round(r.view_zenith) + "°") : "") + (extra ? " · " + extra : "");
}
function queryPixel(p) {
  if (!state.date) return;
  const seq = ++pixelSeq;
  if (!inImage(p)) {
    pixelNext = null;
    pixelShown = seq;
    showPixel({ inside: false });
    return;
  }
  pixelNext = { seq, date: state.date, x: p[0], y: p[1], product: state.product, days: mapDays() };
  pumpPixel();
}
function clearPixel() {
  pixelShown = ++pixelSeq;
  pixelNext = null;
  showPixel(null);
}
async function pumpPixel() {
  if (pixelBusy || !pixelNext) return;
  const job = pixelNext;
  pixelNext = null;
  pixelBusy = true;
  try {
    const lr = job.product === LR, q = new URLSearchParams(lr ? { date: job.date, x: job.x, y: job.y, window: lrWindow(), method: state.lr.method } : { date: job.date, x: job.x, y: job.y });
    if (job.days > 1) q.set("days", job.days);
    if (lr && state.lr.steady && state.lr.view === "lights" && typeof srch !== "undefined") {
      q.set("steady", "1");
      q.set("from", srch.from);
      q.set("to", srch.to);
    }
    const r = await api((lr ? "/api/lr/pixel?" : "/api/pixel?") + q);
    if (job.seq > pixelShown && state.hover && job.date === state.date && job.product === state.product) {
      pixelShown = job.seq;
      showPixel(r);
    }
  } catch { } finally {
    pixelBusy = false;
    pumpPixel();
  }
}
function updateDays() {
  const select = $("daySelect");
  select.replaceChildren();
  $("dateStrip").replaceChildren();
  for (const date of productDates()) {
    const option = document.createElement("option");
    option.value = date;
    option.textContent = displayDate(date, true);
    select.append(option);
    const d = new Date(date + "T12:00:00"), button = document.createElement("button");
    button.className = "day-chip";
    button.dataset.date = date;
    button.setAttribute("aria-label", displayDate(date, true));
    button.textContent = d.getDate();
    button.title = d.toLocaleDateString(LOCALE, { weekday: "long", day: "numeric", month: "long" });
    button.onclick = () => setDay(date);
    $("dateStrip").append(button);
  }
  if (state.date) {   // rebuilt (a new language): keep showing the night that is open
    select.value = state.date;
    document.querySelectorAll(".day-chip").forEach(b => b.classList.toggle("active", b.dataset.date === state.date));
  }
}
function chooseDate(delta) {
  const dates = productDates(), i = dates.indexOf(state.date);
  const d = dates[i + delta];
  if (!d) return;
  if (CHART_TAB) channel?.postMessage({ type: "day", date: d }); else setDay(d);
}
// The shown night is shared: switching product keeps it, or takes that product's nearest night.
async function setDay(date) {
  if (!state.meta) return;
  const dates = productDates(), lr = isLR();
  if (!dates.includes(date)) date = nearestDate(dates, date);
  if (!date) return;
  state.date = date;
  $("daySelect").value = date;
  document.querySelectorAll(".day-chip").forEach(b => b.classList.toggle("active", b.dataset.date === date));
  const i = dates.indexOf(date);
  $("previousDay").disabled = i === 0;
  $("nextDay").disabled = i === dates.length - 1;
  const days = mapDays();
  if (days > 1) $("sourceBadge").textContent = periodText(days); else if (lr) $("sourceBadge").textContent = "Black Marble · VNP46A2"; else {
    const n = state.meta.passes?.[date] || 0;
    $("sourceBadge").textContent = n === 1 ? "מעבר אחד" : n + " מעברים";
  }
  const steady = lr && state.lr.steady && state.lr.view === "lights", frame = typeof srch !== "undefined" ? srch : { from: "", to: "" };
  $("mapTitle").textContent = (days > 1 ? "הרכב · " + periodText(days) : (lr ? "אורות הלילה, " : "תמונת הלילה, ") + displayDate(date, true)) + (steady ? " · בלי האורות הקבועים" : "");
  loadList();
  renderLegend();
  renderChart();
  // a night of the block already shown: its map stays (only leaving the block asks for another)
  const key = days > 1 ? [state.meta.id, lr ? LR : "temper", lr ? state.lr.view : state.band, days, periodSpan(days, date)[0], steady ? "steady " + frame.from + " " + frame.to : ""].join("|") : null;
  if (key && key === state.imageKey && state.image) {
    if (state.hover) queryPixel(state.hover);
    return;
  }
  $("mapLoading").hidden = false;
  const nonce = ++state.imageNonce;
  try {
    const query = lr ? new URLSearchParams({ date, view: state.lr.view, window: lrWindow(), method: state.lr.method }) : new URLSearchParams({ date, low: state.low, high: state.high, palette: state.palette, band: state.band });
    if (days > 1) query.set("days", days);
    if (steady) {
      query.set("steady", "1");
      query.set("from", frame.from);
      query.set("to", frame.to);
    }
    const clouds = lr && state.lr.view !== "typical" && days === 1 ? fetch("/api/lr/clouds?" + new URLSearchParams({ date })).then(r => r.ok ? r.blob() : null).then(b => b ? createImageBitmap(b) : null).catch(() => null) : Promise.resolve(null);
    let response;
    for (;;) {   // 202: the period is still being built
      response = await fetch((lr ? "/api/lr/image?" : "/api/image?") + query);
      if (response.status !== 202) break;
      const p = await response.json();
      if (nonce !== state.imageNonce) return;
      $("mapLoadingText").textContent = (steady ? "מחשב את האורות הקבועים · " : "בונה את ההרכב · ") + Math.round(100 * p.done / Math.max(1, p.total)) + "%";
      await new Promise(r => setTimeout(r, 1000));
      if (nonce !== state.imageNonce) return;
    }
    $("mapLoadingText").textContent = "";
    if (!response.ok) {
      let e = await response.json();
      throw Error(e.error);
    }
    const blob = await response.blob();
    const image = await createImageBitmap(blob), cloud = await clouds;
    if (nonce !== state.imageNonce) {
      image.close();
      cloud?.close();
      return;
    }
    if (state.image) state.image.close();
    if (state.cloudImage) state.cloudImage.close();
    state.image = image;
    state.imageKey = key;
    state.cloudImage = cloud;
    renderMap();
    if (state.hover) queryPixel(state.hover);
    if (state.side === "areas") renderAreas();
  } catch (e) {
    if (nonce === state.imageNonce) toast(e.message);
  } finally {
    if (nonce === state.imageNonce) $("mapLoading").hidden = true;
  }
}
function persistPolygons() {
  if (state.meta) localStorage.setItem("temper-polygons-" + state.meta.id, JSON.stringify(state.polygons));
}
function polygonRow(label, color, checked, change, remove) {
  const row = document.createElement("label");
  row.className = "polygon-row";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  input.onchange = () => change(input.checked);
  const swatch = document.createElement("span");
  swatch.className = "swatch";
  swatch.style.borderColor = color;
  const name = document.createElement("span");
  name.textContent = label;
  row.append(input, swatch, name);
  if (remove) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "delete-polygon";
    button.textContent = "×";
    button.title = "הסרה";
    button.onclick = e => {
      e.preventDefault();
      remove();
    };
    row.append(button);
  }
  return row;
}
function polygonsChanged() {
  persistPolygons();
  renderMap();
  if ($("sampleClip").checked) resampleAll();
}
function renderPolygons() {
  const list = $("polygonList");
  list.replaceChildren();
  list.append(polygonRow("מפת רקע", "rgba(236,236,239,.35)", state.basemapOn, v => {
    state.basemapOn = v;
    renderMap();
  }));
  list.append(polygonRow("אתרי להבות קבועים (TEMPER)", "#ff8a3d", state.sitesOn, v => {
    state.sitesOn = v;
    if (v && !state.sites) loadSites();
    renderMap();
  }));
  if (state.meta.country) list.append(polygonRow(countryName(state.meta), INK, state.countryOn, v => {
    state.countryOn = v;
    polygonsChanged();
  }));
  state.polygons.forEach((p, i) => list.append(polygonRow(p.name, p.color, p.enabled, v => {
    p.enabled = v;
    polygonsChanged();
  }, () => {
    state.polygons.splice(i, 1);
    renderPolygons();
    polygonsChanged();
  })));
}
function addPolygon(name, geometry) {
  state.polygons.push({ name, geometry, enabled: true, color: colors[state.polygons.length % colors.length] });
  renderPolygons();
  polygonsChanged();
}
function updateHint() {
  const hint = $("mapHint");
  hint.textContent = state.drawing ? "לחיצה לכל נקודה · Enter לסיום · Esc ביטול" : "";
  hint.hidden = !hint.textContent;
  $("mapTip").hidden = state.drawing || state.windows.length > 0;
}
function toggleDrawing(force) {
  state.drawing = force === undefined ? !state.drawing : force;
  state.vertices = [];
  if (!state.drawing) state.drawFor = null;
  $("drawButton").textContent = state.drawing ? "ביטול הציור" : "ציור פוליגון";
  $("mapWrap").classList.toggle("drawing", state.drawing);
  updateHint();
  renderMap();
}
function finishDrawing() {
  if (state.vertices.length < 3) {
    toast("צריך לפחות שלוש נקודות.");
    return;
  }
  const ring = state.vertices.map(p => [...p]);
  if (ring.length > 3 && ring[ring.length - 1][0] === ring[ring.length - 2][0] && ring[ring.length - 1][1] === ring[ring.length - 2][1]) ring.pop();
  ring.push(ring[0]);
  if (state.drawFor === "focus") {
    const a = createPolygonArea(ring, { rename: false });
    if (a) {
      setWorkArea(a);
      startRename(a);   // after the focus has drawn the list again, so the name stays open for editing
    }
  } else if (state.drawFor === "area") createPolygonArea(ring); else addPolygon("פוליגון " + (state.polygons.length + 1), { type: "Polygon", coordinates: [ring] });
  toggleDrawing(false);
}
function projectedLonLat(p) {
  if (!state.meta || state.meta.crs !== "EPSG:6933") return null;
  const a = 6378137, e = .08181919084262149, phi30 = Math.PI / 6, k0 = Math.cos(phi30) / Math.sqrt(1 - e * e * Math.sin(phi30) ** 2), q = p[1] * 2 * k0 / a;
  let phi = Math.asin(Math.max(-1, Math.min(1, q / 2)));
  for (let i = 0; i < 8; i++) {
    const s = Math.sin(phi), ec = e * s, qp = (1 - e * e) * (s / (1 - ec * ec) - Math.log((1 - ec) / (1 + ec)) / (2 * e)), der = 2 * (1 - e * e) * Math.cos(phi) / (1 - ec * ec) ** 2;
    phi -= (qp - q) / der;
  }
  return [p[0] / (a * k0) * 180 / Math.PI, phi * 180 / Math.PI];
}
function flyTo(x, y, zoom) {
  state.cx = x;
  state.cy = y;
  state.zoom = Math.max(state.zoom, state.fitZoom * zoom);
  renderMap();
}
// Right-click on the map: copy the point's coordinates, or put a sampling window there.
function closeMenu() {
  $("mapMenu").hidden = true;
}
canvas.addEventListener("contextmenu", e => {
  e.preventDefault();
  if (!state.meta) return;
  const r = canvas.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top, p = world(sx, sy), ll = projectedLonLat(p);
  state.menuPoint = p;
  $("menuCoords").textContent = ll ? coordString(ll) : "";
  $("menuCopy").disabled = !ll;
  $("menuWindow").disabled = !inImage(p);
  const menu = $("mapMenu");
  menu.hidden = false;
  menu.style.left = Math.max(8, Math.min(sx, state.width - menu.offsetWidth - 8)) + "px";
  menu.style.top = Math.max(8, Math.min(sy, state.height - menu.offsetHeight - 8)) + "px";
});
$("menuCopy").onclick = async () => {
  const text = coordString(projectedLonLat(state.menuPoint));
  closeMenu();
  try {
    await navigator.clipboard.writeText(text);
    toast("הועתק: " + ltr(text));
  } catch {
    toast("ההעתקה נכשלה.");
  }
};
$("menuWindow").onclick = () => {
  closeMenu();
  openPlace(state.menuPoint, { add: true });
};
$("menuSimilar").onclick = () => {
  closeMenu();
  const p = state.menuPoint;
  findSimilar({ x: p[0], y: p[1], product: state.product, label: "נקודה במפה" });
};
// Context: TEMPER's steady flare sites (burning on at least a fifth of their nights), as small rings on the map.
async function loadSites() {
  const id = state.meta?.id;
  try {
    const r = await api("/api/sites");
    if (state.meta?.id !== id) return;
    state.sites = r.sites;
    renderMap();
  } catch (e) {
    toast(e.message);
  }
}
function drawSites() {
  ctx.save();
  ctx.strokeStyle = "rgba(255,138,61,.75)";
  ctx.lineWidth = 1.3;
  for (const s of state.sites) {
    const [px, py] = screen(s.x, s.y);
    if (px < -10 || py < -10 || px > state.width + 10 || py > state.height + 10) continue;
    ctx.beginPath();
    ctx.arc(px, py, 3.5, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}
// The raw M10/M11 bands in the legend, for experts (settings).
function setRawBands(on) {
  document.body.classList.toggle("raw-bands", on);
  $("rawBands").checked = on;
  try {
    localStorage.setItem("viewer-raw-bands", on ? "1" : "0");
  } catch { }
  if (!on && (state.band === "m10" || state.band === "m11")) setBand("combo");
}
$("rawBands").onchange = () => setRawBands($("rawBands").checked);
{
  let on = false;
  try {
    on = localStorage.getItem("viewer-raw-bands") === "1";
  } catch { }
  document.body.classList.toggle("raw-bands", on);
  $("rawBands").checked = on;
}
document.addEventListener("pointerdown", e => {
  if (!$("mapMenu").contains(e.target)) closeMenu();
}, true);
// Band shown on the map, in the readout and in the chart's radiance averages (the temperature uses both bands).
// "combo" = the M10+M11 composite on the night's corrections (the chart then uses M10); "m10"/"m11" = raw radiance,
// where the Display range and palette apply; "m15" = thermal (10.8 µm) on a fixed -40 to 45 °C scale, warm dark, cold
// cloud tops white, flagged cloud blue (the chart then uses M10).
// ---------- the period on the map: the night, or a composite of the calendar block holding it ----------
// Its week (Monday to Sunday), its 16-day cycle (one orbit cycle: every viewing angle once), its month or its year
// (server.py: composites, period_span). TEMPER's combined view: per pixel its strongest night, coloured by that night's
// source temperature; LIGHT ROAST's lights: the median of each pixel's clear nights. The other views (raw bands,
// thermal; change, usual) are of the night alone. Moving between nights of one block keeps its map: nothing reloads
// until the block is left.
const PERIODS = [1, 7, 16, 30, 365];
state.period = 1;
try {
  const p = Number(localStorage.getItem("viewer-period"));
  if (PERIODS.includes(p)) state.period = p;
} catch { }
function periodAllowed() {
  return isLR() ? state.lr.view === "lights" : state.band === "combo";
}
function mapDays() {
  return periodAllowed() ? state.period : 1;
}
// The calendar block of `days` holding the night, [first day, last day] (as server.py: period_span); 16-day blocks count
// from Monday 2 Jan 2012.
const CYCLE_EPOCH = Date.UTC(2012, 0, 2);
function periodSpan(days, date = state.date) {
  const t = dayTime(date), d = new Date(t), iso = x => new Date(x).toISOString().slice(0, 10);
  let s, e;
  if (days === 7) {
    s = t - (d.getUTCDay() + 6) % 7 * DAY;
    e = s + 6 * DAY;
  } else if (days === 16) {
    s = CYCLE_EPOCH + Math.floor((t - CYCLE_EPOCH) / (16 * DAY)) * 16 * DAY;
    e = s + 15 * DAY;
  } else if (days === 30) {
    s = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    e = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0);
  } else {
    s = Date.UTC(d.getUTCFullYear(), 0, 1);
    e = Date.UTC(d.getUTCFullYear(), 11, 31);
  }
  return [iso(s), iso(e)];
}
function periodNights(days, date = state.date, dates = productDates()) {
  const [s, e] = periodSpan(days, date);
  return dates.filter(d => d >= s && d <= e).length;
}
function periodName(days, date = state.date) {
  const [s, e] = periodSpan(days, date);
  if (days === 30) return new Date(dayTime(s)).toLocaleDateString(LOCALE, { month: "long", year: "numeric", timeZone: "UTC" });
  if (days === 365) return s.slice(0, 4);
  return (days === 7 ? "שבוע " : "מחזור 16 יום ") + displayDate(s) + " – " + displayDate(e, true);
}
function periodText(days) {
  return periodName(days) + " · " + periodNights(days) + " לילות";
}
function renderPeriod() {
  const ok = periodAllowed();
  for (const b of document.querySelectorAll("#periodSeg button")) {
    const on = Number(b.dataset.days) === (ok ? state.period : 1);
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", on);
    b.disabled = !ok && b.dataset.days !== "1";
  }
  $("periodSeg").title = ok ? "" : isLR() ? "הרכב של תקופה: בתצוגת האורות" : "הרכב של תקופה: בתצוגה המשולבת";
}
for (const b of document.querySelectorAll("#periodSeg button")) b.onclick = () => {
  state.period = Number(b.dataset.days);
  try {
    localStorage.setItem("viewer-period", state.period);
  } catch { }
  renderPeriod();
  setDay(state.date);
};
function bandLegend() {
  renderPeriod();
  if (isLR()) {
    const change = state.lr.view === "change";
    $("colorRamp").className = "ramp " + (change ? "lightchange" : "lights");
    $("colorRamp").style.background = "";
    $("legendLow").textContent = change ? "התעמעם" : "0.5";
    $("legendHigh").textContent = change ? "התבהר" : "100 nW";
    return;
  }
  const combo = state.band === "combo", thermal = state.band === "m15", fixed = combo || thermal;
  $("colorRamp").className = "ramp";
  $("colorRamp").classList.toggle("temperature", combo);
  $("colorRamp").classList.toggle("thermal", thermal);
  $("colorRamp").style.background = fixed ? "" : state.palette === "gray" ? "linear-gradient(90deg,#000,#fff)" : "";
  $("legendLow").textContent = combo ? "700 °C" : thermal ? "45 °C" : state.low;
  $("legendHigh").textContent = combo ? "2,300 °C" : thermal ? "−40 °C" : state.high;
  for (const id of ["palette", "displayLow", "displayHigh", "applyDisplay"]) $(id).disabled = fixed;
}
function setBand(b) {
  if (state.band === b) return;
  const chartBand = s => s === "m11" ? "m11" : "m10";
  const refit = state.metric !== "temperature" && chartBand(state.band) !== chartBand(b);
  state.band = b;
  for (const [id, v] of [["bandCombo", "combo"], ["bandM10", "m10"], ["bandM11", "m11"], ["bandM15", "m15"]]) $(id).classList.toggle("active", b === v);
  bandLegend();
  if (refit) {
    state.chartLow = state.chartHigh = null;
    $("chartLow").value = $("chartHigh").value = "";
    fitChart(true);
  }
  renderLegend();
  renderChart();
  setDay(state.date);
}
$("bandCombo").onclick = () => setBand("combo");
$("bandM10").onclick = () => setBand("m10");
$("bandM11").onclick = () => setBand("m11");
$("bandM15").onclick = () => setBand("m15");
bandLegend();
// LIGHT ROAST map: the night's lights, or the last 7 nights' change against the baseline.
function setLightView(v) {
  if (state.lr.view === v) return;
  state.lr.view = v;
  $("lrViewLights").classList.toggle("active", v === "lights");
  $("lrViewChange").classList.toggle("active", v === "change");
  $("lrViewTypical").classList.toggle("active", v === "typical");
  $("steadyHide").disabled = v !== "lights";
  bandLegend();
  setDay(state.date);
}
// Without the constant lights: what is lit on almost every clear night of the search's frame (all the nights without
// one) dims on the map, so what is not always there stands out (server.py: steady_png).
$("steadyHide").onchange = () => {
  state.lr.steady = $("steadyHide").checked;
  state.imageKey = null;
  setDay(state.date);
};
$("lrViewLights").onclick = () => setLightView("lights");
$("lrViewTypical").onclick = () => setLightView("typical");
$("lrViewChange").onclick = () => setLightView("change");
$("drawButton").onclick = () => {
  setPop("layersButton", false);
  toggleDrawing();
};
$("fitMap").onclick = fitMap;
$("zoomIn").onclick = () => zoomAt(1.4);
$("zoomOut").onclick = () => zoomAt(1 / 1.4);
$("previousDay").onclick = () => chooseDate(-1);
$("nextDay").onclick = () => chooseDate(1);
$("daySelect").onchange = e => setDay(e.target.value);
// Only inside the country: the image is cut to the country's border (and the layers that are on). Remembered.
$("clipDisplay").onchange = () => {
  try {
    localStorage.setItem("viewer-clip", $("clipDisplay").checked ? "1" : "0");
  } catch { }
  renderMap();
};
try {
  $("clipDisplay").checked = localStorage.getItem("viewer-clip") === "1";
} catch { }
$("applyDisplay").onclick = () => {
  const low = Number($("displayLow").value), high = Number($("displayHigh").value);
  if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) {
    toast("המקסימום חייב להיות גדול מהמינימום.");
    return;
  }
  state.low = low;
  state.high = high;
  state.palette = $("palette").value;
  bandLegend();
  setDay(state.date);
};
for (const id of ["displayLow", "displayHigh"]) $(id).onkeydown = e => {
  if (e.key === "Enter") $("applyDisplay").click();
};
$("palette").onchange = () => $("applyDisplay").click();
$("importButton").onclick = () => $("vectorFile").click();   // read in points.js: polygons to the layers, points to their tab
wheelSteps(document.querySelector(".nights"), n => {
  if (!state.meta) return;
  const dates = productDates(), i = dates.indexOf(state.date), d = dates[Math.max(0, Math.min(dates.length - 1, i + n))];
  if (!d || d === state.date) return;
  if (CHART_TAB) channel?.postMessage({ type: "day", date: d }); else setDay(d);
});
