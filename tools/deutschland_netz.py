#!/usr/bin/env python3
"""Erzeugt data/deutschland_netz.json: deutsches Bahnnetz (Strecken + grössere Bahnhöfe) in Kartenkoordinaten.

Eingaben:
  1. Export aus OpenStreetMap (Overpass, im Browser abgefragt und vereinfacht):
     JSON {"f": ..., "m": ..., "b": ...}  – Strecken je Klasse, Teilstücke mit «/» getrennt,
     Punkte «lon,lat» in 1e-4 Grad, ab dem zweiten Punkt als Differenz.
       f = Fernverkehr (Wege aus OSM-Routen route=train, service=high_speed/long_distance, oder highspeed=yes)
       m = übrige Hauptbahnen (usage=main), b = Nebenbahnen (usage=branch)
     Parallele Gleise sind bereits zusammengelegt (Raster ~50 m).
  2. db-stations (npm, full.ndjson) – Bahnhofskategorie 1–3 der DB.
Aufruf:  python3 tools/deutschland_netz.py osm_export.json pfad/zu/full.ndjson pfad/zu/bundeslaender.geo.json
         (Export Stand 25.10.2026 liegt gzip-komprimiert in data/quellen/osm_de_export.json.gz)
Abfrage je Kachel (0,5° × 0,6°, Overpass, z. B. maps.mail.ru oder overpass-api.de, aus dem Browser):
  way["railway"="rail"]["usage"~"^(main|branch)$"][!"service"]->.w; .w out tags geom;
  rel(bw.w)["route"="train"]["service"~"^(high_speed|long_distance)$"]->.r; way(r.r)(bbox)["railway"="rail"]; out ids;
Daten: © OpenStreetMap-Mitwirkende (ODbL), DB Station&Service (CC BY 4.0).
"""
import json, pathlib, sys
from pyproj import Transformer
from shapely.geometry import shape, LineString, MultiLineString, Point
from shapely.ops import unary_union, linemerge
from shapely import prepare

ROOT = pathlib.Path(__file__).resolve().parent.parent
tr = Transformer.from_crs("EPSG:4326", "EPSG:2056", always_xy=True)

def proj(lon, lat):
    e, n = tr.transform(lon, lat)
    return (e - 2480000) / 100, (1300000 - n) / 100

def decode(s):
    for part in filter(None, s.split("/")):
        x = y = 0
        pts = []
        for i, q in enumerate(part.split(";")):
            a, b = map(int, q.split(","))
            x, y = (x + a, y + b) if i else (a, b)
            pts.append(proj(x / 1e4, y / 1e4))
        if len(pts) > 1:
            yield LineString(pts)

def lines(g):
    if isinstance(g, LineString): return [g]
    if isinstance(g, MultiLineString): return list(g.geoms)
    return [x for h in getattr(g, "geoms", []) for x in lines(h)]

def encode(ls):  # wie der Schweizer Gleisverlauf: 10-m-Raster, Differenzen
    out = []
    for l in ls:
        px = py = 0; pts = []
        for i, (x, y) in enumerate(l.coords):
            X, Y = round(x * 10), round(y * 10)
            if i and X == px and Y == py: continue
            pts.append(f"{X - px},{Y - py}" if pts else f"{X},{Y}"); px, py = X, Y
        if len(pts) > 1: out.append(";".join(pts))
    return "/".join(out)

osm = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
# Deutschland-Fläche in Kartenkoordinaten (aus deutschland.json nicht rekonstruierbar → Bundesländer neu laden)
from shapely.ops import transform
bl = json.loads((pathlib.Path(sys.argv[3]) if len(sys.argv) > 3 else pathlib.Path("/tmp/claude-0/de/bl.geojson")).read_text(encoding="utf-8"))
land = unary_union([transform(lambda x, y, z=None: proj(x, y), shape(f["geometry"]).simplify(0.0005)).buffer(0) for f in bl["features"]])
# Ausschnitt: Deutschland (+800 m) und dazu der grenznahe Streifen der Schweiz (5 km), damit Strecken wie
# Basel Bad Bf–Basel SBB, Schaffhausen–Singen oder Konstanz–Kreuzlingen bis zum Schweizer Netz durchgehen.
# Wo eine deutsche Linie auf weniger als 300 m einer Schweizer Strecke folgt, zeichnet die Schweizer Karte sie schon.
sys.path.insert(0, str(ROOT / "tools")); import ch_geo
ch = ch_geo.schweiz(); ch_netz = ch_geo.netz()
clip = land.buffer(8).union(ch.buffer(10).intersection(land.buffer(50))).difference(ch_netz.buffer(3))
de_kern = land.buffer(10); prepare(de_kern)
ch_st = ch_geo.bahnhoefe()
st_area = land.union(ch.intersection(land.buffer(50))); prepare(st_area)
prepare(land); prepare(clip)

res = {}
for c in "fmb":
    ls = [l for g in decode(osm[c]) for l in lines(g.intersection(clip)) if not l.is_empty and l.length > 0]
    merged = lines(linemerge(ls))
    # Stücke auf Schweizer Gebiet nur, wenn sie an das deutsche Netz anschliessen (sonst sind es Schweizer Strecken)
    merged = [l for l in merged if l.length > 0.5]
    # zusammenhängende Teilnetze (100 m Toleranz) behalten, wenn sie Deutschland berühren
    comps = unary_union([l.buffer(1) for l in merged])
    comps = [g for g in getattr(comps, "geoms", [comps]) if de_kern.intersects(g)]
    keep = unary_union(comps); prepare(keep)
    merged = [l.simplify(0.3) for l in merged if keep.intersects(l)]
    res[c] = encode(merged)
    print(c, len(merged), "Linien", round(sum(l.length for l in merged) / 10), "km", len(res[c]), "Zeichen")

st = []
for line in open(sys.argv[2], encoding="utf-8"):
    s = json.loads(line)
    cat = s.get("category")
    if not cat or cat > 3 or not s.get("location"): continue
    x, y = proj(s["location"]["longitude"], s["location"]["latitude"])
    if not st_area.contains(Point(x, y)): continue
    if any(Point(x, y).distance(p) < 5 for p in ch_st.values()): continue   # schon als Schweizer Bahnhof da
    t = cat - 1
    if s["name"] in ("Etzenricht",): t = 2   # Güter-/Betriebsbahnhof, in den Daten fälschlich Kategorie 1
    st.append([s["name"], round(x, 1), round(y, 1), t])
# wichtigste zuerst: Kategorie, dann Hauptbahnhöfe (bekommen bei Platzmangel die Beschriftung)
st.sort(key=lambda r: (r[3], not ("Hbf" in r[0] or "Hauptbahnhof" in r[0]), r[0]))
res["st"] = st
print(len(st), "Bahnhöfe")
(ROOT / "data" / "deutschland_netz.json").write_text(json.dumps(res, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
