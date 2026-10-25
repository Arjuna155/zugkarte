#!/usr/bin/env python3
"""Erzeugt data/grenze.json: grenzüberschreitende Züge Schweiz ↔ Deutschland nach Fahrplan.

Quellen:
  data/quellen/gtfs_de_grenze.json.gz – Auszug aus dem GTFS-Fahrplan Deutschland (gtfs.de, Fern- und Regionalverkehr,
      CC BY 4.0): alle Züge mit Halt im Raum Schweiz/Grenze an den Stichtagen 27.10.2026 (Mo–Fr), 31.10. (Sa), 1.11. (So).
      Format {"fv"|"rv": {"trips": [[trip_id, [kurzname, langname, agency], "101", [[stop_id, an, ab], …]], …],
                          "stops": {stop_id: [name, lat, lon]}}}
  data/quellen/osm_de_export.json.gz  – deutsches Bahnnetz (OSM) für den Laufweg zwischen den Halten
  data/stations.json, data/fahrplan/*.txt – Schweizer Bahnhöfe und Tagesfahrpläne

Ausgabe (von tools/build.py eingebaut):
  {"stationen": {name: [x, y]},                       Halte ausserhalb des Schweizer Netzes (Kartenkoordinaten)
   "kanten": {"A|B": "x,y;dx,dy;…"},                  Laufweg zwischen zwei Halten (Kartenkoordinaten × 10)
   "tage": {"wd"|"sa"|"su": {"neu": [[kat, nr, ziel, [[halt, an, ab], …]], …],
                             "weg": [Fahrplanzeile, …]}}}    ersetzte Schweizer Zeilen (Zug bisher an der Grenze gekappt)
Aufruf: python3 tools/grenze.py
"""
import gzip, json, math, pathlib, re, sys
from collections import defaultdict
import networkx as nx
from pyproj import Transformer
from shapely.geometry import Point, LineString
from shapely import prepare

ROOT = pathlib.Path(__file__).resolve().parent.parent
D = ROOT / "data"
sys.path.insert(0, str(ROOT / "tools")); import ch_geo

tr = Transformer.from_crs("EPSG:4326", "EPSG:2056", always_xy=True)
def proj(lon, lat):
    e, n = tr.transform(lon, lat)
    return (e - 2480000) / 100, (1300000 - n) / 100

G = json.loads(gzip.open(D / "quellen" / "gtfs_de_grenze.json.gz").read())
ST = json.loads((D / "stations.json").read_text(encoding="utf-8"))
SN = list(ST)
STP = {n: ((s["E"] - 2480000) / 100, (1300000 - s["N"]) / 100) for n, s in ST.items()}
ch = ch_geo.schweiz(); prepare(ch)

def clean(n):
    n = re.sub(r"\((S|Gr)\)$", "", n).strip()
    n = re.sub(r"\s*Gl\.\s*[\d\-]+$", "", n)
    n = re.sub(r"(\S)\(", r"\1 (", n)                     # «Biberach(Riß)» → «Biberach (Riß)»
    n = n.replace("Singen(Hohentwiel)", "Singen (Hohentwiel)").replace("Frankfurt(Main)Hbf", "Frankfurt (Main) Hbf")
    n = n.replace("Erzingen(Baden)", "Erzingen (Baden)").replace("Freiburg, Hauptbahnhof", "Freiburg (Breisgau) Hbf")
    n = n.replace("Gesundbrunnen Bahnhof Badstr., Berlin", "Berlin Gesundbrunnen")
    return n

def hhmm(t):
    h, m = map(int, t.split(":")); return h * 60 + m

# Namen grösserer deutscher Bahnhöfe wie auf der Karte (DB-Stationsdaten in deutschland_netz.json)
DBST = json.loads((D / "deutschland_netz.json").read_text(encoding="utf-8"))["st"]
def DBNAME(x, y):
    b = min(DBST, key=lambda r: math.hypot(r[1] - x, r[2] - y))
    return b[0] if math.hypot(b[1] - x, b[2] - y) < 4 else None

