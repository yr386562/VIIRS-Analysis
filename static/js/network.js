"use strict";
// The network of related places, in its own tab (network.html, opened from related places in the viewer). The server
// (/api/network) gives the place, its strongest matches and every pair among them, correlated as related places are
// (Pearson r of residual series, |r| >= max(min r, 4/sqrt(n))), and each node's eigenvector centrality. Drawn here:
// edges blue where two places move together and red where they move oppositely (width and strength by |r|), node size
// by centrality, the place itself ringed. Laid out by a force layout (places related to each other pull together) or
// by the map. The controls choose what is looked for: the product, together or opposite or both, how many places, how
// strong a link, with or without regional changes. A click on a node opens that place in the viewer (BroadcastChannel).
(() => {
  const $ = id => document.getElementById(id), q = new URLSearchParams(location.search);
  const opt = {
    x: Number(q.get("x")), y: Number(q.get("y")), size_km: q.get("size") ? Number(q.get("size")) : null, product: q.get("product") || "lightroast",
    regional: q.get("regional") === "1", from: q.get("from") || null, to: q.get("to") || null, sign: "both", nodes: 25, min_r: .3, layout: "force"
  };
  const label = q.get("label") || "", channel = "BroadcastChannel" in window ? new BroadcastChannel("viirs-network") : null;
  const cv = $("netCanvas"), c = cv.getContext("2d");
  let data = null, pos = [], hover = -1, seq = 0, W = 1, H = 1;
  /* i18n-pairs: written in both languages (I18N.pick), no dictionary entries */
  const L = (he, en) => typeof I18N !== "undefined" ? I18N.pick(he, en) : he;
  const SHAPES = { step: ["מדרגה", "step"], trend: ["מגמה", "trend"], fluct: ["תנודתי", "swinging"], spike: ["קפיצות", "spikes"], stable: ["יציב", "stable"] };
  const tipText = (n, rank) => [
    n.seed ? L("המקום שממנו התחלתם", "The place you started from") : L("מקום ", "Place ") + rank,
    n.lonlat.map(v => v.toFixed(4)).reverse().join(", "),
    n.seed ? "" : "r " + n.r.toFixed(2) + L(" עם המקום · ", " with the place · ") + n.nights + L(" לילות · ", " nights · ") + n.distance_km + L(" ק״מ", " km"),
    L("מרכזיות ", "Centrality ") + n.centrality.toFixed(2) + (n.shape ? " · " + L(...SHAPES[n.shape]) : ""),
    L("לחיצה: בגרפים של המציג", "Click: in the viewer's graphs")].filter(Boolean);
  const statusText = d => d.nodes.length + L(" מקומות · ", " places · ") + d.edges.length + L(" קשרים (", " links (") + d.edges.filter(e => e[2] > 0).length + L(" יחד, ", " together, ") +
    d.edges.filter(e => e[2] < 0).length + L(" הפוך) · ", " opposite) · ") + d.nights + L(" לילות", " nights");
  /* /i18n-pairs */
  function resize() {
    const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    W = r.width;
    H = r.height;
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (data) layout();
    draw();
  }
  async function load() {
    const my = ++seq;
    $("netStatus").textContent = L("בונה את הרשת…", "Building the network…");
    try {
      const r = await fetch("/api/network", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(opt) });
      const d = await r.json();
      if (my !== seq) return;
      if (!r.ok) throw Error(d.error || "error");
      data = d;
      $("netStatus").textContent = statusText(d);
      layout();
      draw();
      list();
    } catch (e) {
      if (my !== seq) return;
      data = null;
      $("netStatus").textContent = e.message;
      draw();
      list();
    }
  }
  const radius = n => 6 + 18 * Math.sqrt(Math.max(0, n.centrality));
  function layout() {
    const N = data.nodes.length, pad = 50;
    if (opt.layout === "map") {   // each place where it is, the map's north up
      const xs = data.nodes.map(n => n.x), ys = data.nodes.map(n => n.y), x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      const s = Math.min((W - 2 * pad) / Math.max(1, x1 - x0), (H - 2 * pad) / Math.max(1, y1 - y0));
      pos = data.nodes.map(n => [W / 2 + (n.x - (x0 + x1) / 2) * s, H / 2 - (n.y - (y0 + y1) / 2) * s]);
      return;
    }
    // Fruchterman-Reingold: every pair pushes apart, every link pulls by its |r|; the place itself stays in the middle
    const k = Math.sqrt(W * H / Math.max(1, N)) * .55;
    pos = data.nodes.map((n, i) => i === 0 ? [W / 2, H / 2] : [W / 2 + Math.cos(i * 2.399) * k * (1 + i / N), H / 2 + Math.sin(i * 2.399) * k * (1 + i / N)]);
    let t = Math.min(W, H) / 6;
    for (let it = 0; it < 450; it++) {
      const d = pos.map(() => [0, 0]);
      for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
        const dx = pos[i][0] - pos[j][0], dy = pos[i][1] - pos[j][1], dist = Math.max(1, Math.hypot(dx, dy)), f = k * k / dist;
        d[i][0] += dx / dist * f;
        d[i][1] += dy / dist * f;
        d[j][0] -= dx / dist * f;
        d[j][1] -= dy / dist * f;
      }
      for (const [i, j, r] of data.edges) {
        const dx = pos[i][0] - pos[j][0], dy = pos[i][1] - pos[j][1], dist = Math.max(1, Math.hypot(dx, dy)), f = dist * dist / k * Math.abs(r);
        d[i][0] -= dx / dist * f;
        d[i][1] -= dy / dist * f;
        d[j][0] += dx / dist * f;
        d[j][1] += dy / dist * f;
      }
      for (let i = 1; i < N; i++) {
        const m = Math.hypot(d[i][0], d[i][1]) || 1, step = Math.min(m, t);
        pos[i][0] = Math.min(W - pad, Math.max(pad, pos[i][0] + d[i][0] / m * step));
        pos[i][1] = Math.min(H - pad, Math.max(pad, pos[i][1] + d[i][1] / m * step));
      }
      t *= .985;
    }
    // then spread to the whole canvas (the place itself stays the centre of the picture)
    const xs = pos.map(p => p[0]), ys = pos.map(p => p[1]), cx = pos[0][0], cy = pos[0][1];
    const sx = Math.max(...xs.map(x => Math.abs(x - cx))), sy = Math.max(...ys.map(y => Math.abs(y - cy)));
    const s = Math.min((W / 2 - pad) / Math.max(1, sx), (H / 2 - pad) / Math.max(1, sy));
    pos = pos.map(([x, y]) => [W / 2 + (x - cx) * s, H / 2 + (y - cy) * s]);
  }
  function draw() {
    c.clearRect(0, 0, W, H);
    if (!data) return;
    const minR = data.min_r || .3;
    const edges = [...data.edges].sort((a, b) => Math.abs(a[2]) - Math.abs(b[2]));   // weaker first, the strong on top
    for (const [i, j, r] of edges) {
      const near = hover < 0 || i === hover || j === hover, s = (Math.abs(r) - minR) / Math.max(.01, 1 - minR);
      c.strokeStyle = (r > 0 ? "rgba(79,140,255," : "rgba(255,77,79,") + (near ? .18 + .7 * s : .05) + ")";
      c.lineWidth = .6 + 3 * s;
      c.beginPath();
      c.moveTo(...pos[i]);
      c.lineTo(...pos[j]);
      c.stroke();
    }
    const order = data.nodes.map((n, i) => i).sort((a, b) => data.nodes[a].centrality - data.nodes[b].centrality);
    const rank = rankOf();
    c.font = "700 11px 'Segoe UI',system-ui,sans-serif";
    c.textAlign = "center";
    c.textBaseline = "middle";
    for (const i of order) {
      const n = data.nodes[i], [x, y] = pos[i], r = radius(n);
      c.beginPath();
      c.arc(x, y, r, 0, Math.PI * 2);
      c.fillStyle = n.seed ? "#f3f4f6" : n.r > 0 ? "rgba(79,140,255,.9)" : "rgba(255,77,79,.9)";
      c.globalAlpha = hover < 0 || i === hover || data.edges.some(e => (e[0] === hover && e[1] === i) || (e[1] === hover && e[0] === i)) ? 1 : .3;
      c.fill();
      c.lineWidth = i === hover ? 3 : 1.5;
      c.strokeStyle = "rgba(8,8,10,.9)";
      c.stroke();
      if (n.seed) {
        c.beginPath();
        c.arc(x, y, r + 5, 0, Math.PI * 2);
        c.lineWidth = 2;
        c.strokeStyle = "#f3f4f6";
        c.stroke();
      }
      if (rank[i] <= 12 || n.seed) {
        c.fillStyle = n.seed ? "#08080a" : "#fff";
        c.fillText(n.seed ? "★" : String(rank[i]), x, y);
      }
      c.globalAlpha = 1;
    }
  }
  function rankOf() {
    const idx = data.nodes.map((n, i) => i).filter(i => !data.nodes[i].seed).sort((a, b) => data.nodes[b].centrality - data.nodes[a].centrality), out = {};
    idx.forEach((i, k) => out[i] = k + 1);
    return out;
  }
  function list() {
    const ol = $("netList");
    ol.replaceChildren();
    if (!data) return;
    const rank = rankOf();
    for (const i of data.nodes.map((n, i) => i).sort((a, b) => data.nodes[b].centrality - data.nodes[a].centrality).slice(0, 20)) {
      const n = data.nodes[i], li = document.createElement("li"), b = document.createElement("button"), dot = document.createElement("i");
      dot.className = n.seed ? "seed" : n.r > 0 ? "pos" : "neg";
      b.append(dot, (n.seed ? "★ " : rank[i] + " · ") + n.centrality.toFixed(2) + (n.seed ? "" : " · r " + n.r.toFixed(2) + " · " + n.distance_km + " km"));
      b.dataset.i18nSkip = "";
      b.onmouseenter = () => {
        hover = i;
        draw();
      };
      b.onmouseleave = () => {
        hover = -1;
        draw();
      };
      b.onclick = () => openInViewer(n);
      li.append(b);
      ol.append(li);
    }
  }
  function openInViewer(n) {
    channel?.postMessage({ type: "open", x: n.x, y: n.y, size_km: n.seed ? (n.size_km || 2.25) : 2.25, add: !n.seed });
    $("netStatus").textContent = L("נפתח בגרפים של המציג", "Opened in the viewer's graphs");
  }
  function nodeAt(e) {
    if (!data) return -1;
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    let best = -1, bd = Infinity;
    data.nodes.forEach((n, i) => {
      const d = Math.hypot(pos[i][0] - x, pos[i][1] - y);
      if (d < radius(n) + 4 && d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  }
  cv.addEventListener("mousemove", e => {
    const i = nodeAt(e), tip = $("netTip");
    if (i !== hover) {
      hover = i;
      draw();
    }
    cv.style.setProperty("cursor", i >= 0 ? "pointer" : "default");
    tip.hidden = i < 0;
    if (i >= 0) {
      tip.replaceChildren(...tipText(data.nodes[i], rankOf()[i]).map(t => Object.assign(document.createElement("div"), { textContent: t })));
      const r = cv.getBoundingClientRect();
      tip.style.setProperty("left", Math.min(r.width - 260, e.clientX - r.left + 14) + "px");
      tip.style.setProperty("top", Math.min(r.height - 110, e.clientY - r.top + 14) + "px");
    }
  });
  cv.addEventListener("mouseleave", () => {
    hover = -1;
    $("netTip").hidden = true;
    draw();
  });
  cv.addEventListener("click", e => {
    const i = nodeAt(e);
    if (i >= 0) openInViewer(data.nodes[i]);
  });
  // the controls: what to look for
  const seg = (id, key, attr, reload = true) => {
    const set = () => {
      for (const b of document.querySelectorAll("#" + id + " button")) b.classList.toggle("active", b.dataset[attr] === String(opt[key]));
    };
    for (const b of document.querySelectorAll("#" + id + " button")) b.onclick = () => {
      opt[key] = b.dataset[attr];
      set();
      if (reload) load(); else {
        layout();
        draw();
      }
    };
    set();
  };
  seg("netProduct", "product", "p");
  seg("netSign", "sign", "s");
  seg("netLayout", "layout", "l", false);
  $("netNodes").onchange = () => {
    opt.nodes = Number($("netNodes").value);
    load();
  };
  $("netMinR").oninput = () => {
    $("netMinROut").textContent = Number($("netMinR").value).toFixed(2);
  };
  $("netMinR").onchange = () => {
    opt.min_r = Number($("netMinR").value);
    load();
  };
  $("netRegional").checked = opt.regional;
  $("netRegional").onchange = () => {
    opt.regional = $("netRegional").checked;
    load();
  };
  document.body.dataset.product = opt.product;
  $("netSeed").textContent = label ? " · " + label : "";
  document.addEventListener("langchange", () => {
    if (data) {
      $("netStatus").textContent = statusText(data);
      list();
    }
  });
  // How to read it: open until closed (remembered).
  try {
    if (localStorage.getItem("viewer-net-howto") === "0") $("netHowto").open = false;
  } catch { }
  $("netHowto").ontoggle = () => {
    try {
      localStorage.setItem("viewer-net-howto", $("netHowto").open ? "1" : "0");
    } catch { }
  };
  // From the tour (?lab=1): the network worked out ahead in the country's lab, shown at once; a control changed then
  // asks the server as usual.
  async function loadLab() {
    try {
      const lab = await (await fetch("/api/lab")).json(), N = lab.network;
      if (!N || N.error) throw Error("no network");
      Object.assign(opt, { x: N.at.x, y: N.at.y, size_km: N.at.size_km, product: N.at.product });
      document.body.dataset.product = opt.product;
      for (const b of document.querySelectorAll("#netProduct button")) b.classList.toggle("active", b.dataset.p === opt.product);
      data = N;
      /* i18n-pairs */
      $("netSeed").textContent = " · " + L("דוגמה מהסיור, מחושבת מראש", "An example from the tour, worked out ahead");
      /* /i18n-pairs */
      $("netStatus").textContent = statusText(N);
      layout();
      draw();
      list();
    } catch {
      load();
    }
  }
  addEventListener("resize", resize);
  resize();
  if (q.get("lab")) loadLab(); else load();
})();
