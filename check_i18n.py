"""Which Hebrew text in the viewer has no English yet (static/i18n-en.js).

    python check_i18n.py

It reads the Hebrew string literals of static/js/*.js, help.js and intro.js, the text and title / aria-label /
placeholder / alt attributes of static/index.html and network.html, and the messages of server.py, lightroast.py and rxmethod.py, and
prints each one the dictionary does not cover: not as a whole string, not by a {0} pattern, and not entirely by
known phrases (the way i18n.js translates). The exit code is the number missing. Text written in both languages
(I18N.pick: intro.js, and in other scripts between /* i18n-pairs */ and /* /i18n-pairs */) needs no entry; neither does
user-made text."""
import html as htmllib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
HEB = re.compile(r"[֐-׿]")


def literals(text, python=False):
    """String literals of a JS or Python file, comments and docstrings skipped."""
    out, i, n = [], 0, len(text)
    while i < n:
        c = text[i]
        if text.startswith("//", i) and not python or c == "#" and python:
            j = text.find("\n", i)
            i = n if j < 0 else j
            continue
        if text.startswith("/*", i) and not python:
            j = text.find("*/", i + 2)
            i = n if j < 0 else j + 2
            continue
        if c in "\"'`":
            if python and text.startswith(c * 3, i):
                j = text.find(c * 3, i + 3)
                i = n if j < 0 else j + 3
                continue
            j, buf = i + 1, []
            while j < n and text[j] != c:
                if text[j] == "\\" and j + 1 < n:
                    buf.append({"n": "\n", "t": "\t"}.get(text[j + 1], text[j + 1]))
                    j += 2
                    continue
                if text[j] == "\n" and c != "`":
                    break
                buf.append(text[j])
                j += 1
            s = "".join(buf)
            if HEB.search(s):
                out.append(s)
            i = j + 1
            continue
        i += 1
    return out


def strings():
    found = {}
    static = ROOT / "static"
    for f in sorted((static / "js").glob("*.js")) + [static / "help.js", static / "intro.js"]:
        text = re.sub(r"/\* i18n-pairs.*?/\* /i18n-pairs \*/", "", f.read_text(encoding="utf-8"), flags=re.S)   # written in both languages
        for s in literals(text):
            found.setdefault(s, f.name)
    for page in ("index.html", "network.html"):
        html = re.sub(r"<!--.*?-->", "", (static / page).read_text(encoding="utf-8"), flags=re.S)
        for s in re.findall(r">([^<>]+)<", html) + re.findall(r'(?:title|aria-label|placeholder|alt)="([^"]*)"', html):
            if HEB.search(s):
                found.setdefault(" ".join(htmllib.unescape(s).split()), page)
    for name in ("server.py", "lightroast.py", "rxmethod.py"):
        for s in literals((ROOT / name).read_text(encoding="utf-8"), python=True):
            found.setdefault(s, name)
    return found


def dictionary():
    text = (ROOT / "static" / "i18n-en.js").read_text(encoding="utf-8")
    start = text.index("window.I18N_EN = {") + len("window.I18N_EN = ")
    return json.loads(text[start:text.rindex("}") + 1])


def main():
    norm = lambda s: re.sub(r"[\s ]+", " ", s).strip()
    d = {norm(k): v for k, v in dictionary().items()}
    exact = {k for k in d if not re.search(r"\{\d\}", k)}
    patterns = [re.compile("^" + re.escape(k).replace(r"\{0\}", "(.+?)").replace(r"\{1\}", "(.+?)") + "$") for k in d if re.search(r"\{\d\}", k)]
    edge = lambda k: (r"(?<![֐-׿])" if HEB.match(k) else "") + re.escape(k) + (r"(?![֐-׿])" if HEB.search(k[-1]) else "")
    phrases = re.compile("|".join(edge(k) for k in sorted((k for k in exact if HEB.search(k)), key=len, reverse=True)))
    missing = []
    for s, where in strings().items():
        if "<div" in s or "I18N.pick" in s:
            continue
        for line in s.split("\n"):
            t = norm(line)
            if not t or not HEB.search(t) or t in exact or any(p.match(t) for p in patterns):
                continue
            if HEB.search(re.sub(r"%[sdg]|%%|\{\w*\}", "", phrases.sub("", t))):   # Hebrew left after the known phrases
                missing.append((where, t))
    for where, t in sorted(set(missing)):
        print(f"{where:16} {t}")
    print(f"{len(set(missing))} Hebrew strings without English; {len(d)} entries in static/i18n-en.js")
    return len(set(missing))


if __name__ == "__main__":
    sys.exit(main())
