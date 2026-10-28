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
from shapely.geometry import LineString, Point
from shapely.ops import substring

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
        nodes = list(G.nodes)
        # echte Gleispunkte alle ~2 m (der Weg im Raster wird danach auf sie zurückgelegt, sonst Treppenstufen)
        fein = []
        for w in ways:
            pts = [lv95(la, lo) for lo, la in w]
            for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
                n = max(1, int(math.hypot(x1 - x0, y1 - y0) / 0.02))
                fein.extend((x0 + (x1 - x0) * j / n, y0 + (y1 - y0) * j / n) for j in range(n))
            if pts: fein.append(pts[-1])
        fein = np.array(fein) if fein else None
        return G, nodes, (cKDTree(np.array(nodes) * Rr) if nodes else None), Rr, fein, (cKDTree(fein) if fein is not None else None)
    GT = graph(osm["tram"], 0.2); GS = graph(osm["faehre"], 1.0)

    def route(A, B, Gx, snap, umweg):
        G, nodes, tree, Rr, fein, ftree = Gx
        if tree is None: return None
        da, ia = tree.query(A); db, ib = tree.query(B)
        if da > snap or db > snap: return None
        try: path = nx.shortest_path(G, nodes[ia], nodes[ib], weight="w")
        except nx.NetworkXNoPath: return None
        pts = [(k[0] * Rr, k[1] * Rr) for k in path]
        if ftree is not None and len(pts) > 1:
            # dichter abtasten, jeden Punkt auf das nächste echte Gleis legen, Zacken entfernen
            dicht = []
            for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
                n = max(1, int(math.hypot(x1 - x0, y1 - y0) / 0.05)); dicht.extend((x0 + (x1 - x0) * j / n, y0 + (y1 - y0) * j / n) for j in range(n))
            dicht.append(pts[-1]); D = np.array(dicht); dd, II = ftree.query(D, k=12); pts = []; vor = None
            for n_, (dq, iq) in enumerate(zip(dd, II)):
                # auf demselben Gleis bleiben (Doppelspur: sonst springt der Weg zwischen den Gleisen hin und her)
                ok = [i for d_, i in zip(dq, iq) if d_ < dq[0] + 0.06 and i < len(fein)]
                if vor is None: i = ok[0]
                else:
                    st = math.hypot(D[n_][0] - D[n_ - 1][0], D[n_][1] - D[n_ - 1][1])
                    if len(pts) > 1:   # Richtung des bisherigen Weges (nicht die Treppenstufen des Rasters)
                        rx, ry = pts[-1][0] - pts[-2][0], pts[-1][1] - pts[-2][1]; rl = math.hypot(rx, ry) or 1; zx, zy = vor[0] + rx / rl * st, vor[1] + ry / rl * st
                    else: zx, zy = vor[0] + D[n_][0] - D[n_ - 1][0], vor[1] + D[n_][1] - D[n_ - 1][1]
                    i = min(ok, key=lambda i: math.hypot(fein[i][0] - zx, fein[i][1] - zy) + 0.3 * math.hypot(fein[i][0] - D[n_][0], fein[i][1] - D[n_][1]))
                q = tuple(fein[i]); vor = q
                if pts and q == pts[-1]: continue
                if len(pts) > 1 and math.hypot(q[0] - pts[-2][0], q[1] - pts[-2][1]) < math.hypot(pts[-1][0] - pts[-2][0], pts[-1][1] - pts[-2][1]) * .5: pts.pop()
                pts.append(q)
        L_ = [A] + pts + [B]
        if ftree is not None and len(pts) > 1:   # Halt neben dem Gleis (Mittel der Haltekanten): Anfang/Ende auf den Weg selbst legen, sonst Zacken
            W = LineString(pts); a_, b_ = W.project(Point(A)), W.project(Point(B))
            if b_ - a_ > 0.05: L_ = list(substring(W, a_, b_).coords)
        geaendert = True
        while geaendert and len(L_) > 2:   # Zacken (Hin und zurück auf kurzem Stück) entfernen
            geaendert = False
            for i in range(1, len(L_) - 1):
                (ax, ay), (px, py), (cx, cy) = L_[i - 1], L_[i], L_[i + 1]; ux, uy, wx, wy = px - ax, py - ay, cx - px, cy - py
                lu, lw = math.hypot(ux, uy), math.hypot(wx, wy)
                if lu < 1e-6 or lw < 1e-6 or (ux * wx + uy * wy < -0.3 * lu * lw and min(lu, lw) < 0.15): del L_[i]; geaendert = True; break
        ls = LineString(L_).simplify(0.02)
        if ls.length > umweg * math.hypot(A[0] - B[0], A[1] - B[1]) + 3: return None
        return list(ls.coords)

    kanten = {}; kanten1 = {}; geo = {}; arten = {}; ok = gerade = 0
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
        out = []; px = py = 0   # dasselbe auf 1 m genau (neue Website; Trams fahren sonst Treppenstufen)
        for i, (x, y) in enumerate(r):
            X, Y = round(x * 100), round(y * 100)
            if i and X == px and Y == py: continue
            out.append(f"{X - px},{Y - py}" if out else f"{X},{Y}"); px, py = X, Y
        kanten1[k] = ";".join(out)
        out = []; px = py = 0
        for i, (x, y) in enumerate(r):
            X, Y = round((x + 24800) * 10), round((13000 - y) * 10)
            if i and X == px and Y == py: continue
            out.append(f"{X - px},{Y - py}" if out else f"{X},{Y}"); px, py = X, Y
        geo[k] = ";".join(out)
    print(f"ÖV-Netz: {len(halte)} Halte ({sum(1 for h in halte.values() if h[3] == 't')} Tram/Metro, "
          f"{sum(1 for h in halte.values() if h[3] == 's')} Schiff), {len(kanten)} Kanten, {ok} mit Verlauf, {gerade} gerade")
    return {"halte": halte, "kanten": kanten, "kanten1": kanten1, "geo": geo, "art": arten}


if __name__ == "__main__":
    res = build()
    (D / "oev_netz.json").write_text(json.dumps(res, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
