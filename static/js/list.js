"use strict";
// אנליטיקות: the night's (or the period's) changes and hot spots, how significant each is, the filters, and the
// CSV / GeoJSON export.

// ---------- the list ----------
// The side panel lists what happened. "הלילה": what was found on the shown night, each with that night's numbers and
// since when it has been seen; a period (7 or 30 days up to the shown night, or everything): each change once, from
// the event log. TEMPER can list instead what burns tonight (hot spots). The server stores each night's changes for
// the default comparison; another comparison (in the settings) compares the shown night live.
const CHANGE_LABELS = { temper: {
    new: ["חדש", "נדלק הלילה, וכמעט לא דלק בלילות הקודמים"], off: ["כבה", "דלק ברוב הלילות הקודמים, ולא הלילה, בלילה בהיר"], brighter: ["התחזק", "פי 3 ויותר מהרגיל, מעבר לתנודות הרגילות של המקום"], dimmer: ["נחלש", "שליש מהרגיל או פחות, מעבר לתנודות הרגילות של המקום"]
  },
  lightroast: {
    new: ["נדלק", "היה חשוך (פחות מ־2 nW) ועכשיו מואר (5 nW ומעלה)"], off: ["כבה", "היה מואר (5 nW ומעלה) ועכשיו חשוך"], brighter: ["התבהר", "פי 1.5 ומעלה מהרגיל, מעבר לתנודות של המקום ולשינוי של כל המדינה"], dimmer: ["התעמעם", "פחות מ־2/3 מהרגיל, מעבר לתנודות של המקום ולשינוי של כל המדינה"]
  } };
