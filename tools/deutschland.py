#!/usr/bin/env python3
"""Erzeugt data/deutschland.json (Landesumriss + Grenzen der Bundesländer) in Kartenkoordinaten.

Quelle: https://github.com/isellsoap/deutschlandGeoJSON (2_bundeslaender/1_sehr_hoch.geo.json, Lizenz siehe dort)
Aufruf:  pip install pyproj shapely
         python3 tools/deutschland.py <pfad/zu/1_sehr_hoch.geo.json>
Kartenkoordinaten wie im Rest der Karte: LV95 (EPSG:2056) / 100, x = (E-2480000)/100, y = (1300000-N)/100.
"""
import json, pathlib, sys
from pyproj import Transformer
from shapely.geometry import shape, Polygon, MultiPolygon, LineString, MultiLineString
from shapely.ops import transform, unary_union

ROOT = pathlib.Path(__file__).resolve().parent.parent
TOL = 2            # Vereinfachung in Karteneinheiten (1 = 100 m)
MIN_AREA = 40      # kleinere Inseln weglassen (Karteneinheiten², 40 = 0,4 km²)

tr = Transformer.from_crs("EPSG:4326", "EPSG:2056", always_xy=True)
def proj(x, y, z=None):
    e, n = tr.transform(x, y)
    return (e - 2480000) / 100, (1300000 - n) / 100

def polys(g):
    return list(g.geoms) if isinstance(g, MultiPolygon) else [g]

def lines(g):
    if isinstance(g, LineString): return [g]
    if isinstance(g, MultiLineString): return list(g.geoms)
    return [x for h in getattr(g, "geoms", []) for x in lines(h)]

def path(coords, close):
    pts = [f"{round(x)},{round(y)}" for x, y in coords]
    out = [pts[0]] + [p for i, p in enumerate(pts[1:], 1) if p != pts[i - 1]]
    return "M" + "L".join(out) + ("Z" if close else "")

src = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
states = [(f["properties"]["name"], transform(proj, shape(f["geometry"])).buffer(0)) for f in src["features"]]
land = unary_union([g for _, g in states]).buffer(0.5).buffer(-0.5)

country = "".join(path(p.simplify(TOL).exterior.coords, True)
                  for p in polys(land) if p.area >= MIN_AREA)
inner = unary_union([g.boundary for _, g in states]).difference(land.exterior.buffer(2) if isinstance(land, Polygon)
                                                                  else unary_union([p.exterior for p in polys(land)]).buffer(2))
borders = "".join(path(l.simplify(TOL).coords, False) for l in lines(inner) if l.length > 3)
SHIFT = {"Brandenburg": (-150, 420)}   # sonst überdeckt Berlin die Beschriftung
labels = [{"name": n, "x": round(g.representative_point().x) + SHIFT.get(n, (0, 0))[0],
           "y": round(g.representative_point().y) + SHIFT.get(n, (0, 0))[1]} for n, g in states]
minx, miny, maxx, maxy = land.bounds
out = {"country": country, "states": borders, "labels": labels,
       "box": [round(minx), round(miny), round(maxx), round(maxy)]}
(ROOT / "data" / "deutschland.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
print("data/deutschland.json:", len(country) + len(borders), "Zeichen, Ausdehnung", out["box"])
