// Strassennetz für die Busse: Strassen der Grundkarte (swisstopo-Kacheln, transportation) im geladenen Ausschnitt als
// Graph; der Weg eines Busses von Halt zu Halt ist der kürzeste Weg darauf (A*). Gerechnet wird nur beim Hineinzoomen
// (Strassen ab Zoom 13, Busse als Punkte ab Zoom 12) und höchstens 4 ms pro Bild; bis dahin fährt der Bus gerade.
// Wege in Kartenkoordinaten (LV95 / 100), 1,8 m rechts der Strassenmitte (Rechtsverkehr).
import { stOf } from "../kern/basis.js";
import { X, Y, lv95, glatt } from "../util.js";

export const STR = { gen: 0, n: 0, q: 0, bild: 0, rest: 0, an: true, wege: 0, gerade: 0 };
const KLASSEN = new Set(["motorway", "trunk", "primary", "secondary", "tertiary", "minor", "service", "busway", "bus_guideway"]);
const ZELLE = .5;   // Raster für die Suche der nächsten Strasse: 50 m
let kx = [], ky = [], adj = [], raster = new Map(), quelle = null, map = null;

function quelleSuchen() { for (const l of map.getStyle().layers) if (l["source-layer"] === "transportation") return l.source; return null; }
function aufbauen() {
  if (!quelle) quelle = quelleSuchen(); const z = map.getZoom(); if (!quelle || z < 13) return;   // grosse Ausschnitte (Zoom 12) wären zu viele Strassen
  const feats = map.querySourceFeatures(quelle, { sourceLayer: "transportation" });
  const id = new Map(), X_ = [], Y_ = [], A_ = [], R = new Map(), kanten = new Set();
  const knoten = (x, y) => { const k = Math.round(x * 100) + "," + Math.round(y * 100); let i = id.get(k); if (i === undefined) { i = X_.length; id.set(k, i); X_.push(x); Y_.push(y); A_.push([]); } return i; };
  const zelle = (x, y) => Math.floor(x / ZELLE) + "," + Math.floor(y / ZELLE);
  const kante = (a, b, einweg) => {
    const k = a < b ? a + "-" + b : b + "-" + a; if (kanten.has(k)) return; kanten.add(k);
    const L = Math.hypot(X_[b] - X_[a], Y_[b] - Y_[a]); A_[a].push(b, L); if (!einweg) A_[b].push(a, L);
    const n = Math.max(1, Math.ceil(L / ZELLE)), zs = new Set();
    for (let i = 0; i <= n; i++) zs.add(zelle(X_[a] + (X_[b] - X_[a]) * i / n, Y_[a] + (Y_[b] - Y_[a]) * i / n));
    for (const c of zs) { let l = R.get(c); if (!l) R.set(c, l = []); l.push(a, b); }
  };
  for (const f of feats) {
    const p = f.properties; if (!KLASSEN.has(p.class)) continue;
    const einweg = (p.oneway === 1 || p.oneway === "1" || p.oneway === true) && (p.class === "motorway" || p.class === "trunk" || p.ramp == 1);
    const g = f.geometry, linien = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [];
    for (const ll of linien) { let v = -1; for (const q of ll) { const [E, N] = lv95(q[0], q[1]), i = knoten((E - 2480000) / 100, (1300000 - N) / 100); if (v >= 0 && v !== i) kante(v, i, einweg); v = i; } }
  }
  // offene Enden an Kachelrändern (Koordinaten leicht verschieden) mit nahen Knoten verbinden (≤ 2 m)
  const nk = X_.length;
  for (let i = 0; i < nk; i++) {
    if (A_[i].length > 2) continue; const l = R.get(zelle(X_[i], Y_[i])) || [];
    let best = -1, bd = .02; for (const j of l) if (j !== i) { const d = Math.hypot(X_[j] - X_[i], Y_[j] - Y_[i]); if (d < bd && !A_[i].includes(j)) { bd = d; best = j; } }
    if (best >= 0) { A_[i].push(best, bd); A_[best].push(i, bd); }
  }
  kx = X_; ky = Y_; adj = A_; raster = R; STR.n = kanten.size; STR.q = Math.min(14, Math.floor(z)); STR.gen++;
}
// nächste Strasse zu einem Punkt (≤ 60 m): Kante a-b, Lage t, Fusspunkt
function naechste(x, y) {
  const cx = Math.floor(x / ZELLE), cy = Math.floor(y / ZELLE); let best = null, bd = .6;
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    const l = raster.get((cx + i) + "," + (cy + j)); if (!l) continue;
    for (let k = 0; k < l.length; k += 2) {
      const a = l[k], b = l[k + 1], ex = kx[b] - kx[a], ey = ky[b] - ky[a], l2 = ex * ex + ey * ey || 1e-12;
      const t = Math.max(0, Math.min(1, ((x - kx[a]) * ex + (y - ky[a]) * ey) / l2)), px = kx[a] + ex * t, py = ky[a] + ey * t, d = Math.hypot(px - x, py - y);
      if (d < bd) { bd = d; best = { a, b, t, px, py }; }
    }
  }
  return best;
}
// kleiner Binärheap für A*
function heap() {
  const k = [], v = [];
  return {
    get n() { return k.length; },
    push(key, val) { k.push(key); v.push(val); let i = k.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= k[i]) break; [k[p], k[i]] = [k[i], k[p]]; [v[p], v[i]] = [v[i], v[p]]; i = p; } },
    pop() { const top = v[0], lk = k.pop(), lv = v.pop(); if (k.length) { k[0] = lk; v[0] = lv; let i = 0; for (; ;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < k.length && k[l] < k[m]) m = l; if (r < k.length && k[r] < k[m]) m = r; if (m === i) break; [k[m], k[i]] = [k[i], k[m]]; [v[m], v[i]] = [v[i], v[m]]; i = m; } } return top; }
  };
}
// kürzester Weg von (xa, ya) nach (xb, yb) auf den Strassen; null, wenn keiner (oder ein unplausibler Umweg)
function strasse(xa, ya, xb, yb) {
  const A = naechste(xa, ya), Z = naechste(xb, yb); if (!A || !Z) return null;
  const luft = Math.hypot(xb - xa, yb - ya), grenze = 1.8 * luft + .4;
  let pts;
  if ((A.a === Z.a && A.b === Z.b) || (A.a === Z.b && A.b === Z.a)) pts = [[A.px, A.py], [Z.px, Z.py]];
  else {
    const g = new Map(), vor = new Map(), H = heap(), h = i => Math.hypot(kx[i] - Z.px, ky[i] - Z.py);
    const start = (i, d) => { if (!g.has(i) || d < g.get(i)) { g.set(i, d); vor.set(i, -1); H.push(d + h(i), i); } };
    start(A.a, Math.hypot(kx[A.a] - A.px, ky[A.a] - A.py)); start(A.b, Math.hypot(kx[A.b] - A.px, ky[A.b] - A.py));
    const ziel = new Map([[Z.a, Math.hypot(kx[Z.a] - Z.px, ky[Z.a] - Z.py)], [Z.b, Math.hypot(kx[Z.b] - Z.px, ky[Z.b] - Z.py)]]);
    let best = Infinity, bestI = -1, schritte = 0; const fertig = new Set();
    while (H.n && schritte++ < 30000) {
      const u = H.pop(); if (fertig.has(u)) continue; fertig.add(u); const gu = g.get(u);
      if (gu + h(u) >= best || gu > grenze) break;
      if (ziel.has(u) && gu + ziel.get(u) < best) { best = gu + ziel.get(u); bestI = u; }
      const n = adj[u]; for (let k = 0; k < n.length; k += 2) { const w = n[k], d = gu + n[k + 1]; if (!g.has(w) || d < g.get(w)) { g.set(w, d); vor.set(w, u); H.push(d + h(w), w); } }
    }
    if (bestI < 0 || best > grenze) return null;
    pts = [[Z.px, Z.py]]; for (let c = bestI; c >= 0; c = vor.get(c)) pts.push([kx[c], ky[c]]); pts.push([A.px, A.py]); pts.reverse();
  }
  pts.unshift([xa, ya]); pts.push([xb, yb]);
  return pts;
}
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
  const t0 = performance.now(), s = Math.hypot(xb - xa, yb - ya) < 150 ? strasse(xa, ya, xb, yb) : null;   // über 15 km: Fernbus, gerade STR.rest -= performance.now() - t0;
  const P = s ? wegAus(s, STR.q < 13, STR.q) : c && c.P.q ? c.P : wegAus([[xa, ya], [xb, yb]], true, 0);   // kein Weg: alten Strassenweg behalten
  if (s) STR.wege++; else STR.gerade++;
  CACHE.set(key, { P, gen: STR.gen }); if (CACHE.size > 60000) CACHE.clear();
  return P;
}
// je Bild: Rechenzeit für neue Wege (bis 4 ms)
export function strassenBild() { STR.bild++; STR.rest = 4; }
export function strassenStarten(m) {
  map = m; let t = 0; const neu = () => { clearTimeout(t); t = setTimeout(aufbauen, 300); };
  map.on("moveend", neu); map.on("sourcedata", e => { if (quelle && e.sourceId === quelle && e.isSourceLoaded && map.getZoom() >= 13) neu(); }); neu();
}
