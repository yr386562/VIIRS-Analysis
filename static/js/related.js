"use strict";
// Related places: where else the same change happened, or what moves with a place (server: /api/related), and
// their marks on the map.

// Related places, one question: the server looks at the place itself and answers what fits it (/api/related).
// A change from the list, or a change at the place around the night shown (one night, or one that lasted): where
// else the same happened then. No change there: what moves with the place over the period, when it varies; a steady
// place gets why there is nothing to relate. A quiet link asks the other question instead (ask).
function similarButton(seed) {
  const b = document.createElement("button");
  b.className = "hot-add sim-btn";
  b.innerHTML = ICONS.related;
  b.title = "מקומות קשורים: איפה עוד זה קרה, או מה זז יחד עם המקום (לפי מה שקרה במקום)";
  b.setAttribute("aria-label", b.title);
  b.onclick = () => findSimilar(seed);
  return b;
}
// night: the night shown when asked (a place without a change of its own is asked about that night).
function findSimilar(seed) {
  state.similar = {
    seed, night: seed.onset || state.date, ask: null, target: seed.product, regional: false, result: null, busy: false, error: null, active: null, seq: 0
  };
  showSide("list");
  runSimilar();
}
// The network of these related places, in its own tab (network.html).
$("similarNet").onclick = () => {
  const s = state.similar;
  if (!s) return;
  const q = new URLSearchParams({ x: s.seed.x, y: s.seed.y, product: s.target, regional: s.regional ? "1" : "0", label: s.seed.label || "" });
  if (s.seed.size_km) q.set("size", s.seed.size_km);
  if (state.rangeFrom) q.set("from", state.rangeFrom);
  if (state.rangeTo) q.set("to", state.rangeTo);
  window.open("network.html?" + q, "viirs-network", "popup,width=1200,height=800");
};
function closeSimilar() {
  state.similar = null;
  showSide(state.side);
}
async function runSimilar() {
  const s = state.similar;
  if (!s || !state.meta) return;
  const seq = ++s.seq;
  s.busy = true;
  s.error = null;
  renderSimilar();
  try {
    const r = await api("/api/related", {
      x: s.seed.x, y: s.seed.y, size_km: s.seed.size_km || null, seed: s.seed.product, target: s.target, onset: s.night,
      last: s.seed.last || s.night, kind: s.seed.kind || null, ask: s.ask, regional: s.regional, from: state.rangeFrom, to: state.rangeTo
    });
    if (state.similar !== s || seq !== s.seq) return;
    s.raw = r;
    s.result = clipRelated(r);   // only the places inside the area worked in (focus.js), if any
    s.active = null;
  } catch (e) {
    if (state.similar !== s || seq !== s.seq) return;
    s.result = s.raw = null;
    s.error = e.message;
  } finally {
    if (state.similar === s && seq === s.seq) s.busy = false;
  }
  renderSimilar();
  renderMap();
}
function productName(p) {
  return p === LR ? "LIGHT ROAST" : "TEMPER";
}
// How much the seed changed: lights as a ratio (the word says up or down), heat in the site's standard deviations.
function timesText(step, product) {
  if (step == null) return "";
  if (product !== LR) return ltr(Math.abs(step).toFixed(1) + "σ");
  const r = Math.exp(Math.abs(step));
  return "פי " + ltr(r >= 10 ? Math.round(r).toString() : r.toFixed(1));
}
// The question answered, and why: what the place itself did around the night.
function answerLine(el, s, r) {
  const head = mk("b"), why = mk("span");
  if (r.mode === "event") {
    const sd = r.seed, up = sd.way === "up", amount = timesText(sd.step, sd.product), when = displayDate(sd.switch);
    head.textContent = "איפה עוד זה קרה";
    if (r.change === "night") {   // on the last night in the data, nothing yet says it went back
      why.textContent = sd.nights_after === 0 ? "ב־" + when + ", הלילה האחרון שיש בנתונים, המקום " + (up ? "קפץ" : "צנח") + (amount ? " " + amount : "") + ": מי עוד חרג כך באותו לילה"
        : "ב־" + when + " המקום " + (up ? "קפץ" : "צנח") + (amount ? " " + amount : "") + " ללילה אחד, ואחר כך חזר לרגיל: מי עוד חרג כך באותו לילה";
    } else {
      why.textContent = "סביב " + when + " המקום " + (up ? "עלה" : "ירד") + (amount ? " " + amount : "") + " ונשאר כך: מי עוד השתנה כך באותו זמן";
      if (sd.nights_after < 3) why.textContent += " (אחרי " + when + " יש בנתונים רק " + sd.nights_after + " לילות: מוקדם לדעת אם נשאר)";
    }
    if (r.chose === "change") why.textContent = "השינוי מהרשימה. " + why.textContent;
    if (r.chose === "detected") {
      const d = r.detected, label = CHANGE_LABELS[sd.product][d.kind][0];
      why.textContent = "ברשימת השינויים יש כאן " + label + " מ־" + displayDate(d.onset) + (d.nights > 1 ? " (" + d.nights + " לילות)" : "") + ". " + why.textContent;
    }
    // A change the list found (each pixel, or block, by itself) that the place's whole series does not show by itself.
    if (sd.step == null && sd.own_z != null) why.textContent += ". " + (sd.nearest_km ? "במוקד הקבוע הקרוב (" + sd.nearest_km + " ק״מ)" : "בסדרה של המקום כולו")
      + " הלילה הזה לא חריג בפני עצמו (" + ltr(sd.own_z.toFixed(1) + "σ") + "; חריג מ־" + ltr("5σ") + "): הרשימה בודקת כל נקודה לבד";
  } else {
    head.textContent = "מה זז יחד";
    why.textContent = r.chose === "asked" ? "מה עולה ויורד יחד עם המקום, לילה אחר לילה, לאורך התקופה"
      : "סביב " + displayDate(s.night) + " לא נמצא כאן שינוי (לא לילה חריג, לא שינוי שנמשך ולא שינוי ברשימה), אז: מה עולה ויורד יחד עם המקום לאורך התקופה";
    if (r.seed?.nearest_km) why.textContent += ". בחלון אין מוקד קבוע, אז הסדרה היא של הקרוב (" + r.seed.nearest_km + " ק״מ)";
  }
  el.append(head, " · ", why);
  const other = mk("button", "link sim-other", r.mode === "event" ? "או: מה זז יחד לאורך התקופה" : "או: איפה עוד זה קרה ב־" + displayDate(s.night));
  other.title = r.mode === "event" ? "המתאם של המקום עם כל מקום אחר, לילה אחר לילה, בתקופה של הגרף" : "השינוי במקום סביב הלילה הזה, ואיפה עוד קרה אז";
  other.onclick = () => {
    s.ask = r.mode === "event" ? "corr" : "event";
    s.result = null;
    runSimilar();
  };
  el.append(mk("br"), other);
}
function simRow(it, i, sign) {
  const li = document.createElement("li"), go = document.createElement("button"), rank = document.createElement("span"), r = document.createElement("b"), where = document.createElement("span"), note = document.createElement("em"), add = document.createElement("button"), s = state.similar;
  go.className = "chg-item" + (s.active === it ? " active" : "");
  rank.className = "sim-rank";
  rank.textContent = i + 1;
  const ev = s.result?.mode === "event", night = s.result?.change === "night";
  if (ev) {
    r.textContent = it.step == null && it.detected ? CHANGE_LABELS[s.result.target][it.detected][0] : stepText(it.step, s.result.target);   // found only in the list: its kind
    where.textContent = ltr(it.distance_km + " ק״מ") + (it.detected ? " · זוהה" : "") + (it.earlier ? " · התחיל קודם" : "");
    note.textContent = it.rate == null ? "" : it.rate === 0 ? "נדיר" : Math.round(it.rate * 100) + (night ? "% מהלילות" : "% מהשבועות");
    go.title = (sign > 0 ? (night ? "חרג באותו כיוון, באותו לילה" : "השתנה באותו כיוון, באותו זמן") : (night ? "חרג בכיוון ההפוך, באותו לילה" : "השתנה בכיוון ההפוך, באותו זמן"))
      + (it.z != null ? " · " + ltr(Math.abs(it.z).toFixed(1) + "σ") : "") + " · " + coordText(it.lonlat, 3)
      + (it.rate != null ? (night ? "\nבלילה רגיל המקום חורג כך ב־" : "\nבשבוע רגיל המקום משתנה כך ב־") + Math.round(it.rate * 100) + "% מהזמן" + (it.rate === 0 ? ": נדיר שם" : "")
        : "\nשינוי שזוהה ברשימה, במקום שאין לו סדרה משלו (חשוך מדי, או דלק מעט מדי לילות)")
      + (it.detected ? "\nגם ברשימת השינויים: " + CHANGE_LABELS[s.result.target][it.detected][0] : "") + (it.earlier ? "\nהשינוי התחיל עוד לפני (4–14 ימים)" : "") + (it.places > 1 ? "\nכולל עוד " + (it.places - 1) + " אזורים צמודים" : "");
  } else {
    r.textContent = ltr("r " + it.r.toFixed(2));
    where.textContent = ltr(it.distance_km + " ק״מ") + (it.places > 1 ? " · " + it.places + " אזורים" : "");
    note.textContent = it.detected_nights != null ? it.detected_nights + " לילות דלק" : it.median_nw != null ? nw(it.median_nw) : "";
    go.title = (sign > 0 ? "עולה ויורד באותם לילות" : "עולה כשהמקום יורד, ולהפך") + " · " + it.nights + " לילות משותפים · " + coordText(it.lonlat, 3) + (it.places > 1 ? " · כולל עוד " + (it.places - 1) + " אזורים צמודים עם התאמה" : "");
  }
  go.onclick = () => {
    s.active = it;
    flyTo(it.x, it.y, 8);
    renderSimilar();
  };
  add.className = "hot-add";
  add.dataset.add = "";   // the A key adds this row's place
  add.innerHTML = ICONS.graph;
  add.title = "שני המקומות בגרפים, זה ליד זה";
  add.setAttribute("aria-label", add.title);
  add.onclick = () => {
    const has = p => state.windows.some(w => Math.hypot(w.center[0] - p[0], w.center[1] - p[1]) < 1000);
    if (!has([s.seed.x, s.seed.y])) openPlace([s.seed.x, s.seed.y], { size: 3 });
    openPlace([it.x, it.y], { size: 3, add: true });
    if (lrMeta() && !state.compare) setCompare(true);
    if (ev) {   // the period around the change: a month either side of one night, else two months before
      const t = dayTime(s.result.seed.switch), [before, after] = night ? [30, 30] : [60, 45];
      $("rangeFrom").value = isoDay(t - before * DAY);
      $("rangeTo").value = isoDay(t + after * DAY);
      setRange();
    }
  };
  go.append(rank, r, where, note);
  li.append(go, add, keepButton(it.x, it.y, 3, () => (ev ? (sign > 0 ? "השתנה יחד עם " : "השתנה הפוך מ") : (sign > 0 ? "נע יחד עם " : "נע הפוך מ")) + s.seed.label), similarButton({ x: it.x, y: it.y, product: s.target, label: "מקום קשור" }));
  return li;
}
function renderSimilar() {
  const s = state.similar, r = s?.result, empty = $("similarEmpty");
  $("similarCount").textContent = r ? String(r.positive.length + r.negative.length) : s?.busy ? "מחפש…" : "";
  for (const [id, p] of [["simTargetTemper", "temper"], ["simTargetLight", LR]]) {
    $(id).classList.toggle("active", s?.target === p);
    $(id).disabled = p === LR && !lrMeta();
  }
  const ev = r?.mode === "event", night = r?.change === "night";
  const answer = $("simAnswer");
  answer.replaceChildren();
  answer.hidden = !r;
  if (r) answerLine(answer, s, r);
  $("simRegionalRow").hidden = !s || !r || ev || (s.target !== LR && s.seed.product !== LR);
  $("simRegional").checked = !!s?.regional;
  $("simPosHead").textContent = ev ? (night ? "חרגו כך באותו לילה" : "השתנו כך באותו זמן") : "נעים יחד";
  $("simNegHead").textContent = ev ? (night ? "חרגו הפוך באותו לילה" : "השתנו הפוך באותו זמן") : "נעים הפוך";
  $("simPosHead").title = ev ? "באותו כיוון, באותו זמן (המקומות שבדרך כלל לא משתנים כך קודם)" : "עולים ויורדים באותם לילות";
  $("simNegHead").title = ev ? "בכיוון ההפוך, באותו זמן" : "כשהמקום עולה הם יורדים, ולהפך";
  const rare = $("simRarity");
  rare.replaceChildren();
  rare.hidden = !(ev && r?.rarity);
  if (ev && r?.rarity) rarityLine(rare, r);
  const seed = $("similarSeed");
  seed.replaceChildren();
  if (s) {
    const b = document.createElement("b");
    b.textContent = s.seed.label;
    seed.append(b, " · ", productName(s.seed.product) + " · " + ltr(coordText(s.seed.lonlat || projectedLonLat([s.seed.x, s.seed.y]) || [0, 0], 3)));
    // two dates, with their years when they are in different years
    const span = (a, b) => a.slice(0, 4) === b.slice(0, 4) ? displayDate(a) + " – " + displayDate(b) : displayDate(a, true) + " – " + displayDate(b, true);
    if (ev) seed.append(" · מול " + (night ? "הלילות " : "") + span(r.window.before[0], r.window.before[1]));
    else if (r && !r.stable) seed.append(" · " + r.nights + " לילות, " + span(r.first, r.last) + " · מול " + r.candidates.toLocaleString("en-US") + (r.target === LR ? " אזורים מוארים שמשתנים" : " מוקדים פעילים שמשתנים") + (r.places ? " (מתוך " + r.places.toLocaleString("en-US") + ")" : ""));
  }
  for (const [id, list, count, sign] of [["simPos", r?.positive, "simPosCount", 1], ["simNeg", r?.negative, "simNegCount", -1]]) {
    const ol = $(id);
    ol.replaceChildren();
    $(count).textContent = r ? String(list.length) : "";
    if (r && !list.length) {
      const li = document.createElement("li");
      li.className = "none";
      li.textContent = ev ? "לא נמצא" : "אין התאמה ברורה";
      ol.append(li);
    }
    if (list) list.forEach((it, i) => ol.append(simRow(it, i, sign)));
  }
  empty.hidden = !!r && !r.stable;
  const quiet = r?.stable ? (r.chose === "no-change" ? "סביב " + displayDate(s.night) + " לא נמצא כאן שינוי, ו" : "") + r.message : "";
  empty.querySelector("span").textContent = !s ? "" : s.busy ? "מחפש מקומות קשורים…" : s.error || quiet;
}
// A place's own year in words: steady, or its shape (and for a step, how much and when).
function profileText(f, product) {
  if (!f.shape) return "מעט מדי לילות";
  if (product === LR && !f.active) return "חשוך";
  if (product !== LR && !f.active) return "כמעט אף פעם";
  if (f.shape === "stable") return "יציב: בלי מתאם";
  const x = { shape: f.shape, change: f.change, direction: f.direction, when: f.when, switches: f.switches, spikes: 0 };
  return f.shape === "spike" ? "קפיצות" : searchText(x, product);
}
// A step or a night: lights as a percentage (as a ratio from x2 up), heat in the site's own standard deviations.
function stepText(step, product) {
  if (step == null) return "—";
  if (product !== LR) return ltr((step > 0 ? "+" : "−") + Math.abs(step).toFixed(1) + "σ");
  const r = Math.exp(step);
  return r >= 2 ? ltr("×" + (r >= 10 ? Math.round(r) : r.toFixed(1))) : pct(r);
}
// How unusual: the changes of this direction that started then (one night: the places that stood out that night,
// and the short changes detected), nearby and in the whole country, against ordinary times.
function rarityLine(el, r) {
  const q = r.rarity, nights = q.unit === "nights", word = x => x == null ? "" : x >= 4 ? "הרבה יותר מהרגיל" : x >= 2 ? "יותר מהרגיל" : x <= .5 ? "פחות מהרגיל" : "כרגיל";
  const part = (label, n, typ, ratio) => {
    const b = document.createElement("b");
    b.textContent = label + ": " + n.toLocaleString("en-US");
    const sp = document.createElement("span");
    sp.textContent = " (" + (nights ? "בלילה רגיל " : "בזמן רגיל ") + (typ == null ? "—" : (+typ.toFixed(1)).toLocaleString("en-US")) + (ratio != null ? ", פי " + ratio : "") + ") · " + word(ratio);
    sp.className = ratio >= 2 ? "hot" : "";
    return [b, sp];
  };
  el.append(...part("עד " + q.local_km + " ק״מ", q.local, q.typical_local, q.ratio_local), document.createElement("br"), ...part("בכל המדינה", q.count, q.typical, q.ratio));
  // A night seen in part: the ordinary count is scaled to the share seen that night.
  const seen = [q.seen_local != null ? Math.round(q.seen_local * 100) + "% מהמקומות עד " + q.local_km + " ק״מ" : "", q.seen != null ? Math.round(q.seen * 100) + "% מהמקומות במדינה" : ""].filter(Boolean);
  if (seen.length) el.append(document.createElement("br"), mk("span", "muted", "בלילה הזה נראו רק " + seen.join(" ו־") + " שנראים בלילה רגיל, והרגיל הותאם לכך"));
  el.title = (nights ? "המקומות שחרגו באותו כיוון באותו לילה, ועוד השינויים הקצרים שזוהו אז (לילה לפני ועד לילה אחרי), מול אותה ספירה ב־" + q.weeks + " לילות רגילים בשנה."
    : "שינויים שזוהו באותו כיוון שהתחילו באותו זמן (3 ימים לפני ועד סוף השינוי), מול אותה ספירה ב־" + q.weeks + " זמנים אחרים בשנה.")
    + " מעל פי 2: יש כאן משהו משותף; כרגיל: השינוי עומד בפני עצמו.";
}
// On the map: the chosen place (a ring with a cross), the places that move with it (filled diamonds, the 10 strongest
// numbered) and against it (hollow diamonds).
function drawSimilar() {
  const s = state.similar, r = s.result;
  ctx.save();
  ctx.lineJoin = "round";
  ctx.font = "700 10px 'Segoe UI',system-ui,sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const diamond = (px, py, size) => {
    ctx.beginPath();
    ctx.moveTo(px, py - size);
    ctx.lineTo(px + size, py);
    ctx.lineTo(px, py + size);
    ctx.lineTo(px - size, py);
    ctx.closePath();
  };
  for (const [list, sign] of [[r.negative, -1], [r.positive, 1]]) list.forEach((it, i) => {
    const [px, py] = screen(it.x, it.y);
    if (px < -20 || py < -20 || px > state.width + 20 || py > state.height + 20) return;
    const on = s.active === it, strength = it.r != null ? Math.abs(it.r) : Math.min(1, Math.abs(it.z ?? 4) / 20), size = on ? 8 : 5 + strength * 3;
    diamond(px, py, size);
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(8,8,10,.8)";
    ctx.stroke();
    ctx.lineWidth = on ? 2.4 : 1.6;
    ctx.strokeStyle = INK;
    if (sign < 0) ctx.setLineDash([2, 2]);
    ctx.stroke();
    ctx.setLineDash([]);
    if (sign > 0) {
      ctx.fillStyle = "rgba(236,236,239," + (0.25 + 0.6 * strength) + ")";
      ctx.fill();
    }
    if (sign > 0 && (i < 10 || on)) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(8,8,10,.85)";
      ctx.strokeText(i + 1, px, py - size - 8);
      ctx.fillStyle = INK;
      ctx.fillText(i + 1, px, py - size - 8);
    }
  });
  const [sx, sy] = screen(r.seed.x, r.seed.y);
  ctx.beginPath();
  ctx.arc(sx, sy, 9, 0, Math.PI * 2);
  ctx.lineWidth = 4;
  ctx.strokeStyle = "rgba(8,8,10,.8)";
  ctx.stroke();
  ctx.lineWidth = 2;
  ctx.strokeStyle = INK;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(sx - 13, sy);
  ctx.lineTo(sx - 5, sy);
  ctx.moveTo(sx + 5, sy);
  ctx.lineTo(sx + 13, sy);
  ctx.moveTo(sx, sy - 13);
  ctx.lineTo(sx, sy - 5);
  ctx.moveTo(sx, sy + 5);
  ctx.lineTo(sx, sy + 13);
  ctx.stroke();
  ctx.restore();
}
$("simTargetTemper").onclick = () => {
  if (!state.similar || state.similar.target === "temper") return;
  state.similar.target = "temper";
  runSimilar();
};
$("simTargetLight").onclick = () => {
  if (!state.similar || state.similar.target === LR) return;
  state.similar.target = LR;
  runSimilar();
};
$("simRegional").onchange = () => {
  if (!state.similar) return;
  state.similar.regional = $("simRegional").checked;
  runSimilar();
};
$("similarBack").onclick = closeSimilar;
