// Strassennetz für die Busse: Strassen der Grundkarte (swisstopo-Kacheln, transportation) im geladenen Ausschnitt als
// Graph; der Weg eines Busses von Halt zu Halt ist der kürzeste Weg darauf (A*). Gerechnet wird nur beim Hineinzoomen
// (Strassen ab Zoom 13, Busse als Punkte ab Zoom 12) und höchstens 4 ms pro Bild; bis dahin fährt der Bus gerade.
// Wege in Kartenkoordinaten (LV95 / 100), 1,8 m rechts der Strassenmitte (Rechtsverkehr).
import { stOf } from "../kern/basis.js";
import { X, Y, lv95, glatt, nachLaden, quellMerkmale, beiRuhe } from "../util.js";
import { netzBauen, wegSuchen, aufBruecke, KLASSEN } from "../kern/strassennetz.js";

export const STR = { gen: 0, n: 0, q: 0, bild: 0, rest: 0, an: true, wege: 0, gerade: 0 };
let netz = null, quelle = null, map = null;

function quelleSuchen() { for (const l of map.getStyle().layers) if (l["source-layer"] === "transportation") return l.source; return null; }
function aufbauen() {
  if (!quelle) quelle = quelleSuchen(); const z = map.getZoom(); if (!quelle || z < 13) return;   // grosse Ausschnitte (Zoom 12) wären zu viele Strassen
  const feats = [];
  for (const f of quellMerkmale(map, quelle, "transportation")) {
    const p = f.properties; if (!KLASSEN.has(p.class)) continue;
    const g = f.geometry, linien = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [];
    feats.push({ pr: p, linien: linien.map(ll => ll.map(q => { const [E, N] = lv95(q[0], q[1]); return [(E - 2480000) / 100, (1300000 - N) / 100]; })) });
  }
  const wasser = [];   // Wasserflächen: Haltestelle nicht übers Wasser an eine Strasse anschliessen
  for (const f of quellMerkmale(map, quelle, "water")) { const g = f.geometry, polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
    for (const poly of polys) wasser.push(poly.map(r => r.map(q => { const [E, N] = lv95(q[0], q[1]); return [(E - 2480000) / 100, (1300000 - N) / 100]; }))); }
  netz = netzBauen(feats, wasser); STR.n = netz.n; STR.q = Math.min(14, Math.floor(z)); STR.gen++;
}
const strasse = (xa, ya, xb, yb) => netz ? wegSuchen(netz, xa, ya, xb, yb) : null;
export const busAufBruecke = (x, y) => aufBruecke(netz, x, y);
// Linienzug 1,8 m nach rechts versetzen (Fahrtrichtung; y zeigt nach Süden → rechts = (−dy, dx))
function rechts(p, d) {
  return p.map((q, i) => { const a = p[Math.max(0, i - 1)], b = p[Math.min(p.length - 1, i + 1)], dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1; return [q[0] - dy / L * d, q[1] + dx / L * d]; });
}
function wegAus(pts, offen, q) {
  const o = []; for (const p of pts) { const l = o[o.length - 1]; if (!l || Math.hypot(p[0] - l[0], p[1] - l[1]) > 1e-4) o.push(p); }
  if (o.length < 2) o.push([o[0][0] + 1e-4, o[0][1]]);
  const P = rechts(glatt(o, 2), .018), cum = new Float64Array(P.length); for (let k = 1; k < P.length; k++) cum[k] = cum[k - 1] + Math.hypot(P[k][0] - P[k - 1][0], P[k][1] - P[k - 1][1]);
  return { pts: P, cum, len: cum[cum.length - 1] || 1e-4, ids: [], seq: [], offen, q };
}
// Weg von Halt i nach Halt j (Indizes in B.SN); zwischengespeichert. «offen» = gerades Ersatzstück oder aus groben Kacheln
const CACHE = new Map();
export function busWeg(i, j) {
  const key = i + ">" + j, c = CACHE.get(key);
  if (c && !c.P.offen) return c.P;
  if (c && c.gen === STR.gen && !(c.P.q < 13 && STR.q >= 13)) return c.P;
  const a = stOf(i), b = stOf(j); if (!a || !b) return null;
  const xa = X(a), ya = Y(a), xb = X(b), yb = Y(b);
  if (!STR.n || !STR.an || STR.rest <= 0) {   // keine Strassen oder keine Rechenzeit mehr: vorläufig gerade
    if (c) return c.P; const P = wegAus([[xa, ya], [xb, yb]], true, 0); CACHE.set(key, { P, gen: -1 }); return P;
  }
  const t0 = performance.now(), s = Math.hypot(xb - xa, yb - ya) < 150 ? strasse(xa, ya, xb, yb) : null;   // über 15 km: Fernbus, gerade
  STR.rest -= performance.now() - t0;
  const P = s ? wegAus(s, STR.q < 13, STR.q) : c && c.P.q ? c.P : wegAus([[xa, ya], [xb, yb]], true, 0);   // kein Weg: alten Strassenweg behalten
  if (s) STR.wege++; else STR.gerade++;
  CACHE.set(key, { P, gen: STR.gen }); if (CACHE.size > 60000) CACHE.clear();
  return P;
}
// je Bild: Rechenzeit für neue Wege (bis 4 ms)
export function strassenBild() { STR.bild++; STR.rest = 4; }
export function strassenStarten(m) {
  map = m; let t = 0; const neu = () => nachLaden(map, "strassen", aufbauen, 300, 4);
  beiRuhe(map, neu); map.on("sourcedata", e => { if (quelle && e.sourceId === quelle && e.isSourceLoaded && map.getZoom() >= 13) neu(); }); neu();
}
