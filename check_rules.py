"""Score the viewer's rules against places whose truth is known (reference/known_cases.json).

    python check_rules.py                 every case
    python check_rules.py Ashdod Riyadh   the cases whose name contains one of these words

For each case it opens the country (read-only: it may fill the cache, never the user's areas), asks the same
functions the viewer uses, and prints each check as PASS or FAIL with what the rules said. The exit code is the
number of failed checks. A failure means a rule disagrees with a known truth: fix the rule, or, if the case was
written wrongly, the case. See README "Checking the rules".
"""
import json
import math
import sys
import warnings
from pathlib import Path

from pyproj import Transformer

import server

CASES = Path(__file__).resolve().parent / "reference" / "known_cases.json"
LEVELS = {"weak": 0, "medium": 1, "strong": 2}


def near_chains(product, x, y, km, lo="", hi="9999"):
    """The change log's changes within km of (x, y) overlapping [lo, hi], with their significance."""
    log, _, _ = server.event_log(product)
    items = [server.public(c) for c in log["chains"]
             if math.hypot(c["x"] - x, c["y"] - y) <= km * 1000 and not (c["last"] < lo or c["onset"] > hi)]
    server.significance(product, items)
    return items


def check_event(c, x, y):
    days = c.get("days", 1)
    on = server._ord(c["on"])
    kinds = c["kind"] if isinstance(c.get("kind"), list) else [c["kind"]] if c.get("kind") else None
    hits = [e for e in near_chains(c["product"], x, y, c["within_km"])
            if abs(server._ord(e["onset"]) - on) <= days and (not kinds or e["kind"] in kinds)
            and (not c.get("cause") or e.get("cause") == c["cause"])]
    said = ", ".join(f"{e['kind']} {e['onset']} ({e['nights']} nights, {e.get('cause') or 'no cause'})" for e in hits[:3]) or "none"
    return bool(hits), said


def check_events_at_most(c, x, y):
    items = near_chains(c["product"], x, y, c["within_km"], c.get("from", ""), c.get("to", "9999"))
    top = LEVELS[c["level"]]
    over = [e for e in items if LEVELS.get((e.get("sig") or {}).get("level"), 0) > top]
    banned = [e for e in items if e.get("cause") in c.get("not_cause", [])]
    levels = {k: sum(1 for e in items if (e.get("sig") or {}).get("level") == k) for k in LEVELS}
    said = f"{len(items)} changes: " + ", ".join(f"{n} {k}" for k, n in levels.items() if n)
    if over:
        said += "; above " + c["level"] + ": " + ", ".join(f"{e['kind']} {e['onset']}" for e in over[:3])
    if banned:
        said += "; cause " + ", ".join(f"{e['cause']} {e['onset']}" for e in banned[:3])
    return not over and not banned, said


def check_profile(c, x, y, size):
    try:
        series, _, info = server.seed_series(c["product"], x, y, size)
    except ValueError as e:   # e.g. no heat source in the window
        f = dict(shape=None, active=False, variable=False, consistency=None, note=str(e))
    else:
        f = server.series_profile(series, c["product"], info)
    ok = True
    if "shape" in c:
        ok &= f.get("shape") in c["shape"]
    for key in ("variable", "active", "direction"):
        if key in c:
            ok &= f.get(key) == c[key]
    if "consistency_min" in c:
        ok &= (f.get("consistency") or 0) >= c["consistency_min"]
    if "consistency_max" in c:
        ok &= (f.get("consistency") or 1) <= c["consistency_max"]
    if "when_from" in c:
        ok &= bool(f.get("when")) and c["when_from"] <= f["when"] <= c["when_to"]
    said = ", ".join(f"{k} {f[k]}" for k in ("shape", "direction", "when", "consistency", "active", "variable", "lit_share") if f.get(k) is not None)
    return bool(ok), said or f.get("note", "")


def check_related(c, x, y, size):
    body = dict(x=x, y=y, size_km=size, seed=c["product"], target=c.get("target", c["product"]), onset=c["night"])
    try:
        r = server.related(body)
    except ValueError as e:
        return False, "error: " + str(e)
    ok = r.get("mode") == c["mode"]
    for key in ("change", "stable", "chose"):
        if key in c:
            ok &= r.get(key) == c[key]
    if "way" in c:
        ok &= r.get("seed", {}).get("way") == c["way"]
    q = r.get("rarity") or {}
    if "local_ratio_min" in c:
        ok &= (q.get("ratio_local") or 0) >= c["local_ratio_min"]
    said = f"{r.get('mode')} ({r.get('chose')})" + (f", {r.get('change')} {r['seed'].get('way')} at {r['seed'].get('switch')}" if r.get("mode") == "event" else "")
    if q:
        said += f", nearby {q.get('local')} vs {q.get('typical_local')} usual (x{q.get('ratio_local')})"
    if r.get("stable"):
        said += ", stable"
    return bool(ok), said


def main(words):
    warnings.simplefilter("ignore")
    cases = json.loads(CASES.read_text(encoding="utf-8"))["cases"]
    if words:
        cases = [k for k in cases if any(w.lower() in k["name"].lower() for w in words)]
    failed = total = 0
    opened = None
    for case in sorted(cases, key=lambda k: k["country"]):
        if opened != case["country"]:
            ds = server.open_dataset(str(server.data_root() / case["country"]))
            server.DATASET, server.LIGHTS = ds, server.open_lights(ds)
            opened = case["country"]
            to_grid = Transformer.from_crs("EPSG:4326", ds.profile["crs"], always_xy=True)
        x, y = to_grid.transform(case["lon"], case["lat"])
        print(f"\n{case['name']} ({case['country']}, {case['lat']}, {case['lon']})\n  truth: {case['truth']}")
        for c in case["checks"]:
            size = c.get("size_km", case.get("size_km", 3))
            kind = c["check"]
            if kind == "event":
                ok, said = check_event(c, x, y)
            elif kind == "events_at_most":
                ok, said = check_events_at_most(c, x, y)
            elif kind == "profile":
                ok, said = check_profile(c, x, y, size)
            elif kind == "related":
                ok, said = check_related(c, x, y, size)
            else:
                raise ValueError("unknown check: " + kind)
            total += 1
            failed += not ok
            want = {k: v for k, v in c.items() if k not in ("check", "product")}
            print(f"  {'PASS' if ok else 'FAIL'}  {kind} ({c['product']}) {json.dumps(want, ensure_ascii=False)}\n        said: {said}")
    print(f"\n{total - failed} of {total} checks pass")
    return failed


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
