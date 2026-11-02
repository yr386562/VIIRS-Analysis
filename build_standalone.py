"""Build the standalone viewer: one folder with VIIRS_ANALYZER.exe, that runs on a Windows computer without Python and
without a network.

    python build_standalone.py                     build dist\\TEMPER and test it
    python build_standalone.py --out D:\\TEMPER     somewhere else
    python build_standalone.py --with-areas        include this computer's saved areas (user_areas\\*.json)
    python build_standalone.py --replace           replace an earlier build in the same place

The folder:
    VIIRS_ANALYZER.exe   the launcher (launcher\\VIIRS_ANALYZER.cs, compiled with the C# compiler that ships with Windows)
    README.txt      how to start it and where the data goes
    runtime\\        this Python (3.13) and only the packages the viewer imports, found by importing it
    app\\            the viewer: server.py and its modules, static\\ (the page), reference\\, config.json;
                    cache\\ and user_areas\\ are made there on first use

Nothing is downloaded: the runtime is copied from the Python that runs this script, and the launcher is compiled
by csc.exe from .NET Framework 4 (part of Windows). The data is not copied (hundreds of GB): on the other computer
VIIRS_ANALYZER.exe finds it in a data\\ folder beside it, or asks for it once. Copying cache\\ into app\\cache\\ as well skips
the first preparation of each country (the cache is keyed by paths relative to the country folders).
"""
import argparse
import importlib.metadata
import json
import os
import shutil
import site
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
APP_FILES = ["server.py", "lightroast.py", "bands.py", "evt.py", "rxmethod.py", "check_rules.py", "vectors.py", "requirements.txt"]
APP_DIRS = ["static", "reference"]
MARK = ".temper-build"   # marks a folder this script made, so --replace removes only such a folder
SKIP_LIB = {"site-packages", "test", "tests", "idlelib", "tkinter", "turtledemo", "ensurepip", "__pycache__", "lib2to3"}
SKIP_DLLS = ("tcl", "tk", "_tkinter")
CSC = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Microsoft.NET" / "Framework64" / "v4.0.30319" / "csc.exe"
EXE = "VIIRS_ANALYZER.exe"   # the launcher, named after the app (VIIRS · Analyze. Study. Observe.); its source is launcher/VIIRS_ANALYZER.cs
# what the viewer imports, including those imported inside functions (see `import` in the modules)
# loaded only because they are installed here (rasterio tries AWS for s3:// paths, setuptools' hook): left out
OPTIONAL = {"boto3", "botocore", "s3transfer", "jmespath", "urllib3", "dateutil", "six", "charset_normalizer", "defusedxml",
            "win32", "win32com", "pythoncom", "pywintypes", "_distutils_hack", "requests", "idna"}
IMPORTS = "import server, lightroast, bands, evt, rxmethod, check_rules, vectors, scipy.stats, scipy.linalg, scipy.ndimage"


def size_of(path):
    return sum(f.stat().st_size for f in Path(path).rglob("*") if f.is_file())


def third_party():
    """The top-level packages the viewer loads from site-packages, found by importing it in a fresh process."""
    code = (IMPORTS + "\nimport sys, json\n"
            "print(json.dumps({n: getattr(m, '__file__', None) for n, m in list(sys.modules.items())}))")
    out = subprocess.run([sys.executable, "-c", code], cwd=ROOT, capture_output=True, text=True, check=True).stdout
    places = [Path(p).resolve() for p in site.getsitepackages() + [site.getusersitepackages()]
              if Path(p).is_dir() and Path(p).name.lower() == "site-packages"]
    found = {}
    for name, file in json.loads(out.strip().splitlines()[-1]).items():
        if not file:
            continue
        f = Path(file).resolve()
        for sp in places:
            if f.is_relative_to(sp):
                top = f.relative_to(sp).parts[0]
                if top.split(".")[0].lower() not in OPTIONAL:
                    found[top.removesuffix(".py")] = sp / top
    return found


def copy_packages(found, target):
    """Each package, its bundled DLLs (<name>.libs) and the metadata of the distribution it belongs to."""
    dists = importlib.metadata.packages_distributions()
    for top, path in sorted(found.items()):
        dest = target / path.name
        if path.is_dir():
            shutil.copytree(path, dest, ignore=shutil.ignore_patterns("__pycache__"))   # tests too: numpy.testing imports them
        else:
            shutil.copy2(path, dest)
        for dist in dists.get(top, []):
            try:
                d = importlib.metadata.distribution(dist)
            except importlib.metadata.PackageNotFoundError:
                continue
            info = Path(d._path)
            if info.is_dir() and not (target / info.name).exists():
                shutil.copytree(info, target / info.name)
            libs = path.parent / f"{dist.lower()}.libs"
            for candidate in (libs, path.parent / f"{top}.libs"):
                if candidate.is_dir() and not (target / candidate.name).exists():
                    shutil.copytree(candidate, target / candidate.name)


