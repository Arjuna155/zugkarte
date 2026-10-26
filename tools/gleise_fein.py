"""Genauer Gleisverlauf für alle Streckenteile (data/geo_lines.json) aus den Gleisen der swisstopo-Grundkarte.

Die bisherigen Verläufe stammen teils aus vereinfachten Daten (Punkte im Abstand von ~100 m, gerade Stücke zum Bahnhof).
Auf der 3D-Karte über der swisstopo-Grundkarte sieht man die Abweichungen. Dieses Werkzeug sucht für jeden Streckenteil
den Weg auf dem Gleisnetz der swisstopo-Vektorkarte (passt genau zur Grundkarte der 3D-Karte) – aber nur in einem Korridor um den bisherigen Verlauf, damit der Zug auf derselben
Strecke bleibt (z. B. nicht durch den Zimmerbergtunnel statt über Enge). Klappt das nicht, bleibt der alte Verlauf.

Quelle: data/quellen/swisstopo_gleise.txt.gz – je Zeile ein Gleisstück: Art (r Normalspur, n Schmalspur, z Zahnrad)
        + «lon,lat;dlon,dlat;…» in 1e-5 Grad. Aus den swisstopo-Vektorkacheln ch.swisstopo.base.vt, Zoom 13,
        Ebene transportation, class=rail ohne Abstellgleise (im Browser geholt, © swisstopo).
Aufruf: python3 tools/gleise_fein.py   (nach tools/netz_ausbau.py, vor tools/build.py)
"""
import gzip, json, math, pathlib, sys
import numpy as np
from scipy.spatial import cKDTree
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import dijkstra, connected_components
from shapely.geometry import LineString, Point
from shapely.strtree import STRtree

ROOT = pathlib.Path(__file__).resolve().parent.parent
D = ROOT / "data"; Q = D / "quellen"


def lv95(lat, lon):
    p = (lat * 3600 - 169028.66) / 10000; l = (lon * 3600 - 26782.5) / 10000
    E = 2600072.37 + 211455.93 * l - 10938.51 * l * p - 0.36 * l * p * p - 44.54 * l ** 3
    N = 1200147.07 + 308807.95 * p + 3745.25 * l * l + 76.63 * p * p - 194.56 * l * l * p + 119.79 * p ** 3
    return (E - 2480000) / 100, (1300000 - N) / 100


def dec(p):
    x = y = 0; pts = []
    for i, q in enumerate(p.split(";")):
        a, b = map(int, q.split(",")); x, y = (x + a, y + b) if i else (a, b); pts.append((x / 10 - 24800, 13000 - y / 10))
    return pts


def enc(pts):
    out = []; px = py = 0
    for i, (x, y) in enumerate(pts):
        X, Y = round((x + 24800) * 10), round((13000 - y) * 10)
        if i and X == px and Y == py: continue
        out.append(f"{X - px},{Y - py}" if out else f"{X},{Y}"); px, py = X, Y
    return ";".join(out)


