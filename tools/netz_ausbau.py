#!/usr/bin/env python3
"""Netz um zusätzliche Strecken erweitern (tools/netz_neu.py) und den Fahrplan neu aufbauen.

Quellen (data/quellen/):
  ch_raw_<datum>.txt.gz   Rohfahrplan Hauptnetz (stationboard mit passList, transport.opendata.ch), je Zug
                          «Kat,Linie,Ziel|halt_id:an:ab;…» (Minuten ab Mitternacht)
  ch_sb_neu.json.gz       stationboards der neuen Bahnhöfe {"halte": {id: [name, lat, lon]}, "sb": {"datum|bahnhof":
                          {id, name, x, y, t: [[kat, linie, ziel, "halt_id:an:ab;…"], …]}}} (nur Halte des Kartennetzes)
  ch_halte.json.gz        bekannte Halte id → [name, lat, lon];  ch_id2n.json  id → Kartenbahnhof
  osm_ch_export.json.gz   OSM-Gleise Schweiz [[osm_id, «r»=Normalspur|«n»=Schmalspur, usage, gauge, rack, «lon,lat;Δ…» (1e-5 Grad)],…]
Ausgabe: data/stations.json, data/netz.json, data/geo_lines.json, data/stuic.json, data/uics.json, data/fahrplan/*.txt
Aufruf:  python3 tools/netz_ausbau.py   (idempotent: startet immer vom Stand in data/quellen/basis_*)
"""
import gzip, json, math, pathlib, sys, heapq
import networkx as nx
import numpy as np
from scipy.spatial import cKDTree
from shapely.geometry import LineString, Point

ROOT = pathlib.Path(__file__).resolve().parent.parent
D = ROOT / "data"; Q = D / "quellen"
sys.path.insert(0, str(ROOT / "tools")); from netz_neu import NEU

def lv95(lat, lon):   # Näherungsformel swisstopo (wie beim ursprünglichen Netz)
    p = (lat * 3600 - 169028.66) / 10000; l = (lon * 3600 - 26782.5) / 10000
    E = 2600072.37 + 211455.93 * l - 10938.51 * l * p - 0.36 * l * p * p - 44.54 * l ** 3
    N = 1200147.07 + 308807.95 * p + 3745.25 * l * l + 76.63 * p * p - 194.56 * l * l * p + 119.79 * p ** 3
    return E, N

def jload(p): return json.loads((gzip.open(p).read() if str(p).endswith(".gz") else p.read_bytes()).decode("utf-8"))

# ---- Ausgangsstand (Hauptnetz vom 23.10.2026) ----
B = Q / "basis"
ST = jload(B / "stations.json"); NETZ = jload(B / "netz.json"); GEO = jload(B / "geo_lines.json"); STUIC = jload(B / "stuic.json")
id2n = jload(Q / "ch_id2n.json"); halte = jload(Q / "ch_halte.json.gz")
SBX = jload(Q / "ch_sb_neu.json.gz"); SB = SBX["sb"]
for sid, h in SBX["halte"].items(): halte.setdefault(sid, h)

# ---- neue Bahnhöfe: Name/Koordinate/ID aus den stationboards ----
n2id_board = {}
for k, v in SB.items():
    _, name = k.split("|", 1)
    if v.get("id"): n2id_board[name] = (v["id"], v["name"], v["x"], v["y"])
alias = {"Rapperswil SG": "Rapperswil", "Langnau i.E.": "Langnau im Emmental", "Romont FR": "Romont"}   # Kartennamen
for n, typ, hs in NEU:
    for s in hs:
        if s in ST or s in alias: continue
        sid, sname, la, lo = n2id_board.get(s, (None, None, None, None))
        if sid in id2n: alias[s] = id2n[sid]; continue            # schon Kartenbahnhof unter anderem Namen
        if not sid: print("kein stationboard:", s); continue
        E, N = lv95(la, lo)
        nm = s.replace(" (Suisse)", "")
        ST[nm] = dict(n=nm, lat=round(la, 5), lon=round(lo, 5), E=round(E), N=round(N)); alias[s] = nm
        id2n[sid] = nm; STUIC.append([sid])