def runtime(out):
    """This Python's own files (no installer needed), its standard library without tests and Tk, and a ._pth file
    that fixes the module path to the folder, so nothing from the computer is used."""
    base = Path(sys.base_prefix)
    rt = out / "runtime"
    rt.mkdir(parents=True)
    for f in base.iterdir():
        if f.is_file() and f.suffix.lower() in (".exe", ".dll") or f.name == "LICENSE.txt":
            shutil.copy2(f, rt / f.name)
    shutil.copytree(base / "DLLs", rt / "DLLs", ignore=lambda d, names: [n for n in names if n.lower().startswith(SKIP_DLLS)])
    (rt / "Lib").mkdir()
    for item in (base / "Lib").iterdir():
        if item.name in SKIP_LIB:
            continue
        if item.is_dir():
            shutil.copytree(item, rt / "Lib" / item.name, ignore=shutil.ignore_patterns("__pycache__", "test", "tests"))
        else:
            shutil.copy2(item, rt / "Lib" / item.name)
    sp = rt / "Lib" / "site-packages"
    sp.mkdir()
    found = third_party()
    copy_packages(found, sp)
    version = f"python{sys.version_info.major}{sys.version_info.minor}"
    (rt / f"{version}._pth").write_text("Lib\nDLLs\nLib\\site-packages\n..\\app\nimport site\n", encoding="utf-8")
    return found


def app(out, with_areas):
    a = out / "app"
    a.mkdir()
    for name in APP_FILES:
        shutil.copy2(ROOT / name, a / name)
    for name in APP_DIRS:
        shutil.copytree(ROOT / name, a / name, ignore=shutil.ignore_patterns("__pycache__"))
    # this computer's settings without its paths: the launcher sets the data folders on the other one
    try:
        config = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        config = {}
    for key in ("data_root", "lightroast_root"):
        config.pop(key, None)
    (a / "config.json").write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
    if with_areas and (ROOT / "user_areas").is_dir():
        (a / "user_areas").mkdir()
        for f in (ROOT / "user_areas").glob("*.json"):
            shutil.copy2(f, a / "user_areas" / f.name)


def launcher(out):
    """The launcher (EXE), with VIIRS's icon: static/brand/viirs.ico, the whole logo from 64 px up and a
    brighter, tighter cut of its globe below, so it still reads at 16-48 px."""
    icon = ROOT / "static" / "brand" / "viirs.ico"
    if not CSC.is_file():
        raise SystemExit(f"The C# compiler is missing ({CSC}); it comes with .NET Framework 4, part of Windows.")
    cmd = [str(CSC), "/nologo", "/target:exe", "/optimize+", f"/out:{out / EXE}", f"/win32icon:{icon}",
           "/r:System.Windows.Forms.dll", "/r:System.Web.Extensions.dll", str(ROOT / "launcher" / "VIIRS_ANALYZER.cs")]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode:
        raise SystemExit(EXE + " did not compile:\n" + result.stdout + result.stderr)


README = """VIIRS · Analyze. Study. Observe. (TEMPER · LIGHT ROAST), standalone

Start: double-click VIIRS_ANALYZER.exe. A window shows that it runs (close it to stop), and the viewer opens in Edge or
Chrome as an app window, or in the default browser. It needs no installation and no network.

Data: the first time, VIIRS_ANALYZER.exe looks for a data folder beside it:
    data\\VIIRS_NIGHT_SWIR    TEMPER: one folder per country
    data\\VIIRS_NIGHT_DNB     LIGHT ROAST (night lights): one folder per country, optional
Without one, it asks for the folders and remembers them (app\\config.json). To choose again:
    VIIRS_ANALYZER.exe --choose-data

Other options: --port 8770 (another port; the next free one is used when 8768 is taken), --no-browser.

What it keeps, in app\\: cache\\ (each country's prepared nights; the first opening of a country prepares them in the
background, which takes a few minutes) and user_areas\\ (your saved areas, with backups in user_areas\\history\\).
Copy the whole folder to move it; keep it somewhere you can write to (not Program Files).

Folders: runtime\\ is Python {version} with the packages the viewer uses; app\\ is the viewer (app\\README.md and
app\\METHODS.md explain it).
"""