def graphen(zeilen):
    """Zwei Graphen (Normalspur «r», Schmalspur «n» inkl. Zahnrad): Knoten = Punkte der Gleisstücke.
    Die Kacheln schneiden die Gleise ab; Punkte, die näher als 2 m beieinander liegen, werden verbunden."""
    out = {}
    for g in ("r", "n"):
        xy = []; rows = []; cols = []; w = []
        for z in zeilen:
            art = z[0]
            if (g == "r") != (art == "r"): continue
            x = y = 0; prev = None
            for i, q in enumerate(z[1:].split(";")):
                a, b = map(int, q.split(",")); x, y = (x + a, y + b) if i else (a, b)
                k = len(xy); xy.append(lv95(y / 1e5, x / 1e5))
                if prev is not None:
                    d = math.hypot(xy[k][0] - xy[prev][0], xy[k][1] - xy[prev][1]); rows += [prev, k]; cols += [k, prev]; w += [d, d]
                prev = k
        xy = np.array(xy); tree = cKDTree(xy)
        for i, j in tree.query_pairs(0.02):   # gleiche Stelle in zwei Stücken/Kacheln
            d = float(np.hypot(*(xy[i] - xy[j]))) + 0.001; rows += [i, j]; cols += [j, i]; w += [d, d]
        # Enden der Stücke (an Kachelrändern abgeschnitten) auf das nächste Gleisstück eines anderen Stücks setzen:
        # dort einen neuen Punkt einfügen (Segmente der Vektorkacheln sind auf Geraden oft sehr lang)
        grad = np.bincount(np.array(rows, dtype=np.int64), minlength=len(xy)) if rows else np.zeros(len(xy), int)
        stueck = np.zeros(len(xy), int); k = 0; s_id = 0
        for z in zeilen:
            if not z or (g == "r") != (z[0] == "r"): continue
            n_p = z.count(";") + 1; stueck[k:k + n_p] = s_id; k += n_p; s_id += 1
        segs = [(rows[q], cols[q]) for q in range(0, len(rows), 2)]
        geoms = [LineString([xy[a_], xy[b_]]) for a_, b_ in segs]
        baum = STRtree(geoms); xy = list(map(tuple, xy))
        for e in np.where(grad <= 1)[0]:
            P = Point(xy[e]); best = None
            for q in baum.query(P.buffer(0.4)):
                a_, b_ = segs[q]
                if stueck[a_] == stueck[e] or a_ == e or b_ == e: continue
                dd = geoms[q].distance(P)
                if dd <= 0.4 and (best is None or dd < best[0]): best = (dd, q)
            if best is None: continue
            a_, b_ = segs[best[1]]; L = geoms[best[1]]; pr = L.interpolate(L.project(P)); nk = len(xy); xy.append((pr.x, pr.y))
            for u, dd in ((e, best[0] + 0.001), (a_, Point(xy[a_]).distance(pr) + 0.001), (b_, Point(xy[b_]).distance(pr) + 0.001)):
                rows += [u, nk]; cols += [nk, u]; w += [dd, dd]
        xy = np.array(xy); tree = cKDTree(xy)
        n = len(xy); M = csr_matrix((w, (rows, cols)), shape=(n, n))
        out[g] = (xy, M, tree)
        print(f"Graph {g}: {n} Knoten, {len(w) // 2} Kanten")
    return out


def dicht(pts, schritt=0.5):
    o = [pts[0]]
    for a, b in zip(pts, pts[1:]):
        L = math.hypot(b[0] - a[0], b[1] - a[1]); n = max(1, int(L / schritt))
        o += [(a[0] + (b[0] - a[0]) * j / n, a[1] + (b[1] - a[1]) * j / n) for j in range(1, n + 1)]
    return o