print(len(ST), "Kartenbahnhöfe")
names = list(ST); XY = {n: ((s["E"] - 2480000) / 100, (1300000 - s["N"]) / 100) for n, s in ST.items()}

# ---- OSM-Gleisnetz als Graph (Raster 50 m) für die Laufwege der neuen Strecken ----
osm = jload(Q / "osm_ch_export.json.gz")
R = 0.5; GR = nx.Graph()
def P(lon, lat):
    E, N = lv95(lat, lon); return (E - 2480000) / 100, (1300000 - N) / 100
def key(x, y): return (round(x / R), round(y / R))
def osm_pts(e):
    x = y = 0
    for i, q in enumerate(e.split(";")):
        a, b = map(int, q.split(",")); x, y = (x + a, y + b) if i else (a, b); yield x / 1e5, y / 1e5
for _, rw, usage, gauge, rack, e in osm:
    if rw != "r": continue                      # Normalspur
    prev = None
    for lon, lat in osm_pts(e):
        p = P(lon, lat)
        if prev is not None:
            n = max(1, int(math.hypot(p[0] - prev[0], p[1] - prev[1]) / R)); k0 = key(*prev)
            for j in range(1, n + 1):
                k1 = key(prev[0] + (p[0] - prev[0]) * j / n, prev[1] + (p[1] - prev[1]) * j / n)
                if k1 != k0: GR.add_edge(k0, k1, w=math.hypot(k1[0] - k0[0], k1[1] - k0[1])); k0 = k1
        prev = p
for k in list(GR.nodes):
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            n2 = (k[0] + dx, k[1] + dy)
            if (dx or dy) and n2 in GR and not GR.has_edge(k, n2): GR.add_edge(k, n2, w=math.hypot(dx, dy) * 1.5)
nodes = list(GR.nodes); tree = cKDTree(np.array(nodes) * R)
def route(A, B):
    da, ia = tree.query(XY[A]); db, ib = tree.query(XY[B])
    if da > 6 or db > 6: return None
    try: path = nx.shortest_path(GR, nodes[ia], nodes[ib], weight="w")
    except nx.NetworkXNoPath: return None
    ls = LineString([XY[A]] + [(k[0] * R, k[1] * R) for k in path] + [XY[B]]).simplify(0.15)
    direct = math.hypot(XY[A][0] - XY[B][0], XY[A][1] - XY[B][1])
    if ls.length > 2.5 * direct + 30: print("  Umweg", A, B, round(ls.length / 10), "km statt", round(direct / 10)); return None
    return list(ls.coords)

def enc(pts):   # wie geo_lines.json: LV95 in 10-m-Einheiten, Differenzen
    out = []; px = py = 0
    for i, (x, y) in enumerate(pts):
        X, Y = round((x + 24800) * 10), round((13000 - y) * 10)
        if i and X == px and Y == py: continue
        out.append(f"{X - px},{Y - py}" if out else f"{X},{Y}"); px, py = X, Y
    return ";".join(out)
def dec(p):
    x = y = 0; pts = []
    for i, q in enumerate(p.split(";")):
        a, b = map(int, q.split(",")); x, y = (x + a, y + b) if i else (a, b); pts.append((x / 10 - 24800, 13000 - y / 10))
    return pts

