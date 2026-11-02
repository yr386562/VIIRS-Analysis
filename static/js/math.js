"use strict";
// The math page. A secret: three clicks on the product's emblem (top bar) open it; the tour and the help never name
// it. What the viewer computes, as a short paper: its formulas are written in LaTeX and typeset here as MathML, which
// the browser draws itself (TEX below: a small LaTeX reader, no library, nothing online). A click on a formula copies
// its LaTeX; .tex saves the whole paper as a LaTeX document (XeLaTeX). The thresholds that can be changed sit in a
// table in their section, by their symbol (server: /api/params; kept in config.json); changing one makes again what
// depends on it (the event log, the behaviour shapes, the kept answers, the tour's lab). Written in both languages
// (I18N.pick). METHODS.md has the same in full, with the checks behind each number.

// ---------- TEX: LaTeX (the part of amsmath these formulas use) to MathML ----------
const TEX = (() => {
  const NS = "http://www.w3.org/1998/Math/MathML";
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const el = (tag, attrs, ...kids) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs || {}) e.setAttribute(k, attrs[k]);
    for (const k of kids) if (k != null) e.append(k);
    return e;
  };
  const GREEK = {
    alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ϵ", varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ",
    iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", upsilon: "υ", phi: "ϕ",
    varphi: "φ", chi: "χ", psi: "ψ", omega: "ω", ell: "ℓ", infty: "∞", partial: "∂", nabla: "∇", emptyset: "∅", hbar: "ℏ"
  };
  const UPGREEK = { Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω" };
  const OPS = {
    le: "≤", leq: "≤", ge: "≥", geq: "≥", ne: "≠", neq: "≠", approx: "≈", sim: "∼", simeq: "≃", propto: "∝", equiv: "≡", ll: "≪", gg: "≫",
    cdot: "⋅", times: "×", div: "÷", pm: "±", mp: "∓", ast: "∗", star: "⋆", circ: "∘", to: "→", rightarrow: "→", leftarrow: "←",
    Rightarrow: "⇒", Leftarrow: "⇐", Leftrightarrow: "⇔", iff: "⟺", implies: "⟹", mapsto: "↦", uparrow: "↑", downarrow: "↓",
    in: "∈", notin: "∉", ni: "∋", subset: "⊂", subseteq: "⊆", cup: "∪", cap: "∩", setminus: "∖", land: "∧", wedge: "∧", lor: "∨",
    vee: "∨", neg: "¬", lnot: "¬", forall: "∀", exists: "∃", nexists: "∄", mid: "∣", ldots: "…", dots: "…", cdots: "⋯", vdots: "⋮",
    lfloor: "⌊", rfloor: "⌋", lceil: "⌈", rceil: "⌉", langle: "⟨", rangle: "⟩", lvert: "|", rvert: "|", lVert: "‖", rVert: "‖",
    "|": "‖", "{": "{", "}": "}", colon: ":", coloneqq: "≔", triangleq: "≜", top: "⊤", perp: "⊥", oplus: "⊕", otimes: "⊗"
  };
  const FENCES = new Set(["lfloor", "rfloor", "lceil", "rceil", "langle", "rangle", "lvert", "rvert", "lVert", "rVert", "|", "{", "}"]);
  const BIG = { sum: "∑", prod: "∏", bigcup: "⋃", bigcap: "⋂" };
  const FN = new Set(["log", "ln", "exp", "sin", "cos", "tan", "dim", "arg"]);
  const LIMITS = new Set(["max", "min", "sup", "inf", "lim", "Pr", "det"]);
  const SPACE = { ",": .1667, ":": .2222, ">": .2222, ";": .2778, " ": .3333, quad: 1, qquad: 2, enspace: .5 };
  const ACCENT = { bar: "¯", overline: "‾", hat: "^", widehat: "^", tilde: "˜", widetilde: "˜", dot: "˙", ddot: "¨", vec: "→" };
  const BIGSIZE = { big: 1.2, Big: 1.62, bigg: 2.05, Bigg: 2.47 };
  const RAW = new Set(["text", "textrm", "textit", "textbf", "mbox", "mathrm", "operatorname", "mathbb", "mathcal", "mathbf", "mathit"]);
  const styled = (s, kind) => [...s].map(ch => {
    const c = ch.codePointAt(0), up = c >= 65 && c <= 90, low = c >= 97 && c <= 122, dig = c >= 48 && c <= 57;
    if (kind === "mathbb") {
      const odd = { C: "ℂ", H: "ℍ", N: "ℕ", P: "ℙ", Q: "ℚ", R: "ℝ", Z: "ℤ" };
      return odd[ch] || (up ? String.fromCodePoint(0x1D538 + c - 65) : low ? String.fromCodePoint(0x1D552 + c - 97) : dig ? String.fromCodePoint(0x1D7D8 + c - 48) : ch);
    }
    if (kind === "mathcal") {
      const odd = { B: "ℬ", E: "ℰ", F: "ℱ", H: "ℋ", I: "ℐ", L: "ℒ", M: "ℳ", R: "ℛ" };
      return odd[ch] || (up ? String.fromCodePoint(0x1D49C + c - 65) : ch);
    }
    if (kind === "mathbf") return up ? String.fromCodePoint(0x1D400 + c - 65) : low ? String.fromCodePoint(0x1D41A + c - 97) : dig ? String.fromCodePoint(0x1D7CE + c - 48) : ch;
    return ch;
  }).join("");

  function lex(s) {
    const out = [];
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === "\\") {
        const m = /^\\([A-Za-z]+)\s*|^\\([^A-Za-z])/.exec(s.slice(i));
        i += m[0].length;
        const name = m[1] || m[2];
        if (m[1] && RAW.has(name)) {   // its argument as written: text, a name, a letter style
          let star = false;
          if (s[i] === "*") {
            star = true;
            i++;
          }
          while (s[i] === " ") i++;
          if (s[i] === "{") {
            let depth = 1, j = i + 1;
            while (j < s.length && depth) {
              if (s[j] === "\\") j++;
              else if (s[j] === "{") depth++;
              else if (s[j] === "}") depth--;
              j++;
            }
            out.push({ t: "raw", c: name, star, v: s.slice(i + 1, j - 1) });
            i = j;
          } else {
            out.push({ t: "raw", c: name, star, v: s[i] || "" });
            i++;
          }
          continue;
        }
        out.push({ t: "cmd", v: name });
      } else if (/\s/.test(ch)) {
        i++;
      } else if (/[0-9]/.test(ch)) {
        const m = /^[0-9]+(\.[0-9]+)?/.exec(s.slice(i));
        out.push({ t: "num", v: m[0] });
        i += m[0].length;
      } else {
        const cp = String.fromCodePoint(s.codePointAt(i));
        out.push({ t: "ch", v: cp });
        i += cp.length;
      }
    }
    return out;
  }
  const isCh = (t, v) => t && t.t === "ch" && t.v === v, isCmd = (t, v) => t && t.t === "cmd" && t.v === v;
  const unraw = v => v.replace(/\\,|\\;|\\:|\\ /g, " ").replace(/\\([%#&_{}$])/g, "$1").replace(/~/g, " ");
  // A function name and what follows: a thin space, unless a bracket opens right after (TeX's Op then Open).
  const opens = t => isCh(t, "(") || isCh(t, "[") || isCmd(t, "left") || (t && t.t === "cmd" && /^[Bb]igg?l?$/.test(t.v));

  function parse(src, display) {
    const T = lex(src);
    let i = 0;
    const row = items => items.length === 1 ? items[0] : el("mrow", null, ...items);
    const fence = (v, extra) => el("mo", Object.assign({ fence: "true", stretchy: "true", symmetric: "true" }, extra), v === "." ? "" : v);
    function delim() {
      const t = T[i++];
      if (!t) return ".";
      if (t.t === "ch") return t.v === "<" ? "⟨" : t.v === ">" ? "⟩" : t.v;
      return has(OPS, t.v) ? OPS[t.v] : t.v;
    }
    function seq(stop) {
      const items = [];
      while (i < T.length && !stop(T[i])) {
        if (isCmd(T[i], "displaystyle") || isCmd(T[i], "textstyle")) {
          const ds = T[i++].v === "displaystyle";
          items.push(el("mrow", { displaystyle: String(ds) }, ...seq(stop)));
          break;
        }
        const a = script();
        if (a == null) continue;
        items.push(a);
        if (a._fn && i < T.length && !stop(T[i]) && !opens(T[i])) items.push(el("mspace", { width: "0.1667em" }));
      }
      return items;
    }
    const inBraces = t => isCh(t, "}");
    function group() {
      if (isCh(T[i], "{")) {
        i++;
        const r = seq(inBraces);
        i++;
        return row(r);
      }
      return atom() || el("mrow");
    }
    function script() {
      const base = atom();
      if (base == null) return null;
      let sub = null, sup = null, primes = 0;
      for (;;) {
        if (isCh(T[i], "_")) {
          i++;
          sub = group();
        } else if (isCh(T[i], "^")) {
          i++;
          sup = group();
        } else if (isCh(T[i], "'")) {
          i++;
          sup = el("mo", null, "′″‴"[Math.min(primes++, 2)]);
        } else break;
      }
      if (!sub && !sup) return base;
      // limits go under and over (movablelimits puts them aside in running text, as TeX does)
      const tag = base._limits ? (sub && sup ? "munderover" : sub ? "munder" : "mover") : (sub && sup ? "msubsup" : sub ? "msub" : "msup");
      const n = el(tag, null, base, sub, sup);
      n._fn = base._fn;
      return n;
    }
    function env(name) {
      const rows = [[[]]], stop = t => isCh(t, "&") || isCmd(t, "\\") || isCmd(t, "end");
      for (;;) {
        const r = rows[rows.length - 1];
        r[r.length - 1] = seq(stop);
        const t = T[i++];
        if (!t || isCmd(t, "end")) {
          if (isCh(T[i], "{")) while (i < T.length && !isCh(T[i++], "}"));
          break;
        }
        if (isCh(t, "&")) r.push([]);
        else {
          if (isCh(T[i], "[")) while (i < T.length && !isCh(T[i++], "]"));   // \\[4pt]: the gap is the stylesheet's
          rows.push([[]]);
        }
      }
      const aligned = /^(aligned|align\*?|split|gathered)$/.test(name);
      const table = el("mtable", { class: "tex-" + (aligned ? "aligned" : name) }, ...rows.filter(r => r.some(c => c.length)).map(r => el("mtr", null,
        ...r.map((c, k) => el("mtd", { class: aligned ? (k % 2 ? "tex-l" : "tex-r") : "tex-l" }, ...(aligned && k % 2 ? [el("mi")] : []), ...c)))));
      if (name === "cases") return el("mrow", null, fence("{"), table, fence("."));
      if (name === "pmatrix") return el("mrow", null, fence("("), table, fence(")"));
      if (name === "bmatrix") return el("mrow", null, fence("["), table, fence("]"));
      return table;
    }
    function atom() {
      const t = T[i++];
      if (!t) return null;
      if (t.t === "num") return el("mn", null, t.v);
      if (t.t === "raw") {
        const v = unraw(t.v);
        if (/^text|^mbox/.test(t.c)) return el("mtext", { class: t.c === "textbf" ? "tex-bf" : t.c === "textit" ? "tex-it" : "" }, v.replace(/^ | $/g, "\u00a0"));
        if (t.c === "mathbb" || t.c === "mathcal" || t.c === "mathbf") return el("mi", { mathvariant: "normal" }, styled(v, t.c));
        if (t.c === "mathit") return el("mi", null, v);
        if (t.c === "operatorname" && t.star) {   // \operatorname*: limits under it
          const n = el("mo", { movablelimits: "true", lspace: "0", rspace: "0" }, v);
          n._fn = n._limits = true;
          return n;
        }
        const n = el("mi", { mathvariant: "normal" }, v);   // \mathrm, \operatorname
        n._fn = t.c === "operatorname";
        return n;
      }
      if (t.t === "ch") {
        const v = t.v;
        if (v === "{") {
          const r = seq(inBraces);
          i++;
          return row(r);
        }
        if (v === "}") return null;
        if (v === "~") return el("mspace", { width: "0.3333em" });
        if (/\p{L}/u.test(v)) return el("mi", null, v);
        if (/\p{N}/u.test(v)) return el("mn", null, v);
        if (v === "-") return el("mo", null, "−");
        if (v === "*") return el("mo", null, "∗");
        if ("()[]|".includes(v)) return el("mo", { stretchy: "false", lspace: "0", rspace: "0" }, v);   // brackets and bars: no operator space
        return el("mo", null, v);
      }
      const c = t.v;
      if (has(GREEK, c)) return el("mi", null, GREEK[c]);
      if (has(UPGREEK, c)) return el("mi", { mathvariant: "normal" }, UPGREEK[c]);
      if (has(SPACE, c)) return el("mspace", { width: SPACE[c] + "em" });
      if (c === "!") return null;
      if ("%#&_$".includes(c) && c.length === 1) return el("mi", { mathvariant: "normal" }, c);
      if (has(BIG, c)) {
        const n = el("mo", { largeop: "true", movablelimits: "true" }, BIG[c]);
        n._limits = true;
        return n;
      }
      if (c === "int") return el("mo", { largeop: "true" }, "∫");
      if (LIMITS.has(c)) {
        const n = el("mo", { movablelimits: "true", lspace: "0", rspace: "0" }, c);
        n._fn = n._limits = true;
        return n;
      }
      if (FN.has(c)) {
        const n = el("mi", { mathvariant: "normal" }, c);
        n._fn = true;
        return n;
      }
      if (c === "bmod") return el("mo", { lspace: "0.2222em", rspace: "0.2222em" }, "mod");
      if (has(OPS, c)) {
        if (FENCES.has(c)) return el("mo", { stretchy: "false", lspace: "0", rspace: "0" }, OPS[c]);
        if (c === "iff" || c === "implies") return el("mo", { lspace: "0.2778em", rspace: "0.2778em" }, OPS[c]);
        return el("mo", null, OPS[c]);
      }
      if (c === "frac" || c === "dfrac" || c === "tfrac") {
        const num = group(), den = group();
        return el("mfrac", c === "tfrac" ? { displaystyle: "false" } : c === "dfrac" ? { displaystyle: "true" } : null, num, den);
      }
      if (c === "sqrt") {
        if (isCh(T[i], "[")) {
          i++;
          const idx = seq(t => isCh(t, "]"));
          i++;
          return el("mroot", null, group(), row(idx));
        }
        return el("msqrt", null, group());
      }
      if (c === "left") {
        const open = delim(), body = seq(t => isCmd(t, "right"));
        i++;
        const close = delim();
        return el("mrow", null, fence(open), ...body, fence(close));
      }
      if (c === "middle") return fence(delim());
      if (has(BIGSIZE, c.replace(/[lr]$/, ""))) {
        const size = BIGSIZE[c.replace(/[lr]$/, "")] + "em";
        return fence(delim(), { minsize: size, maxsize: size });
      }
      if (has(ACCENT, c)) {
        const wide = c === "overline" || c.startsWith("wide");
        return el("mover", { accent: "true" }, group(), el("mo", { stretchy: wide ? "true" : "false" }, ACCENT[c]));
      }
      if (c === "underline") return el("munder", { accentunder: "true" }, group(), el("mo", { stretchy: "true" }, "_"));
      if (c === "underset" || c === "overset" || c === "stackrel") {
        const a = group(), b = group();
        return el(c === "underset" ? "munder" : "mover", null, b, a);
      }
      if (c === "phantom") return el("mphantom", null, group());
      if (c === "begin") {
        let name = "";
        if (isCh(T[i], "{")) {
          i++;
          while (i < T.length && !isCh(T[i], "}")) name += T[i++].v;
          i++;
        }
        return env(name);
      }
      return el("mtext", { class: "tex-err" }, "\\" + c);
    }
    const kids = seq(() => false);
    return el("math", display ? { display: "block", dir: "ltr" } : { dir: "ltr" }, row(kids));
  }
  // MathML drawn by the browser (Chrome and Edge from 109, Firefox): else the formulas stay as their LaTeX.
  let ok = null;
  function supported() {
    if (ok == null) {
      const probe = mk("div", "tex-probe"), m = el("math", null, el("mspace", { height: "23px", width: "77px" }));
      probe.append(m);
      document.body.append(probe);
      const r = m.getBoundingClientRect();
      probe.remove();
      ok = Math.abs(r.width - 77) <= 2 && Math.abs(r.height - 23) <= 2;
    }
    return ok;
  }
  function render(src, display) {
    if (!supported()) return mk(display ? "pre" : "code", "tex-src", src);
    try {
      return parse(src, display);
    } catch {
      return mk(display ? "pre" : "code", "tex-src", src);
    }
  }
  return { render, supported };
})();

// ---------- the paper ----------
/* i18n-pairs: written in both languages (I18N.pick), no dictionary entries */
// A section's body: prose [he, en] (inline math between $…$), or { tex } a numbered display formula.
const MATH = [
  { id: "grid", title: ["הרשת והלילה", "The grid and the night"], body: [
    ["כל לילה יושב על אותה רשת: EPSG:6933, תאים שווי־שטח של 750 מ׳. כשמעברים חופפים, כל פיקסל לוקח את המעבר עם זווית הצילום $\\theta$ הקטנה ביותר (הכי קרוב לנדיר): שם הפיקסל הקטן ביותר והרעש הנמוך ביותר. כל דגימה מקורית נספרת פעם אחת.",
     "Every night sits on one grid: EPSG:6933, equal-area 750 m cells. Where passes overlap, each pixel takes the pass with the smallest view zenith $\\theta$ (nearest nadir): the smallest pixel and the lowest noise. Each native sample is counted once."],
    { tex: "L(x) = L_{p^\\ast}(x), \\qquad p^\\ast(x) = \\operatorname*{arg\\,min}_{p \\,\\ni\\, x} \\theta_p(x)" },
    ["LIGHT ROAST: אריחי Black Marble ($15''$) מצטמצמים לאותה רשת: תא $c$ הוא ממוצע התאים השמישים $U_c$ שבו, כשהם לפחות חצי מתאי המקור $C_c$.",
     "LIGHT ROAST: Black Marble tiles ($15''$) are reduced to the same grid: a cell $c$ is the mean of its usable cells $U_c$, when they are at least half of its source cells $C_c$."],
    { tex: "L(c) = \\frac{1}{|U_c|} \\sum_{u \\in U_c} L(u), \\qquad |U_c| \\ge \\tfrac{1}{2}\\,|C_c|" }] },
  { id: "sig", title: ["רעש ומובהקות (TEMPER)", "Noise and significance (TEMPER)"], body: [
    ["הרעש של כל לילה נמדד מהלילה עצמו, לכל רצועה $\\Theta_k$ של $5^\\circ$ בזווית הצילום: הממוצע של הרעש $N$ הקטוע ב־0 (בלי ה־0.1% העליונים). לרעש נורמלי $\\mathbb{E}\\max(N,0) = \\sigma/\\sqrt{2\\pi}$; זו גם ההטיה שהקטיעה מוסיפה לכל ממוצע, ולכן היא מנוכה מכל ערך.",
     "Each night's noise is measured from the night itself, per $5^\\circ$ band $\\Theta_k$ of view zenith: the mean of the noise $N$ clipped at 0 (the top 0.1% left out). For normal noise $\\mathbb{E}\\max(N,0) = \\sigma/\\sqrt{2\\pi}$; it is also the bias the clipping adds to every average, so it is taken off every value."],
    { tex: "b(\\theta) = \\operatorname{mean}_{\\Theta_k} \\max(N, 0), \\qquad \\sigma(\\theta) = \\sqrt{2\\pi}\\; b(\\theta)" },
    { tex: "\\tilde L = L - b(\\theta), \\qquad z = \\frac{L - b(\\theta)}{\\sigma(\\theta)}" },
    ["במפה המשולבת:", "On the combined map:"],
    { tex: "S = \\begin{cases} (z_{10} + z_{11}) / \\sqrt{2} & \\text{both bands} \\\\ z_{10} & \\text{otherwise} \\end{cases}" }] },
  { id: "detect", title: ["זיהוי: מה בוער הלילה", "Detection: what burns tonight"], body: [
    ["הסף נקבע ביחידות רעש, כך שהוא קפדני באותה מידה בנדיר ובקצה הסריקה. התפלגות פארטו מוכללת (EVT) מותאמת לזנב שמעל האחוזון ה־95 $u$:",
     "The threshold is set in noise units, so it is equally strict at nadir and at the swath edge. A generalised Pareto distribution (EVT) is fitted to the tail above the 95th percentile $u$:"],
    { tex: "P\\left(X > u + y \\mid X > u\\right) = \\left(1 + \\frac{\\xi\\, y}{\\beta}\\right)^{-1/\\xi}, \\qquad X = \\frac{L}{\\sigma(\\theta)}" },
    ["הסף הוא הקוונטיל שלה לתקציב של $B = 100$ אזעקות שווא ללילה על $N$ הפיקסלים של המדינה, ואישור M11 באותו פיקסל או בשכן ($\\mathcal{N}_1$). M11 מעל הרעש שלו: שיעור אזעקת שווא $10^{-3}$ לדגימה. בלי M11 במעבר: נשמר, לא מאושר.",
     "The threshold is its quantile for a budget of $B = 100$ false alarms a night over the country's $N$ pixels, with M11 confirmation in the same or a neighbouring pixel ($\\mathcal{N}_1$). M11 above its own noise: a false-alarm rate of $10^{-3}$ a sample. A pass without M11: kept, unconfirmed."],
    { tex: "\\text{hot}(x) \\iff \\frac{L(x)}{\\sigma(\\theta)} > Q_{\\mathrm{GPD}}\\!\\left(1 - \\frac{B}{N}\\right) \\;\\land\\; \\exists\\, x' \\in \\mathcal{N}_1(x) : L_{11}(x') > t_{11}" }] },
  { id: "temp", title: ["טמפרטורת המקור", "Source temperature"], body: [
    ["מקור קטן בהרבה מהפיקסל: היחס בין שני ערוצי האש תלוי רק בטמפרטורה שלו, לא בגודל שלו ($\\lambda_{10} = 1.61\\,\\mu\\mathrm{m}$, $\\lambda_{11} = 2.25\\,\\mu\\mathrm{m}$).",
     "A source much smaller than the pixel: the ratio of the two fire bands depends only on its temperature, not its size ($\\lambda_{10} = 1.61\\,\\mu\\mathrm{m}$, $\\lambda_{11} = 2.25\\,\\mu\\mathrm{m}$)."],
    { tex: "R = \\frac{L_{10} - b_{10}}{L_{11} - b_{11}} = f(T) = \\frac{B(\\lambda_{10}, T)}{B(\\lambda_{11}, T)}, \\qquad T = f^{-1}(R)" },
    { tex: "B(\\lambda, T) = \\frac{2hc^2}{\\lambda^5} \\cdot \\frac{1}{e^{hc/\\lambda k T} - 1}" },
    ["נמדד כששני הערוצים לפחות $10\\sigma$, ונשמר מ־500 K.", "Measured where both bands are at least $10\\sigma$, and kept from 500 K."]] },
  { id: "tchange", title: ["שינויים בחום (TEMPER)", "Changes in heat (TEMPER)"], body: [
    ["כל מקום מול הלילות שלפניו (ברירת מחדל 14). $I$: הלילות האינפורמטיביים שבהם, שבהם המקום נצפה והיה בהיר או דלוק; $\\ell_t$: דלוק בלילה $t$, והלילה הוא $t = 0$; $t_0$ הסף של הלילה.",
     "Each place against the nights before it (default 14). $I$: the informative ones, where the place was observed and clear or lit; $\\ell_t$: lit on night $t$, tonight being $t = 0$; $t_0$ tonight's threshold."],
    { tex: "\\begin{aligned} \\text{new} &\\iff \\ell_0 \\;\\land\\; |I| \\ge 7 \\;\\land\\; \\tfrac{1}{|I|} \\textstyle\\sum_{t \\in I} \\ell_t \\le 0.1 \\\\ \\text{off} &\\iff \\neg\\ell_0 \\;\\land\\; \\tfrac{1}{|I|} \\textstyle\\sum_{t \\in I} \\ell_t \\ge 0.7 \\\\ &\\phantom{\\iff} \\land\\; |M15_0 - M15_{\\text{clear}}| \\le 4\\,\\mathrm{K} \\;\\land\\; \\operatorname{median}_{t \\in I} \\tilde L_t \\ge 2\\, t_0 \\end{aligned}" },
    ["חזק או חלש יותר: $\\Sigma_t$ סכום ה־$3 \\times 3$ המתוקן, $\\tilde\\Sigma$ החציון שלו על $I$, ו־$s$ סטיית התקן החסינה של $\\log \\Sigma$ של המקום עצמו.",
     "Brighter or dimmer: $\\Sigma_t$ the corrected $3 \\times 3$ sum, $\\tilde\\Sigma$ its median over $I$, and $s$ the robust s.d. of the place's own $\\log \\Sigma$."],
    { tex: "\\begin{aligned} \\text{brighter} &\\iff \\Sigma_0 \\ge 3\\, \\tilde\\Sigma \\;\\land\\; \\log \\Sigma_0 - \\log \\tilde\\Sigma \\ge 3 s \\\\ \\text{dimmer} &\\iff \\Sigma_0 \\le \\tfrac{1}{3}\\, \\tilde\\Sigma \\;\\land\\; \\log \\tilde\\Sigma - \\log \\Sigma_0 \\ge 3 s \\end{aligned}" }] },
  { id: "lchange", title: ["שינויים באור (LIGHT ROAST)", "Changes in light (LIGHT ROAST)"], body: [
    ["שבוע מול אותם לילות במחזורי 16 הימים הקודמים (אותה זווית צילום), אחרי שמנכים את השינוי $s$ שמשותף לכל המדינה (החציון על הפיקסלים הדלוקים, $L \\ge 5$ nW).",
     "A week against the same nights in earlier 16-day cycles (the same view angle), after removing the shift $s$ the whole country shares (the median over lit pixels, $L \\ge 5$ nW)."],
    { tex: "m = \\operatorname{median}_{7} \\log(L + 1), \\qquad \\Delta = m_{\\text{week}} - m_{\\text{base}}, \\qquad s = \\operatorname{median}_{L \\ge 5} \\Delta" },
    { tex: "z_0 = \\frac{\\Delta - s}{1.25\\, \\mathrm{spread} \\sqrt{1/n_1 + 1/n_2}}, \\qquad z = \\frac{z_0}{\\mathrm{spread}_{\\text{night}}(z_0)}" },
    { tex: "\\text{change} \\iff |z| \\ge 4 \\quad (\\text{a lone pixel: } |z| \\ge 6)" },
    { tex: "\\text{new}: L_{\\text{base}} < 2 \\to L \\ge 5, \\qquad \\text{brighter}: \\frac{L}{L_{\\text{base}}} \\ge 1.5, \\qquad \\text{dimmer}: \\frac{L}{L_{\\text{base}}} \\le \\frac{2}{3}" }] },
  { id: "events", title: ["יומן השינויים והסיבות", "The change log and its causes"], params: "events", body: [
    ["שינוי שנראה לילה אחרי לילה הוא אירוע אחד: אותו כיוון, קרוב, בהפרשים קצרים. אתר קבוע: אתר TEMPER שדלק לפחות ב־$\\phi_{\\text{steady}}$ מהלילות שלו; $d_s$: המרחק לקרוב שבהם.",
     "A change seen night after night is one event: the same direction, close by, with short gaps. A steady site: a TEMPER site lit on at least $\\phi_{\\text{steady}}$ of its nights; $d_s$: the distance to the nearest."],
    { tex: "e_i \\sim e_j \\iff \\operatorname{dir}_i = \\operatorname{dir}_j \\;\\land\\; \\lVert x_i - x_j \\rVert \\le d_{\\text{link}} \\;\\land\\; \\text{gaps} \\le g_{\\max}" },
    ["הסיבה נקבעת משני המוצרים יחד:", "Its cause comes from both products together:"],
    { tex: "\\text{cause} = \\begin{cases} \\text{flare} & \\text{heat},\\; d_s \\le d_{\\text{flare}} \\\\ \\text{fire} & \\text{heat},\\; d_s > d_{\\text{flare}} \\\\ \\text{field} & \\text{no heat},\\; d_s \\le d_{\\text{field}} \\\\ \\text{lighting} & \\text{otherwise} \\end{cases}" },
    ["תאורה שמשתנה יחד באזור: אירועים נוספים באותו כיוון בתוך $d_{\\text{area}}$, שהתחילו בתוך $t_{\\text{area}}$ ימים. לפחות $k_{\\text{area}}$ כאלה: כבה, או ירד מתחת ל־$\\rho_{\\text{out}}$, הוא הפסקת חשמל; אחרת שינוי אזורי (אובך, מזג אוויר).",
     "Lighting changing together in an area: other events of its direction within $d_{\\text{area}}$, starting within $t_{\\text{area}}$ days. With at least $k_{\\text{area}}$ of them, out or below $\\rho_{\\text{out}}$ is an outage; else a regional shift (haze, weather)."],
    { tex: "n_{\\text{area}} = \\#\\left\\{e' : \\operatorname{dir}' = \\operatorname{dir},\\; \\lVert x' - x \\rVert < d_{\\text{area}},\\; |t'_0 - t_0| \\le t_{\\text{area}}\\right\\}" },
    { tex: "n_{\\text{area}} \\ge k_{\\text{area}} \\implies \\begin{cases} \\text{outage} & \\text{down} \\land \\left(\\text{off} \\lor L/L_{\\text{base}} \\le \\rho_{\\text{out}}\\right) \\\\ \\text{regional} & \\text{otherwise} \\end{cases}" }] },
  { id: "level", title: ["חזק, בינוני, חלש", "Strong, medium, weak"], body: [
    ["כמה שינוי בולט, מתוך השנה של המקום עצמו: $p$ הוא חלק השבועות האחרים בשנה שבהם המקום זז כך, לפחות $0.8$ מהשינוי; $n$ הלילות, $|z|$ ומספר הפיקסלים של השינוי; $t$ הסף של הלילה.",
     "How much a change stands out, from the place's own year: $p$ is the share of its other weeks in which it moved this way, at least $0.8$ of this change; $n$ the change's nights, $|z|$ and pixels; $t$ the night's threshold."],
    { tex: "p = \\frac{\\#\\{w \\ne w_0 : \\Delta_w \\ge 0.8\\, \\Delta_{w_0}\\}}{\\#\\{w \\ne w_0\\}}" },
    { tex: "\\text{LIGHT ROAST:} \\quad \\begin{cases} \\text{strong} & p \\le 2\\% \\land (n \\ge 2 \\lor |z| \\ge 10) \\\\ \\text{weak} & p > 8\\% \\lor (n = 1 \\land \\text{one pixel} \\land |z| < 8) \\\\ \\text{medium} & \\text{otherwise} \\end{cases}" },
    { tex: "\\text{TEMPER:} \\quad \\begin{cases} \\text{strong} & n \\ge 3 \\lor \\tilde L \\ge 3\\, t \\\\ \\text{weak} & n = 1 \\land \\tilde L < 1.5\\, t \\\\ \\text{medium} & \\text{otherwise} \\end{cases}" }] },
  { id: "shapes", title: ["צורת השנה (חיפוש לפי התנהגות)", "The shape of the year (search by behaviour)"], params: "shapes", body: [
    ["לכל מקום סדרה אחת לשנה. באור: $\\log(L + 1)$ פחות החציון של המדינה באותו לילה, פחות הדפוס שלו במחזור 16 הימים ($c_{t \\bmod 16}$) ותגובתו לירח; בחום, הפעילות שלו מתוקננת. קטועה ב־5 סטיות תקן חסינות.",
     "Each place gets one series for the year. In light: $\\log(L + 1)$ less the country's median that night, less its own 16-day pattern ($c_{t \\bmod 16}$) and its response to the moon; in heat, its activity standardised. Clipped at 5 robust s.d."],
    { tex: "y_t = \\log(L_t + 1) - \\operatorname{median}_{\\text{country}} \\log(L_t + 1) - c_{t \\bmod 16} - \\beta\\, \\mathrm{moon}_t" },
    ["היחידות: באור מדרגה של $\\times 1.5$ ($u = \\log 1.5$), תנודה של $\\times 2$, קפיצה של $\\times 3$; בחום 1, 1 ו־2.5 סטיות תקן. מדרגה: החלוקה הטובה ביותר $k$, לפחות 25 לילות בכל צד.",
     "The units: in light a step of $\\times 1.5$ ($u = \\log 1.5$), a swing of $\\times 2$, a spike of $\\times 3$; in heat 1, 1 and 2.5 s.d. A step: the best split $k$, at least 25 nights a side."],
    { tex: "\\begin{aligned} \\text{step} &\\iff R^2_{\\text{step}} \\ge \\tau_{\\text{step}} \\;\\land\\; R^2_{\\text{step}} - R^2_{\\text{line}} \\ge \\delta_{\\text{step}} \\\\ &\\phantom{\\iff} \\land\\; |\\Delta| \\ge u \\;\\land\\; |\\Delta| \\ge \\kappa_{\\text{step}}\\, s_{\\text{within}} \\end{aligned}" },
    { tex: "\\text{trend} \\iff R^2_{\\text{line}} \\ge \\tau_{\\text{trend}} \\;\\land\\; |\\hat\\beta|\\,(t_n - t_1) \\ge \\log 1.5" },
    { tex: "\\text{swinging} \\iff P_{80} - P_{20} \\ge \\log 2 \\;\\land\\; \\#\\text{swings} \\ge n_{\\text{swing}}" },
    { tex: "\\text{spikes} \\iff 0.3\\% \\le \\frac{1}{n}\\, \\#\\{t : y_t - \\tilde y \\ge \\log 3\\} \\le \\phi_{\\text{spike}}" },
    ["קפיצות: ושאר השנה יציבה.", "Spikes: and the rest of the year steady."],
    ["בתקופה $[t_a, t_b]$ שנבחרה בחיפוש, כל זה רק על הלילות שבה, ומדרגה צריכה $\\min(25, \\max(6, n/4))$ לילות בכל צד. וגם מה שקבוע בה: $s$, חלק הלילות שהמקום דלק (חום) או מואר מעל 5 nW (אור), מתוך הלילות שנראה בהם (10 לפחות).",
     "Within a frame $[t_a, t_b]$ chosen in the search, all of this on its nights only, and a step needs $\\min(25, \\max(6, n/4))$ nights a side. And what is constant through it: $s$, the share of nights the place was lit (heat) or above 5 nW (light), of the nights it was seen (10 at least)."],
    { tex: "\\text{constant} \\iff \\begin{cases} s \\ge \\phi_{\\text{hot}} & \\text{TEMPER} \\\\ s \\ge \\phi_{\\text{lit}} & \\text{LIGHT ROAST} \\end{cases}" },
    ["במפת האור, **בלי האורות הקבועים**: פיקסל קבוע מתעמעם, אלא אם הלילה רחוק פי 2 מהרמה הרגילה שלו $\\bar L$ (הממוצע הגאומטרי).",
     "On the light map, **without the constant lights**: a constant pixel dims, unless tonight is off its usual level $\\bar L$ (the geometric mean) by $\\times 2$."],
    { tex: "\\text{dimmed} \\iff \\text{constant} \\;\\land\\; \\left|\\log(L + 1) - \\log(\\bar L + 1)\\right| < \\log 2" }] },
  { id: "related", title: ["מקומות קשורים", "Related places"], params: "related", body: [
    ["מה זז יחד: מתאם פירסון בין הסדרות (אחרי הניכויים של צורת השנה) על $n$ הלילות ששתיהן נמדדו. רק מקומות שמשתנים, ולא בתוך 3 ק״מ מהמקום.",
     "What moves together: Pearson $r$ between the series (after the removals above) over the $n$ nights both were seen. Only places that vary, and none within 3 km of the place."],
    { tex: "r = \\frac{\\sum_t (a_t - \\bar a)(b_t - \\bar b)}{\\sqrt{\\sum_t (a_t - \\bar a)^2 \\, \\sum_t (b_t - \\bar b)^2}}" },
    { tex: "\\text{kept} \\iff |r| \\ge \\max\\!\\left(r_{\\min}, \\frac{4}{\\sqrt{n}}\\right)" },
    ["איפה עוד זה קרה באותו זמן: הקפיצה של כל מקום באותו לילה מול ששת השבועות שלפני.", "Where else it happened at the same time: each place's jump at that night against the six weeks before."],
    { tex: "z = \\frac{\\operatorname{median}_{\\text{after}} - \\operatorname{median}_{\\text{before}}}{1.25\\, \\mathrm{spread} \\sqrt{1/n_1 + 1/n_2}}, \\qquad \\text{kept} \\iff |z| \\ge z_{\\text{co}} \\;\\land\\; \\text{ratio} \\ge 1.5" }] },
  { id: "network", title: ["רשת ומרכזיות", "Network and centrality"], body: [
    ["ברשת: המקום והמקומות הקשורים אליו, וכל זוג ביניהם מתואם באותו אופן; $r_{\\text{net}}$ החוזק המינימלי שנבחר שם. קשת כחולה: $r > 0$; אדומה: $r < 0$. גודל צומת: מרכזיות וקטור עצמי, הווקטור העצמי המוביל של $A$: מקום מרכזי כשהוא זז עם מקומות שהם עצמם מרכזיים.",
     "In the network: the place and its related places, every pair among them correlated the same way; $r_{\\text{net}}$ the least strength chosen there. Blue edge: $r > 0$; red: $r < 0$. Node size: eigenvector centrality, the leading eigenvector of $A$: a place is central when it moves with places that are themselves central."],
    { tex: "A_{ij} = \\begin{cases} |r_{ij}| & |r_{ij}| \\ge \\max\\left(r_{\\text{net}}, 4/\\sqrt{n_{ij}}\\right) \\\\ 0 & \\text{otherwise} \\end{cases}" },
    { tex: "A v = \\lambda_{\\max} v, \\qquad c_i = \\frac{|v_i|}{\\max_j |v_j|}" },
    ["הסידור: Fruchterman–Reingold, זוגות נדחים וקשתות מושכות לפי $|r|$, 450 צעדים:", "The layout: Fruchterman–Reingold, pairs pushing apart and edges pulling by $|r|$, 450 steps:"],
    { tex: "F_{\\text{rep}}(d) = \\frac{k^2}{d}, \\qquad F_{\\text{att}}(d) = \\frac{d^2}{k}\\, |r_{ij}|" }] },
  { id: "area", title: ["ניתוח אזור", "Area analysis"], params: "area", body: [
    ["עקביות: באור, חלק הלילות בטווח ±20% מהרמה הרגילה $\\tilde L$; בחום, חלק הלילות שהמקום דלק. מקום משתנה: יש לו צורה, ובחום גם דלוק ב־$\\phi_{\\text{heat}}$ מהלילות לפחות.",
     "Consistency: in light, the share of nights within ±20% of its usual level $\\tilde L$; in heat, the share of nights it was lit. A place varies when it has a shape, and for heat is lit on at least $\\phi_{\\text{heat}}$ of its nights."],
    { tex: "C_{\\text{light}} = \\frac{1}{n}\\, \\#\\left\\{t : \\left|\\frac{L_t}{\\tilde L} - 1\\right| \\le 0.2\\right\\}, \\qquad C_{\\text{heat}} = \\frac{1}{n} \\sum_t \\ell_t \\ge \\phi_{\\text{heat}}" },
    ["אור מול חום, ומי מוביל (עד 7 לילות):", "Light against heat, and which leads (up to 7 nights):"],
    { tex: "\\begin{aligned} \\text{clear} &\\iff |r_0| \\ge \\max\\left(0.2, \\frac{2.6}{\\sqrt{n}}\\right) \\\\ \\text{lead } \\ell &\\iff |r_\\ell| - |r_0| \\ge 0.1 \\;\\land\\; |r_\\ell| \\ge \\max\\left(0.3, \\frac{3.5}{\\sqrt{n}}\\right) \\end{aligned}" }] },
  { id: "comp", title: ["הרכבים", "Composites"], params: "composites", body: [
    ["תקופה $\\mathcal{P}$ היא בלוק בלוח השנה שבו הלילה: השבוע (שני עד ראשון), מחזור 16 הימים (מ־2 בינואר 2012, $t_e$), החודש או השנה.",
     "A period $\\mathcal{P}$ is the calendar block holding the night: its week (Monday to Sunday), its 16-day cycle (from 2 January 2012, $t_e$), month or year."],
    { tex: "\\mathcal{P}_{16}(t) = [t_s, t_s + 15], \\qquad t_s = t_e + 16 \\left\\lfloor \\frac{t - t_e}{16} \\right\\rfloor" },
    ["ב־TEMPER, לכל פיקסל הלילה החזק בתקופה, הטמפרטורה של אותו לילה, ומספר הלילות החמים; ב־LIGHT ROAST, החציון של הלילות הבהירים.",
     "In TEMPER, each pixel's strongest night in it, that night's temperature, and the number of hot nights; in LIGHT ROAST, the median of its clear nights."],
    { tex: "S^{\\max}(x) = \\max_{t \\in \\mathcal{P}} S_t(x), \\qquad h(x) = \\#\\{t \\in \\mathcal{P} : S_t(x) \\ge \\sigma_{\\text{hot}}\\}" },
    { tex: "T(x) = T_{t^\\ast}(x), \\qquad t^\\ast = \\operatorname*{arg\\,max}_{t \\in \\mathcal{P}} S_t(x), \\qquad \\tilde L(x) = \\operatorname{median}_{t \\in \\mathcal{P},\\ \\text{clear}} L_t(x)" },
    ["השנה נבנית מהחודשים שלה: מקסימום ומניה מתחברים, ולכן כל חודש נשמר פעם אחת.", "The year is made of its months: a maximum and a count combine, so each month is kept once."],
    { tex: "S^{\\max}_{A \\cup B} = \\max\\left(S^{\\max}_A, S^{\\max}_B\\right), \\qquad h_{A \\cup B} = h_A + h_B" }] },
];
// Each changeable threshold: its symbol in the formulas above, and what it is.
const PARAM_TEXT = {
  EVENT_LINK_KM: ["d_{\\text{link}}", "מרחק קישור (ק״מ)", "Linking distance (km)"], EVENT_GAP_DAYS: ["g_{\\max}", "רווח מרבי בין לילות (ימים)", "Largest gap between nights (days)"],
  EVENT_FLARE_KM: ["d_{\\text{flare}}", "להבה: עד אתר קבוע (ק״מ)", "Flare: to a steady site (km)"], EVENT_FIELD_KM: ["d_{\\text{field}}", "שדה: עד אתר קבוע (ק״מ)", "Field: to a steady site (km)"],
  EVENT_STEADY_SHARE: ["\\phi_{\\text{steady}}", "אתר קבוע: חלק הלילות שדלק", "Steady site: share of nights lit"], EVENT_AREA_MIN: ["k_{\\text{area}}", "אזורי: אירועים נוספים לפחות", "Area: other events at least"],
  EVENT_AREA_KM: ["d_{\\text{area}}", "אזורי: רדיוס (ק״מ)", "Area: radius (km)"], EVENT_AREA_DAYS: ["t_{\\text{area}}", "אזורי: התחילו בתוך (ימים)", "Area: started within (days)"],
  EVENT_OUTAGE_RATIO: ["\\rho_{\\text{out}}", "הפסקה: ירידה מתחת לפי", "Outage: fell below ×"], SHAPE_STEP_R2: ["\\tau_{\\text{step}}", "מדרגה: R² לפחות", "Step: R² at least"],
  SHAPE_STEP_EFF: ["\\kappa_{\\text{step}}", "מדרגה: פי הפיזור שבתוכה", "Step: times the spread within"], SHAPE_STEP_BEAT: ["\\delta_{\\text{step}}", "מדרגה: עדיפה על קו ב־", "Step: beats a line by"],
  SHAPE_TREND_R2: ["\\tau_{\\text{trend}}", "מגמה: R² לפחות", "Trend: R² at least"], SHAPE_FLUCT_SWITCHES: ["n_{\\text{swing}}", "תנודתי: תנודות מלאות לפחות", "Swinging: full swings at least"],
  SHAPE_SPIKE_MAX: ["\\phi_{\\text{spike}}", "קפיצות: חלק הלילות לכל היותר", "Spikes: share of nights at most"], SIMILAR_MIN_R: ["r_{\\min}", "קשורים: |r| לפחות", "Related: |r| at least"],
  CO_Z: ["z_{\\text{co}}", "באותו זמן: |z| לפחות", "Same time: |z| at least"], ACTIVE_HEAT: ["\\phi_{\\text{heat}}", "חום פעיל: חלק הלילות לפחות", "Active heat: share of nights at least"],
  COMPOSITE_HOT_SIGMA: ["\\sigma_{\\text{hot}}", "לילה חם בהרכב: σ לפחות", "Hot night in a composite: σ at least"],
  CONSTANT_HOT_SHARE: ["\\phi_{\\text{hot}}", "חם קבוע: חלק הלילות שבער לפחות", "Constantly hot: share of nights lit at least"],
  CONSTANT_LIT_SHARE: ["\\phi_{\\text{lit}}", "בהיר קבוע: חלק הלילות המוארים לפחות", "Constantly bright: share of nights lit at least"]
};
const MATH_UI = {
  title: ["המתמטיקה של המציג", "The mathematics of the viewer"],
  abstract: ["תקציר", "Abstract"],
  abstractText: ["מה המציג מחשב מהלילות של VIIRS: הרשת, הרעש והמובהקות, מה בוער ומה דלוק, השינויים ביומן וסיבותיהם, צורת השנה של כל מקום, מקומות שזזים יחד והרשת שלהם, ניתוח אזור, וההרכבים של תקופה. הספים שאפשר לשנות מופיעים בטבלה בסוף הסעיף שלהם, לפי הסמל שלהם בנוסחאות.",
    "What the viewer computes from VIIRS's nights: the grid, the noise and significance, what burns and what is lit, the changes in the log and their causes, each place's shape of the year, places that move together and their network, area analysis, and a period's composites. The thresholds that can be changed are in a table at the end of their section, by their symbol in the formulas."],
  contents: ["תוכן", "Contents"], table: ["טבלה", "Table"], tableCap: ["ספים שאפשר לשנות", "Thresholds that can be changed"],
  symbol: ["סמל", "Symbol"], param: ["פרמטר", "Parameter"], value: ["ערך", "Value"], def: ["ברירת מחדל", "Default"], range: ["טווח", "Range"],
  apply: ["החלה", "Apply"], reset: ["הכל לברירת המחדל", "All back to the defaults"],
  note: ["שינוי בונה מחדש את מה שתלוי בו: יומן השינויים, צורות השנה, התשובות השמורות והמעבדה של הסיור.", "A change makes again what depends on it: the change log, the shapes, the kept answers and the tour's lab."],
  applied: ["הוחל. נבנה מחדש: ", "Applied. Made again: "], nothing: ["לא השתנה דבר.", "Nothing changed."], back: ["חזר לברירות המחדל.", "Back to the defaults."],
  copied: ["ה־LaTeX של נוסחה ", "The LaTeX of equation "], copiedEnd: [" הועתק.", " copied."], copy: ["לחיצה: העתקת ה־LaTeX", "Click: copy its LaTeX"],
  noMathml: ["הדפדפן הזה לא מצייר MathML: הנוסחאות מוצגות כ־LaTeX.", "This browser does not draw MathML: the formulas show as LaTeX."],
  methods: ["METHODS.md: אותו דבר במלואו, עם הבדיקות מאחורי כל מספר.", "METHODS.md: the same in full, with the checks behind each number."],
  noParams: ["הספים לא נטענו מהשרת.", "The thresholds did not load from the server."]
};
const mathPick = (he, en) => typeof I18N !== "undefined" ? I18N.pick(he, en) : he;
const mui = k => mathPick(...MATH_UI[k]);
/* /i18n-pairs */
let mathParams = null;
async function openMath() {
  const dlg = $("mathDialog");
  if (!dlg.open) dlg.showModal();
  try {
    mathParams = (await api("/api/params")).params;
  } catch {
    mathParams = null;
  }
  renderMath();
}
// Prose with inline math ($…$).
function mathProse(tag, text, cls) {
  const p = mk(tag, cls);
  p.dataset.i18nSkip = "";
  text.split(/\$([^$]+)\$/).forEach((part, k) => {
    if (k % 2) p.append(TEX.render(part, false));
    else if (part) p.append(part);
  });
  return p;
}
async function copyTex(tex, label) {
  try {
    await navigator.clipboard.writeText(tex);
  } catch {
    const a = mk("textarea");
    a.value = tex;
    document.body.append(a);
    a.select();
    document.execCommand("copy");
    a.remove();
  }
  toast(mui("copied") + label + mui("copiedEnd"));
}
function renderMath() {
  const nav = $("mathNav"), desk = $("mathBody"), keep = desk.scrollTop, paper = mk("article", "tex-paper");
  const tocH = mk("h4", "math-toc-h", mui("contents"));
  tocH.dataset.i18nSkip = "";
  nav.replaceChildren(tocH);
  desk.replaceChildren(paper);
  // the title block, and the abstract
  const head = mk("header", "tex-titleblock");
  head.append(mk("h1", null, mui("title")), mk("p", "tex-author", "VIIRS · TEMPER · LIGHT ROAST"),
    mk("p", "tex-date", new Date().toLocaleDateString(mathPick("he-IL", "en-GB"), { day: "numeric", month: "long", year: "numeric" })));
  for (const e of head.children) e.dataset.i18nSkip = "";
  const abs = mk("div", "tex-abstract"), absH = mk("h5", null, mui("abstract"));
  absH.dataset.i18nSkip = "";
  abs.append(absH, mathProse("p", mui("abstractText")));
  paper.append(head, abs);
  if (!TEX.supported()) paper.append(mathProse("p", mui("noMathml"), "tex-foot"));
  let tables = 0;
  MATH.forEach((s, si) => {
    const n = si + 1, sec = mk("section", "tex-section"), h = mk("h2");
    sec.id = "math-" + s.id;
    h.dataset.i18nSkip = "";
    h.append(mk("span", "tex-secnum", String(n)), mathPick(...s.title));
    sec.append(h);
    let eq = 0;
    for (const part of s.body) {
      if (part.tex) {
        const label = n + "." + ++eq, row = mk("div", "tex-eq");
        row.title = mui("copy");
        row.tabIndex = 0;
        row.append(TEX.render(part.tex, true), mk("span", "tex-eqnum", "(" + label + ")"));
        row.onclick = () => copyTex(part.tex, label);
        row.onkeydown = e => {
          if (e.key === "Enter") copyTex(part.tex, label);
        };
        sec.append(row);
      } else sec.append(mathProse("p", mathPick(...part)));
    }
    if (s.params) sec.append(mathParamTable(s.params, ++tables));
    paper.append(sec);
    const b = mk("button", "math-tab");
    b.dataset.i18nSkip = "";
    b.dataset.sec = s.id;
    b.append(mk("span", "tex-secnum", String(n)), mathPick(...s.title));
    b.onclick = () => sec.scrollIntoView({ block: "start", behavior: "smooth" });
    nav.append(b);
  });
  paper.append(mathProse("p", mui("methods"), "tex-foot"));
  desk.scrollTop = keep;
  mathSpy();
}
// The contents follow the reading.
function mathSpy() {
  const top = $("mathBody").getBoundingClientRect().top + 80;
  let on = MATH[0].id;
  for (const s of MATH) if ($("math-" + s.id)?.getBoundingClientRect().top <= top) on = s.id;
  for (const b of $("mathNav").querySelectorAll(".math-tab")) b.classList.toggle("active", b.dataset.sec === on);
}
$("mathBody").addEventListener("scroll", () => requestAnimationFrame(mathSpy), { passive: true });
// A section's thresholds, as a table (booktabs): the symbol, what it is, its value (to change), default and range.
function mathParamTable(group, k) {
  const fig = mk("figure", "tex-table"), cap = mk("figcaption");
  cap.dataset.i18nSkip = "";
  cap.append(mk("b", null, mui("table") + " " + k + ": "), mui("tableCap"));
  fig.append(cap);
  if (!mathParams) {
    fig.append(mathProse("p", mui("noParams"), "tex-foot"));
    return fig;
  }
  const table = mk("table"), thead = mk("tr"), mine = mathParams.filter(p => p.group === group);
  for (const c of ["symbol", "param", "value", "def", "range"]) {
    const th = mk("th", null, mui(c));
    th.dataset.i18nSkip = "";
    thead.append(th);
  }
  table.append(thead);
  for (const p of mine) {
    const [sym, he, en] = PARAM_TEXT[p.name] || [p.name, p.name, p.name], tr = mk("tr", p.value !== p.default ? "changed" : null);
    const input = mk("input");
    input.type = "number";
    input.min = p.min;
    input.max = p.max;
    input.step = p.step;
    input.value = p.value;
    input.dataset.name = p.name;
    const tdSym = mk("td", "tex-sym"), tdName = mk("td", null, mathPick(he, en)), tdVal = mk("td");
    const tdDef = mk("td", "tex-num", String(p.default)), tdRange = mk("td", "tex-num", "[" + p.min + ", " + p.max + "]");
    tdSym.append(TEX.render(sym, false));
    tdName.dataset.i18nSkip = "";
    tdName.title = p.name;
    tdVal.append(input);
    tr.append(tdSym, tdName, tdVal, tdDef, tdRange);
    table.append(tr);
  }
  const acts = mk("div", "math-acts"), apply = mk("button", "primary", mui("apply")), reset = mk("button", "link", mui("reset"));
  apply.dataset.i18nSkip = reset.dataset.i18nSkip = "";
  const note = mk("small", "math-note", mui("note"));
  note.dataset.i18nSkip = "";
  apply.onclick = async () => {
    const values = {};
    for (const i of table.querySelectorAll("input[data-name]")) values[i.dataset.name] = Number(i.value);
    try {
      const r = await api("/api/params", { values });
      mathParams = r.params;
      toast(r.changed.length ? mui("applied") + r.changed.join(", ") : mui("nothing"));
      afterParams(r.changed);
    } catch (e) {
      toast(e.message);
    }
    renderMath();
  };
  reset.onclick = async () => {
    const r = await api("/api/params", { reset: true });
    mathParams = r.params;
    toast(mui("back"));
    afterParams(r.changed);
    renderMath();
  };
  acts.append(apply, reset);
  fig.append(table, acts, note);
  return fig;
}
// The paper as a LaTeX document (XeLaTeX: Hebrew needs polyglossia), in the language shown, with today's values.
function mathTexDocument() {
  const he = mathPick("he", "en") === "he";
  const esc = s => s.replace(/[\\{}&%#_^~]/g, ch => ({ "\\": "\\textbackslash{}", "~": "\\textasciitilde{}", "^": "\\textasciicircum{}" })[ch] || "\\" + ch);
  const prose = s => s.split(/\$([^$]+)\$/).map((part, k) => k % 2 ? "$" + part + "$" : esc(part)).join("");
  const out = ["% " + mui("title") + " - VIIRS · TEMPER · LIGHT ROAST", "% Compile with XeLaTeX.", "\\documentclass[11pt]{article}",
    "\\usepackage{amsmath,amssymb}", "\\usepackage{booktabs}", "\\usepackage{fontspec}", "\\usepackage{polyglossia}",
    he ? "\\setmainlanguage{hebrew}\\setotherlanguage{english}" : "\\setmainlanguage{english}\\setotherlanguage{hebrew}",
    "\\newfontfamily\\hebrewfont[Script=Hebrew]{David}", "\\numberwithin{equation}{section}",
    "\\title{" + esc(mui("title")) + "}", "\\author{VIIRS · TEMPER · LIGHT ROAST}", "\\date{\\today}", "", "\\begin{document}", "\\maketitle",
    "\\begin{abstract}", prose(mui("abstractText")), "\\end{abstract}", ""];
  for (const s of MATH) {
    out.push("\\section{" + esc(mathPick(...s.title)) + "}");
    for (const part of s.body) {
      if (part.tex) out.push("\\begin{equation}", "  " + part.tex, "\\end{equation}");
      else out.push(prose(mathPick(...part)), "");
    }
    const mine = (mathParams || []).filter(p => p.group === s.params);
    if (s.params && mine.length) {
      out.push("\\begin{table}[h]\\centering", "\\caption{" + esc(mui("tableCap")) + "}",
        "\\begin{tabular}{llrrr}\\toprule", [mui("symbol"), mui("param"), mui("value"), mui("def"), mui("range")].map(esc).join(" & ") + " \\\\\\midrule");
      for (const p of mine) {
        const [sym, hn, en] = PARAM_TEXT[p.name] || [p.name, p.name, p.name];
        out.push("$" + sym + "$ & " + esc(mathPick(hn, en)) + " & " + p.value + " & " + p.default + " & [" + p.min + ", " + p.max + "] \\\\");
      }
      out.push("\\bottomrule\\end{tabular}", "\\end{table}", "");
    }
  }
  out.push("\\end{document}", "");
  return out.join("\n");
}
// What reads the changed thresholds is asked again: the list, the search, the places' area analyses.
function afterParams(groups) {
  if (!groups?.length) return;
  loadList();
  if (srch.data) runSearch();
  for (const w of state.windows) analyzeArea(w);
}
$("mathClose").onclick = () => $("mathDialog").close();
$("mathTex").onclick = () => download("viirs_math_" + mathPick("he", "en") + ".tex", mathTexDocument(), "application/x-tex");
// The way in: three clicks on the emblem of the product shown.
for (const e of document.querySelectorAll("#brand .brand-emblem")) {
  e.addEventListener("click", ev => {
    if (ev.detail === 3) openMath();
  });
}
document.addEventListener("langchange", () => {
  if ($("mathDialog").open) renderMath();
});
