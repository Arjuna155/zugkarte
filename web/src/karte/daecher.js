// Dächer: Wohnhäuser bekommen beim Hineinzoomen (ab Zoom ZD) ein Sattel- oder Walmdach. Die Mauern zeichnet weiterhin
// die Grundkarte (fill-extrusion «gebaeude-3d», MapLibre setzt jedes Gebäude als Ganzes auf die Geländehöhe in der Mitte
// seines Grundrisses, Dach flach auf render_height) – das Dach sitzt genau darauf: über dem kleinsten umschliessenden
// Rechteck des Grundrisses, mit Vorsprung. Nur kleine, kompakte Gebäude (Wohnhäuser); Hallen, Blöcke und Hochhäuser
// behalten ihr Flachdach. Farbe nach festem Zufall je Gebäude, in den Bergen eher grau.
import { K } from "./karte.js";
import { ladeThree, szeneMitLicht } from "./drei.js";
import { W3 } from "./welt3d.js";
import { istHandy } from "../util.js";

export const ZD = 15;
// Dachhöhe aus der Gesamthöhe (render_height = bis zum First): Mauern ab Zoom ZD nur bis zur Traufe (welt3d.js nutzt
// dieselbe Formel als Ausdruck), das Dach endet genau auf der Gesamthöhe. Gilt für Häuser H_MIN … H_MAX ohne Unterbau.
export const H_MIN = 3.5, H_MAX = 22, DACH_ANTEIL = .32, DACH_MIN = 1.8, DACH_MAX = 6;
export const dachH = H => Math.max(DACH_MIN, Math.min(DACH_MAX, DACH_ANTEIL * H));
const N_MAX = istHandy() ? 4000 : 15000;
export const DA = { n: 0, fertig: 0, liste: null };
// Fassadenfarben: gleiche Liste und Wahl (Kennung % Anzahl) wie die Gebäude-Ebene in welt3d.js
export const FASSADE = ["#ebe6dc", "#e3ddd0", "#efece6", "#e6dccb", "#dcd8d1", "#e9e1d3"];
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
    if (!(H >= H_MIN && H <= H_MAX) || H0 > 0) continue;   // nur Häuser bis ~6 Geschosse, ohne Überbauten
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
    liste.push({ ml, x: dx, y: dy, H, r, id, h: hash(fest), d: Math.hypot(dx, dy), z: NaN, schraeg, P });
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
  const tri = (A, B, Cc, c) => { const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], e2 = [Cc[0] - A[0], Cc[1] - A[1], Cc[2] - A[2]]; let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]; const l = Math.hypot(...n) || 1; n = n.map(q => q / l); if (n[2] < 0) n = n.map(q => -q);
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
    tri(G[3], G[0], G1, CW); tri(G[1], G[2], G2, CW);
  }
}
// Übrige Häuser (verwinkelt, gross): flaches Stück von der Traufe bis zur Gesamthöhe (die Mauern enden ab ZD an der Traufe)
function aufstock(b, pos, nor, col) {
  const z0 = b.z + b.H - dachH(b.H) - .05, z1 = b.z + b.H, P = b.P, CW = new THREE.Color(FASSADE[b.id % FASSADE.length]), CT = new THREE.Color("#d2cfc8");
  let sa = 0; for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; sa += p[0] * q[1] - q[0] * p[1]; } const sg = sa >= 0 ? 1 : -1;   // Umlaufsinn → Normale nach aussen
  for (let i = 0; i < P.length; i++) { const a = P[i], c = P[(i + 1) % P.length], ax = b.x + a[0], ay = b.y + a[1], cx = b.x + c[0], cy = b.y + c[1], L = Math.hypot(cx - ax, cy - ay) || 1, n = [sg * (cy - ay) / L, -sg * (cx - ax) / L, 0];
    for (const q of [[ax, ay, z0], [cx, cy, z0], [cx, cy, z1], [ax, ay, z0], [cx, cy, z1], [ax, ay, z1]]) { pos.push(...q); nor.push(...n); col.push(CW.r, CW.g, CW.b); } }
  let tri; try { tri = THREE.ShapeUtils.triangulateShape(P.map(q => new THREE.Vector2(q[0], q[1])), []); } catch (e) { return; }
  for (const t of tri) for (const i of t) { pos.push(b.x + P[i][0], b.y + P[i][1], z1); nor.push(0, 0, 1); col.push(CT.r, CT.g, CT.b); }
}
function schicht() {
  return {
    id: "daecher3d", type: "custom", renderingMode: "3d",
    onAdd(m, gl) {
      this.cam = new THREE.Camera(); this.szene = szeneMitLicht();
      this.r = new THREE.WebGLRenderer({ canvas: m.getCanvas(), context: gl, antialias: true }); this.r.autoClear = false;
      this.mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }); this.netz = null; this.v = -1; this.f = -1;
    },
    render(gl, args) {
      const map = K.map; if (!DA.liste || !W3.gebaeudeAn || map.getZoom() < ZD - .2) return;
      const neu = hoehen();
      // neu bauen, wenn neue Höhen da sind (höchstens alle 25 % und am Ende)
      if (this.v !== version || (this.f !== DA.fertig && (DA.fertig === DA.n || DA.fertig - this.f > DA.n / 4))) {
        this.v = version; this.f = DA.fertig; const pos = [], nor = [], col = [];
        for (let i = 0; i < DA.fertig; i++) { const b = DA.liste[i]; if (!isNaN(b.z)) (b.schraeg ? dach : aufstock)(b, pos, nor, col); }
        if (this.netz) { this.szene.remove(this.netz); this.netz.geometry.dispose(); this.netz = null; }
        if (pos.length) { const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3)); g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
          this.netz = new THREE.Mesh(g, this.mat); this.netz.frustumCulled = false; this.szene.add(this.netz); }
      }
      if (!this.netz) { if (neu) map.triggerRepaint(); return; }
      const mm = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix), lm = new THREE.Matrix4().makeTranslation(anker.x, anker.y, 0).scale(new THREE.Vector3(ams, ams, ams));
      this.cam.projectionMatrix = mm.multiply(lm); this.r.resetState(); this.r.render(this.szene, this.cam);
      if (neu) map.triggerRepaint();
    },
  };
}
export function daecherStarten() {
  const map = K.map; let geladen = false, t = 0;
  const neu = () => { clearTimeout(t); t = setTimeout(() => { bauen(); map.triggerRepaint(); }, 400); };
  const laden = () => { if (geladen || map.getZoom() < ZD - .5) return; geladen = true; ladeThree().then(() => { try { map.addLayer(schicht(), map.getLayer("fz") ? "fz" : undefined); } catch (e) { console.error(e); } neu(); }); };
  map.on("moveend", () => { laden(); neu(); });
  map.on("sourcedata", e => { if (quelle && e.sourceId === quelle && e.isSourceLoaded && map.getZoom() >= ZD) neu(); });
  map.on("terrain", neu);
  laden();
}