# ---- neue Bahnhöfe, die auf bestehenden Strecken liegen, als Zwischenhalt einfügen ----
strecken = [dict(s) for s in NETZ["strecken"]]; parts = [g.split("/") for g in GEO]
neue = set(ST) - set(jload(B / "stations.json"))
for n in sorted(neue):
    p = Point(XY[n])
    for si, s in enumerate(strecken):
        for j, part in enumerate(parts[si]):
            ls = LineString(dec(part))
            if ls.distance(p) < 2 and s["halte"][j] != n and s["halte"][j + 1] != n:
                d = ls.project(p)
                if d < 3 or d > ls.length - 3: continue
                pts = list(ls.coords); acc = 0; a, b = [pts[0]], None
                for k in range(1, len(pts)):
                    seg = math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1])
                    if b is None and acc + seg >= d:
                        q = ls.interpolate(d).coords[0]; a.append(q); b = [q, pts[k]]
                    elif b is None: a.append(pts[k])
                    else: b.append(pts[k])
                    acc += seg
                parts[si][j:j + 1] = [enc(a), enc(b)]; s["halte"] = s["halte"][:j + 1] + [n] + s["halte"][j + 1:]
                print(f"  {n} in «{s['name']}» eingefügt"); break
        else: continue
        break

# ---- neue Strecken ----
for name, typ, hs in NEU:
    hs = [alias.get(h, h) for h in hs]
    if any(h not in ST for h in hs): print("übersprungen (Bahnhof fehlt):", name); continue
    geo = []
    for A, B2 in zip(hs, hs[1:]):
        r = route(A, B2)
        if not r: print("  kein Laufweg", A, "–", B2, "→ gerade Linie"); r = [XY[A], XY[B2]]
        geo.append(enc(r))
    strecken.append(dict(name=name, typ=typ, halte=hs)); parts.append(geo)
print(len(strecken), "Strecken")

# ---- Fahrplan: Rohdaten + stationboards der neuen Bahnhöfe zusammenführen ----
adj = {}
for s, pr in zip(strecken, parts):
    for j, p in enumerate(pr):
        g = dec(p); L = LineString(g).length * 100; a, b = s["halte"][j], s["halte"][j + 1]
        adj.setdefault(a, []).append((b, g, L)); adj.setdefault(b, []).append((a, g[::-1], L))
cache = {}
def path(A, B):
    if (A, B) in cache: return cache[(A, B)]
    dist = {A: 0}; prev = {}; H = [(0, A)]
    while H:
        d, u = heapq.heappop(H)
        if d > dist[u]: continue
        if u == B: break
        for v, g, L in adj.get(u, []):
            if v not in dist or d + L < dist[v]: dist[v] = d + L; prev[v] = (u, g); heapq.heappush(H, (d + L, v))
    if B not in dist: cache[(A, B)] = None; return None
    seq = []; c = B
    while c != A: seq.append(prev[c][1]); c = prev[c][0]
    pts = []
    for g in reversed(seq): pts += g if not pts else g[1:]
    cache[(A, B)] = (LineString(pts), dist[B]); return cache[(A, B)]

