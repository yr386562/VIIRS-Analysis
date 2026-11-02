"use strict";
// For a first-time user, without taking anything away from an expert:
// - Simple | Full (top bar): Simple hides the controls an expert tunes (the graph's metric, window size, period
//   fields and scale menu; the search's query line; the related places' regional switch). Everything still works the
//   same; Full shows them. A new user starts in Simple; the choice is remembered.
// - Where to start (on the empty map, in Simple): the night's strongest change, a place by its coordinates, the tour.
// - Next steps (under the graph's chips, in Simple): the viewer's smart functions that fit the place open now: where
//   else it happened, pinning it in the graph, saving it, the scale that shows small shifts, both products together, and
//   the night as a GeoTIFF.

const UI_MODE_KEY = "viewer-ui-mode", START_OFF_KEY = "viewer-start-off";
function setUIMode(mode, save = true) {
  document.body.classList.toggle("simple", mode === "simple");
  for (const b of document.querySelectorAll("#uiMode button")) {
    b.classList.toggle("active", b.dataset.ui === mode);
    b.setAttribute("aria-pressed", b.dataset.ui === mode);
  }
  if (save) try {
    localStorage.setItem(UI_MODE_KEY, mode);
  } catch { }
  renderNextSteps();
  if (state.meta) resize();
}
for (const b of document.querySelectorAll("#uiMode button")) b.onclick = () => setUIMode(b.dataset.ui);
{
  let mode = "simple", off = false;
  try {
    mode = localStorage.getItem(UI_MODE_KEY) === "full" ? "full" : "simple";
    off = localStorage.getItem(START_OFF_KEY) === "1";
  } catch { }
  document.body.classList.toggle("start-off", off);
  setUIMode(mode, false);
}
// ---------- where to start ----------
// The first row of the list as it is shown; on a night with only weak changes (hidden by default), the first of those.
function strongestNow() {
  if (hotMode()) return state.hot?.[0] ? { hot: state.hot[0] } : null;
  const e = shownEvents()[0] || filteredEvents()[0];
  return e ? { event: e, weak: !shownEvents().length } : null;
}
$("startStrongest").onclick = () => {
  const s = strongestNow();
  if (!s) {
    toast(state.events.busy ? "הרשימה עוד נטענת; נסו שוב בעוד רגע." : "אין שינויים ברשימה של הלילה הזה. נסו ׳7 ימים׳ ברשימה.");
    return;
  }
  if (s.hot) selectHot(s.hot, false); else selectEvent(s.event, false);
  if (s.weak) toast("הלילה יש רק שינויים חלשים; זה החזק מביניהם.");
};
$("startCoords").onclick = () => {
  $("coordInput").focus();
};
$("startTour").onclick = () => $("helpButton").click();
$("startClose").onclick = () => {
  document.body.classList.add("start-off");
  try {
    localStorage.setItem(START_OFF_KEY, "1");
  } catch { }
};
// ---------- next steps, for the place shown in the area card ----------
function renderNextSteps() {
  const box = $("nextSteps");
  if (!box) return;
  box.replaceChildren();
  const w = typeof cardWindow === "function" ? cardWindow() : null;
  box.hidden = !w || CHART_TAB || !document.body.classList.contains("simple");
  if (box.hidden) return;
  const step = (text, title, act) => {
    const b = mk("button", "next-step", text);
    b.type = "button";
    b.title = title;
    b.onclick = act;
    box.append(b);
  };
  box.append(mk("span", "next-label", "מה אפשר עכשיו:"));
  step("איפה עוד זה קרה?", "מקומות קשורים: אם במקום היה שינוי, איפה עוד קרה אותו דבר באותו זמן; אחרת, מה זז יחד איתו",
    () => findSimilar({ x: w.center[0], y: w.center[1], size_km: w.size, product: state.product, label: "מקום #" + num(w) }));
  if (!w.kept && !w.areaId) step("נעיצה בגרף", "המקום נשאר בגרף כשפותחים מקום אחר, בלי לשמור אותו", () => {
    w.kept = true;
    renderLegend();
    renderChart();
  });
  if (!w.areaId) step("שמירה בניתוח האישי", "המקום נשמר במחשב בשם משלכם, ונפתח בלחיצה בכל פעם", () => saveArea(w));
  if ((state.rangeFrom || state.rangeTo) && chartMode === "fixed") step("להדגיש שינויים קטנים", "הסקאלה מתאימה את עצמה לתקופה שבגרף: שינוי קטן ממלא את הגובה", () => setChartMode("view"));
  if (lrMeta() && !comparing()) step("אור וחום יחד", "שני הגרפים זה מעל זה: TEMPER (חום) ו־LIGHT ROAST (אור), לאותם מקומות", () => setCompare(true));
  step("הלילה כ־GeoTIFF", "התמונה המחוברת של הלילה, על המלבן שמסביב למדינה", openExport);
}
