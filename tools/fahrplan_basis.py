"""Grundlage für den automatischen Fahrplan des Servers (app/fahrplan_basis.json), von tools/build.py aufgerufen.

Der Server (app/fahrplan.js) lädt den offiziellen Schweizer GTFS-Fahrplan (opentransportdata.swiss) und rechnet ihn
für die nächsten Tage in das Fahrplanformat der Karte um. Dafür braucht er die Kartenbahnhöfe (Reihenfolge = Index im
Fahrplan), deren Halt-IDs (UIC/didok) und die Streckenteile mit Verlauf (für die Plausibilitätsprüfung).

Inhalt:
  v       Kennung dieser Grundlage (Hash). Die Seite übernimmt nur Fahrpläne mit derselben Kennung.
  st      [[x, y], …]               Kartenkoordinaten der Bahnhöfe (LV95/100), Index wie stations.json
  name    [Name, …]                 gleiche Reihenfolge
  uic     {UIC: Index}                  Bahnhöfe
  oev     {didok: Index}                Tram-, Metro- und Schiffshalte (data/oev_netz.json)
  kanten  [[a, b, "Verlauf"], …]   Verlauf wie geo_lines.json (10-m-Einheiten, Differenzen)
"""
import hashlib, json


def build(lines, stations, stuic, stx=None, oev=None, oev_name=None):
    stx = stx or {}; alle = {**stations, **stx}
    names = list(alle); sidx = {n: i for i, n in enumerate(names)}
    st = [[round((s["E"] - 2480000) / 100, 2), round((1300000 - s["N"]) / 100, 2)] for s in alle.values()]
    uic = {}
    for i, ids in enumerate(stuic):
        for u in ids: uic.setdefault(str(u), i)
    kanten = []
    for L in lines:
        for j, part in enumerate(L["geo"].split("/")):
            kanten.append([sidx[L["stops"][j]], sidx[L["stops"][j + 1]], part])
    # Tram/Metro/Schiff: eigene Halte (didok → Index) und Kanten mit Verlauf
    oevi = {did: sidx[n] for did, n in (oev_name or {}).items()}
    for key, g in ((oev or {}).get("geo") or {}).items():
        a, b = key.split("|"); kanten.append([oevi[a], oevi[b], g])
    body = {"st": st, "name": names, "nbahn": len(stations), "uic": uic, "oev": oevi, "kanten": kanten}
    v = hashlib.sha1(json.dumps(body, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()[:10]
    return {"v": v, **body}
