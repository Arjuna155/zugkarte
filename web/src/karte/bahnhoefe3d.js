// Bahnhöfe in 3D: Perrons aus OpenStreetMap (echte Umrisse, auch gebogen; /api/perrons je 10-km-Kachel) auf Gleishöhe,
// weisse Kante und gelbe Sicherheitslinie nur an den Seiten, an denen ein Gleis entlangführt, Perrondach nur wo der Perron
// in OSM als überdacht erfasst ist und swisstopo dort nicht schon ein Dach als Gebäude hat. Rückfall, wo OSM keinen Perron
// kennt: geschätzter Perron an der Bahnsteigkante aus dem Fahrplan (/api/gleise), kurz und ohne Dach.
// Ab Zoom ZBF, nach jedem Verschieben neu für den Umkreis.
import { K } from "./karte.js";
import { B } from "../kern/basis.js";
import { GLAGE, gleiseLaden } from "../kern/gleislage.js";
import { kachelnIm } from "../kern/busse.js";
import { GL, gleisNah } from "./gleise.js";
import { huelle, rechteck } from "./daecher.js";
import { ladeThree, szeneMitLicht } from "./drei.js";
import { ebene } from "../ui/ebenen.js";
import { wgs } from "../util.js";

export const ZBF = 14.5;
export const BF = { an: true, perrons: 0, osm: 0, ersatz: 0, kacheln: 0 };
const mc = ll => maplibregl.MercatorCoordinate.fromLngLat(ll);
let anker = null, ams = 1, version = 0, daten = null;
const HOEHE = .55, ABSTAND = 1.75, R = 2500;   // Perronhöhe über Gelände, Kante bis Gleismitte, Umkreis (m)

// ---- OSM-Perrons je Kachel laden ----
const KA = new Map();   // Kachel → Liste {zu, dach, gl, pts [[E, N]]} oder {lauf}/{fehler, t}
function kachelnLaden(map, fertig) {
  const fehlt = kachelnIm(map).filter(k => { const s = KA.get(k); return !s || (s.fehler && Date.now() - s.t > 10 * 60000); });
  if (!fehlt.length) return;
  for (const k of fehlt) KA.set(k, { lauf: true });
  fetch("/api/perrons?k=" + fehlt.join(",")).then(r => r.ok ? r.json() : Promise.reject()).then(j => {
    for (const k of fehlt) KA.set(k, (j.k[k] || []).map(f => { const pts = [[f[3] / 10, f[4] / 10]]; for (let i = 5; i + 1 < f.length; i += 2) pts.push([pts[pts.length - 1][0] + f[i] / 10, pts[pts.length - 1][1] + f[i + 1] / 10]); return { zu: !!f[0], dach: f[1], gl: f[2], pts }; }));
    BF.kacheln = KA.size; fertig();
  }).catch(() => { for (const k of fehlt) KA.set(k, { fehler: true, t: Date.now() }); });
}
const lokal = (E, N, o, ms) => { const m = mc(wgs((E - 2480000) / 100, (1300000 - N) / 100)); return [(m.x - o.x) / ms, (m.y - o.y) / ms]; };
const inPoly = (x, y, P) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const a = P[i], b = P[j]; if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
const abstandPoly = (x, y, P) => { let m = Infinity; for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length], ex = b[0] - a[0], ey = b[1] - a[1], l2 = ex * ex + ey * ey || 1e-9, t = Math.max(0, Math.min(1, ((x - a[0]) * ex + (y - a[1]) * ey) / l2)); m = Math.min(m, Math.hypot(a[0] + ex * t - x, a[1] + ey * t - y)); } return inPoly(x, y, P) ? 0 : m; };