# ---- Halte zuordnen: Schweizer Bahnhof (Kartennetz) oder fremder Halt ----
stationen = {}
def halt(sid, src):
    name, lat, lon = src["stops"][sid]
    x, y = proj(lon, lat)
    best = min(SN, key=lambda n: math.hypot(STP[n][0] - x, STP[n][1] - y))
    if math.hypot(STP[best][0] - x, STP[best][1] - y) < 4:          # < 400 m: Schweizer Bahnhof der Karte
        return best, True
    if ch.contains(Point(x, y)):
        if ch.exterior.distance(Point(x, y)) > 30:                   # kleiner Schweizer Halt: weglassen wie im CH-Fahrplan
            return None, True
        n = clean(name); stationen.setdefault(n, (round(x, 1), round(y, 1)))
        return n, True                                               # grenznaher Halt (z. B. Basel Bad Bf, Thayngen) behalten
    n = DBNAME(x, y) or clean(name)
    stationen.setdefault(n, (round(x, 1), round(y, 1)))
    return n, False

KAT = re.compile(r"^(ICE|ECE|EC|IC|IRE|RE|RB|S)\s*(\d*)$")
laeufe = []
for src in (G["fv"], G["rv"]):
    for tid, (kurz, lang, ag), tage, stops in src["trips"]:
        m = KAT.match(kurz.strip())
        if not m: continue                       # z. B. reine Liniennummern (Busse)
        seq = []; ch_hit = de_hit = False
        for sid, an, ab in stops:
            n, isch = halt(sid, src)
            if isch: ch_hit = True
            else: de_hit = True
            if n is None: continue
            a, d = hhmm(an or ab), hhmm(ab or an)
            if seq and seq[-1][0] == n: seq[-1][2] = d; continue
            seq.append([n, a, d])
        if not (ch_hit and de_hit) or len(seq) < 2: continue
        seq[0][1] = seq[0][2]; seq[-1][2] = seq[-1][1]
        kat = "EC" if m.group(1) == "ECE" else m.group(1)
        laeufe.append(dict(kat=kat, linie=m.group(2), tage=tage, seq=seq, ziel=clean(src["stops"][stops[-1][0]][0])))
print(len(laeufe), "grenzüberschreitende Zugläufe,", len(stationen), "Halte ausserhalb des Schweizer Kartennetzes")

# ---- Schweizer Fahrplanzeilen, die dieselben Züge (an der Grenze gekappt) enthalten ----
DAYS = {"wd": ("mo-fr.txt", 0), "sa": ("samstag.txt", 1), "su": ("sonntag.txt", 2)}
tage = {}
for dk, (fn, ti) in DAYS.items():
    lines = (D / "fahrplan" / fn).read_text(encoding="utf-8").split("\n")
    head = lines[0].split("|"); rows = [l for l in lines[1:] if l]
    idx = defaultdict(list)            # (bahnhof, abfahrt) -> zeilen
    parsed = []
    for l in rows:
        h, body = l.split("|"); kat, nr, di = h.split(",")
        st = []
        for q in body.split(";"):
            a = q.split(","); t1 = int(a[1]); t2 = int(a[2]) if len(a) > 2 else t1
            st.append((SN[int(a[0], 16)], t1, t2))
        parsed.append((l, kat, nr, st))
        for n, a, d in st: idx[(n, d)].append(len(parsed) - 1); idx[(n, -a)].append(len(parsed) - 1)
    neu, weg = [], set()
    for L in laeufe:
        if L["tage"][ti] != "1": continue
        chst = [(n, a, d) for n, a, d in L["seq"] if n in STP]
        kat, nr = L["kat"], L["linie"]
        # passende Schweizer Zeile: mindestens zwei gemeinsame Halte, alle mit gleicher Zeit (±1 min)
        votes = defaultdict(int)
        for n, a, d in chst:
            for dt in (-1, 0, 1):
                for k in set(idx.get((n, d + dt), []) + idx.get((n, -(a + dt)), [])): votes[k] += 1
        best = max(votes, key=votes.get) if votes else None
        if best is not None:                     # alle gemeinsamen Halte müssen zeitlich passen
            st0 = {n: (a, d) for n, a, d in parsed[best][3]}
            common = [(n, a, d) for n, a, d in chst if n in st0]
            if len(common) < 2 or any(abs(st0[n][1] - d) > 1 and abs(st0[n][0] - a) > 1 for n, a, d in common): best = None
        if best is not None:
            l, kat0, nr0, st0 = parsed[best]
            weg.add(l); kat, nr = kat0, nr0
            # Schweizer Halte/Zeiten aus dem Schweizer Fahrplan übernehmen (genauer, inkl. Halte, die im deutschen Datensatz fehlen)
            sw = {n: (a, d) for n, a, d in st0}
            seq = [[n, *sw.get(n, (a, d))] for n, a, d in L["seq"]]
            names = {n for n, _, _ in seq}
            for n, a, d in st0:                  # fehlende Schweizer Halte einfügen (nach Zeit)
                if n not in names: seq.append([n, a, d])
            seq.sort(key=lambda s: (s[1], s[2]))
        else:
            seq = L["seq"]
        if not nr: nr = ""
        neu.append([kat, nr, L["ziel"], seq])
    # Doppelte (gleicher Zug in Fern- und Regionaldaten) entfernen
    seen = set(); neu2 = []
    for z in neu:
        k = (z[0], tuple((s[0], s[2]) for s in z[3][:3]))
        if k in seen: continue
        seen.add(k); neu2.append(z)
    tage[dk] = {"neu": neu2, "weg": sorted(weg)}
    print(dk, len(neu2), "Züge,", len(weg), "Schweizer Zeilen ersetzt")

