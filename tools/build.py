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
sn = list(stations) + list(stx); sidx = {n: i for i, n in enumerate(sn)}
for k, txt in fahrplan.items():
    zl = txt.split("\n"); head = zl[0].split("|"); rows = [l for l in zl[1:] if l]
    weg = set(grenze["tage"][k]["weg"]); rows = [l for l in rows if l not in weg]
    for kat, nr, ziel, seq in grenze["tage"][k]["neu"]:
        if ziel not in head: head.append(ziel)
        stops = ";".join(f"{sidx[n]:x},{a}" + (f",{d}" if d != a else "") for n, a, d in seq)
        rows.append(f"{kat},{nr},{head.index(ziel)}|{stops}")
    fahrplan[k] = "|".join(head) + "\n" + "\n".join(rows)

values = {
    "__TT__": fahrplan,
    "__STX__": stx,
    "__KANTEN__": grenze["kanten"],
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
(ROOT / "app" / "uics.json").write_text((D / "uics.json").read_text(encoding="utf-8"), encoding="utf-8")
print(f"{out.relative_to(ROOT)}: {out.stat().st_size/1e6:.2f} MB")
