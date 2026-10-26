"""Tram-, Metro- und Schiffsnetz für die Karte (data/oev_netz.json), Etappe 1 «ganzer ÖV».

Quellen:
  data/quellen/gtfs_oev.json.gz  Auszug aus dem GTFS-Fahrplan (opentransportdata.swiss, 26.10.2026):
                                 Linien (route_type 900 Tram, 400/401 Metro, 1000 Schiff), Haltefolgen, Haltestellen
  data/quellen/osm_oev.json.gz   OSM: Tram-/Stadtbahn-/Metrogleise (Zürich, Basel, Bern, Genf, Lausanne) und Fährlinien

Ergebnis:
  halte   {Schlüssel: [Name, x, y, Art]}     Schlüssel = didok (UIC), Art "t" (Tram/Metro) oder "s" (Schiff)
  kanten  {"a|b": "x,y;dx,dy;…"}            Verlauf zwischen zwei aufeinanderfolgenden Halten (Kartenkoord. × 10)
  geo     {"a|b": "…"}                      gleicher Verlauf im Format von geo_lines.json (für den Server)
  art     {"a|b": "t"|"s"}

Aufruf: python3 tools/oev_netz.py  (danach tools/build.py)
"""
import gzip, json, math, pathlib, collections
import networkx as nx
import numpy as np
from scipy.spatial import cKDTree
from shapely.geometry import LineString

ROOT = pathlib.Path(__file__).resolve().parent.parent
D = ROOT / "data"; Q = D / "quellen"


def lv95(lat, lon):
    p = (lat * 3600 - 169028.66) / 10000; l = (lon * 3600 - 26782.5) / 10000
    E = 2600072.37 + 211455.93 * l - 10938.51 * l * p - 0.36 * l * p * p - 44.54 * l ** 3
    N = 1200147.07 + 308807.95 * p + 3745.25 * l * l + 76.63 * p * p - 194.56 * l * l * p + 119.79 * p ** 3
    return (E - 2480000) / 100, (1300000 - N) / 100


# Linien, die schon im Bahnnetz sind oder nicht hineingehören (Agentur oder Agentur/Linie)
AUSSCHLIESSEN = {"46", "37/19", "7005", "617"}   # Forchbahn, Waldenburgerbahn, Riffelalp-Tram, Alpintrans


def build():
    g = json.load(gzip.open(Q / "gtfs_oev.json.gz"))
    osm = json.load(gzip.open(Q / "osm_oev.json.gz"))
    R = g["routes"]; S = g["stops"]
    def art_von(r): return "s" if R[r]["typ"] == 1000 else "t"
    def gilt(r): a = R[r]["ag"]; return a not in AUSSCHLIESSEN and f"{a}/{R[r]['kurz']}" not in AUSSCHLIESSEN

    # Haltestellen nach didok zusammenfassen (Mittel der Kanten/Steige), Art merken
    pos = collections.defaultdict(list); name = {}; art = {}
    for p in g["patterns"]:
        if not gilt(p["r"]): continue
        for s in p["s"]:
            nm, la, lo, did = S[str(s)]
            pos[did].append(lv95(la, lo)); name.setdefault(did, nm); art.setdefault(did, art_von(p["r"]))
    halte = {d: [name[d], round(sum(x for x, _ in v) / len(v), 3), round(sum(y for _, y in v) / len(v), 3), art[d]] for d, v in pos.items()}

    # Kanten aus den Haltefolgen
    paare = {}
    for p in g["patterns"]:
        if not gilt(p["r"]): continue
        ds = [S[str(s)][3] for s in p["s"]]
        for a, b in zip(ds, ds[1:]):
            if a != b: paare.setdefault(tuple(sorted((a, b))), art_von(p["r"]))

    # OSM-Graphen (Raster 20 m für Trams, 100 m für Schiffe)
    def graph(ways, Rr):
        G = nx.Graph()
        for w in ways:
            pts = [lv95(la, lo) for lo, la in w]
            for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
                n = max(1, int(math.hypot(x1 - x0, y1 - y0) / Rr)); k0 = (round(x0 / Rr), round(y0 / Rr))
                for j in range(1, n + 1):
                    k1 = (round((x0 + (x1 - x0) * j / n) / Rr), round((y0 + (y1 - y0) * j / n) / Rr))
                    if k1 != k0: G.add_edge(k0, k1, w=math.hypot(k1[0] - k0[0], k1[1] - k0[1])); k0 = k1
        for k in list(G.nodes):   # Nachbarzellen verbinden (Weichen, kleine Lücken)
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    n2 = (k[0] + dx, k[1] + dy)
                    if (dx or dy) and n2 in G and not G.has_edge(k, n2): G.add_edge(k, n2, w=math.hypot(dx, dy) * 1.5)
        nodes = list(G.nodes); return G, nodes, (cKDTree(np.array(nodes) * Rr) if nodes else None), Rr
    GT = graph(osm["tram"], 0.2); GS = graph(osm["faehre"], 1.0)

    def route(A, B, Gx, snap, umweg):
        G, nodes, tree, Rr = Gx
        if tree is None: return None
        da, ia = tree.query(A); db, ib = tree.query(B)
        if da > snap or db > snap: return None
        try: path = nx.shortest_path(G, nodes[ia], nodes[ib], weight="w")
        except nx.NetworkXNoPath: return None
        ls = LineString([A] + [(k[0] * Rr, k[1] * Rr) for k in path] + [B]).simplify(0.05)
        if ls.length > umweg * math.hypot(A[0] - B[0], A[1] - B[1]) + 3: return None
        return list(ls.coords)

    kanten = {}; geo = {}; arten = {}; ok = gerade = 0
    for (a, b), ar in sorted(paare.items()):
        if a not in halte or b not in halte: continue
        A = tuple(halte[a][1:3]); B = tuple(halte[b][1:3])
        r = route(A, B, GT, 1.0, 2.5) if ar == "t" else route(A, B, GS, 4.0, 2.0)
        if r: ok += 1
        else: gerade += 1; r = [A, B]
        k = f"{a}|{b}"; arten[k] = ar
        out = []; px = py = 0
        for i, (x, y) in enumerate(r):
            X, Y = round(x * 10), round(y * 10)
            if i and X == px and Y == py: continue
            out.append(f"{X - px},{Y - py}" if out else f"{X},{Y}"); px, py = X, Y
        kanten[k] = ";".join(out)
        out = []; px = py = 0
        for i, (x, y) in enumerate(r):
            X, Y = round((x + 24800) * 10), round((13000 - y) * 10)
            if i and X == px and Y == py: continue
            out.append(f"{X - px},{Y - py}" if out else f"{X},{Y}"); px, py = X, Y
        geo[k] = ";".join(out)
    print(f"ÖV-Netz: {len(halte)} Halte ({sum(1 for h in halte.values() if h[3] == 't')} Tram/Metro, "
          f"{sum(1 for h in halte.values() if h[3] == 's')} Schiff), {len(kanten)} Kanten, {ok} mit Verlauf, {gerade} gerade")
    return {"halte": halte, "kanten": kanten, "geo": geo, "art": arten}


if __name__ == "__main__":
    res = build()
    (D / "oev_netz.json").write_text(json.dumps(res, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