const KIND_CHIPS = { temper: { new: "חדשים", off: "כבו", brighter: "התחזקו", dimmer: "נחלשו" }, lightroast: { new: "נדלקו", off: "כבו", brighter: "התבהרו", dimmer: "התעמעמו" } };
function changeWindow() {
  const r = state.meta?.change_window_range || [7, 60], v = Math.round(Number($("changeWindow").value));
  return Number.isFinite(v) && v > 0 ? Math.max(r[0], Math.min(r[1], v)) : (state.meta?.change_window || 14);
}
// LIGHT ROAST's baseline as months back: 14/28/42/56 nights = 2/4/6/8 cycles of 16 days.
function lrWindow() {
  const v = Number($("lrWindow").value), r = lrMeta()?.window_range || [7, 63];
  return Number.isFinite(v) && v >= r[0] && v <= r[1] ? v : (lrMeta()?.window || 28);
}
// The repository's RX method is offered only when the server has it switched on (config.json "rx_method").
function rxAvailable() {
  return !!lrMeta()?.methods?.includes("rx");
}
function hotMode() {
  return !isLR() && state.events.mode === "hot";
}
function liveNight() {
  return isLR() ? lrWindow() !== (lrMeta()?.window || 28) || (rxAvailable() && state.lr.method === "rx") : changeWindow() !== (state.meta?.change_window || 14);
}
function strengthOf(e) {
  if (isLR()) return Math.abs(e.z || 0);
  const v = e.kind === "off" ? e.usual : e.value;
  return v != null && e.threshold ? v / e.threshold : e.ratio ? Math.abs(Math.log(e.ratio)) : 0;
}
let evSeq = 0;
function dateMinus(d, n) {
  const t = new Date(d + "T12:00:00Z");
  t.setUTCDate(t.getUTCDate() - n);
  return t.toISOString().slice(0, 10);
}
function loadList() {
  if (hotMode()) suggestHot(); else loadEvents();
}
async function loadEvents() {
  if (!state.meta || !state.date) return;
  const p = state.product, s = state.events, date = state.date, seq = ++evSeq;
  s.busy = true;
  renderList();
  try {
    let r;
    if (s.days === 1 && liveNight()) {
      const raw = await api((p === LR ? "/api/lr/changes?" : "/api/changes?") + new URLSearchParams(p === LR ? { date, window: lrWindow(), method: rxAvailable() ? state.lr.method : "weekly" } : { date, window: changeWindow() })), before = raw.context || [];
      r = {
        product: p, night: date, live: true, ready: 1, total: 1, counts: raw.counts, pending: raw.pending || {}, causes: {}, info: { context: before.length, shared_ratio: raw.shared_ratio, glow: raw.moonlit_removed?.length || 0 },
        events: raw.events.map(e => ({
          kind: e.kind, x: e.x, y: e.y, lonlat: e.lonlat, detail: e, onset: date, last: date, nights: 1, cause: null, status: "ongoing", strength: strengthOf(e), id: e.kind + ":" + date + ":" + e.lonlat[0].toFixed(3) + ":" + e.lonlat[1].toFixed(3)
        })).sort((a, b) => b.strength - a.strength)
      };
    } else {
      const q = { product: p };
      if (s.days === 1) q.night = date; else if (s.days) {
        q.from = dateMinus(date, s.days - 1);
        q.to = date;
      }
      r = await api("/api/events?" + new URLSearchParams(q));
    }
    if (seq !== evSeq) return;
    s.raw = r;
    s.data = clipEvents(r);   // inside the area worked in (focus.js), if any
    s.error = null;
    if (s.active) s.active = r.events.find(e => e.id === s.active.id) || null;
  } catch (e) {
    if (seq !== evSeq) return;
    s.error = e.message;
    s.data = s.raw = null;
  } finally {
    if (seq === evSeq) s.busy = false;
  }
  renderList();
  renderMap();
  renderChart();
}
// Hot spots of the shown night, brightest first, in two groups (server side):
// sure        a measured two-band source temperature tonight, or a known flare: faint tonight, but a source temperature
//             was measured at the same place (within two pixels) on one of the context-window nights before.
// unconfirmed the rest, behind a + row: they carry only an M10 pixel brightness (~150-230 °C).
// Numbers follow the shown list.
async function suggestHot() {
  if (!state.meta || !state.date) return;
  const date = state.date, id = state.meta.id, seq = ++evSeq;
  state.events.busy = true;
  renderList();
  try {
    const r = await api("/api/hotspots?" + new URLSearchParams({ date, window: changeWindow() }));
    if (seq !== evSeq || state.meta?.id !== id || state.date !== date) return;
    state.hotRaw = r.spots;
    state.hotAll = r.spots.filter(inFocus);
    state.hotThreshold = r.threshold_low;
    state.hotRange = r;
    state.hotActive = null;
    filterHot();
    state.events.error = null;
  } catch (e) {
    if (seq !== evSeq) return;
    state.hot = state.hotAll = state.hotRaw = null;
    state.events.error = e.message;
  } finally {
    if (seq === evSeq) state.events.busy = false;
  }
  renderList();
  renderMap();
}
function filterHot() {
  if (!state.hotAll) {
    state.hot = null;
    return;
  }
  const sure = state.hotAll.filter(s => s.sure), rest = state.hotAll.filter(s => !s.sure);
  state.hot = (state.hotWeak ? sure.concat(rest) : sure).map((s, i) => ({ ...s, rank: i + 1 }));
}
function selectHot(s, add, fly = true) {
  state.hotActive = s.rank;
  if (fly) flyTo(s.x, s.y, 10);
  openCluster(s, add);
  renderHot();
  renderMap();
}
function hotRow(s) {
  const li = document.createElement("li"), go = document.createElement("button"), rank = document.createElement("span"), temp = document.createElement("b"), where = document.createElement("span");
  go.className = "hot-item" + (s.rank === state.hotActive ? " active" : "");
  rank.className = "hot-rank";
  rank.textContent = s.rank;
  where.textContent = ltr(coordText(s.lonlat, 3));
  go.append(rank, temp);
  const detail = ltr("M10 " + fmt(s.value) + (s.m11 != null ? " · M11 " + fmt(s.m11) : "") + " " + RADIANCE) + " · " + s.samples + " דגימות" + (s.view_zenith != null ? " · " + ltr(Math.round(s.view_zenith) + "°") : "");
  if (s.measured) {
    temp.textContent = celsius(s.temperature_k);
    go.title = "טמפ׳ מקור M10/M11 " + ltr(Math.round(s.temperature_k - C0) + " ± " + Math.round(s.temperature_sd_k) + " °C") + " (רעש בלבד) · שטח " + ltr(fmt(s.area_m2) + " m²") + " · " + ltr(fmt(s.heat_mw) + " MW") + "\n" + detail;
  } else if (s.known) {
    const k = s.known, tag = document.createElement("span");
    temp.textContent = ltr("≈" + (Math.round((k.temperature_k - C0) / 10) * 10).toLocaleString("en-US") + " °C");
    temp.className = "known";
    tag.className = "hot-tag";
    tag.textContent = "מוכר";
    go.append(tag);
    go.title = "להבה מוכרת: חלשה מדי הלילה לטמפ׳ מקור" + (s.confirmed === null ? " (אין M11 למעבר)" : "") + ". במקום הזה נמדדה טמפ׳ מקור ב־" + ltr(k.nights + "/" + k.of) + " מהלילות הקודמים, לאחרונה " + celsius(k.temperature_k) + " ב־" + displayDate(k.date) + "\n" + detail;
  } else {
    temp.textContent = s.brightness_temperature_k ? ltr("~" + Math.round(s.brightness_temperature_k - C0) + " °C") : "—";
    temp.className = "weak";
    go.title = "לא מאומת: בלי טמפ׳ מקור הלילה ובלי מדידה במקום הזה בלילות הקודמים. המספר הוא טמפ׳ בהירות של הפיקסל, לא של המקור\n" + detail;
  }
  go.title += "\nלחיצה: המקום לאורך זמן · Shift+לחיצה או A: להוסיף להשוואה";
  go.append(where);
  go.onclick = ev => selectHot(s, ev.shiftKey);
  go.dataset.addShift = "";   // the A key: as Shift+click
  li.append(go, keepButton(s.x, s.y, clusterSize(s), () => "מוקד " + (s.measured ? (Math.round((s.temperature_k - C0) / 10) * 10).toLocaleString("en-US") + " °C" : "חום") + " · " + displayDate(state.date)), similarButton({ x: s.x, y: s.y, product: "temper", label: "מוקד " + s.rank + " (" + displayDate(state.date) + ")" }));
  return li;
}
function renderHot() {
  const list = $("hotList");
  list.replaceChildren();
  if (!state.hot) return;
  const sure = state.hotAll.filter(s => s.sure).length, rest = state.hotAll.length - sure;
  state.hot.slice(0, sure).forEach(s => list.append(hotRow(s)));
  if (rest) {
    const li = document.createElement("li"), b = document.createElement("button"), i = document.createElement("i"), label = document.createElement("span");
    li.className = "hot-more";
    i.textContent = state.hotWeak ? "−" : "+";
    label.textContent = state.hotWeak ? "הסתרת " + rest + " לא מאומתים" : rest + " לא מאומתים";
    b.title = "מוקדים בלי טמפ׳ מקור הלילה ובלי מדידה במקום בלילות הקודמים: חלשים, בקצה הסריקה, או רעש";
    b.append(i, label);
    b.onclick = () => {
      state.hotWeak = !state.hotWeak;
      state.hotActive = null;
      filterHot();
      renderHot();
      renderMap();
    };
    li.append(b);
    list.append(li);
  }
  if (state.hotWeak) state.hot.slice(sure).forEach(s => list.append(hotRow(s)));
}
// The threshold follows the viewing angle: lowest near nadir, highest at the swath edge (shown as M10 pixel brightness).
function hotContext() {
  const t = state.hotRange;
  if (!t || !state.hotAll) return ["", ""];
  const sure = state.hotAll.filter(s => s.sure).length, known = state.hotAll.filter(s => s.known).length;
  return [sure + " מוקדים" + (known ? " · " + known + " מוכרים" : "") + " · סף " + ltr(Math.round(t.threshold_low_k - C0) + "–" + Math.round(t.threshold_high_k - C0) + " °C"),
    "סף הגילוי כטמפ׳ בהירות של פיקסל: " + ltr(fmt(t.threshold_low) + "–" + fmt(t.threshold_high) + " " + RADIANCE) + "\nמוכר: חלש הלילה, אבל במקום נמדדה טמפ׳ מקור באחד מ־" + t.context_nights + " הלילות הקודמים"];
}
function changeNumber(e) {
  if (isLR()) return e.kind === "new" ? nw(e.after_nw) : pct(e.ratio);
  return e.kind === "new" ? ltr("×" + fmt(e.value / e.threshold)) : e.kind === "off" ? ltr(e.lit_nights + "/" + e.informative_nights) : e.ratio != null ? ltr("×" + fmt(e.ratio)) : "";
}
function changeTitle(e) {
  if (isLR()) return ["לפני " + nw(e.before_nw) + " · עכשיו " + nw(e.after_nw) + " (" + pct(e.ratio) + ")", e.area_km2 != null ? "שטח " + ltr(e.area_km2 + " km²") : "", e.z != null ? ltr(Math.abs(e.z).toFixed(1) + "σ") : "", e.nights_recent ? e.nights_recent + " לילות מול " + e.nights_before : ""].filter(Boolean).join(" · ")
    + (e.holds != null ? "\nבשבוע שאחרי: " + (e.after_later_nw != null ? nw(e.after_later_nw) + " · " : "") + (e.holds ? "השינוי נמשך" : "השינוי חלף") : "");
  return (e.kind === "new" && e.threshold ? "פי " + ltr(fmt(e.value / e.threshold)) + " מסף הגילוי · " : e.kind === "off" && e.informative_nights ? "דלק ב־" + ltr(e.lit_nights + "/" + e.informative_nights) + " מהלילות הקודמים שבהם נראה · " : e.ratio != null ? "פי " + ltr(fmt(e.ratio)) + " מהרגיל · " : "")
    + (e.value != null ? "הלילה " + ltr(fmt(e.value)) : "") + (e.usual != null ? " · בדרך כלל " + ltr(fmt(e.usual)) : "") + " " + ltr(RADIANCE) + (e.after_informative ? "\nאחר כך: דלק ב־" + ltr(e.after_lit + "/" + e.after_informative) + " לילות" : "");
}
// Settings that change the list: the comparison and, for LIGHT ROAST, the method.
function renderMethod() {
  const rx = state.lr.method === "rx" && rxAvailable();
  document.querySelector(".lr-method").hidden = !rxAvailable();
  $("lrMethodWeekly").classList.toggle("active", !rx);
  $("lrMethodRx").classList.toggle("active", rx);
  $("lrMethodWeekly").setAttribute("aria-pressed", !rx);
  $("lrMethodRx").setAttribute("aria-pressed", rx);
  $("lrBaseLabel").textContent = rx ? "הלילה מול" : "השבוע מול";
}
function setLightMethod(m) {
  if (state.lr.method === m) return;
  state.lr.method = m;
  try {
    localStorage.setItem("lightroast-method", m);
  } catch { }
  renderMethod();
  if (isLR() && state.lr.view === "change") setDay(state.date); else loadList();
  if (state.hover) queryPixel(state.hover);
}
$("lrMethodWeekly").onclick = () => setLightMethod("weekly");
$("lrMethodRx").onclick = () => setLightMethod("rx");
$("lrWindow").onchange = () => {
  try {
    localStorage.setItem("lightroast-window", lrWindow());
  } catch { }
  if (isLR() && state.lr.view === "change") setDay(state.date); else loadList();
};
$("changeWindow").onchange = () => {
  const w = changeWindow();
  $("changeWindow").value = w;
  try {
    localStorage.setItem("temper-change-window", w);
  } catch { }
  loadList();
};
function setMarks(on) {
  state.marks = on;
  $("marksToggle").checked = on;
  $("listMarks").classList.toggle("active", on);
  $("listMarks").setAttribute("aria-pressed", on);
  $("listMarks").title = on ? "הסתרת הסימונים מהמפה" : "הצגת הסימונים על המפה";
  renderMap();
}
$("marksToggle").onchange = () => setMarks($("marksToggle").checked);
$("listMarks").onclick = () => setMarks(!state.marks);
// Causes, from both products (server: event_log)
const CAUSE_LABELS = {
  flare: ["להבה", "חום קבוע במקום (TEMPER רואה כאן לפיד ברוב הלילות)"], fire: ["שריפה / חום", "חום ש־TEMPER ראה במקום עצמו, בשבוע השינוי (בשני לילות לפחות, או טמפ׳ שנמדדה), ולא לפיד קבוע: שריפה או מקור חד־פעמי"],
  field: ["שדה נפט/גז", "בלי חום במקום עצמו, ליד לפיד קבוע (עד 10 ק״מ): תאורת מתקנים"], outage: ["הפסקה אזורית", "אורות כבו או ירדו לפחות מחצי, יחד עם 5 מקומות ויותר באזור (25 ק״מ, יומיים)"],
  regional: ["אזורי (אובך?)", "שינוי מתון יחד עם מקומות רבים באזור: כנראה אובך או מזג אוויר"], lighting: ["תאורה", "שינוי בתאורה בלי חום ובלי שינוי אזורי"]
};
function chip(label, count, off, title, onclick, color) {
  const b = mk("button", "ev-chip" + (off ? " off" : ""));
  if (color) {
    const i = mk("i");
    i.style.setProperty("background", color);
    b.append(i);
  }
  b.append(label + " ", mk("small", null, String(count)));
  b.title = (title || "") + "\nלחיצה: להסתיר או להציג";
  b.setAttribute("aria-pressed", !off);
  b.onclick = onclick;
  return b;
}
function toggleSet(set, v) {
  if (set.has(v)) set.delete(v); else set.add(v);
}
// Weak changes (sig.level, server: significance) are folded under a "+N חלשים" row and kept off the map until it is opened.
function filteredEvents() {
  const r = state.events.data, s = state.events;
  if (!r || hotMode()) return [];
  return r.events.filter(e => !(e.cause && s.hideCauses.has(e.cause)) && !s.hideKinds.has(e.kind) && !(s.hideMixed && e.pattern === "intermittent"));
}
function isWeak(e) {
  return e.sig?.level === "weak";
}
// Why a change has its level: how far beyond normal this week, how often the place swings like this, how long it lasted.
function sigText(e) {
  const g = e.sig;
  if (!g) return "";
  const parts = ["מובהקות: " + { strong: "חזקה", medium: "בינונית", weak: "חלשה" }[g.level]];
  if (g.z) parts.push("השבוע " + ltr(g.z.toFixed(1) + "σ") + " מעבר לתנודות הרגילות");
  if (g.p != null) parts.push(g.p === 0 ? "במקום הזה לא היה שינוי כזה בשאר השנה" : "במקום הזה שינוי כזה קורה ב־" + (g.p < .01 ? "פחות מ־1" : Math.round(g.p * 100)) + "% מהשבועות"); else if (g.times != null) parts.push("פי " + ltr(fmt(g.times)) + " מסף הגילוי");
  parts.push(g.nights > 1 ? "נראה ב־" + g.nights + " לילות" : "לילה אחד בלבד");
  if (g.holds === 0 || g.holds === false) parts.push("חלף בשבוע שאחרי");
  return parts.join(" · ");
}
// The heat behind a heat cause: on how many of the change's week TEMPER saw a source there, and measured a temperature.
function heatText(e) {
  const d = e.detail || {};
  if (d.heat_nights != null) return "\nTEMPER בשבוע השינוי: מקור חום ב־" + (d.heat || 0) + " מתוך " + d.heat_nights + " לילות" + (d.heat_measured ? ", טמפ׳ נמדדה ב־" + d.heat_measured : ", בלי טמפ׳ שנמדדה");
  if (e.heat != null && isLR()) return "\nTEMPER: חום בשבוע השינוי ב־" + e.heat + " מלילות האירוע" + (e.heat_measured ? ", טמפ׳ נמדדה ב־" + e.heat_measured : "");
  return "";
}
function shownEvents() {
  const list = filteredEvents();
  return state.events.showWeak ? list : list.filter(e => !isWeak(e));
}
function rowWhen(e) {
  const night = state.events.data?.night;
  if (night) {
    if (state.events.data.live) return "";
    return e.onset === night ? "חדש הלילה" : "מאז " + displayDate(e.onset) + " · " + e.nights + " לילות";
  }
  return displayDate(e.onset) + (e.nights > 1 ? " · " + e.nights + " לילות" : " · לילה אחד") + (e.status === "ongoing" ? " · נמשך" : "");
}
// The line under the title: what the night was compared with, or what the period lists.
function contextText() {
  const r = state.events.data, s = state.events;
  if (!r) return ["", ""];
  const i = r.info || {}, parts = [];
  let tip = "";
  if (r.night) {
    if (isLR()) {
      if (i.context) parts.push("השבוע מול " + i.context + " לילות באותה זווית");
      if (i.shared_ratio != null) parts.push(Math.abs(Math.log(i.shared_ratio)) <= .05 ? "כל המדינה כרגיל" : "כל המדינה " + pct(i.shared_ratio));
      if (i.moon != null && i.moon >= .3) parts.push("ירח " + Math.round(i.moon * 100) + "%");
      if (i.glow) parts.push(i.glow + " הוסרו: זוהר ירח");
      tip = "השבוע שעד " + displayDate(r.night, true) + " מול אותם לילות במחזורי המסלול הקודמים" + (i.context_first ? " (" + displayDate(i.context_first) + " – " + displayDate(i.context_last) + ")" : "") + ". שינוי שמשותף לכל המדינה (ירח, אטמוספרה, כיול) מנוכה לפני שמחפשים שינויים מקומיים." + (i.glow ? "\nזוהר ירח: מקומות חשוכים שנראו מוארים רק בלילות עם ירח, בכתמים גדולים שזזים מלילה ללילה. בלילות בלי ירח הם חשוכים." : "");
    } else {
      if (i.context) parts.push("מול " + i.context + " לילות קודמים");
      tip = "כל מקום מול הלילות שלפניו: נדלק, כבה בלילה בהיר, או השתנה פי 3 ומעבר לתנודות הרגילות שלו";
    }
    if (r.live) parts.push("השוואה לפי ההגדרות");
  } else {
    parts.push(s.days ? s.days + " הימים שעד " + displayDate(state.date) : "עד " + displayDate(state.date), "כל שינוי פעם אחת");
    tip = "שינוי שנראה לילה אחרי לילה מקושר לאירוע אחד: אותו סוג, עד 1.5 ק״מ, בהפרשים של עד 7 ימים. נמשך: נראה ביומיים האחרונים של הנתונים.";
  }
  if (r.ready < r.total) parts.push("נבנה ברקע " + ltr(r.ready + "/" + r.total));
  return [parts.join(" · "), tip];
}
function renderList() {
  const s = state.events, r = s.data, hot = hotMode();
  for (const b of document.querySelectorAll("#tMode button")) {
    const on = b.dataset.mode === s.mode;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", on);
  }
  for (const b of document.querySelectorAll("#evDays button")) {
    const on = Number(b.dataset.days) === s.days;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", on);
  }
  $("evDays").hidden = hot;
  $("evFilters").hidden = hot;
  $("listFoot").hidden = hot;
  $("evList").hidden = hot;
  $("hotList").hidden = !hot;
  $("listTitle").textContent = hot ? "בוער הלילה" : s.days === 1 ? "מה השתנה הלילה" : "מה השתנה";
  const line = $("listContext"), empty = $("evEmpty"), status = $("listStatus");
  if (hot) {
    renderHot();
    const [t, tip] = hotContext();
    line.textContent = t;
    line.title = tip;
    if (focusArea()) line.textContent = "בתוך " + focusArea().name + (t ? " · " + t : "");
    status.textContent = s.busy ? "טוען…" : "";
    empty.hidden = !!state.hot?.length;
    renderFocus();
    empty.querySelector("span").textContent = s.busy ? "מחשב את הסף של הלילה…" : s.error || (state.hot ? "אין מוקדים מאומתים בלילה הזה" : "");
    return;
  }
  const kinds = $("evKinds"), causes = $("evCauses");
  kinds.replaceChildren();
  causes.replaceChildren();
  if (r) {
    for (const k of ["new", "off", "brighter", "dimmer"]) {
      const n = r.counts?.[k] || 0, p = r.pending?.[k] || 0;
      if (!n && !p) continue;
      kinds.append(chip(KIND_CHIPS[state.product][k], n.toLocaleString("en-US") + (p ? " +" + p : ""), s.hideKinds.has(k), CHANGE_LABELS[state.product][k][1] + (p ? "\n+" + p + " ממתינים: חלק מקבוצה גדולה באזור בשבוע מואר בירח; מחכים ללילות בלי ירח" : ""), () => {
        toggleSet(s.hideKinds, k);
        renderList();
        renderMap();
      }, CHANGE_KINDS[k].color));
    }
    if (r.intermittent) kinds.append(chip("לסירוגין", r.intermittent.toLocaleString("en-US"), s.hideMixed, "מקורות שנדלקו וכבו במהלך השבוע, ולא עברו לרמה חדשה: לא שינוי קבוע. חציון השבוע רואה בהם שינוי", () => {
      s.hideMixed = !s.hideMixed;
      renderList();
      renderMap();
    }));
    for (const [c, [label, title]] of Object.entries(CAUSE_LABELS)) if (r.causes?.[c]) causes.append(chip(label, r.causes[c].toLocaleString("en-US"), s.hideCauses.has(c), title, () => {
      toggleSet(s.hideCauses, c);
      renderList();
      renderMap();
    }));
  }
  const all = filteredEvents(), firm = all.filter(e => !isWeak(e)), weak = all.filter(isWeak), shown = shownEvents(), cap = 300, list = $("evList");
  list.replaceChildren();
  for (const e of firm.slice(0, cap)) list.append(eventRow(e));
  if (weak.length) {
    const li = mk("li", "hot-more"), b = mk("button"), i = mk("i", null, s.showWeak ? "−" : "+");
    b.append(i, mk("span", null, s.showWeak ? "הסתרת " + weak.length + " חלשים" : weak.length.toLocaleString("en-US") + " חלשים"));
    b.title = "שינויים שהמקום עושה לעתים קרובות, או של לילה אחד בפיקסל אחד: כנראה לא שינוי של ממש";
    b.onclick = () => {
      s.showWeak = !s.showWeak;
      renderList();
      renderMap();
    };
    li.append(b);
    list.append(li);
    if (s.showWeak) for (const e of weak.slice(0, cap)) list.append(eventRow(e));
  }
  if (firm.length > cap) list.append(mk("li", "none", "מוצגים " + cap + " החזקים מתוך " + firm.length.toLocaleString("en-US") + ". צמצמו בעזרת הסינון."));
  const [t, tip] = contextText();
  line.textContent = focusArea() ? "בתוך " + focusArea().name + (t ? " · " + t : "") : t;
  line.title = tip;
  status.textContent = s.busy ? "טוען…" : r ? shown.length.toLocaleString("en-US") : "";
  renderFocus();
  empty.hidden = !!(r && all.length);
  empty.querySelector("span").textContent = s.busy && !r ? "טוען…" : s.error || (r ? (r.info?.error || (r.events.length ? "אין שורות בסינון הזה" : r.outside ? "אין שינויים בתוך האזור (" + r.outside.toLocaleString("en-US") + " מחוץ לו)" : s.days === 1 ? "לא נמצאו שינויים בלילה הזה" : "אין שינויים בתקופה הזו")) : "");
  $("evCsv").disabled = $("evGeo").disabled = !shown.length;
}
// A row: the number that matters (light now, or the change), the kind and the cause; then since when, and where.
// Labels (real / false / unsure) and related places on hover.
function eventRow(e) {
  const li = mk("li"), pend = e.detail?.moon === "pending", go = mk("button", "ev-item" + (state.events.active === e ? " active" : "") + (e.status === "ended" ? " ended" : "") + (pend ? " pending" : "")), k = CHANGE_KINDS[e.kind], mark = mk("span", "chg-mark", k.mark);
  mark.style.setProperty("color", k.color);
  const top = mk("span", "ev-top"), sub = mk("span", "ev-sub");
  top.append(mk("b", null, changeNumber(e.detail || {})), mk("span", "ev-kind", CHANGE_LABELS[state.product][e.kind][0]));
  if (e.sig) {
    const g = mk("span", "sig sig-" + e.sig.level, { strong: "חזק", medium: "בינוני", weak: "חלש" }[e.sig.level]);
    g.title = sigText(e);
    top.append(g);
  }
  if (e.cause) {
    const c = mk("span", "hot-tag cause " + e.cause, CAUSE_LABELS[e.cause][0]);
    c.title = CAUSE_LABELS[e.cause][1] + heatText(e);
    top.append(c);
  } else if (isLR() && (e.detail?.heat >= 2 || e.detail?.heat_measured >= 1)) {
    const t = mk("span", "hot-tag heat", "חום");
    t.title = "TEMPER רואה כאן מקור חום: להבה או שריפה, לא תאורה" + heatText(e);
    top.append(t);
  }
  if (pend) {
    const t = mk("span", "hot-tag pend", "ממתין · ירח");
    t.title = "חלק מקבוצה גדולה של אורות חדשים באזור, והשבוע היה מואר בירח. זוהר ירח נראה בדיוק כך, ולכן מחכים ללילות בלי ירח כדי לאשר.";
    top.append(t);
  }
  if (e.pattern === "intermittent") {
    const t = mk("span", "hot-tag mixed", "לסירוגין"), w = e.week;
    t.title = "בשבוע שעד הלילה המקום היה ברמה הקודמת ב־" + w.old + " לילות וברמה החדשה ב־" + w.new + ", ועבר ביניהן " + w.turns + " פעמים: מקור שנדלק וכבה, לא שינוי קבוע.";
    top.append(t);
  }
  {
    const k = keptArea(e.x, e.y, clusterSize(e.detail));
    if (k) {
      const t = mk("span", "ev-kept", "★");
      t.title = "בניתוח האישי: " + k.name;
      top.append(t);
    }
  }
  const when = rowWhen(e);
  if (when) sub.append(mk("span", "ev-when", when));
  sub.append(mk("span", "ev-where", ltr(coordText(e.lonlat, 3))));
  const body = mk("span", "ev-body");
  body.append(top, sub);
  go.append(mark, body);
  go.title = [CHANGE_LABELS[state.product][e.kind][0] + (e.nights > 1 ? " · " + displayDate(e.onset, true) + " – " + displayDate(e.last, true) + ", נראה ב־" + e.nights + " לילות" : ""), changeTitle(e.detail || {}), e.sig ? sigText(e) : "", e.cause ? CAUSE_LABELS[e.cause][1] + heatText(e) : "", "לחיצה: המקום לאורך זמן · Shift+לחיצה או A: להוסיף להשוואה"].filter(Boolean).join("\n");
  go.onclick = ev => selectEvent(e, ev.shiftKey);
  go.dataset.addShift = "";
  const acts = mk("span", "row-acts");
  acts.append(keepButton(e.x, e.y, clusterSize(e.detail), () => [CHANGE_LABELS[state.product][e.kind][0], e.cause ? CAUSE_LABELS[e.cause][0] : "", displayDate(e.onset)].filter(Boolean).join(" · ")), similarButton({
    x: e.x, y: e.y, size_km: clusterSize(e.detail), product: state.product, label: CHANGE_LABELS[state.product][e.kind][0] + " מ־" + displayDate(e.onset), onset: e.onset, last: e.last, kind: e.kind
  }));
  li.append(go, acts);
  return li;
}
// Choosing an event: its place over time (a window just around it, both graphs), its nights shaded in the graph.
function selectEvent(e, add, fly = true) {
  state.events.active = e;
  if (fly) flyTo(e.x, e.y, 8);
  openCluster(e, add);
  renderList();
  renderMap();
  renderChart();
}
function eventsFileName(ext) {
  const s = state.events;
  return (state.product === LR ? "LIGHTROAST" : "TEMPER") + "_events_" + state.meta.name.replace(/\W+/g, "_") + "_" + (s.days === 1 ? state.date : s.days ? s.days + "d_to_" + state.date : "all") + "." + ext;
}
$("evCsv").onclick = () => {
  const rows = [["id", "product", "kind", "cause", "onset", "last", "nights", "status", "longitude", "latitude", "peak"]];
  for (const e of shownEvents()) rows.push([e.id, state.product, e.kind, e.cause || "", e.onset, e.last, e.nights, e.status, e.lonlat[0], e.lonlat[1], e.peak ?? e.strength ?? ""]);
  download(eventsFileName("csv"), rows.map(r => r.join(",")).join("\r\n"), "text/csv");
};
$("evGeo").onclick = () => {
  const fc = { type: "FeatureCollection", features: shownEvents().map(e => ({ type: "Feature", geometry: { type: "Point", coordinates: e.lonlat }, properties: {
        id: e.id, product: state.product, kind: e.kind, cause: e.cause || null, onset: e.onset, last: e.last, nights: e.nights, status: e.status, peak: e.peak ?? e.strength ?? null
      } })) };
  download(eventsFileName("geojson"), JSON.stringify(fc), "application/geo+json");
};
for (const b of document.querySelectorAll("#evDays button")) b.onclick = () => {
  state.events.days = Number(b.dataset.days);
  try {
    localStorage.setItem("viewer-list-days", state.events.days);
  } catch { }
  loadEvents();
};
for (const b of document.querySelectorAll("#tMode button")) b.onclick = () => {
  if (state.events.mode === b.dataset.mode) return;
  state.events.mode = b.dataset.mode;
  loadList();
  renderList();
  renderMap();
};
