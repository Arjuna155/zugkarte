"""Hilfsfunktionen: Schweizer Grundlagen aus data/ (Landesfläche, Seen, Bahnnetz, Bahnhöfe) als shapely-Geometrien in Kartenkoordinaten."""
import json, pathlib, re
from shapely.geometry import Polygon, LineString, Point
from shapely.ops import unary_union

D = pathlib.Path(__file__).resolve().parent.parent / "data"

def path_polys(d):
    out = []
    for ring in re.findall(r"M([^MZ]+)Z?", d):
        pts = [tuple(map(float, p.split(","))) for p in ring.split("L")]
        if len(pts) >= 3:
            out.append(Polygon(pts).buffer(0))
    return out

def schweiz():
    g = json.loads((D / "geo.json").read_text(encoding="utf-8"))
    return unary_union(path_polys(g["country"]))

def seen():
    g = json.loads((D / "geo.json").read_text(encoding="utf-8"))
    return unary_union([p for l in g["lakes"] for p in path_polys(l["d"])])

def netz():
    out = []
    for geo in json.loads((D / "geo_lines.json").read_text(encoding="utf-8")):
        for part in geo.split("/"):
            x = y = 0; pts = []
            for i, q in enumerate(part.split(";")):
                a, b = map(int, q.split(","))
                x, y = (x + a, y + b) if i else (a, b)
                pts.append((x / 10 - 24800, 13000 - y / 10))
            if len(pts) > 1: out.append(LineString(pts))
    return unary_union(out)

def bahnhoefe():
    st = json.loads((D / "stations.json").read_text(encoding="utf-8"))
    return {n: Point((s["E"] - 2480000) / 100, (1300000 - s["N"]) / 100) for n, s in st.items()}