def fein(alt, G, korridor):
    xy, M, tree = G
    d = dicht(alt)
    near = sorted({i for l in tree.query_ball_point(d, korridor) for i in l})
    if len(near) < 2: return None
    near = np.array(near); sub = M[near][:, near].tocoo()
    # Kanten nahe am bisherigen Verlauf bevorzugen (bei parallelen Gleisen/Strecken bleibt der Weg auf der richtigen)
    nah = cKDTree(np.array(d)).query(xy[near])[0]
    f = 1 + 1.5 * (nah[sub.row] + nah[sub.col]) / 2
    sub = csr_matrix((sub.data * f, (sub.row, sub.col)), shape=sub.shape)
    A, B = alt[0], alt[-1]
    def start(P):   # nächster Korridorknoten zum Endpunkt (höchstens 300 m)
        dd = np.hypot(xy[near][:, 0] - P[0], xy[near][:, 1] - P[1]); i = int(np.argmin(dd))
        return i if dd[i] <= 3 else None
    a, b = start(A), start(B)
    if a is None or b is None or a == b: return None
    dist, pred = dijkstra(sub, indices=a, return_predecessors=True)
    if not np.isfinite(dist[b]):
        # Lücken überbrücken (Tunnel fehlen in den Vektorkacheln): Teilnetze im Korridor über ihre nächsten Punkte verbinden
        P = xy[near]; nc, lab = connected_components(sub, directed=False)
        if nc > 60: return None
        kd = {c: cKDTree(P[lab == c]) for c in range(nc)}; idxs = {c: np.where(lab == c)[0] for c in range(nc)}
        kanten = []
        for c1 in range(nc):
            for c2 in range(c1 + 1, nc):
                dd, j = kd[c2].query(P[idxs[c1]]); i1 = int(np.argmin(dd))
                kanten.append((float(dd[i1]), int(idxs[c1][i1]), int(idxs[c2][j[i1]]), c1, c2))
        kanten.sort(); eltern = list(range(nc))
        def wurzel(c):
            while eltern[c] != c: eltern[c] = eltern[eltern[c]]; c = eltern[c]
            return c
        r_, c_, w_ = [], [], []
        for dd, i1, i2, c1, c2 in kanten:
            if dd > 700: break
            if wurzel(c1) != wurzel(c2): eltern[wurzel(c1)] = wurzel(c2); r_ += [i1, i2]; c_ += [i2, i1]; w_ += [dd * 1.2 + 0.01] * 2
        from scipy.sparse import coo_matrix
        sub = (sub + coo_matrix((w_, (r_, c_)), shape=sub.shape)).tocsr()
        dist, pred = dijkstra(sub, indices=a, return_predecessors=True)
        if not np.isfinite(dist[b]): return None
    path = []; c = b
    while c != a and c >= 0: path.append(c); c = pred[c]
    if c != a: return None
    path.append(a); path.reverse()
    pts = [tuple(xy[near[i]]) for i in path]
    # Bahnhofspunkt liegt oft neben dem Gleis: Weg erst ab dem dem Bahnhof nächsten Punkt (keine Haken)
    n = len(pts); d_a = [math.hypot(p[0] - A[0], p[1] - A[1]) for p in pts[:max(2, n * 2 // 5)]]
    pts = pts[d_a.index(min(d_a)):]; n = len(pts)
    d_b = [math.hypot(p[0] - B[0], p[1] - B[1]) for p in pts[n - max(2, n * 2 // 5):]]
    pts = pts[:n - max(2, n * 2 // 5) + d_b.index(min(d_b)) + 1]
    pts = [A] + pts + [B]
    neu = LineString(pts).simplify(0.03)
    alt_len = LineString(alt).length
    if not (0.6 * alt_len - 1 <= neu.length <= 1.35 * alt_len + 1.5): return None   # anderer Weg als bisher
    return list(neu.coords)


def main():
    G = graphen(gzip.open(Q / "swisstopo_gleise.txt.gz", "rt").read().split("\n"))
    netz = json.loads((D / "netz.json").read_text(encoding="utf-8"))
    geo = json.loads((D / "geo_lines.json").read_text(encoding="utf-8"))
    neu_geo = []; ok = alt_bleibt = 0; abw = []
    for s, g in zip(netz["strecken"], geo):
        teile = []
        for part in g.split("/"):
            alt = dec(part); res = None
            for gr in (("n", "r") if s["typ"] == "sm" else ("r", "n")):
                for korr in (2.5, 6):
                    res = fein(alt, G[gr], korr)
                    if res: break
                if res: break
            if res:
                ok += 1
                al = LineString(alt); abw.append(max(al.distance(Point(p)) for p in res[::max(1, len(res) // 20)]))
                teile.append(enc(res))
            else:
                alt_bleibt += 1; teile.append(part)
        neu_geo.append("/".join(teile))
    (D / "geo_lines.json").write_text(json.dumps(neu_geo, separators=(",", ":")), encoding="utf-8")
    abw.sort()
    print(f"Streckenteile: {ok} neu aus OSM, {alt_bleibt} unverändert; Abweichung zum alten Verlauf Median {abw[len(abw)//2]*100:.0f} m, max {abw[-1]*100:.0f} m")


if __name__ == "__main__":
    main()
