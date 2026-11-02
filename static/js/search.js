"use strict";
// חיפוש: places by the shape of their year (server: /api/behaviour), the SQL-like line, and groups among the results.

// ---------- search by behaviour ----------
// Places by the shape of their year (server: /api/behaviour, shapes): a step (one lasting change), swings (on and
// off, again and again), a trend over the year, or spikes on single nights. The buttons write the SQL-like line; the
// line can be edited and run as it is (Enter). Groups among the results: steps by when and where, swings by moving
// together. A result opens like a change's row: its place in the graphs; ☆ keeps it; ≈ asks where else (a step at
// its night) or what moves with it.
// The time frame (from, to; empty: all the nights): the shapes are worked out on its nights only; "constant" finds
// what is constant through it (heat: sites burning on most of its nights; lights: places lit on almost all of its
// clear nights), and the map can hide the constant lights over it (js/map.js: steadyHide).
const srch = { data: null, busy: false, error: null, group: null, active: null, seq: 0, shape: "step", dir: "down", from: "", to: "" };
const SHAPE_LABELS = { step: "מדרגה", trend: "מגמה", fluct: "תנודתי", spike: "קפיצות", stable: "יציב", constant: "קבוע" };
function shapeColor(x) {
  return x.shape === "step" ? (x.direction > 0 ? "#2fa36b" : "#5b8fea") : x.shape === "trend" ? "#a07ce8" : x.shape === "fluct" ? "#d67a26" : x.shape === "spike" ? "#ececef" : x.shape === "constant" ? "#f2c94c" : "#6e6e78";
}
function shapeMark(x) {
  return x.shape === "step" ? (x.direction > 0 ? "▲" : "▼") : x.shape === "trend" ? (x.direction > 0 ? "↗" : "↘") : x.shape === "fluct" ? "∿" : x.shape === "spike" ? "⌃" : x.shape === "constant" ? "■" : "–";
}
function buildQuery() {
  const parts = [], shape = srch.shape;
  if (shape === "constant") {   // not a shape: no direction, size or date
    parts.push("shape = constant");
    const where = $("qWithin").value;
    if (where && where !== "country") parts.push("within = " + (where === "view" ? "view" : "'" + where.replace(/'/g, "") + "'"));
    $("queryText").value = parts.join(" AND ");
    return;
  }
  if (shape) parts.push("shape = " + shape);
  if (srch.dir && shape !== "fluct" && shape !== "spike") parts.push("direction = " + srch.dir);
  const ch = $("qChange").value;
  if (ch) parts.push("change >= " + ch);
  const w = $("qWhen").value, dates = productDates(), last = dates[dates.length - 1];
  if (w && (shape === "step" || shape === "spike")) {
    if (w === "graph") {
      if (state.rangeFrom || state.rangeTo) parts.push("when BETWEEN " + (state.rangeFrom || dates[0]) + " AND " + (state.rangeTo || last));
    } else parts.push("when BETWEEN " + dateMinus(last, Number(w) - 1) + " AND " + last);
  }
  const where = $("qWithin").value;
  if (where && where !== "country") parts.push("within = " + (where === "view" ? "view" : "'" + where.replace(/'/g, "") + "'"));
  $("queryText").value = parts.join(" AND ");
}
function searchView() {
  const tl = world(0, 0), br = world(state.width, state.height);
  return [Math.min(tl[0], br[0]), Math.min(tl[1], br[1]), Math.max(tl[0], br[0]), Math.max(tl[1], br[1])];
}
async function runSearch() {
  if (!state.meta) return;
  const seq = ++srch.seq;
  srch.busy = true;
  srch.error = null;
  renderSearch();
  const areas = {};
  for (const a of state.areas) areas[a.name] = a.geometry || [a.center[0] - a.size_km * 500, a.center[1] - a.size_km * 500, a.center[0] + a.size_km * 500, a.center[1] + a.size_km * 500];
  try {
    const r = await api("/api/behaviour", { product: state.product, query: $("queryText").value, view: searchView(), areas, focus: focusArea() ? areaGeometry(focusArea()) : null, from: srch.from, to: srch.to });
    if (seq !== srch.seq) return;
    srch.data = r;
    srch.group = null;
    srch.active = null;
  } catch (e) {
    if (seq !== srch.seq) return;
    srch.error = e.message;
    srch.data = null;
  } finally {
    if (seq === srch.seq) srch.busy = false;
  }
  renderSearch();
  renderMap();
}
function searchRows() {
  const r = srch.data;
  if (!r) return [];
  return srch.group ? srch.group.members.map(k => r.results[k]) : r.results;
}
// What a result did: a step's size and night, a trend over the year, the swing and how often, the spikes.
function searchText(x, product) {
  const lr = product === LR, size = lr ? "פי " + ltr(fmt(Math.exp(x.change))) : ltr(x.change.toFixed(1) + "σ");
  if (x.shape === "step") return (x.direction > 0 ? "עלה " : "ירד ") + size + " ב־" + displayDate(x.when);
  if (x.shape === "trend") return (x.direction > 0 ? "עלייה " : "ירידה ") + size + " בשנה";
  if (x.shape === "fluct") return "תנודתי " + size + " · " + x.switches + " מעברים";
  if (x.shape === "spike") return "קפיצות " + size + " · " + ltr(Math.round(x.spikes * 1000) / 10 + "%") + " מהלילות";
  if (x.shape === "constant") return (lr ? "מואר ב־" : "בוער ב־") + Math.round(x.lit_share * 100) + "% מהלילות" + (x.year_shape && x.year_shape !== "stable" ? " · " + SHAPE_LABELS[x.year_shape] : "");
  return "יציב";
}
function searchLevel(x, product) {
  return product === LR ? nw(x.level) : "דלוק ב־" + Math.round(x.level * 100) + "% מהלילות";
}
function searchRow(x, product) {
  const li = mk("li"), go = mk("button", "ev-item" + (srch.active === x ? " active" : "")), mark = mk("span", "chg-mark", shapeMark(x));
  mark.style.setProperty("color", shapeColor(x));
  const top = mk("span", "ev-top"), sub = mk("span", "ev-sub");
  top.append(mk("b", null, searchText(x, product)), mk("span", "ev-kind", SHAPE_LABELS[x.shape]));
  sub.append(mk("span", "ev-when", searchLevel(x, product) + (x.shape === "step" || x.shape === "trend" ? " · התאמה " + ltr(x.fit.toFixed(2)) : "")), mk("span", "ev-where", ltr(coordText(x.lonlat, 3))));
  const body = mk("span", "ev-body");
  body.append(top, sub);
  go.append(mark, body);
  go.title = SHAPE_LABELS[x.shape] + ": " + searchText(x, product) + "\n" + searchLevel(x, product) + (x.fit ? " · התאמת הצורה (R²) " + x.fit : "") + (x.switches ? " · " + x.switches + " מעברים בין הרמות" : "") + "\nלחיצה: המקום לאורך זמן · Shift+לחיצה או A: להוסיף להשוואה";
  go.onclick = ev => selectSearch(x, ev.shiftKey);
  go.dataset.addShift = "";
  const acts = mk("span", "row-acts"), name = () => SHAPE_LABELS[x.shape] + (x.when ? " · " + displayDate(x.when) : "") + " · " + (x.direction > 0 ? "עלה" : x.direction < 0 ? "ירד" : "");
  const seed = { x: x.x, y: x.y, size_km: 2.25, product, label: SHAPE_LABELS[x.shape] + (x.when ? " ב־" + displayDate(x.when) : "") };
  if (x.shape === "step") Object.assign(seed, { onset: x.when, last: x.when, kind: x.direction > 0 ? "brighter" : "dimmer" });
  acts.append(keepButton(x.x, x.y, 2.25, name), similarButton(seed));
  li.append(go, acts);
  return li;
}
function selectSearch(x, add, fly = true) {
  srch.active = x;
  if (srch.data?.frame && (srch.from || srch.to)) {   // a frame: the graph shows it
    $("rangeFrom").value = srch.data.frame[0];
    $("rangeTo").value = srch.data.frame[1];
    setRange();
  }
  if (fly) flyTo(x.x, x.y, 8);
  openPlace([x.x, x.y], { size: 2.25, add });
  // the place keeps the shape it was found by, drawn over its line in the graph (chart.js: drawShape)
  const w = state.windows[state.windows.length - 1];
  if (w) w.found = { product: srch.data.product, shape: x.shape, when: x.when || null, direction: x.direction };
  if (lrMeta() && !state.compare) setCompare(true);
  renderSearch();
  renderMap();
}
// A group: its places alone in the list and on the map, the map around them; "בגרפים" opens up to four of them.
function groupText(g, r) {
  const n = g.members.length + " מקומות";
  if (g.kind === "together") {
    const when = g.first === g.last ? displayDate(g.first) : displayDate(g.first) + "–" + displayDate(g.last);
    return [(g.direction > 0 ? "עלו" : "ירדו") + " יחד", n, when, g.scattered ? "פזורים, עד " + ltr(g.span_km + " ק״מ") : "בטווח " + ltr(g.span_km + " ק״מ")];
  }
  return ["זזים יחד", n, ltr("r " + g.r.toFixed(2)), "בטווח " + ltr(g.span_km + " ק״מ")];
}
function selectGroup(g) {
  srch.group = srch.group === g ? null : g;
  srch.active = null;
  if (srch.group) {
    const xs = searchRows().map(x => x.x), ys = searchRows().map(x => x.y), x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    state.cx = (x0 + x1) / 2;
    state.cy = (y0 + y1) / 2;
    state.zoom = Math.max(state.fitZoom, Math.min(state.fitZoom * 60, .7 * Math.min(state.width / Math.max(x1 - x0, 4000), state.height / Math.max(y1 - y0, 4000))));
  }
  renderSearch();
  renderMap();
}
function renderSearch() {
  const r = srch.data, product = r?.product || state.product;
  for (const b of document.querySelectorAll("#qShape button")) b.classList.toggle("active", b.dataset.v === srch.shape);
  for (const b of document.querySelectorAll("#qDir button")) {
    b.classList.toggle("active", b.dataset.v === srch.dir);
    b.disabled = srch.shape === "fluct" || srch.shape === "spike" || srch.shape === "constant";
  }
  $("qWhen").disabled = !(srch.shape === "step" || srch.shape === "spike");
  $("qChange").disabled = srch.shape === "constant";
  {   // the frame: within the nights there are
    const ds = productDates(), lo = ds[0] || "", hi = ds[ds.length - 1] || "";
    for (const id of ["qFrom", "qTo"]) {
      $(id).min = lo;
      $(id).max = hi;
    }
    $("qFrom").value = srch.from;
    $("qTo").value = srch.to;
    $("qFrameAll").disabled = !srch.from && !srch.to;
    $("qFrameGraph").disabled = !state.rangeFrom && !state.rangeTo;
  }
  $("qChangeLabel").textContent = isLR() ? "פי לפחות" : "לפחות (σ)";
  {
    const sel = $("qWithin"), keep = sel.value;
    for (const o of [...sel.options]) if (o.dataset.area) o.remove();
    for (const a of state.areas) {
      const o = document.createElement("option");
      o.value = a.name;
      o.textContent = "אזור: " + a.name;
      o.dataset.area = "1";
      sel.append(o);
    }
    if ([...sel.options].some(o => o.value === keep)) sel.value = keep;
  }
  $("searchStatus").textContent = srch.busy ? "מחפש…" : r ? r.total.toLocaleString("en-US") + " מתוך " + r.candidates.toLocaleString("en-US") + (srch.from || srch.to ? " · " + r.nights + " לילות" : "") : "";
  const groups = $("searchGroups");
  groups.replaceChildren();
  if (r && r.groups.length) {
    const head = mk("h3", null, "קבוצות (" + r.groups.length + ")");
    head.title = "בין התוצאות בלבד: מדרגות באותם ימים (עד 3) ובאותו אזור (עד 50 ק״מ), ומקומות שעולים ויורדים יחד לילה אחר לילה";
    groups.append(head);
    for (const g of r.groups.slice(0, 12)) {
      const b = mk("button", "group-chip" + (srch.group === g ? " active" : ""));
      const [t, ...rest] = groupText(g, r);
      b.append(mk("b", null, t), mk("span", null, rest.join(" · ")));
      b.onclick = () => selectGroup(g);
      const open = mk("button", "link", "בגרפים");
      open.title = "עד ארבעה מהמקומות בגרפים, לצד זה";
      open.onclick = ev => {
        ev.stopPropagation();
        g.members.slice(0, 4).forEach((k, i) => {
          const x = r.results[k];
          openPlace([x.x, x.y], { size: 2.25, add: i > 0 || state.windows.length > 0 });
        });
        if (lrMeta() && !state.compare) setCompare(true);
      };
      const row = mk("div", "group-row");
      row.append(b, open);
      groups.append(row);
    }
  }
  const list = $("searchList");
  list.replaceChildren();
  const rows = searchRows();
  for (const x of rows.slice(0, 300)) list.append(searchRow(x, product));
  if (srch.group) {
    const back = mk("li", "none");
    const b = mk("button", "link", "כל התוצאות");
    b.onclick = () => selectGroup(srch.group);
    back.append("קבוצה אחת מוצגת · ", b);
    list.prepend(back);
  }
  const empty = $("searchEmpty");
  empty.hidden = !!(r && rows.length);
  empty.querySelector("span").textContent = srch.busy ? "מחפש…" : srch.error || (r ? "לא נמצאו מקומות כאלה" : "בחרו צורה, או כתבו שאילתה, ולחצו חיפוש");
  $("searchNote").textContent = r ? (srch.from || srch.to ? "בתקופה " + displayDate(r.frame[0]) + " – " + displayDate(r.frame[1]) + ": " : "במדינה: ") + ["step", "fluct", "trend", "spike"].map(k => r.counts[k].toLocaleString("en-US") + " " + SHAPE_LABELS[k]).join(" · ") + " · " + r.counts.stable.toLocaleString("en-US") + " יציבים · " + (r.counts.constant || 0).toLocaleString("en-US") + (r.product === LR ? " בהירים קבועים" : " חמים קבועים") : "";
  $("searchCsv").disabled = $("searchGeo").disabled = !rows.length;
}
// On the map while the tab is open: each result as a dot in its shape's colour; a group's places only, when one is chosen.
function drawSearch() {
  ctx.save();
  for (const x of searchRows().slice(0, 1000)) {
    const [px, py] = screen(x.x, x.y);
    if (px < -10 || py < -10 || px > state.width + 10 || py > state.height + 10) continue;
    const on = srch.active === x, r = on ? 8 : 4.5;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fillStyle = shapeColor(x);
    ctx.globalAlpha = on ? 1 : .9;
    ctx.fill();
    ctx.lineWidth = on ? 2.5 : 1.2;
    ctx.strokeStyle = "rgba(8,8,10,.85)";
    ctx.stroke();
  }
  ctx.restore();
}
for (const b of document.querySelectorAll("#qShape button")) b.onclick = () => {
  srch.shape = b.dataset.v;
  buildQuery();
  renderSearch();
  runSearch();
};
for (const b of document.querySelectorAll("#qDir button")) b.onclick = () => {
  srch.dir = b.dataset.v;
  buildQuery();
  renderSearch();
  runSearch();
};
for (const id of ["qChange", "qWhen", "qWithin"]) $(id).onchange = () => {
  buildQuery();
  runSearch();
};
// A new frame: the search again (when one was made), and the map without the constant lights, if shown.
function setFrame(from, to) {
  if (from && to && from > to) [from, to] = [to, from];
  if (from === srch.from && to === srch.to) return renderSearch();
  srch.from = from || "";
  srch.to = to || "";
  renderSearch();
  if (srch.data || state.side === "search") runSearch();
  if (state.lr.steady && isLR()) {
    state.imageKey = null;
    setDay(state.date);
  }
}
$("qFrom").onchange = () => setFrame($("qFrom").value, srch.to);
$("qTo").onchange = () => setFrame(srch.from, $("qTo").value);
$("qFrameAll").onclick = () => setFrame("", "");
$("qFrameGraph").onclick = () => setFrame(state.rangeFrom || "", state.rangeTo || "");
$("queryRun").onclick = runSearch;
$("queryText").onkeydown = e => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    runSearch();
  }
};
$("queryExamples").onchange = () => {
  const v = $("queryExamples").value;
  if (!v) return;
  $("queryText").value = v;
  $("queryExamples").value = "";
  runSearch();
};
$("searchCsv").onclick = () => {
  const rows = [["shape", "direction", "change", "when", "level", "switches", "fit", "longitude", "latitude"]];
  for (const x of searchRows()) rows.push([x.shape, x.direction, srch.data.product === LR ? Math.exp(x.change).toFixed(3) : x.change.toFixed(2), x.when || "", x.level.toFixed(2), x.switches, x.fit, x.lonlat[0], x.lonlat[1]]);
  download((srch.data.product === LR ? "LIGHTROAST" : "TEMPER") + "_search_" + state.meta.name.replace(/\W+/g, "_") + ".csv", rows.map(r => r.join(",")).join("\r\n"), "text/csv");
};
$("searchGeo").onclick = () => {
  const lr = srch.data.product === LR, fc = { type: "FeatureCollection", features: searchRows().map(x => ({ type: "Feature", geometry: { type: "Point", coordinates: x.lonlat }, properties: {
        shape: x.shape, direction: x.direction, change: lr ? Math.exp(x.change) : x.change, when: x.when, level: x.level, switches: x.switches, fit: x.fit
      } })) };
  download((lr ? "LIGHTROAST" : "TEMPER") + "_search_" + state.meta.name.replace(/\W+/g, "_") + ".geojson", JSON.stringify(fc), "application/geo+json");
};
buildQuery();
