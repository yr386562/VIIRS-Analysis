"use strict";
// Hebrew | English. The page and its scripts are written in Hebrew; in English, I18N translates what the page shows,
// from one dictionary (i18n-en.js: Hebrew -> English), so the code keeps building its Hebrew strings as before:
// - the page's text and its title / aria-label / placeholder / alt attributes, as they appear (a MutationObserver
//   keeps each node's Hebrew, so switching back restores it exactly);
// - text drawn on canvases (fillText, strokeText, measureText);
// - a whole string first, then a pattern with {0} {1} parts, then the known phrases inside a longer string (numbers,
//   dates and names around them stay as they are); what the dictionary does not know stays in Hebrew.
// Only the words change: the layout stays right to left in both languages (nothing moves sides). English lines read
// left to right inside their own boxes (app.css, html.lang-en), and English drawn on a canvas likewise.
// Dates follow the language (I18N.locale()). Switching fires "langchange" on document, and the page redraws.
// Loaded first, in <head>; i18n-en.js just before it.
const I18N = (() => {
  const KEY = "viewer-lang", HEB = /[֐-׿]/, ATTRS = ["title", "aria-label", "placeholder", "alt"];
  let lang = "he";
  try {
    lang = localStorage.getItem(KEY) === "en" ? "en" : "he";
  } catch { }
  const norm = s => s.replace(/[\s ]+/g, " ").trim();
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const exact = new Map(), patterns = [];
  for (const [he, en] of Object.entries(window.I18N_EN || {})) {
    const k = norm(he);
    if (/\{\d\}/.test(k)) patterns.push([new RegExp("^" + esc(k).replace(/\\\{(\d)\\\}/g, "(.+?)") + "$"), en]);
    else exact.set(k, en);
  }
  // Phrases: every known string, longest first, matched only as whole Hebrew words: an end that is a Hebrew letter may
  // not continue a Hebrew word there (one that starts with ": " may follow a word).
  const phrases = [...exact.keys()].filter(k => HEB.test(k)).sort((a, b) => b.length - a.length);
  const edge = k => (HEB.test(k[0]) ? "(?<![\\u0590-\\u05FF])" : "") + esc(k) + (HEB.test(k[k.length - 1]) ? "(?![\\u0590-\\u05FF])" : "");
  const phraseRx = phrases.length ? new RegExp(phrases.map(edge).join("|"), "g") : null;
  const cache = new Map();
  function line(text) {
    const t = norm(text);
    if (!t || !HEB.test(t)) return text;
    if (cache.has(t)) return keep(text, cache.get(t));
    let out = exact.get(t);
    if (out === undefined) for (const [rx, en] of patterns) {
      const m = t.match(rx);
      if (m) {
        out = en.replace(/\{(\d)\}/g, (_, i) => line(m[+i + 1]));
        break;
      }
    }
    if (out === undefined) out = phraseRx ? t.replace(phraseRx, m => exact.get(m)) : t;
    if (cache.size > 5000) cache.clear();
    cache.set(t, out);
    return keep(text, out);
  }
  // keep the text's own spaces at both ends (they separate it from its neighbours)
  function keep(text, out) {
    return text.match(/^\s*/)[0] + out + text.match(/\s*$/)[0];
  }
  function tr(text) {
    if (lang !== "en" || text == null) return text;
    const s = String(text);
    if (!HEB.test(s)) return s;
    return s.includes("\n") ? s.split("\n").map(line).join("\n") : line(s);
  }
  // ---------- the page ----------
  const texts = new WeakMap(), attrs = new WeakMap();
  const SKIP = new Set(["SCRIPT", "STYLE", "TEXTAREA", "NOSCRIPT"]);
  function applyText(n) {
    const p = n.parentNode;
    if (!p || SKIP.has(p.nodeName) || p.closest?.("[data-i18n-skip]")) return;
    let rec = texts.get(n);
    const cur = n.nodeValue;
    if (!rec || cur !== rec.out) rec = { he: cur, out: cur };   // new, or changed by the page: what it says now is the source
    const want = lang === "en" ? tr(rec.he) : rec.he;
    rec.out = want;
    texts.set(n, rec);
    if (cur !== want) n.nodeValue = want;
  }
  function applyAttr(el, name) {
    const cur = el.getAttribute(name);
    if (cur == null) return;
    let map = attrs.get(el);
    if (!map) attrs.set(el, map = {});
    let rec = map[name];
    if (!rec || cur !== rec.out) rec = map[name] = { he: cur, out: cur };
    const want = lang === "en" ? tr(rec.he) : rec.he;
    rec.out = want;
    if (cur !== want) el.setAttribute(name, want);
  }
  function walk(root) {
    if (root.nodeType === 3) return applyText(root);
    if (root.nodeType !== 1 && root.nodeType !== 9) return;
    if (root.nodeType === 1) for (const a of ATTRS) if (root.hasAttribute(a)) applyAttr(root, a);
    const it = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n = it.nextNode(); n; n = it.nextNode()) {
      if (n.nodeType === 3) applyText(n); else for (const a of ATTRS) if (n.hasAttribute(a)) applyAttr(n, a);
    }
  }
  const observer = new MutationObserver(list => {
    for (const m of list) {
      if (m.type === "characterData") applyText(m.target);
      else if (m.type === "attributes") applyAttr(m.target, m.attributeName);
      else for (const n of m.addedNodes) walk(n);
    }
  });
  function frame() {
    document.documentElement.lang = lang;
    document.documentElement.classList.toggle("lang-en", lang === "en");
    for (const b of document.querySelectorAll("[data-lang-set]")) {
      b.classList.toggle("active", b.dataset.langSet === lang);
      b.setAttribute("aria-pressed", b.dataset.langSet === lang);
    }
  }
  function start() {
    frame();
    walk(document.documentElement);
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    document.addEventListener("click", e => {
      const b = e.target.closest?.("[data-lang-set]");
      if (b) set(b.dataset.langSet);
    });
  }
  function set(l) {
    l = l === "en" ? "en" : "he";
    if (l === lang) return;
    lang = l;
    try {
      localStorage.setItem(KEY, lang);
    } catch { }
    frame();
    walk(document.documentElement);
    document.dispatchEvent(new CustomEvent("langchange", { detail: { lang } }));
  }
  // ---------- canvases ----------
  {
    const P = CanvasRenderingContext2D.prototype;
    for (const f of ["fillText", "strokeText", "measureText"]) {
      const orig = P[f];
      P[f] = function (text, ...rest) {
        if (lang !== "en") return orig.call(this, text, ...rest);
        const t = tr(text);
        // English set right to left would move its punctuation; the anchor (left/right/center) stays where it was
        if (f === "measureText" || this.direction !== "rtl" || HEB.test(t)) return orig.call(this, t, ...rest);
        this.direction = "ltr";
        try {
          return orig.call(this, t, ...rest);
        } finally {
          this.direction = "rtl";
        }
      };
    }
  }
  frame();   // the language at once, before the page draws
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true }); else start();
  return {
    tr, set, get lang() { return lang; }, locale: () => lang === "en" ? "en-GB" : "he-IL",
    // a string in both languages, for text built in code that the dictionary cannot know (numbers in words, physics)
    pick: (he, en) => lang === "en" ? en : he
  };
})();
