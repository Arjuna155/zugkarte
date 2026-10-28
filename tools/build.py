#!/usr/bin/env python3
"""Baut die fertige Kartenseite app/public/index.html aus src/template.html und den Daten in data/.

Aufruf (im Repo-Stammverzeichnis):  python3 tools/build.py
Danach app/public/index.html mit committen – der Server auf dem NAS liefert genau diese Datei aus.
"""
import json, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
D = ROOT / "data"

# Deutschland (Grundkarte, Bahnnetz, grenzüberschreitende Züge) ein-/ausschalten.
# Arjuna möchte sich vorerst auf die Schweiz konzentrieren (25.10.2026) → aus. Daten und Werkzeuge bleiben erhalten.
MIT_DEUTSCHLAND = False
# Trams, Metro und Schiffe (Etappe 1 «ganzer ÖV», 26.10.2026)
MIT_OEV = True


def load(name):
    return json.loads((D / name).read_text(encoding="utf-8"))


netz = load("netz.json")
lines = [dict(name=s["name"], type=s["typ"], stops=s["halte"], geo=g)
         for s, g in zip(netz["strecken"], load("geo_lines.json"))]
fahrplan = {k: (D / "fahrplan" / f).read_text(encoding="utf-8")
            for k, f in [("wd", "mo-fr.txt"), ("sa", "samstag.txt"), ("su", "sonntag.txt")]}

# Grenzüberschreitende Züge (tools/grenze.py): Halte ausserhalb des Schweizer Netzes anhängen,
# an der Grenze gekappte Schweizer Zeilen durch die ganzen Zugläufe ersetzen.
grenze = load("grenze.json") if MIT_DEUTSCHLAND else {"stationen": {}, "kanten": {}, "tage": {k: {"neu": [], "weg": []} for k in ("wd", "sa", "su")}}
stations = load("stations.json")
stx = {n: {"n": n, "E": round(x * 100 + 2480000), "N": round(1300000 - y * 100)}
       for n, (x, y) in grenze["stationen"].items() if n not in stations}
# Tram-, Metro- und Schiffshalte (tools/oev_netz.py) als weitere Zusatzhalte; Fahrten nur aus dem GTFS-Fahrplan des Servers
oev = load("oev_netz.json") if MIT_OEV else {"halte": {}, "kanten": {}, "geo": {}, "art": {}}
oev_name = {}
for did, (nm, x, y, art) in oev["halte"].items():
    n = nm
    if n in stations or n in stx: n = f"{nm} ({'Schiff' if art == 's' else 'Tram'})"
    k = 2
    while n in stations or n in stx: n = f"{nm} ({k})"; k += 1
    stx[n] = {"n": n, "E": round(x * 100 + 2480000), "N": round(1300000 - y * 100), "a": art}; oev_name[did] = n
kanten = dict(grenze["kanten"]); oev_art = {"t": [], "s": []}
for key, val in oev["kanten"].items():
    a, b = key.split("|"); kk = f"{oev_name[a]}|{oev_name[b]}"; kanten[kk] = val; oev_art[oev["art"][key]].append(kk)
sn = list(stations) + list(stx); sidx = {n: i for i, n in enumerate(sn)}
for k, txt in fahrplan.items():
    zl = txt.split("\n"); head = zl[0].split("|"); rows = [l for l in zl[1:] if l]
    weg = set(grenze["tage"][k]["weg"]); rows = [l for l in rows if l not in weg]
    for kat, nr, ziel, seq in grenze["tage"][k]["neu"]:
        if ziel not in head: head.append(ziel)
        stops = ";".join(f"{sidx[n]:x},{a}" + (f",{d}" if d != a else "") for n, a, d in seq)
        rows.append(f"{kat},{nr},{head.index(ziel)}|{stops}")
    fahrplan[k] = "|".join(head) + "\n" + "\n".join(rows)

