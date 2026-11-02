"use strict";
// Coordinates on the map (its corner by the zoom buttons): where the pointer is, or the map's centre when it is
// elsewhere, in the system chosen (GEO, DMS, UTM, MGRS, ITM or the data's own grid; js/geo.js does the maths), and a
// search box that takes any of them. A found point gets a pin on the map, and can open as a place in the graphs.

const COORD_SYSTEM_KEY = "viewer-coord-system";
const coord = { system: "geo", last: null, pin: null };
try {
  const s = localStorage.getItem(COORD_SYSTEM_KEY);
  if (GEO.SYSTEMS.includes(s)) coord.system = s;
} catch { }
// ITM is the Israeli grid: shown only around Israel, where it means something.
function itmCovers(lat, lon) {
  return lat > 29 && lat < 34 && lon > 33.5 && lon < 36.5;
}
function coordString(ll, system = coord.system) {
  if (!ll) return "";
  const [lon, lat] = ll;
  if (system === "itm" && !itmCovers(lat, lon)) return "—";
  if (system === "grid") {
    const [x, y] = GEO.toGrid(lat, lon);
    return Math.round(x).toLocaleString("en-US") + ", " + Math.round(y).toLocaleString("en-US");
  }
  return GEO.format(lat, lon, system);
}
function renderCoordSystem() {
  for (const b of document.querySelectorAll("#coordSys button")) {
    b.classList.toggle("active", b.dataset.sys === coord.system);
    b.setAttribute("aria-pressed", b.dataset.sys === coord.system);
  }
  $("coordInput").placeholder = {
    geo: "31.7683, 35.2137", dms: "31°46′06″N 35°12′49″E", utm: "36R 709643 3516887", mgrs: "36R YA 09643 16886", itm: "220334, 630626", grid: "3397639, 3853067"
  }[coord.system];
}
// The live line: the point under the pointer, else the centre of the map.
function coordHover(p) {
  const ll = p ? projectedLonLat(p) : state.meta ? projectedLonLat([state.cx, state.cy]) : null;
  coord.last = ll;
  $("coordLive").textContent = ll ? coordString(ll) : "—";
  $("coordWhat").textContent = p ? "מתחת לסמן" : "מרכז המפה";
}
for (const b of document.querySelectorAll("#coordSys button")) b.onclick = () => {
  coord.system = b.dataset.sys;
  try {
    localStorage.setItem(COORD_SYSTEM_KEY, coord.system);
  } catch { }
  renderCoordSystem();
  coordHover(state.hover);
  if (coord.pin) renderCoordHit();
};
$("coordLive").onclick = async () => {
  const text = $("coordLive").textContent;
  if (!coord.last || text === "—") return;
  try {
    await navigator.clipboard.writeText(text);
    toast("הועתק: " + ltr(text));
  } catch {
    toast("ההעתקה נכשלה.");
  }
};
const PARSE_ERRORS = {
  empty: "כתבו קואורדינטות.", format: "לא זיהיתי את הפורמט. דוגמאות: 31.77, 35.21 · 36R 711737 3518074 · 36RYA1173718074 · 220000, 631000",
  range: "הקואורדינטות מחוץ לטווח.", "bad-square": "ריבוע MGRS לא תקין לאזור הזה."
};
$("coordFind").onsubmit = e => {
  e.preventDefault();
  if (!state.meta) return;
  let r;
  try {
    const zone = coord.last ? GEO.utmZone(coord.last[0]) : 36;
    r = GEO.parse($("coordInput").value, coord.system, zone);
  } catch (err) {
    toast(PARSE_ERRORS[err.message] || err.message);
    return;
  }
  const [x, y] = GEO.toGrid(r.lat, r.lon);
  coord.pin = { x, y, lat: r.lat, lon: r.lon, from: r.system };
  flyTo(x, y, 6);
  renderCoordHit();
  if (!inImage([x, y])) toast("הנקודה מחוץ לתמונה של המדינה; המפה עברה אליה בכל זאת.");
};
// The found point: its coordinates in the system chosen and as latitude/longitude, open it as a place, or clear it.
function renderCoordHit() {
  const box = $("coordHit"), p = coord.pin;
  box.hidden = !p;
  box.replaceChildren();
  if (!p) return;
  const where = mk("span", "coord-hit-where");
  where.dir = "ltr";
  where.textContent = coordString([p.lon, p.lat]) + (coord.system === "geo" ? "" : "  ·  " + GEO.format(p.lat, p.lon, "geo"));
  const open = mk("button", "link", "פתיחה בגרף"), clear = mk("button", "coord-clear", "×");
  open.disabled = !inImage([p.x, p.y]);
  open.title = open.disabled ? "מחוץ לתמונה של המדינה" : "המקום הזה לאורך זמן, בגרפים";
  open.onclick = () => openPlace([p.x, p.y], { add: state.windows.some(w => w.kept) });
  clear.title = "הסרת הסימון";
  clear.setAttribute("aria-label", clear.title);
  clear.onclick = () => {
    coord.pin = null;
    renderCoordHit();
    renderMap();
  };
  box.append(where, open, clear);
}
// The pin: a ring with a cross, over everything else on the map.
function drawCoordPin() {
  const p = coord.pin;
  if (!p) return;
  const [px, py] = screen(p.x, p.y);
  ctx.save();
  for (const [w, color] of [[4.5, "rgba(8,8,10,.85)"], [2, "#ffffff"]]) {
    ctx.lineWidth = w;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.arc(px, py, 9, 0, Math.PI * 2);
    ctx.moveTo(px - 16, py);
    ctx.lineTo(px - 5, py);
    ctx.moveTo(px + 5, py);
    ctx.lineTo(px + 16, py);
    ctx.moveTo(px, py - 16);
    ctx.lineTo(px, py - 5);
    ctx.moveTo(px, py + 5);
    ctx.lineTo(px, py + 16);
    ctx.stroke();
  }
  ctx.restore();
}
renderCoordSystem();