function bauen() {
  const map = K.map; if (!BF.an || map.getZoom() < ZBF) { daten = null; version++; return; }
  gleiseLaden(); kachelnLaden(map, () => neuBauen && neuBauen());
  const o = mc(map.getCenter()), ms = o.meterInMercatorCoordinateUnits(), T = map.getTerrain(), ex = T ? T.exaggeration || 1 : 0;
  const hoehe = (x, y) => { if (!ex) return 0; const e = map.queryTerrainElevation(new maplibregl.MercatorCoordinate(o.x + x * ms, o.y + y * ms).toLngLat()); return e === null || e === undefined ? NaN : e; };
  const merc = (x, y) => ({ x: o.x + x * ms, y: o.y + y * ms });
  const osm = [], ersatz = [], gesehen = new Set();
  // OSM-Perrons im Umkreis
  for (const [, liste] of KA) {
    if (!Array.isArray(liste)) continue;
    for (const p of liste) {
      let P = p.pts.map(([E, N]) => lokal(E, N, o, ms));
      if (!P.some(q => Math.hypot(q[0], q[1]) < R)) continue;
      const sig = p.pts.length + ":" + Math.round(p.pts[0][0]) + ":" + Math.round(p.pts[0][1]); if (gesehen.has(sig)) continue; gesehen.add(sig);   // gleicher Perron in mehreren Kacheln
      if (p.zu) P = P.slice(0, -1);
      else {   // als Linie erfasst: 3,6 m breiter Streifen
        const L = [], Rr = []; for (let i = 0; i < P.length; i++) { const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1, nx = -dy / l * 1.8, ny = dx / l * 1.8; L.push([P[i][0] + nx, P[i][1] + ny]); Rr.push([P[i][0] - nx, P[i][1] - ny]); }
        P = L.concat(Rr.reverse());
      }
      if (P.length < 3) continue;
      let sa = 0; for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; sa += a[0] * b[1] - b[0] * a[1]; } const sg = sa >= 0 ? 1 : -1;
      const z = P.map(q => hoehe(q[0], q[1])), gut = z.filter(v => !isNaN(v)); if (ex && !gut.length) continue; const mz = gut.length ? gut.reduce((a, b) => a + b) / gut.length : 0; for (let i = 0; i < z.length; i++) if (isNaN(z[i])) z[i] = mz;
      // Kanten: Seiten mit einem Gleis daneben (≤ 3 m, parallel)
      const kanten = P.map((a, i) => { const b = P[(i + 1) % P.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 4) return false; const g = gleisNah(merc((a[0] + b[0]) / 2, (a[1] + b[1]) / 2), 3); return !!g && Math.abs(g.ux * (b[0] - a[0]) + g.uy * (b[1] - a[1])) / L > .85; });
      // Dach: in OSM überdacht und kein Dach-Gebäude von swisstopo darüber (sonst doppelt)
      let dach = p.dach === 1;
      if (dach) { const c = P.reduce((s, q) => [s[0] + q[0] / P.length, s[1] + q[1] / P.length], [0, 0]), ll = new maplibregl.MercatorCoordinate(o.x + c[0] * ms, o.y + c[1] * ms).toLngLat(), px = map.project(ll), cv = map.getCanvas();
        if (px.x > 0 && px.y > 0 && px.x < cv.clientWidth && px.y < cv.clientHeight && map.getLayer("gebaeude-3d") && map.queryRenderedFeatures(px, { layers: ["gebaeude-3d"] }).some(f => +(f.properties.render_min_height || 0) > 1)) dach = false; }
      osm.push({ P, z, sg, kanten, dach });
    }
  }
  // Rückfall: Bahnsteigkanten aus dem Fahrplan ohne OSM-Perron in der Nähe (≤ 15 m)
  if (GLAGE.daten && GL.bereit) for (const [i, kanten] of Object.entries(GLAGE.daten)) {
    const name = B.SN[+i], st = name && (B.ST[name] || B.STX[name]); if (!st) continue;
    const s = lokal(st.E, st.N, o, ms); if (Math.hypot(s[0], s[1]) > R) continue;
    for (const [, [E, N]] of Object.entries(kanten)) {
      const q = lokal(E, N, o, ms); if (osm.some(p => abstandPoly(q[0], q[1], p.P) < 15)) continue;
      const g = gleisNah(merc(q[0], q[1]), 18); if (!g || g.tun) continue;
      const gx = (g.px - o.x) / ms, gy = (g.py - o.y) / ms, n0x = g.uy, n0y = -g.ux;
      let seite = Math.sign((q[0] - gx) * n0x + (q[1] - gy) * n0y); if (!seite || Math.hypot(q[0] - gx, q[1] - gy) < 1) seite = Math.sign((s[0] - gx) * n0x + (s[1] - gy) * n0y) || 1;
      const nx = n0x * seite, ny = n0y * seite, W = 5, L = 120, cx = gx + nx * (ABSTAND + W / 2), cy = gy + ny * (ABSTAND + W / 2);
      const key = Math.round(cx / 3) + "," + Math.round(cy / 3); if (gesehen.has(key)) continue; gesehen.add(key);
      // als Polygon (gerades Rechteck), Gleisseite = erste Längsseite
      const P = [[cx - g.ux * L / 2 - nx * W / 2, cy - g.uy * L / 2 - ny * W / 2], [cx + g.ux * L / 2 - nx * W / 2, cy + g.uy * L / 2 - ny * W / 2], [cx + g.ux * L / 2 + nx * W / 2, cy + g.uy * L / 2 + ny * W / 2], [cx - g.ux * L / 2 + nx * W / 2, cy - g.uy * L / 2 + ny * W / 2]];
      let sa = 0; for (let k = 0; k < 4; k++) { const a = P[k], b = P[(k + 1) % 4]; sa += a[0] * b[1] - b[0] * a[1]; }
      const z = P.map(v => hoehe(v[0], v[1])); if (z.some(isNaN)) continue;
      ersatz.push({ P, z, sg: sa >= 0 ? 1 : -1, kanten: [true, false, false, false], dach: false });
    }
  }
  anker = o; ams = ms; daten = osm.concat(ersatz); BF.osm = osm.length; BF.ersatz = ersatz.length; BF.perrons = daten.length; version++;
}
let neuBauen = null;

