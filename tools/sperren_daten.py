"""Grundlage für die tägliche Sperrungsprüfung des Servers (app/sperren.json), von tools/build.py aufgerufen.

Die Karte besteht aus Streckenteilen (Strecke i, Teil j = Abschnitt zwischen zwei Kartenbahnhöfen).
Für jeden Teil wird gezählt, wie viele Fahrten ihn laut Fahrplan je Tagestyp befahren. Der Server holt einmal pro Tag
die Abfahrten ausgewählter Bahnhöfe (mit Halteliste) und markiert Teile, die heute niemand befährt, als gesperrt.

Inhalt:
  teile    [[i, j], …]                     Index = Teilnummer
  erwartet {"wd"|"sa"|"su": [Anzahl je Teil]}
  beine    {"a-b": [Teilnummern]}          Weg zwischen zwei Kartenbahnhöfen (Indizes in stations.json)
  uic      {Halt-ID: Bahnhofsindex}
  abfrage  [[Bahnhofsindex, Halt-ID], …]   Bahnhöfe, deren Abfahrten der Server täglich holt (decken alle Teile ab)
"""
import heapq, json, math


def dec(p):
    x = y = 0; pts = []
    for i, q in enumerate(p.split(";")):
        a, b = map(int, q.split(",")); x, y = (x + a, y + b) if i else (a, b); pts.append((x, y))
    return pts


def build(lines, stations, stuic, fahrplan):
    names = list(stations); sidx = {n: i for i, n in enumerate(names)}
    teile = []; adj = {}
    for i, L in enumerate(lines):
        for j, part in enumerate(L["geo"].split("/")):
            g = dec(part); ln = sum(math.hypot(g[k][0] - g[k - 1][0], g[k][1] - g[k - 1][1]) for k in range(1, len(g)))
            t = len(teile); teile.append([i, j]); a, b = sidx[L["stops"][j]], sidx[L["stops"][j + 1]]
            adj.setdefault(a, []).append((b, ln, t)); adj.setdefault(b, []).append((a, ln, t))
    cache = {}
    def weg(a, b):
        k = (min(a, b), max(a, b))
        if k in cache: return cache[k]
        dist = {k[0]: 0}; prev = {}; H = [(0, k[0])]
        while H:
            d, u = heapq.heappop(H)
            if d > dist[u]: continue
            if u == k[1]: break
            for v, ln, t in adj.get(u, []):
                if v not in dist or d + ln < dist[v]: dist[v] = d + ln; prev[v] = (u, t); heapq.heappush(H, (d + ln, v))
        r = None
        if k[1] in dist:
            r = []; c = k[1]
            while c != k[0]: r.append(prev[c][1]); c = prev[c][0]
        cache[k] = r; return r
    erwartet = {}
    for typ, txt in fahrplan.items():
        cnt = [0] * len(teile)
        for l in txt.split("\n")[1:]:
            if not l: continue
            st = [int(q.split(",")[0], 16) for q in l.split("|")[1].split(";")]
            for a, b in zip(st, st[1:]):
                if a >= len(names) or b >= len(names): continue
                for t in weg(a, b) or []: cnt[t] += 1
        erwartet[typ] = cnt
    beine = {f"{a}-{b}": r for (a, b), r in cache.items() if r}
    for t, (i, j) in enumerate(teile):                # jeder Teil auch direkt zwischen seinen Endbahnhöfen
        a, b = sorted((sidx[lines[i]["stops"][j]], sidx[lines[i]["stops"][j + 1]]))
        beine.setdefault(f"{a}-{b}", weg(a, b) or [t])
    # Abfrage-Bahnhöfe: jeder Teil mit Verkehr braucht einen abgefragten Endbahnhof (gierige Überdeckung,
    # kleine Bahnhöfe bevorzugt – weniger Abfahrten, weniger Seiten)
    need = set(range(len(teile)))   # alle Teile (auch ohne Fahrplandaten, z. B. an den Stichtagen gesperrte Strecken)
    ends = {}
    for t in need:
        i, j = teile[t]; L = lines[i]
        for n in (L["stops"][j], L["stops"][j + 1]): ends.setdefault(sidx[n], set()).add(t)
    last = {}
    for typ in erwartet:
        for t, c in enumerate(erwartet[typ]):
            i, j = teile[t]
            for n in (lines[i]["stops"][j], lines[i]["stops"][j + 1]): last[sidx[n]] = last.get(sidx[n], 0) + c
    abfrage = []; offen = set(need)
    while offen:
        s = max(ends, key=lambda s: (len(ends[s] & offen), -last.get(s, 0)))
        if not ends[s] & offen: break
        if stuic[s]: abfrage.append([s, stuic[s][0]])
        offen -= ends[s]
    uic = {u: i for i, us in enumerate(stuic) for u in us}
    return dict(teile=teile, erwartet=erwartet, beine=beine, uic=uic, abfrage=abfrage)
