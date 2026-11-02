"use strict";
// Download a night as a GeoTIFF (server: /api/export): the night's mosaic over the rectangle around the country, as the
// viewer reads it (every pass joined; not the raw swaths), with the layers chosen, on the data's own grid or in
// latitude/longitude; or a period ending with the night (a week, 16 days, a month, a year), as its composite's layers.

const EXPORT_LAYERS = {
  temper: [["m10", "M10 · 1.61 µm", "קרינה, ערוץ האש הראשי"], ["m11", "M11 · 2.25 µm", "קרינה, לאישור ולטמפרטורת מקור"], ["m15", "M15 · 10.8 µm", "טמפ׳ בהירות, קלווין"],
    ["m16", "M16 · 12 µm", "טמפ׳ בהירות, קלווין"], ["vza", "זווית צילום", "מעלות מהנדיר"], ["cloud", "ענן", "ירידת M15 מתחת לשמיים הבהירים, קלווין"]],
  lightroast: [["dnb", "DNB · אורות הלילה", "nW cm⁻² sr⁻¹, Black Marble"], ["cloud", "ענן", "חלק התא מתחת לענן, 0–1"]]
};
// A period's layers (server.py: composites, EXPORT_PERIOD_BANDS).
const EXPORT_PERIOD_LAYERS = {
  temper: [["sig_max", "הלילה החזק", "מובהקות משולבת M10/M11, σ"], ["temperature_k", "טמפ׳ מקור", "באותו לילה, קלווין"], ["m10_max", "M10 מקס׳", "הקרינה הגבוהה בתקופה"],
    ["hot_nights", "לילות חמים", "מובהקות 10σ ומעלה"], ["seen_nights", "לילות שנצפו", "כמה לילות נמדד"]],
  lightroast: [["median_nw", "DNB · חציון", "nW cm⁻² sr⁻¹, הלילות הבהירים"], ["clear_nights", "לילות בהירים", "בלי ענן, באיכות טובה"]]
};
const exp = { product: "temper", crs: "native", days: 1, busy: false };
// The area worked in (focus.js): the file cropped to its rectangle, NaN outside it (ticked by default).
function exportClip() {
  const a = focusArea();
  return a && $("exClip").checked ? a : null;
}
function openExport() {
  if (!state.meta) return;
  exp.product = isLR() && lrMeta() ? LR : "temper";
  exp.days = state.period || 1;
  $("exportDialog").showModal();
  renderExport();
}
function renderExport() {
  const lr = !!lrMeta();
  for (const b of document.querySelectorAll("#exProduct button")) {
    b.classList.toggle("active", b.dataset.p === exp.product);
    b.disabled = b.dataset.p === LR && !lr;
  }
  for (const b of document.querySelectorAll("#exCrs button")) b.classList.toggle("active", b.dataset.c === exp.crs);
  for (const b of document.querySelectorAll("#exPeriod button")) b.classList.toggle("active", Number(b.dataset.days) === exp.days);
  $("exDateLabel").textContent = exp.days > 1 ? "התקופה של" : "לילה";
  // nights: of the product chosen, the night shown first
  const sel = $("exDate"), dates = productDates(exp.product), keep = sel.value;
  sel.replaceChildren(...[...dates].reverse().map(d => {
    const o = document.createElement("option");
    o.value = d;
    o.textContent = displayDate(d, true);
    return o;
  }));
  sel.value = dates.includes(keep) ? keep : dates.includes(state.date) ? state.date : dates[dates.length - 1] || "";
  const box = $("exLayers");
  box.replaceChildren();
  for (const [id, name, what] of (exp.days > 1 ? EXPORT_PERIOD_LAYERS : EXPORT_LAYERS)[exp.product]) {
    const row = mk("label", "ex-layer"), cb = mk("input");
    cb.type = "checkbox";
    cb.value = id;
    cb.checked = true;
    cb.onchange = exportSize;
    row.append(cb, mk("b", null, name), mk("small", null, what));
    box.append(row);
  }
  const a = focusArea();
  $("exClipRow").hidden = !a;
  if (a) $("exClipName").textContent = a.name;
  $("exError").textContent = "";
  exportSize();
}
function exportBands() {
  return [...document.querySelectorAll("#exLayers input:checked")].map(c => c.value);
}
// Before compression: width × height × layers × 4 bytes (float32). Compressed files are usually a third to a half of it.
function exportSize() {
  const m = state.meta, n = exportBands().length, a = exportClip();
  let W = m.width, H = m.height;
  if (a) {
    const [x0, y0, x1, y1] = geomBounds(areaGeometry(a));
    W = Math.min(m.width, Math.ceil((x1 - x0) / 750) + 1);
    H = Math.min(m.height, Math.ceil((y1 - y0) / 750) + 1);
  }
  const mb = W * H * n * 4 / 1048576, d = $("exDate").value;
  $("exPeriodName").textContent = exp.days > 1 && d ? periodName(exp.days, d) + " · " + periodNights(exp.days, d, productDates(exp.product)) + " לילות" : "";
  $("exSize").textContent = n ? ltr(W.toLocaleString("en-US") + " × " + H.toLocaleString("en-US")) + " פיקסלים · " + n + " שכבות · עד " + ltr(Math.max(.1, mb).toFixed(mb < 10 ? 1 : 0) + " MB") : "בחרו לפחות שכבה אחת";
  $("exGo").disabled = !n || exp.busy || !$("exDate").value;
}
async function runExport() {
  const bands = exportBands(), date = $("exDate").value;
  if (!bands.length || !date || exp.busy) return;
  exp.busy = true;
  $("exGo").textContent = "מכין את הקובץ…";
  $("exError").textContent = "";
  exportSize();
  try {
    const q = new URLSearchParams({ product: exp.product, date, crs: exp.crs, bands: bands.join(","), days: exp.days }), area = exportClip();
    if (area) {
      q.set("clip", JSON.stringify(areaGeometry(area).coordinates[0].map(p => [Math.round(p[0]), Math.round(p[1])])));
      q.set("area", area.name);
    }
    let r;
    for (;;) {   // 202: the period's composite is still being built
      r = await fetch("/api/export?" + q);
      if (r.status !== 202) break;
      const p = await r.json();
      $("exGo").textContent = "בונה את ההרכב · " + Math.round(100 * p.done / Math.max(1, p.total)) + "%";
      await new Promise(res => setTimeout(res, 1000));
      if (!$("exportDialog").open) return;
    }
    $("exGo").textContent = "מכין את הקובץ…";
    if (!r.ok) throw Error((await r.json().catch(() => ({}))).error || "שגיאה בשרת המקומי");
    const name = (r.headers.get("Content-Disposition") || "").match(/filename="([^"]+)"/)?.[1] || "night.tif", blob = await r.blob();
    const a = document.createElement("a"), url = URL.createObjectURL(blob);
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast("הורד: " + ltr(name) + " · " + ltr((blob.size / 1048576).toFixed(1) + " MB"));
    $("exportDialog").close();
  } catch (e) {
    $("exError").textContent = e.message;
  } finally {
    exp.busy = false;
    $("exGo").textContent = "הורדה";
    exportSize();
  }
}
$("exportButton").onclick = openExport;
$("exportClose").onclick = () => $("exportDialog").close();
$("exGo").onclick = runExport;
$("exDate").onchange = exportSize;
$("exClip").onchange = exportSize;
for (const b of document.querySelectorAll("#exProduct button")) b.onclick = () => {
  exp.product = b.dataset.p;
  renderExport();
};
for (const b of document.querySelectorAll("#exPeriod button")) b.onclick = () => {
  exp.days = Number(b.dataset.days);
  renderExport();
};
for (const b of document.querySelectorAll("#exCrs button")) b.onclick = () => {
  exp.crs = b.dataset.c;
  for (const x of document.querySelectorAll("#exCrs button")) x.classList.toggle("active", x.dataset.c === exp.crs);
};