// ---- Geometrie ----
function geometrie() {
  const pos = [], nor = [], col = [], C = {};
  const farbe = h => C[h] || (C[h] = new THREE.Color(h));
  const dreieck = (a, b, c, h, n) => { if (!n) { const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]; n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]; const l = Math.hypot(...n) || 1; n = n.map(q => q / l); if (n[2] < -.01) n = n.map(q => -q); }
    const f = farbe(h); for (const q of [a, b, c]) { pos.push(q[0], q[1], q[2]); nor.push(n[0], n[1], n[2]); col.push(f.r, f.g, f.b); } };
  const quad = (a, b, c, d, h, n) => { dreieck(a, b, c, h, n); dreieck(a, c, d, h, n); };
  for (const p of daten || []) {
    const { P, z, sg } = p, n = P.length;
    let tri; try { tri = THREE.ShapeUtils.triangulateShape(P.map(q => new THREE.Vector2(q[0], q[1])), []); } catch (e) { continue; }
    for (const [a, b, c] of tri) dreieck([P[a][0], P[a][1], z[a] + HOEHE], [P[b][0], P[b][1], z[b] + HOEHE], [P[c][0], P[c][1], z[c] + HOEHE], "#c4c2bd", [0, 0, 1]);   // Belag
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, a = P[i], b = P[j], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, ox = sg * (b[1] - a[1]) / L, oy = -sg * (b[0] - a[0]) / L;   // nach aussen
      quad([a[0], a[1], z[i] - .4], [b[0], b[1], z[j] - .4], [b[0], b[1], z[j] + HOEHE], [a[0], a[1], z[i] + HOEHE], "#a5a29c", [ox, oy, 0]);   // Wand
      if (p.kanten[i]) {   // weisse Kante und gelbe Linie (nach innen versetzt)
        const ix = -ox, iy = -oy, S = (d0, d1, h, dz) => quad([a[0] + ix * d0, a[1] + iy * d0, z[i] + HOEHE + dz], [b[0] + ix * d0, b[1] + iy * d0, z[j] + HOEHE + dz], [b[0] + ix * d1, b[1] + iy * d1, z[j] + HOEHE + dz], [a[0] + ix * d1, a[1] + iy * d1, z[i] + HOEHE + dz], h, [0, 0, 1]);
        S(0, .3, "#f1f0ec", .01); S(.75, .87, "#e8c21c", .012);
      }
    }
    if (p.dach) {   // Perrondach: Umriss 0,4 m nach innen, auf 3,5 m, Stützen entlang der Mittellinie alle 12 m
      const zm = z.reduce((s, v) => s + v, 0) / n + HOEHE + 3.5, Q = P.map((q, i) => { const a = P[(i + n - 1) % n], b = P[(i + 1) % n], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [q[0] - sg * dy / l * .4, q[1] + sg * dx / l * .4]; });
      for (const [a, b, c] of tri) { dreieck([Q[a][0], Q[a][1], zm + .25], [Q[b][0], Q[b][1], zm + .25], [Q[c][0], Q[c][1], zm + .25], "#6e757b", [0, 0, 1]); dreieck([Q[a][0], Q[a][1], zm], [Q[b][0], Q[b][1], zm], [Q[c][0], Q[c][1], zm], "#5d6368", [0, 0, -1]); }
      const r = rechteck(huelle(P));
      if (r && r.b > 1.2) for (let s = -r.a + 5; s <= r.a - 5; s += 12) {
        const cx = r.cx + r.ax[0] * s, cy = r.cy + r.ax[1] * s; if (!inPoly(cx, cy, P)) continue;
        let k = 0, d = Infinity; for (let i = 0; i < n; i++) { const dd = Math.hypot(P[i][0] - cx, P[i][1] - cy); if (dd < d) { d = dd; k = i; } }
        const z0 = z[k] + HOEHE, c = (dx, dy) => [cx + dx, cy + dy];
        const e = [c(-.15, -.15), c(.15, -.15), c(.15, .15), c(-.15, .15)];
        for (let i = 0; i < 4; i++) { const a = e[i], b = e[(i + 1) % 4]; quad([a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], zm], [a[0], a[1], zm], "#8b9196"); }
      }
    }
  }
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3)); g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3)); return g;
}
function schicht() {
  return {
    id: "bahnhoefe3d", type: "custom", renderingMode: "3d",
    onAdd(m, gl) {
      this.cam = new THREE.Camera(); this.szene = szeneMitLicht();
      this.r = new THREE.WebGLRenderer({ canvas: m.getCanvas(), context: gl, antialias: true }); this.r.autoClear = false;
      this.mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }); this.netz = null; this.v = -1;
    },
    render(gl, args) {
      const map = K.map;
      if (this.v !== version) { this.v = version; if (this.netz) { this.szene.remove(this.netz); this.netz.geometry.dispose(); this.netz = null; }
        if (daten && daten.length) { this.netz = new THREE.Mesh(geometrie(), this.mat); this.netz.frustumCulled = false; this.szene.add(this.netz); } }
      if (!this.netz || !BF.an || map.getZoom() < ZBF - .2) return;
      const mm = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix), lm = new THREE.Matrix4().makeTranslation(anker.x, anker.y, 0).scale(new THREE.Vector3(ams, ams, ams));
      this.cam.projectionMatrix = mm.multiply(lm); this.r.resetState(); this.r.render(this.szene, this.cam);
    },
  };
}
export function bahnhoefeStarten() {
  const map = K.map; let geladen = false, t = 0;
  const neu = () => { clearTimeout(t); t = setTimeout(() => { bauen(); map.triggerRepaint(); if (!GL.bereit && map.getZoom() >= ZBF && BF.an) neu(); }, 700); };   // nach den Gleisen (gleise.js baut nach 200 ms)
  neuBauen = neu;
  const laden = () => { if (geladen || map.getZoom() < ZBF - .5) return; geladen = true; ladeThree().then(() => { try { map.addLayer(schicht(), map.getLayer("zuege3d") ? "zuege3d" : map.getLayer("fz") ? "fz" : undefined); } catch (e) { console.error(e); } neu(); }); };
  map.on("moveend", () => { laden(); neu(); });
  map.on("terrain", neu);
  ebene({ id: "bahnhoefe", name: "Bahnhöfe (Perrons, 3D)", an: true, setze: an => { BF.an = an; if (an) { laden(); neu(); } else { daten = null; version++; } map.triggerRepaint(); } });
  laden();
}
