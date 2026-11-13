// Dächer: Wohnhäuser bekommen beim Hineinzoomen (ab Zoom ZD) ein Sattel- oder Walmdach. Die Mauern zeichnet weiterhin
// die Grundkarte (fill-extrusion «gebaeude-3d», MapLibre setzt jedes Gebäude als Ganzes auf die Geländehöhe in der Mitte
// seines Grundrisses, Dach flach auf render_height) – das Dach sitzt genau darauf: über dem kleinsten umschliessenden
// Rechteck des Grundrisses, mit Vorsprung. Nur kleine, kompakte Gebäude (Wohnhäuser); Hallen, Blöcke und Hochhäuser
// behalten ihr Flachdach. Farbe nach festem Zufall je Gebäude, in den Bergen eher grau.
import { K } from "./karte.js";
import { ladeThree, szeneMitLicht, gemeinsamerZeichner } from "./drei.js";
import { VOR_3D } from "./tageszeit.js";
import { lichtAnmelden, fensterAnteil } from "./lichter.js";
import { W3 } from "./welt3d.js";
import { istHandy, nachLaden, beiRuhe } from "../util.js";

export const ZD = 15;
// Dachhöhe aus der Gesamthöhe (render_height = bis zum First): Mauern ab Zoom ZD nur bis zur Traufe (welt3d.js nutzt
// dieselbe Formel als Ausdruck), das Dach endet genau auf der Gesamthöhe. Gilt für Häuser H_MIN … H_MAX ohne Unterbau.
export const H_MIN = 3.5, H_MAX = 22, DACH_ANTEIL = .32, DACH_MIN = 1.8, DACH_MAX = 6;
export const dachH = H => Math.max(DACH_MIN, Math.min(DACH_MAX, DACH_ANTEIL * H));
const N_MAX = istHandy() ? 4000 : 15000, N_FENSTER_TAG = istHandy() ? 5000 : 20000;
export const DA = { n: 0, fertig: 0, liste: null };
// Fassadenfarben: gleiche Liste und Wahl (Kennung % Anzahl) wie die Gebäude-Ebene in welt3d.js
export const FASSADE = ["#ebe6dc", "#e3ddd0", "#efece6", "#e6dccb", "#dcd8d1", "#e9e1d3", "#e8dcbf", "#d8dcd5", "#ead8cf", "#f1efe9"];
const ZIEGEL = ["#c0644a", "#b0583d", "#c9775a", "#a1523b", "#b86d55"], GRAU = ["#7a7e83", "#86827d", "#6e6a66", "#8f8a83"];
const mc = ll => maplibregl.MercatorCoordinate.fromLngLat(ll);
let quelle = null, anker = null, ams = 1, version = 0, hEx = -1;

function hash(n) { let h = (n | 0) * 2654435761 | 0; h = (h ^ (h >>> 15)) * 2246822519 | 0; return ((h ^ (h >>> 13)) >>> 0) / 4294967296; }
// konvexe Hülle (Monotone Chain) und kleinstes umschliessendes Rechteck (je Hüllkante als Richtung)
export function huelle(P) {
  const p = P.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]), kr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const u = [], l = []; for (const q of p) { while (l.length > 1 && kr(l[l.length - 2], l[l.length - 1], q) <= 0) l.pop(); l.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (u.length > 1 && kr(u[u.length - 2], u[u.length - 1], q) <= 0) u.pop(); u.push(q); }
  return l.slice(0, -1).concat(u.slice(0, -1));
}
export function rechteck(H) {
  let best = null;
  for (let i = 0; i < H.length; i++) {
    const a = H[i], b = H[(i + 1) % H.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 1e-6) continue;
    const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L; let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const q of H) { const s = q[0] * ux + q[1] * uy, t = -q[0] * uy + q[1] * ux; u0 = Math.min(u0, s); u1 = Math.max(u1, s); v0 = Math.min(v0, t); v1 = Math.max(v1, t); }
    const A = (u1 - u0) * (v1 - v0); if (!best || A < best.A) best = { A, ux, uy, u0, u1, v0, v1 };
  }
  if (!best) return null;
  const { ux, uy, u0, u1, v0, v1 } = best, cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
  let a = (u1 - u0) / 2, b = (v1 - v0) / 2, ax = [ux, uy], bx = [-uy, ux];
  if (b > a) { [a, b] = [b, a]; [ax, bx] = [bx, ax]; }   // a = halbe Länge (First), b = halbe Breite
  return { A: best.A, a, b, ax, bx, cx: cu * ux - cv * uy, cy: cu * uy + cv * ux };
}
const flaeche = P => { let s = 0; for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; s += p[0] * q[1] - q[0] * p[1]; } return Math.abs(s) / 2; };