# Grundlage für den automatischen GTFS-Fahrplan des Servers (app/fahrplan.js); die Kennung kommt auch in die Seite
import sys; sys.path.insert(0, str(ROOT / "tools")); import fahrplan_basis
fb = fahrplan_basis.build(lines, stations, load("stuic.json"), stx, oev, oev_name)
(ROOT / "app" / "fahrplan_basis.json").write_text(json.dumps(fb, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

values = {
    "__FPV__": fb["v"],
    "__TT__": fahrplan,
    "__STX__": stx,
    "__KANTEN__": kanten,
    "__OEV__": oev_art,
    "__STUIC__": load("stuic.json"),
    "__GEO__": load("geo.json"),
    "__DE__": load("deutschland.json") if MIT_DEUTSCHLAND else {"country": "", "states": "", "labels": [], "box": [0, 0, 1, 1]},
    "__DENETZ__": load("deutschland_netz.json") if MIT_DEUTSCHLAND else {"f": "", "m": "", "b": "", "st": []},
    "__ST__": load("stations.json"),
    "__LINES__": lines,
    "__TIER0__": netz["stufe0"],
    "__TIER1__": netz["stufe1"],
}

html = (ROOT / "src" / "template.html").read_text(encoding="utf-8")
for key, val in values.items():
    assert key in html, f"Platzhalter {key} fehlt in src/template.html"
    html = html.replace(key, json.dumps(val, ensure_ascii=False, separators=(",", ":")))

head = ('<!doctype html><html lang="de"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
        '<meta name="description" content="Interaktive Karte des Schweizer Bahnnetzes mit allen Zügen nach Fahrplan und in Echtzeit.">'
        '<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22%3E%3Crect width=%2232%22 height=%2232%22 rx=%227%22 fill=%22%2316222b%22/%3E%3Cpath d=%22M5 22c6-1 8-12 22-12%22 stroke=%22%23fff%22 stroke-width=%223%22 fill=%22none%22 stroke-linecap=%22round%22/%3E%3Ccircle cx=%2216%22 cy=%2214.5%22 r=%224%22 fill=%22%23e5484d%22 stroke=%22%23fff%22 stroke-width=%221.5%22/%3E%3C/svg%3E">'
        '<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}'
        'body{margin:0;font:14px system-ui,-apple-system,"Segoe UI",sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>'
        '</head><body>')
out = ROOT / "app" / "public" / "index.html"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(head + html + "</body></html>", encoding="utf-8")
# 3D-Karte (Prototyp, MapLibre GL) – gleiche Daten, eigene Seite /3d
h3 = (ROOT / "src" / "template3d.html").read_text(encoding="utf-8")
for key, val in values.items():
    if key in h3: h3 = h3.replace(key, json.dumps(val, ensure_ascii=False, separators=(",", ":")))
(ROOT / "app" / "public" / "3d.html").write_text(head.replace("<meta charset=\"utf-8\">", "<meta charset=\"utf-8\"><title>ÖV Schweiz 3D – ZugKarte</title>", 1) + h3 + "</body></html>", encoding="utf-8")
# Neue Website (web/, tools/web_bauen.mjs): Daten als eigene, lange zwischenspeicherbare Dateien statt in der Seite
import hashlib
DATEN = ROOT / "app" / "public" / "daten"; DATEN.mkdir(parents=True, exist_ok=True)
def daten_datei(name, obj):
    txt = json.dumps(obj, ensure_ascii=False, separators=(",", ":")); h = hashlib.sha1(txt.encode()).hexdigest()[:10]
    fn = f"{name}.{h}.json"
    for alt in DATEN.glob(name + ".*.json"):
        if alt.name != fn: alt.unlink()
    (DATEN / fn).write_text(txt, encoding="utf-8"); return "daten/" + fn
basis = {"fpv": fb["v"], "st": {n: [v["E"], v["N"], round(v["lat"], 5), round(v["lon"], 5)] for n, v in stations.items()},
         "stx": {n: [v["E"], v["N"], v.get("a", "")] for n, v in stx.items()}, "lines": [[L["name"], L["type"], L["stops"], L["geo"]] for L in lines],
         "kanten": kanten, "oev": oev_art, "stuic": load("stuic.json"), "tier0": netz["stufe0"], "tier1": netz["stufe1"]}
web_daten = {"basis": daten_datei("basis", basis), "ersatz": daten_datei("ersatz", fahrplan)}
(ROOT / "app" / "public" / "daten" / "index.json").write_text(json.dumps(web_daten), encoding="utf-8")
(ROOT / "app" / "uics.json").write_text((D / "uics.json").read_text(encoding="utf-8"), encoding="utf-8")
# Grundlage für die tägliche Sperrungsprüfung des Servers (nur Schweizer Netz)
import sperren_daten
sp = sperren_daten.build(lines, load("stations.json"), load("stuic.json"),
                         {k: (D / "fahrplan" / f).read_text(encoding="utf-8") for k, f in [("wd", "mo-fr.txt"), ("sa", "samstag.txt"), ("su", "sonntag.txt")]})
(ROOT / "app" / "sperren.json").write_text(json.dumps(sp, separators=(",", ":")), encoding="utf-8")
print(f"app/fahrplan_basis.json: Kennung {fb['v']}, {len(fb['kanten'])} Streckenteile")
print(f"app/sperren.json: {len(sp['teile'])} Streckenteile, {len(sp['abfrage'])} Abfrage-Bahnhöfe")
print(f"{out.relative_to(ROOT)}: {out.stat().st_size/1e6:.2f} MB")
for k, f in web_daten.items(): print(f"app/public/{f}: {(ROOT / 'app' / 'public' / f).stat().st_size/1e6:.2f} MB")