# ---- Laufweg auf dem OSM-Netz zwischen aufeinanderfolgenden Halten ----
osm = json.loads(gzip.open(D / "quellen" / "osm_de_export.json.gz").read())
GR = nx.Graph(); R = 0.5   # Raster 50 m
def key(x, y): return (round(x / R), round(y / R))
for c in "fmb":
    for part in osm[c].split("/"):
        x = y = 0; prev = None
        for i, q in enumerate(part.split(";")):
            a, b = map(int, q.split(",")); x, y = (x + a, y + b) if i else (a, b)
            p = proj(x / 1e4, y / 1e4)
            if prev is not None:
                n = max(1, int(math.hypot(p[0] - prev[0], p[1] - prev[1]) / R))
                k0 = key(*prev)
                for j in range(1, n + 1):
                    q2 = (prev[0] + (p[0] - prev[0]) * j / n, prev[1] + (p[1] - prev[1]) * j / n); k1 = key(*q2)
                    if k1 != k0: GR.add_edge(k0, k1, w=math.hypot(k1[0] - k0[0], k1[1] - k0[1])); k0 = k1
            prev = p
for k in list(GR.nodes):                          # kleine Lücken (Weichen, zusammengelegte Gleise) überbrücken
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            n2 = (k[0] + dx, k[1] + dy)
            if (dx or dy) and n2 in GR and not GR.has_edge(k, n2): GR.add_edge(k, n2, w=math.hypot(dx, dy) * 1.5)
nodes = list(GR.nodes)
import numpy as np
from scipy.spatial import cKDTree
tree = cKDTree(np.array(nodes) * R)
def snap(p):
    d, i = tree.query(p); return nodes[i] if d < 10 else None
pos = dict(STP); pos.update(stationen)
pairs = set()
for t in tage.values():
    for z in t["neu"]:
        s = z[3]
        for i in range(1, len(s)):
            A, B = s[i - 1][0], s[i][0]
            if A in STP and B in STP: continue    # Schweizer Abschnitt: Schweizer Netz der Karte
            pairs.add((A, B) if A < B else (B, A))
kanten = {}
for A, B in sorted(pairs):
    a, b = snap(pos[A]), snap(pos[B])
    if not a or not b: print("kein Netz bei", A if not a else B); continue
    try: path = nx.shortest_path(GR, a, b, weight="w")
    except nx.NetworkXNoPath: print("kein Weg", A, B); continue
    pts = [pos[A]] + [(k[0] * R, k[1] * R) for k in path] + [pos[B]]
    ls = LineString(pts).simplify(0.3)
    direct = math.hypot(pos[A][0] - pos[B][0], pos[A][1] - pos[B][1])
    if ls.length > 3 * direct + 50:          # Netzlücke: lieber direkt verbinden als einen grossen Umweg zeigen
        print("Umweg, direkt verbunden:", A, B, round(ls.length / 10), "km statt", round(direct / 10)); ls = LineString([pos[A], pos[B]])
    out = []; px = py = 0
    for i, (x, y) in enumerate(ls.coords):
        X, Y = round(x * 10), round(y * 10)
        out.append(f"{X - px},{Y - py}" if i else f"{X},{Y}"); px, py = X, Y
    kanten[A + "|" + B] = ";".join(out)
print(len(kanten), "Kanten")
(D / "grenze.json").write_text(json.dumps({"stationen": stationen, "kanten": kanten, "tage": tage},
                                          ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