idx = {n: i for i, n in enumerate(names)}
FILES = {"2026-10-27": "mo-fr.txt", "2026-10-31": "samstag.txt", "2026-11-01": "sonntag.txt"}
for datum, fn in FILES.items():
    J = []; index = {}
    def add(cat, num, to, stops):
        hit = None
        for sid, (a, d) in stops.items():
            for t in (d, a):
                if t is not None and t >= 0 and (cat, num, to, sid, t) in index: hit = index[(cat, num, to, sid, t)]; break
            if hit is not None: break
        if hit is None: J.append([cat, num, to, {}]); hit = len(J) - 1
        S = J[hit][3]
        for sid, (a, d) in stops.items():
            o = S.get(sid, [-1, -1]); S[sid] = [a if a is not None and a >= 0 else o[0], d if d is not None and d >= 0 else o[1]]
            for t in S[sid]:
                if t >= 0: index[(cat, num, to, sid, t)] = hit
    for line in gzip.open(Q / f"ch_raw_{datum}.txt.gz").read().decode("utf-8").split("\n"):
        if not line: continue
        h, body = line.split("|", 1); c, n, to = h.split(",", 2); stops = {}
        for q in body.split(";"):
            if not q: continue
            sid, a, d = q.split(":"); stops[sid] = (int(a) if a else -1, int(d) if d else -1)
        add(c, n, to, stops)
    nraw = len(J)
    for k, v in SB.items():
        if not k.startswith(datum): continue
        for cat, num, to, pl in v["t"]:
            stops = {}
            for j, q in enumerate(pl.split(";")):
                sid, a, d = q.split(":")
                # transport.opendata.ch liefert im ersten passList-Eintrag (= Bahnhof der Tafel) eine falsche ID
                if j == 0 and not a and v.get("id"): sid = v["id"]
                stops[sid] = (int(a) if a else -1, int(d) if d else -1)
            add(cat, num or "", to, stops)
    # in Kartenhalte übersetzen, unplausible Abschnitte verwerfen (wie bisher)
    dests = []; di = {}; out = []; ok = bad = 0
    for cat, num, to, stops in J:
        seq = sorted(((s[0] if s[0] >= 0 else s[1]), sid, (s[0] if s[0] >= 0 else None), (s[1] if s[1] >= 0 else None))
                     for sid, s in stops.items() if s[0] >= 0 or s[1] >= 0)
        cur = None; last = None; between = []; runs = []
        for _, sid, a, d in seq:
            n = id2n.get(sid)
            if not n: between.append(sid); continue
            if last:
                ln, la, ld = last; dep = ld if ld is not None else la; arr = a if a is not None else d; good = False
                Pth = path(ln, n) if ln != n else None
                if Pth and arr is not None and dep is not None and arr > dep:
                    sp = Pth[1] / 1000 / ((arr - dep) / 60)
                    if 8 < sp < 240:
                        good = True
                        for b in between:
                            h = halte.get(b)
                            if not h or h[1] is None: continue
                            E, N = lv95(h[1], h[2])
                            if Pth[0].distance(Point((E - 2480000) / 100, (1300000 - N) / 100)) > 15: good = False; break
                if good:
                    ok += 1
                    if cur is None: cur = [(idx[ln], la, ld)]
                    cur.append((idx[n], a, d))
                else:
                    bad += 1
                    if cur and len(cur) > 1: runs.append(cur)
                    cur = None
            last = (n, a, d); between = []
        if cur and len(cur) > 1: runs.append(cur)
        for s in runs:
            if to not in di: di[to] = len(dests); dests.append(to)
            # Standzeit > 20 Min. → doppelt vergebene Nummer, Lauf teilen
            pieces = [[]]
            for k, (i, a, d) in enumerate(s):
                a = a if a is not None else d; d = d if d is not None else a
                if pieces[-1] and 0 < k < len(s) - 1 and d - a > 20:
                    pieces[-1].append((i, a, a)); pieces.append([(i, d, d)])
                else: pieces[-1].append((i, a, d))
            for pc in pieces:
                if len(pc) < 2: continue
                pc = [(pc[0][0], pc[0][2], pc[0][2])] + pc[1:-1] + [(pc[-1][0], pc[-1][1], pc[-1][1])]
                nn = str(int(num)) if num and num.isdigit() else (num or "")
                out.append(f"{cat},{nn},{di[to]}|" + ";".join(f"{i:x},{a}" if a == d else f"{i:x},{a},{d}" for i, a, d in pc))
    (D / "fahrplan" / fn).write_text("|".join(dests) + "\n" + "\n".join(out), encoding="utf-8")
    print(datum, "Rohzüge", nraw, "+ neu", len(J) - nraw, "→ Zugläufe", len(out), "Abschnitte ok", ok, "verworfen", bad)

# ---- schreiben ----
geo_out = ["/".join(p) for p in parts]
netz = dict(NETZ); netz["strecken"] = strecken
(D / "stations.json").write_text(json.dumps(ST, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
(D / "netz.json").write_text(json.dumps(netz, ensure_ascii=False, indent=1), encoding="utf-8")
(D / "geo_lines.json").write_text(json.dumps(geo_out, separators=(",", ":")), encoding="utf-8")
(D / "stuic.json").write_text(json.dumps(STUIC, separators=(",", ":")), encoding="utf-8")
(D / "uics.json").write_text(json.dumps(sorted({u for l in STUIC for u in l}), separators=(",", ":")), encoding="utf-8")
