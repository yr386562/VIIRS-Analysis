"use strict";
// Coordinate systems, offline and without libraries: latitude/longitude on WGS84 to and from UTM, MGRS, the Israeli
// grid (ITM, EPSG:2039) and the viewer's own grid (EPSG:6933), and a parser for what a person types. Pure functions,
// no page: js/coords.js draws them, and they run in Node for the tests (checked against PROJ).

const GEO = (() => {
  const D = Math.PI / 180;
  const WGS84 = { a: 6378137, f: 1 / 298.257223563 }, GRS80 = { a: 6378137, f: 1 / 298.257222101 };

  // ---------- Transverse Mercator (Snyder 1987, eq. 8-9 to 8-25), accurate to well under a metre within a zone ----------
  function tm(ell, lat0, lon0, k0, fe, fn) {
    const a = ell.a, e2 = ell.f * (2 - ell.f), ep2 = e2 / (1 - e2), e4 = e2 * e2, e6 = e4 * e2;
    const m = phi => a * ((1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * phi - (3 * e2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * Math.sin(2 * phi)
      + (15 * e4 / 256 + 45 * e6 / 1024) * Math.sin(4 * phi) - (35 * e6 / 3072) * Math.sin(6 * phi));
    const M0 = m(lat0 * D);
    return {
      forward(lat, lon) {
        const phi = lat * D, s = Math.sin(phi), c = Math.cos(phi), t = Math.tan(phi);
        const N = a / Math.sqrt(1 - e2 * s * s), T = t * t, C = ep2 * c * c, A = (lon - lon0) * D * c;
        const x = k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5 / 120);
        const y = k0 * (m(phi) - M0 + N * t * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24 + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6 / 720));
        return [fe + x, fn + y];
      },
      inverse(x, y) {
        const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2)), mu = (M0 + (y - fn) / k0) / (a * (1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256));
        const p1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 * e1 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
          + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
        const s = Math.sin(p1), c = Math.cos(p1), t = Math.tan(p1), C1 = ep2 * c * c, T1 = t * t;
        const N1 = a / Math.sqrt(1 - e2 * s * s), R1 = a * (1 - e2) / (1 - e2 * s * s) ** 1.5, Dd = (x - fe) / (N1 * k0);
        const phi = p1 - (N1 * t / R1) * (Dd * Dd / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * Dd ** 4 / 24
          + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * Dd ** 6 / 720);
        const lam = (Dd - (1 + 2 * T1 + C1) * Dd ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * Dd ** 5 / 120) / c;
        return [phi / D, lon0 + lam / D];
      }
    };
  }

  // ---------- UTM and its latitude bands ----------
  const BANDS = "CDEFGHJKLMNPQRSTUVWXX";
  const utmZone = lon => Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1));
  const utmProj = (zone, south) => tm(WGS84, 0, zone * 6 - 183, 0.9996, 500000, south ? 10000000 : 0);
  function toUTM(lat, lon, zone = utmZone(lon)) {
    const [e, n] = utmProj(zone, lat < 0).forward(lat, lon);
    return { zone, band: BANDS[Math.max(0, Math.min(20, Math.floor((lat + 80) / 8)))], e, n };
  }
  function fromUTM(zone, band, e, n) {
    const south = band ? band < "N" : false;
    return utmProj(zone, south).inverse(e, n);
  }

  // ---------- MGRS: UTM with a lettered 100 km square ----------
  const COLS = ["ABCDEFGH", "JKLMNPQR", "STUVWXYZ"], ROWS = "ABCDEFGHJKLMNPQRSTUV";
  function toMGRS(lat, lon) {
    const u = toUTM(lat, lon), set = (u.zone - 1) % 3, col = COLS[set][Math.floor(u.e / 1e5) - 1], row = ROWS[(Math.floor(u.n / 1e5) + (u.zone % 2 ? 0 : 5)) % 20];
    const pad = v => String(Math.floor(v % 1e5)).padStart(5, "0");
    return { zone: u.zone, band: u.band, square: col + row, e: pad(u.e), n: pad(u.n) };
  }
  function fromMGRS(zone, band, square, e, n) {
    const col = COLS[(zone - 1) % 3].indexOf(square[0]), row = ROWS.indexOf(square[1]);
    if (col < 0 || row < 0) throw Error("bad-square");
    const easting = (col + 1) * 1e5 + e;
    let northing = ((row - (zone % 2 ? 0 : 5) + 20) % 20) * 1e5 + n;
    // The row letters repeat every 2,000 km: take the repeat that falls in the latitude band.
    const bi = BANDS.indexOf(band), south = band < "N", lat0 = -80 + 8 * bi, proj = utmProj(zone, south), floor = proj.forward(lat0, zone * 6 - 183)[1];
    while (northing < floor - 1e5) northing += 2e6;
    return proj.inverse(easting, northing);
  }

  // ---------- ITM (Israel 1993, EPSG:2039): Helmert from WGS84, then Transverse Mercator on GRS80 ----------
  // EPSG:1073 (towgs84 -24.0024, -17.1032, -17.8444, -0.33077″, -1.85269″, 1.66969″, 5.4248 ppm), position vector.
  const H = { tx: -24.0024, ty: -17.1032, tz: -17.8444, rx: -0.33077 / 3600 * D, ry: -1.85269 / 3600 * D, rz: 1.66969 / 3600 * D, s: 5.4248e-6 };
  function toXYZ(ell, lat, lon, h = 0) {
    const e2 = ell.f * (2 - ell.f), p = lat * D, l = lon * D, N = ell.a / Math.sqrt(1 - e2 * Math.sin(p) ** 2);
    return [(N + h) * Math.cos(p) * Math.cos(l), (N + h) * Math.cos(p) * Math.sin(l), (N * (1 - e2) + h) * Math.sin(p)];
  }
  function fromXYZ(ell, [x, y, z]) {
    const e2 = ell.f * (2 - ell.f), lon = Math.atan2(y, x), p = Math.hypot(x, y);
    let lat = Math.atan2(z, p * (1 - e2));
    for (let i = 0; i < 6; i++) {
      const N = ell.a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
      lat = Math.atan2(z + e2 * N * Math.sin(lat), p);
    }
    return [lat / D, lon / D];
  }
  // local (Israel 1993) to WGS84 is +H; the way back is -H (the rotations are tiny, so the error is millimetres)
  function helmert([x, y, z], k) {
    const s = 1 + k * H.s, rx = k * H.rx, ry = k * H.ry, rz = k * H.rz;
    return [k * H.tx + s * (x - rz * y + ry * z), k * H.ty + s * (rz * x + y - rx * z), k * H.tz + s * (-ry * x + rx * y + z)];
  }
  const itmProj = tm(GRS80, 31.7343936111111, 35.2045169444444, 1.0000067, 219529.584, 626907.39);
  function toITM(lat, lon) {
    const [la, lo] = fromXYZ(GRS80, helmert(toXYZ(WGS84, lat, lon), -1));
    return itmProj.forward(la, lo);
  }
  function fromITM(e, n) {
    const [la, lo] = itmProj.inverse(e, n);
    return fromXYZ(WGS84, helmert(toXYZ(GRS80, la, lo), 1));
  }

  // ---------- the viewer's grid: EPSG:6933, Lambert cylindrical equal area on WGS84, standard parallel 30° ----------
  const EA = (() => {
    const a = WGS84.a, e2 = WGS84.f * (2 - WGS84.f), e = Math.sqrt(e2), k0 = Math.cos(30 * D) / Math.sqrt(1 - e2 * Math.sin(30 * D) ** 2);
    const q = s => (1 - e2) * (s / (1 - e2 * s * s) - Math.log((1 - e * s) / (1 + e * s)) / (2 * e));
    return {
      forward: (lat, lon) => [a * k0 * lon * D, a * q(Math.sin(lat * D)) / (2 * k0)],
      inverse(x, y) {
        const qq = y * 2 * k0 / a;
        let phi = Math.asin(Math.max(-1, Math.min(1, qq / 2)));
        for (let i = 0; i < 8; i++) {
          const s = Math.sin(phi), ec = e * s, der = 2 * (1 - e2) * Math.cos(phi) / (1 - ec * ec) ** 2;
          phi -= (q(s) - qq) / der;
        }
        return [phi / D, x / (a * k0) / D];
      }
    };
  })();

  // ---------- text ----------
  function dms(v, pos, neg) {
    const h = v < 0 ? neg : pos, a = Math.abs(v), d = Math.floor(a), mf = (a - d) * 60, m = Math.floor(mf), s = (mf - m) * 60;
    const S = s.toFixed(1) === "60.0" ? [d, m + 1, 0] : [d, m, s];
    if (S[1] === 60) {
      S[0] += 1;
      S[1] = 0;
    }
    return S[0] + "°" + String(S[1]).padStart(2, "0") + "′" + S[2].toFixed(1).padStart(4, "0") + "″" + h;
  }
  const group = v => Math.round(v).toLocaleString("en-US");
  const SYSTEMS = ["geo", "dms", "utm", "mgrs", "itm", "grid"];
  function format(lat, lon, system) {
    if (system === "dms") return dms(lat, "N", "S") + " " + dms(lon, "E", "W");
    if (system === "utm") {
      const u = toUTM(lat, lon);
      return u.zone + u.band + " " + Math.round(u.e) + " " + Math.round(u.n);
    }
    if (system === "mgrs") {
      const m = toMGRS(lat, lon);
      return m.zone + m.band + " " + m.square + " " + m.e + " " + m.n;
    }
    if (system === "itm") {
      const [e, n] = toITM(lat, lon);
      return Math.round(e) + ", " + Math.round(n);
    }
    if (system === "grid") {
      const [x, y] = EA.forward(lat, lon);
      return group(x) + ", " + group(y);
    }
    return lat.toFixed(5) + ", " + lon.toFixed(5);
  }

  // What a person types: decimal degrees (lat, lon; with N/S/E/W or not), degrees-minutes-seconds, UTM ("36R 711737
  // 3518074", or "36 711737 3518074" in the north), MGRS ("36RYA1173718074", spaces allowed), ITM or grid metres (two
  // large numbers; which one by the system chosen, else ITM when they fall in Israel's range). Returns { lat, lon,
  // system } or throws an Error whose message is one of the keys of PARSE_ERRORS.
  function parse(text, system = "geo", zoneHint = 36) {
    const t = String(text).trim().toUpperCase().replace(/[‎‏⁦-⁩]/g, "");
    if (!t) throw Error("empty");
    let m = t.replace(/\s+/g, "").match(/^(\d{1,2})([C-HJ-NP-X])([A-HJ-NP-Z])([A-HJ-NP-V])(\d*)$/);
    if (m && m[5].length % 2 === 0) {
      const half = m[5].length / 2, scale = 10 ** (5 - half), e = half ? Number(m[5].slice(0, half)) * scale : 0, n = half ? Number(m[5].slice(half)) * scale : 0;
      const [lat, lon] = fromMGRS(Number(m[1]), m[2], m[3] + m[4], e, n);
      return check(lat, lon, "mgrs");
    }
    m = t.match(/^(\d{1,2})\s*([C-HJ-NP-X])?\s+(\d{5,7}(?:\.\d+)?)\s*E?[\s,]+(\d{5,8}(?:\.\d+)?)\s*N?$/);
    if (m) {
      const [lat, lon] = fromUTM(Number(m[1]), m[2] || "N", Number(m[3]), Number(m[4]));
      return check(lat, lon, "utm");
    }
    if (/[°'′"″]/.test(t)) {
      const parts = [...t.matchAll(/([NSEW])?\s*(\d+(?:\.\d+)?)\s*°\s*(?:(\d+(?:\.\d+)?)\s*['′]\s*)?(?:(\d+(?:\.\d+)?)\s*(?:"|″|''))?\s*([NSEW])?/g)];
      if (parts.length === 2) {
        const v = parts.map(p => {
          const h = p[5] || p[1] || "", x = Number(p[2]) + Number(p[3] || 0) / 60 + Number(p[4] || 0) / 3600;
          return { h, x: h === "S" || h === "W" ? -x : x };
        });
        const latFirst = !(v[0].h === "E" || v[0].h === "W" || v[1].h === "N" || v[1].h === "S");
        const [lat, lon] = latFirst ? [v[0].x, v[1].x] : [v[1].x, v[0].x];
        return check(lat, lon, "dms");
      }
      throw Error("format");
    }
    // Numbers and hemisphere letters as tokens; the letters lead their numbers ("N31.7 E35.2") or follow them ("31.7N 35.2E").
    const toks = t.replace(/([NSEW])(?=-?\d)/g, "$1 ").replace(/(\d)([NSEW])/g, "$1 $2").split(/[\s,;]+/).filter(Boolean);
    if (toks.some(x => !/^([NSEW]|-?\d+(\.\d+)?)$/.test(x))) throw Error("format");
    const lead = /^[NSEW]$/.test(toks[0]), v = [];
    toks.forEach((x, i) => {
      if (/^[NSEW]$/.test(x)) return;
      const h = lead ? (/^[NSEW]$/.test(toks[i - 1] || "") ? toks[i - 1] : "") : (/^[NSEW]$/.test(toks[i + 1] || "") ? toks[i + 1] : "");
      v.push({ h, x: Number(x) });
    });
    if (v.length !== 2) throw Error("format");
    if (Math.abs(v[0].x) <= 180 && Math.abs(v[1].x) <= 180) {
      for (const p of v) if (p.h === "S" || p.h === "W") p.x = -Math.abs(p.x);
      let lat = v[0].x, lon = v[1].x;
      if (v[0].h === "E" || v[0].h === "W" || v[1].h === "N" || v[1].h === "S" || Math.abs(lat) > 90) [lat, lon] = [lon, lat];
      return check(lat, lon, "geo");
    }
    const [a, b] = [v[0].x, v[1].x];
    if (system === "grid") {
      const [lat, lon] = EA.inverse(a, b);
      return check(lat, lon, "grid");
    }
    if (system === "utm" || system === "mgrs") {
      const [lat, lon] = fromUTM(zoneHint, "N", a, b);
      return check(lat, lon, "utm");
    }
    if (system === "itm" || (a > 1e5 && a < 3e5 && b > 3.5e5 && b < 1.4e6)) {
      const [lat, lon] = fromITM(a, b);
      return check(lat, lon, "itm");
    }
    const [lat, lon] = EA.inverse(a, b);
    return check(lat, lon, "grid");
  }
  function check(lat, lon, system) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw Error("range");
    return { lat, lon, system };
  }

  return { SYSTEMS, format, parse, toUTM, fromUTM, toMGRS, fromMGRS, toITM, fromITM, toGrid: EA.forward, fromGrid: EA.inverse, utmZone };
})();
if (typeof module !== "undefined") module.exports = GEO;