def self_test(out, data_root, lr_root):
    """The folder alone: its Python with the computer's Python hidden (no PATH, no user packages), every module
    from inside the folder, then the launcher serving a country and a map."""
    rt = out / "runtime"
    env = {"SystemRoot": os.environ.get("SystemRoot", r"C:\Windows"), "PATH": os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32"),
           "TEMP": tempfile.gettempdir(), "TMP": tempfile.gettempdir(), "PYTHONIOENCODING": "utf-8"}
    code = (IMPORTS + "\nimport sys, os\nout = os.path.abspath(sys.argv[1])\n"
            "outside = sorted({m.__file__ for m in list(sys.modules.values()) if getattr(m, '__file__', None) and not os.path.abspath(m.__file__).startswith(out)})\n"
            "print('prefix', sys.prefix); print('outside', len(outside)); [print('  ', f) for f in outside[:10]]")
    r = subprocess.run([str(rt / "python.exe"), "-c", code, str(out)], cwd=out / "app", env=env, capture_output=True, text=True)
    print(r.stdout.strip(), r.stderr.strip()[-2000:])
    if r.returncode or "outside 0" not in r.stdout:
        raise SystemExit("Self-test failed: the folder's Python could not import the viewer from inside the folder.")
    # the launcher, as the user starts it, with this computer's data folders for the test only
    config = out / "app" / "config.json"
    kept = config.read_text(encoding="utf-8")
    test = json.loads(kept)
    test.update(data_root=str(data_root), lightroast_root=str(lr_root))
    config.write_text(json.dumps(test), encoding="utf-8")
    port = 8790
    env_launch = dict(env, TEMPER_CACHE=str(ROOT / "cache"), TEMPER_USER_AREAS=tempfile.mkdtemp(prefix="temper-test-areas-"))
    proc = subprocess.Popen([str(out / EXE), "--no-browser", "--port", str(port)], cwd=out, env=env_launch,
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
    base = f"http://127.0.0.1:{port}"
    try:
        def get(path, body=None):
            req = urllib.request.Request(base + path, json.dumps(body).encode() if body else None, {"Content-Type": "application/json"} if body else {})
            with urllib.request.urlopen(req, timeout=300) as resp:
                return resp.read()
        for _ in range(240):
            try:
                if json.loads(get("/api/health")).get("offline"):
                    break
            except OSError:
                time.sleep(0.25)
        countries = json.loads(get("/api/countries"))["countries"]
        print("countries:", ", ".join(c["name"] for c in countries))
        pick = next((c for c in countries if c["name"] == "Israel"), countries[0])
        meta = json.loads(get("/api/connect", {"path": pick["path"]}))
        night = meta["dates"][-1]
        png = get(f"/api/image?date={night}&band=combo")
        lr = meta.get("lightroast") or {}
        lr_png = get(f"/api/lr/image?date={lr['dates'][-1]}&view=lights") if lr.get("available") else b""
        page = get("/")
        print(f"{pick['name']}: {len(meta['dates'])} nights; TEMPER map {len(png):,} bytes; LIGHT ROAST map {len(lr_png):,} bytes; page {len(page):,} bytes")
        if not png.startswith(b"\x89PNG") or (lr.get("available") and not lr_png.startswith(b"\x89PNG")):
            raise SystemExit("Self-test failed: the maps did not render.")
    finally:   # the launcher and the viewer it started (also ended by the launcher's job object)
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)
        proc.kill()
        for _ in range(40):   # until the viewer has let go of the port
            try:
                urllib.request.urlopen(base + "/api/health", timeout=0.5)
                time.sleep(0.25)
            except OSError:
                break
        else:
            raise SystemExit(f"Self-test: the viewer on port {port} did not stop; stop it before building again.")
        config.write_text(kept, encoding="utf-8")
    print("self-test passed")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", default=str(ROOT / "dist" / "TEMPER"))
    parser.add_argument("--with-areas", action="store_true", help="include this computer's saved areas")
    parser.add_argument("--replace", action="store_true", help="replace an earlier build in the same place")
    parser.add_argument("--no-test", action="store_true")
    args = parser.parse_args()
    out = Path(args.out).resolve()
    if out.exists() and any(out.iterdir()):
        if not (args.replace and (out / MARK).exists()):
            raise SystemExit(f"{out} is not empty. Use --replace to replace an earlier build there, or choose --out.")
        shutil.rmtree(out)
    out.mkdir(parents=True, exist_ok=True)
    (out / MARK).write_text("made by build_standalone.py\n", encoding="utf-8")
    t = time.time()
    found = runtime(out)
    print("packages:", ", ".join(sorted(found)))
    app(out, args.with_areas)
    for doc in ("README.md", "METHODS.md"):
        if (ROOT / doc).is_file():
            shutil.copy2(ROOT / doc, out / "app" / doc)
    launcher(out)
    (out / "README.txt").write_text(README.format(version=sys.version.split()[0]), encoding="utf-8")
    print(f"built {out} in {time.time() - t:.0f} s: {size_of(out) / 2**20:,.0f} MB (runtime {size_of(out / 'runtime') / 2**20:,.0f} MB)")
    if not args.no_test:
        import server
        self_test(out, server.data_root(), server.lightroast_root())
        # what the test left in app\: compiled modules, and an empty cache folder
        shutil.rmtree(out / "app" / "__pycache__", ignore_errors=True)
        cache = out / "app" / "cache"
        if cache.is_dir() and not any(cache.rglob("*")):
            cache.rmdir()


if __name__ == "__main__":
    main()