function bauen() {
  const map = K.map; if (!map || !W3.gebaeudeAn || map.getZoom() < ZD) { DA.liste = null; DA.n = 0; version++; return; }
  if (!quelle) { for (const l of map.getStyle().layers) if (l["source-layer"] === "building") { quelle = l.source; break; } } if (!quelle) return;
  const z = map.getZoom(), o = mc(map.getCenter()), ms = o.meterInMercatorCoordinateUnits(), R = z >= 17 ? 700 : z >= 16 ? 1100 : 1600;
  const liste = [], gesehen = new Set();
  // genau die Gebäude, die die Karte zeichnet (sonst kommen beim Zoomen vereinfachte Umrisse gröberer Kacheln dazu)
  if (!map.getLayer("gebaeude-3d")) return;
  for (const f of map.queryRenderedFeatures({ layers: ["gebaeude-3d"] })) {
    const p = f.properties, H = +(p.render_height ?? p.height ?? 8), H0 = +(p.render_min_height ?? p.min_height ?? 0);
    if (!(H >= 3)) continue; const nurFenster = !(H >= H_MIN && H <= H_MAX) || H0 > 0;   // Dach nur für Häuser bis ~6 Geschosse ohne Überbauten; grössere Gebäude nur Fenster (Lichter)
    const g = f.geometry; if (g.type !== "Polygon") continue; const ring = g.coordinates[0]; if (!ring || ring.length < 4 || ring.length > 60) continue;
    // Mitte wie MapLibre (Mittel der Eckpunkte) – darauf bezieht sich die Geländehöhe des ganzen Gebäudes
    let sx = 0, sy = 0; const n = ring.length - 1; for (let i = 0; i < n; i++) { sx += ring[i][0]; sy += ring[i][1]; }
    const ml = [sx / n, sy / n], m = mc(ml), dx = (m.x - o.x) / ms, dy = (m.y - o.y) / ms; if (Math.hypot(dx, dy) > R) continue;
    const key = Math.round(dx * 2) + "," + Math.round(dy * 2) + "," + H; if (gesehen.has(key)) continue; gesehen.add(key);   // gleiches Haus aus mehreren Kacheln
    const P = []; for (let i = 0; i < n; i++) { const q = mc(ring[i]); P.push([(q.x - m.x) / ms, (q.y - m.y) / ms]); }
    const Hu = huelle(P); if (Hu.length < 3) continue; const r = rechteck(Hu); if (!r) continue;
    const A = flaeche(P), schraeg = !(r.A > 650 || r.A < 25 || A / r.A < .8 || r.a / r.b > 4.5);   // Schrägdach nur auf kleinen, fast rechteckigen Häusern
    // Kennung für die Fassadenfarbe (wie die Gebäude-Ebene: ohne Kennung 0); Zufall für das Dach aus der festen Lage
    const id = f.id !== undefined && f.id !== null ? Math.abs(+f.id || 0) : 0, fest = Math.round(ml[0] * 2e5) * 31 + Math.round(ml[1] * 2e5);
    const h = hash(fest), klein = A < 900 && H <= 16;   // verwinkelte Wohnhäuser: Walmdach mit Plateau (meist), sonst Flachdach mit Brüstung
    liste.push({ ml, x: dx, y: dy, H, H0, r, id, h, fest, d: Math.hypot(dx, dy), z: NaN, schraeg: schraeg && !nurFenster, walm: !schraeg && klein && hash(fest + 5) < .82, nurFenster, P, A });
  }
  if (liste.length > N_MAX) { liste.sort((a, b) => a.h - b.h); liste.length = N_MAX; }   // Auswahl unabhängig von der Bildmitte
  anker = o; ams = ms; DA.liste = liste; DA.n = liste.length; DA.fertig = 0; hEx = -1; version++;
}
function hoehen() {
  const L = DA.liste, map = K.map; if (!L) return false; const T = map.getTerrain(), ex = T ? T.exaggeration || 1 : 0;
  if (ex !== hEx) { hEx = ex; DA.fertig = 0; }
  if (DA.fertig >= L.length) return false;
  const bis = performance.now() + 5;
  while (DA.fertig < L.length && performance.now() < bis) for (let k = 0; k < 100 && DA.fertig < L.length; k++) {
    const b = L[DA.fertig++]; if (!ex) { b.z = 0; b.meer = 500; continue; }
    const e = map.queryTerrainElevation(b.ml); b.z = e === null || e === undefined ? NaN : e; b.meer = b.z / ex;
  }
  return true;
}
// Dach eines Hauses in ein Dreieckspuffer schreiben (lokale Meter, z nach oben)
function dach(b, pos, nor, col) {
  const r = b.r, o = .45, a = r.a + o * .7, w = r.b + o, walm = r.a / r.b < 1.35 || b.h < .22;
  const z0 = b.z + b.H - dachH(b.H) - .05, rh = Math.min(b.z + b.H - z0, r.b * (b.meer > 1100 ? .75 : 1.1)), z1 = z0 + rh;   // First auf der Gesamthöhe (bei schmalen Häusern höchstens ~48°)
  const cx = b.x + r.cx, cy = b.y + r.cy, [ux, uy] = r.ax, [vx, vy] = r.bx;
  const P = (s, t, z) => [cx + ux * s + vx * t, cy + uy * s + vy * t, z];
  const berg = b.meer > 1100, farbe = berg ? (b.h < .75 ? GRAU[Math.floor(b.h * 40) % GRAU.length] : ZIEGEL[Math.floor(b.h * 50) % ZIEGEL.length]) : (b.h < .18 ? GRAU[Math.floor(b.h * 40) % GRAU.length] : ZIEGEL[Math.floor(b.h * 50) % ZIEGEL.length]);
  const C = new THREE.Color(farbe), CW = new THREE.Color(FASSADE[b.id % FASSADE.length]);
  const tri = (A, B, Cc, c, aus) => { const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], e2 = [Cc[0] - A[0], Cc[1] - A[1], Cc[2] - A[2]]; let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]; const l = Math.hypot(...n) || 1; n = n.map(q => q / l); if (aus ? n[0] * aus[0] + n[1] * aus[1] < 0 : n[2] < 0) n = n.map(q => -q);
    for (const q of [A, B, Cc]) { pos.push(q[0], q[1], q[2]); nor.push(n[0], n[1], n[2]); col.push(c.r, c.g, c.b); } };
  const quad = (A, B, Cc, D, c) => { tri(A, B, Cc, c); tri(A, Cc, D, c); };
  const e = [P(-a, -w, z0), P(a, -w, z0), P(a, w, z0), P(-a, w, z0)];
  if (walm) {   // Walmdach: kurzer First, vier geneigte Flächen
    const f = Math.max(0, a - w * .9), F1 = P(-f, 0, z1), F2 = P(f, 0, z1);
    quad(e[0], e[1], F2, F1, C); quad(e[2], e[3], F1, F2, C); tri(e[1], e[2], F2, C); tri(e[3], e[0], F1, C);
  } else {      // Satteldach: First über die ganze Länge, Giebel in Fassadenfarbe
    const F1 = P(-a, 0, z1), F2 = P(a, 0, z1), G = [P(-r.a, -r.b, z0), P(r.a, -r.b, z0), P(r.a, r.b, z0), P(-r.a, r.b, z0)];
    quad(e[0], e[1], F2, F1, C); quad(e[2], e[3], F1, F2, C);
    const G1 = P(-r.a, 0, z1), G2 = P(r.a, 0, z1);
    tri(G[3], G[0], G1, CW, [-ux, -uy]); tri(G[1], G[2], G2, CW, [ux, uy]);   // Giebel: Normale nach aussen
  }
  // Kamin: auf gut der Hälfte der Häuser, nahe am First, Höhe aus der Dachfläche an dieser Stelle
  if (hash(b.fest + 11) < .6) { const s = (hash(b.fest + 12) - .5) * 1.2 * r.a, t = (hash(b.fest + 13) < .5 ? -1 : 1) * w * .28, zf = z1 - (Math.abs(t) / w) * (z1 - z0), K = P(s, t, 0);
    kasten(pos, nor, col, K[0], K[1], ux, uy, .3, .3, zf - .8, zf + 1, KAMIN, KAMIN_D); }
}
const sflaeche = P => { let s = 0; for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; s += p[0] * q[1] - q[0] * p[1]; } return s / 2; };
const drin = (q, P) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const a = P[i], b = P[j]; if ((a[1] > q[1]) !== (b[1] > q[1]) && q[0] < (b[0] - a[0]) * (q[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
// Umriss um d nach innen (d < 0: nach aussen) verschieben: jede Ecke entlang der Winkelhalbierenden
export function einruecken(P, d) {
  const n = P.length, sg = sflaeche(P) >= 0 ? 1 : -1, N = [];
  for (let i = 0; i < n; i++) { const a = P[i], b = P[(i + 1) % n], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; N.push([-sg * (b[1] - a[1]) / L, sg * (b[0] - a[0]) / L]); }   // Normale nach innen
  return P.map((p, i) => { const n1 = N[(i - 1 + n) % n], n2 = N[i], k = Math.max(.25, 1 + n1[0] * n2[0] + n1[1] * n2[1]); return [p[0] + (n1[0] + n2[0]) / k * d, p[1] + (n1[1] + n2[1]) / k * d]; });
}
// gültig: gleicher Umlaufsinn, keine Kante umgedreht, alle Ecken im Original, Fläche nicht verschwunden
function einrueckenOk(P, Q) {
  const a0 = sflaeche(P), a1 = sflaeche(Q); if (Math.sign(a0) !== Math.sign(a1) || Math.abs(a1) < Math.abs(a0) * .04) return false;
  for (let i = 0; i < P.length; i++) { const j = (i + 1) % P.length; if ((P[j][0] - P[i][0]) * (Q[j][0] - Q[i][0]) + (P[j][1] - P[i][1]) * (Q[j][1] - Q[i][1]) <= 0) return false; if (!drin(Q[i], P)) return false; }
  return true;
}
const dreieck = (pos, nor, col, A, B, Cc, c, hoch = true) => { const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], e2 = [Cc[0] - A[0], Cc[1] - A[1], Cc[2] - A[2]]; let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]; const l = Math.hypot(...n) || 1; n = n.map(q => q / l); if (hoch && n[2] < 0) n = n.map(q => -q);
  for (const q of [A, B, Cc]) { pos.push(q[0], q[1], q[2]); nor.push(n[0], n[1], n[2]); col.push(c.r, c.g, c.b); } };
const dachFarbe = b => { const berg = b.meer > 1100, grau = berg ? b.h < .75 : b.h < .18; return new THREE.Color(grau ? GRAU[Math.floor(b.h * 40) % GRAU.length] : ZIEGEL[Math.floor(b.h * 50) % ZIEGEL.length]); };
// Kasten (Kamin, Lüftung): Seiten und Deckel, Normalen nach aussen
function kasten(pos, nor, col, cx, cy, ux, uy, la, lb, z0, z1, c, cd) {
  const vx = -uy, vy = ux, E = [[-la, -lb], [la, -lb], [la, lb], [-la, lb]].map(([s, t]) => [cx + ux * s + vx * t, cy + uy * s + vy * t]);
  for (let i = 0; i < 4; i++) { const a = E[i], b = E[(i + 1) % 4], mx = (a[0] + b[0]) / 2 - cx, my = (a[1] + b[1]) / 2 - cy, l = Math.hypot(mx, my) || 1, n = [mx / l, my / l, 0];
    for (const q of [[a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], z1], [a[0], a[1], z0], [b[0], b[1], z1], [a[0], a[1], z1]]) { pos.push(...q); nor.push(...n); col.push(c.r, c.g, c.b); } }
  for (const t of [[0, 1, 2], [0, 2, 3]]) for (const i of t) { pos.push(E[i][0], E[i][1], z1); nor.push(0, 0, 1); col.push(cd.r, cd.g, cd.b); }
}
// Verwinkelte Wohnhäuser: Walmdach über dem echten Umriss (Traufe mit Vorsprung, Dachflächen bis zum eingerückten Umriss,
// oben ein flaches Stück in Dachfarbe). Wenn das Einrücken nicht aufgeht (sehr schmale Flügel), kleiner versuchen.
function walmUmriss(b, pos, nor, col) {
  const P = b.P, z0 = b.z + b.H - dachH(b.H) - .05, hoch = b.z + b.H - z0, steil = b.meer > 1100 ? .6 : .8;
  let Q = null, d = Math.min(hoch / steil, b.r.b * .95);
  for (let v = 0; v < 4 && !Q; v++, d *= .6) { const q = einruecken(P, d); if (einrueckenOk(P, q)) Q = q; }
  if (!Q || d < .8) return false; d /= .6;
  const z1 = z0 + Math.min(hoch, d * steil), O = einruecken(P, -.4), C = dachFarbe(b), zt = z0 - .4 * steil * .5;
  for (let i = 0; i < P.length; i++) { const j = (i + 1) % P.length, A = [b.x + O[i][0], b.y + O[i][1], zt], B = [b.x + O[j][0], b.y + O[j][1], zt], Cc = [b.x + Q[j][0], b.y + Q[j][1], z1], D = [b.x + Q[i][0], b.y + Q[i][1], z1];
    dreieck(pos, nor, col, A, B, Cc, C); dreieck(pos, nor, col, A, Cc, D, C); }
  let tri; try { tri = THREE.ShapeUtils.triangulateShape(Q.map(q => new THREE.Vector2(q[0], q[1])), []); } catch (e) { tri = []; }
  const Cp = C.clone().multiplyScalar(.93); for (const t of tri) for (const i of t) { pos.push(b.x + Q[i][0], b.y + Q[i][1], z1); nor.push(0, 0, 1); col.push(Cp.r, Cp.g, Cp.b); }
  // Kamin auf jedem zweiten Haus
  if (hash(b.fest + 11) < .55) { const k = Q[Math.floor(hash(b.fest + 12) * Q.length)], m = [Q.reduce((s, q) => s + q[0], 0) / Q.length, Q.reduce((s, q) => s + q[1], 0) / Q.length], t = .35;
    kasten(pos, nor, col, b.x + k[0] + (m[0] - k[0]) * t, b.y + k[1] + (m[1] - k[1]) * t, b.r.ax[0], b.r.ax[1], .3, .3, z1 - 1, z1 + .9, KAMIN, KAMIN_D); }
  return true;
}
const KAMIN = { r: .55, g: .5, b: .47 }, KAMIN_D = { r: .2, g: .2, b: .21 };
// Übrige Häuser (verwinkelt, gross): flaches Stück von der Traufe bis zur Gesamthöhe (die Mauern enden ab ZD an der Traufe)
function aufstock(b, pos, nor, col) {
  if (b.walm && walmUmriss(b, pos, nor, col)) return;
  const z0 = b.z + b.H - dachH(b.H) - .05, z1 = b.z + b.H, P = b.P, CW = new THREE.Color(FASSADE[b.id % FASSADE.length]), CT = new THREE.Color(KIES[Math.floor(b.h * 30) % KIES.length]);
  mauer(b, pos, nor, col, z0, z1 + .45);   // Mauer mit Brüstung (Attika) 45 cm über dem Dach
  const m = [P.reduce((s, q) => s + q[0], 0) / P.length, P.reduce((s, q) => s + q[1], 0) / P.length];
  if (b.A > 60 && drin(m, P) && hash(b.fest + 21) < .6) kasten(pos, nor, col, b.x + m[0], b.y + m[1], b.r.ax[0], b.r.ax[1], Math.min(2.2, b.r.a * .25), Math.min(1.4, b.r.b * .3), z1, z1 + 1.2, LUEFT, LUEFT);
  void CW;
  let tri; try { tri = THREE.ShapeUtils.triangulateShape(P.map(q => new THREE.Vector2(q[0], q[1])), []); } catch (e) { return; }
  for (const t of tri) for (const i of t) { pos.push(b.x + P[i][0], b.y + P[i][1], z1); nor.push(0, 0, 1); col.push(CT.r, CT.g, CT.b); }
}
const KIES = ["#c9c4b9", "#bfbab0", "#cfcbc3", "#b8b5ae"], LUEFT = { r: .62, g: .63, b: .64 };
// Mauerstück z0 … z1 entlang des Umrisses (Normalen nach aussen)
function mauer(b, pos, nor, col, z0, z1) {
  const P = b.P, CW = new THREE.Color(FASSADE[b.id % FASSADE.length]), sg = sflaeche(P) >= 0 ? 1 : -1;
  for (let i = 0; i < P.length; i++) { const a = P[i], c = P[(i + 1) % P.length], ax = b.x + a[0], ay = b.y + a[1], cx = b.x + c[0], cy = b.y + c[1], L = Math.hypot(cx - ax, cy - ay) || 1, n = [sg * (cy - ay) / L, -sg * (cx - ax) / L, 0];
    for (const q of [[ax, ay, z0], [cx, cy, z0], [cx, cy, z1], [ax, ay, z0], [cx, cy, z1], [ax, ay, z1]]) { pos.push(...q); nor.push(...n); col.push(CW.r, CW.g, CW.b); } }
}
// Fenster am Tag: Rahmen hell, Glas dunkel, bei Wohnhäusern teils Fensterläden – gleiche Lage wie die Nachtfenster
let GLAS = null, RAHMEN = null, LADEN = null;   // erst nach dem Laden von three.js
function fensterTag(pos, nor, col) {
  if (!GLAS) { GLAS = ["#3a4651", "#33404b", "#40505c", "#2e3a44", "#46525b"].map(c => new THREE.Color(c)); RAHMEN = new THREE.Color("#f6f4ef"); LADEN = ["#4f6b4a", "#61744f", "#7d8b91", "#8a5a3c", "#5a6e7d", "#9a4a3a"].map(c => new THREE.Color(c)); }
  const L = DA.liste.slice(0, DA.fertig).filter(b => !isNaN(b.z)).sort((a, b) => a.d - b.d); let n = 0;
  const quad = (x, y, ux, uy, nx, ny, s0, s1, z0, z1, off, c) => { const ax = x + ux * s0 + nx * off, ay = y + uy * s0 + ny * off, bx = x + ux * s1 + nx * off, by = y + uy * s1 + ny * off;
    for (const q of [[ax, ay, z0], [bx, by, z0], [bx, by, z1], [ax, ay, z0], [bx, by, z1], [ax, ay, z1]]) { pos.push(q[0], q[1], q[2]); nor.push(nx, ny, 0); col.push(c.r, c.g, c.b); } };
  for (const b of L) {
    if (n >= N_FENSTER_TAG) break;
    const oben = b.nurFenster ? b.H : b.H - dachH(b.H), unten = b.nurFenster ? b.H0 : 0, gross = b.H > 22, P = b.P, sg = sflaeche(P) >= 0 ? 1 : -1;
    const laeden = (b.schraeg || b.walm) && hash(b.fest + 31) < .45 && b.meer < 1600, LF = LADEN[Math.floor(hash(b.fest + 32) * LADEN.length)];
    for (let k = 0; k < P.length && n < N_FENSTER_TAG; k++) {
      const a = P[k], c = P[(k + 1) % P.length], Lk = Math.hypot(c[0] - a[0], c[1] - a[1]); if (Lk < 2.6) continue;
      const ux = (c[0] - a[0]) / Lk, uy = (c[1] - a[1]) / Lk, nx = sg * uy, ny = -sg * ux, ab = gross ? 2.6 : 3.2, w = gross ? 1.6 : 1.3, nw = Math.floor((Lk - .8) / ab);
      for (let st = 0, z = unten + 1.0; z + 1.3 < oben - .3 && n < N_FENSTER_TAG; st++, z += 3) for (let j = 0; j < nw; j++) {
        if (hash(b.fest * 7919 + k * 131 + st * 17 + j + 3) < .08) continue;   // hie und da keine (Mauer, Treppenhaus)
        const m = (Lk - nw * ab) / 2 + ab * (j + .5), x = b.x + a[0], y = b.y + a[1], z0 = b.z + z, z1 = z0 + 1.3;
        quad(x, y, ux, uy, nx, ny, m - w / 2 - .12, m + w / 2 + .12, z0 - .12, z1 + .12, .04, RAHMEN);
        quad(x, y, ux, uy, nx, ny, m - w / 2, m + w / 2, z0, z1, .07, GLAS[Math.floor(hash(b.fest + st * 5 + j * 3 + k) * GLAS.length)]);
        if (laeden && !gross) { const lw = w * .5; quad(x, y, ux, uy, nx, ny, m - w / 2 - .14 - lw, m - w / 2 - .14, z0 - .05, z1 + .05, .05, LF); quad(x, y, ux, uy, nx, ny, m + w / 2 + .14, m + w / 2 + .14 + lw, z0 - .05, z1 + .05, .05, LF); }
        n++;
      }
    }
  }
  DA.fensterTag = n;
}
function schicht() {
  return {
    id: "daecher3d", type: "custom", renderingMode: "3d",
    onAdd(m, gl) {
      this.cam = new THREE.Camera(); this.szene = szeneMitLicht();
      this.r = gemeinsamerZeichner(m, gl);
      this.mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }); this.netz = null; this.v = -1; this.f = -1;
      // Normalen sind selbst nach aussen/oben gerechnet → nicht nach Blickseite umdrehen (y nach Süden kehrt den Umlaufsinn um,
      // sonst wurden Flachdächer und Mauern von hinten beleuchtet und viel zu dunkel)
      this.mat.onBeforeCompile = sh => { sh.fragmentShader = sh.fragmentShader.replace("#include <normal_fragment_begin>", THREE.ShaderChunk.normal_fragment_begin.replace("gl_FrontFacing ? 1.0 : - 1.0", "1.0")); };   // Bausteine sind hier noch nicht eingesetzt
      // Fenster: eigene Szene, gezeichnet von lichter.js nach der Abdunkelung
      this.fensterSzene = new THREE.Scene(); this.fenster = null; this.fensterM = new THREE.Matrix4(); this.fensterAn = false;
      this.fensterMat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, vertexColors: true,
        uniforms: { uNacht: { value: 0 }, uAnteil: { value: .3 } },
        vertexShader: "attribute float rnd; varying float vR; varying vec3 vC; void main(){ vR = rnd; vC = color; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
        fragmentShader: "uniform float uNacht; uniform float uAnteil; varying float vR; varying vec3 vC; void main(){ if (vR > uAnteil) discard; gl_FragColor = vec4(vC, uNacht); }" });
      const U = this.fensterMat.uniforms;
      lichtAnmelden({ aktiv: () => this.fensterAn && !!this.fenster, szene: this.fensterSzene, matrix: this.fensterM, nacht: v => { U.uNacht.value = v; U.uAnteil.value = fensterAnteil(); } });
    },
    // Fenster als leuchtende Rechtecke vor den Mauern (nur die, die nachts höchstens brennen; welche brennen, entscheidet
    // der Zufallswert gegen den Anteil der Uhrzeit im Shader)
    fensterBauen() {
      const pos = [], col = [], rnd = []; let n = 0; const MAX = istHandy() ? 15000 : 60000;
      const FARBEN = ["#ffd58f", "#ffe3a8", "#ffcc7a", "#fff0cf", "#dfe7ff"].map(c => new THREE.Color(c));
      for (let i = 0; i < DA.fertig && n < MAX; i++) {
        const b = DA.liste[i]; if (isNaN(b.z)) continue;
        const oben = b.nurFenster ? b.H : b.H - dachH(b.H), unten = b.nurFenster ? b.H0 : 0, gross = b.H > 22, P = b.P;
        let sa = 0; for (let k = 0; k < P.length; k++) { const p = P[k], q = P[(k + 1) % P.length]; sa += p[0] * q[1] - q[0] * p[1]; } const sg = sa >= 0 ? 1 : -1;
        for (let k = 0; k < P.length && n < MAX; k++) {
          const a = P[k], c = P[(k + 1) % P.length], L = Math.hypot(c[0] - a[0], c[1] - a[1]); if (L < 2.6) continue;
          const ux = (c[0] - a[0]) / L, uy = (c[1] - a[1]) / L, nx = sg * uy * .12, ny = -sg * ux * .12;   // 12 cm vor der Mauer
          const ab = gross ? 2.6 : 3.2, w = gross ? 1.6 : 1.3, nw = Math.floor((L - .8) / ab);
          for (let st = 0, z = unten + 1.0; z + 1.3 < oben - .3 && n < MAX; st++, z += 3) for (let j = 0; j < nw; j++) {
            const r = hash(b.fest * 7919 + k * 131 + st * 17 + j); if (r > .5) continue;   // höchstens die Hälfte kann brennen
            const m = (L - nw * ab) / 2 + ab * (j + .5), x0 = b.x + a[0] + ux * (m - w / 2) + nx, y0 = b.y + a[1] + uy * (m - w / 2) + ny, x1 = x0 + ux * w, y1 = y0 + uy * w, z0 = b.z + z, z1 = z0 + 1.3;
            const C = FARBEN[Math.floor(hash(b.fest + st * 3 + j) * FARBEN.length)];
            for (const q of [[x0, y0, z0], [x1, y1, z0], [x1, y1, z1], [x0, y0, z0], [x1, y1, z1], [x0, y0, z1]]) { pos.push(q[0], q[1], q[2]); col.push(C.r, C.g, C.b); rnd.push(r); }
            n++;
          }
        }
      }
      if (this.fenster) { this.fensterSzene.remove(this.fenster); this.fenster.geometry.dispose(); this.fenster = null; }
      if (!n) return;
      const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3)); g.setAttribute("rnd", new THREE.Float32BufferAttribute(rnd, 1));
      this.fenster = new THREE.Mesh(g, this.fensterMat); this.fenster.frustumCulled = false; this.fensterSzene.add(this.fenster); DA.fenster = n;
    },
    render(gl, args) {
      const map = K.map; if (!DA.liste || !W3.gebaeudeAn || map.getZoom() < ZD - .2) { this.fensterAn = false; return; }
      const neu = hoehen();
      // neu bauen, wenn neue Höhen da sind (höchstens alle 25 % und am Ende)
      if (this.v !== version || (this.f !== DA.fertig && (DA.fertig === DA.n || DA.fertig - this.f > DA.n / 4))) {
        this.v = version; this.f = DA.fertig; const pos = [], nor = [], col = [];
        for (let i = 0; i < DA.fertig; i++) { const b = DA.liste[i]; if (!isNaN(b.z) && !b.nurFenster) (b.schraeg ? dach : aufstock)(b, pos, nor, col); }
        if (map.getZoom() >= 15.6 && DA.fertig === DA.n) fensterTag(pos, nor, col);   // Fenster erst, wenn alle Höhen da sind (einmal statt bei jedem Zwischenschritt)
        this.fensterBauen();
        if (this.netz) { this.szene.remove(this.netz); this.netz.geometry.dispose(); this.netz = null; }
        if (pos.length) { const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3)); g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
          this.netz = new THREE.Mesh(g, this.mat); this.netz.frustumCulled = false; this.szene.add(this.netz); }
      }
      const mm = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix), lm = new THREE.Matrix4().makeTranslation(anker.x, anker.y, 0).scale(new THREE.Vector3(ams, ams, ams));
      this.fensterM.copy(lm); this.fensterAn = true;
      if (!this.netz) { if (neu) map.triggerRepaint(); return; }
      this.cam.projectionMatrix = mm.multiply(lm); this.r.resetState(); this.r.render(this.szene, this.cam);
      if (neu) map.triggerRepaint();
    },
  };
}
export function daecherStarten() {
  const map = K.map; let geladen = false, t = 0;
  const neu = () => nachLaden(map, "daecher", () => { bauen(); map.triggerRepaint(); }, 400, 5);
  const laden = () => { if (geladen || map.getZoom() < ZD - .5) return; geladen = true; ladeThree().then(() => { try { map.addLayer(schicht(), VOR_3D()); } catch (e) { console.error(e); } neu(); }); };
  beiRuhe(map, () => { laden(); neu(); });
  map.on("sourcedata", e => { if (quelle && e.sourceId === quelle && e.isSourceLoaded && map.getZoom() >= ZD) neu(); });
  map.on("terrain", neu);
  laden();
}
