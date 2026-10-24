#!/usr/bin/env python3
"""Baut die fertige Kartenseite app/public/index.html aus src/template.html und den Daten in data/.

Aufruf (im Repo-Stammverzeichnis):  python3 tools/build.py
Danach app/public/index.html mit committen – der Server auf dem NAS liefert genau diese Datei aus.
"""
import json, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
D = ROOT / "data"


def load(name):
    return json.loads((D / name).read_text(encoding="utf-8"))


netz = load("netz.json")
lines = [dict(name=s["name"], type=s["typ"], stops=s["halte"], geo=g)
         for s, g in zip(netz["strecken"], load("geo_lines.json"))]
fahrplan = {k: (D / "fahrplan" / f).read_text(encoding="utf-8")
            for k, f in [("wd", "mo-fr.txt"), ("sa", "samstag.txt"), ("su", "sonntag.txt")]}

values = {
    "__TT__": fahrplan,
    "__STUIC__": load("stuic.json"),
    "__GEO__": load("geo.json"),
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
        '<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}'
        'body{margin:0;font:14px system-ui,-apple-system,"Segoe UI",sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>'
        '</head><body>')
out = ROOT / "app" / "public" / "index.html"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(head + html + "</body></html>", encoding="utf-8")
(ROOT / "app" / "uics.json").write_text((D / "uics.json").read_text(encoding="utf-8"), encoding="utf-8")
print(f"{out.relative_to(ROOT)}: {out.stat().st_size/1e6:.2f} MB")
