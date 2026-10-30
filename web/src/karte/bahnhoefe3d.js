// Bahnhöfe in 3D: Perrons (Bahnsteige) mit weisser Kante, gelber Sicherheitslinie und Perrondach mit Stützen.
// Grundlage: die Lage jeder Bahnsteigkante aus dem Fahrplan (/api/gleise, Mittel der GTFS-Kanten) und die Gleise der
// Grundkarte (gleise.js): Perron entlang des nächsten Gleises, auf der Seite der Kante, so breit wie Platz bis zum nächsten
// Gleis ist (3–10 m), Länge nach Grösse des Bahnhofs. Unterirdische Gleise (Tunnel) bekommen keinen Perron oben.
// Ab Zoom ZBF, nach jedem Verschieben neu für die Bahnhöfe im Umkreis.
import { K } from "./karte.js";
import { B } from "../kern/basis.js";
import { GLAGE, gleiseLaden } from "../kern/gleislage.js";
import { GL, gleisNah } from "./gleise.js";
import { ladeThree, szeneMitLicht } from "./drei.js";
import { ebene } from "../ui/ebenen.js";
import { wgs } from "../util.js";

export const ZBF = 14.5;
export const BF = { an: true, perrons: 0 };
const mc = ll => maplibregl.MercatorCoordinate.fromLngLat(ll);
let anker = null, ams = 1, version = 0, daten = null;
const HOEHE = .55, ABSTAND = 1.75;   // Perronhöhe über Schiene, Kante bis Gleismitte (m)

function bauen() {
  const map = K.map; if (!BF.an || map.getZoom() < ZBF) { daten = null; version++; return; }
  gleiseLaden(); if (!GLAGE.daten || !GL.bereit) return;
  const o = mc(map.getCenter()), ms = o.meterInMercatorCoordinateUnits(), R = 2500, T = map.getTerrain();
  const perrons = [], gesehen = new Set();
  for (const [i, kanten] of Object.entries(GLAGE.daten)) {
    const name = B.SN[+i], st = name && (B.ST[name] || B.STX[name]); if (!st) continue;
    const sm = mc(wgs((st.E - 2480000) / 100, (1300000 - st.N) / 100)); if (Math.hypot(sm.x - o.x, sm.y - o.y) / ms > R) continue;
    const tier = B.ST[name] ? B.tier(name) : 2, L = tier === 0 ? 320 : tier === 1 ? 220 : 150;
    for (const [gl, [E, N]] of Object.entries(kanten)) {
      const m = mc(wgs((E - 2480000) / 100, (1300000 - N) / 100)), g = gleisNah(m, 18); if (!g || g.tun) continue;
      // Seite der Kante (Punkt liegt am Bahnsteig); liegt er auf dem Gleis, zur Bahnhofsmitte hin
      const n0x = g.uy, n0y = -g.ux; let seite = Math.sign(((m.x - g.px) * n0x + (m.y - g.py) * n0y) / ms);
      if (!seite || Math.hypot(m.x - g.px, m.y - g.py) / ms < 1) seite = Math.sign((sm.x - g.px) * n0x + (sm.y - g.py) * n0y) || 1;
      const nx = n0x * seite, ny = n0y * seite;
      // Breite: Platz bis zum nächsten Gleis auf dieser Seite
      let W = 7;
      for (let k = 3; k <= 16; k += .5) { const q = { x: g.px + nx * k * ms, y: g.py + ny * k * ms }, h = gleisNah(q, 1.4); if (h && h.s !== g.s && Math.abs(h.ux * g.ux + h.uy * g.uy) > .9) { W = Math.max(3, Math.min(10, k - 2 * ABSTAND)); break; } }
      const cx = (g.px - o.x) / ms + nx * (ABSTAND + W / 2), cy = (g.py - o.y) / ms + ny * (ABSTAND + W / 2);
      const key = Math.round(cx / 3) + "," + Math.round(cy / 3); if (gesehen.has(key)) continue; gesehen.add(key);   // gleicher Perron von beiden Kanten
      // Höhe: Gelände an 7 Punkten entlang des Perrons
      const zs = []; for (let k = 0; k <= 6; k++) { const s = -L / 2 + L * k / 6, q = new maplibregl.MercatorCoordinate(o.x + (cx + g.ux * s) * ms, o.y + (cy + g.uy * s) * ms).toLngLat(); const e = T ? map.queryTerrainElevation(q) : 0; zs.push(e === null || e === undefined ? NaN : e); }
      const gut = zs.filter(z => !isNaN(z)); if (!gut.length) continue; const mz = gut.reduce((a, b) => a + b) / gut.length; for (let k = 0; k < zs.length; k++) if (isNaN(zs[k])) zs[k] = mz;
      perrons.push({ cx, cy, ux: g.ux, uy: g.uy, nx, ny, W, L, zs, dach: tier === 0 ? .8 : tier === 1 ? .6 : .4, gl });
    }
  }
  anker = o; ams = ms; daten = perrons; BF.perrons = perrons.length; version++;
}
// Geometrie aller Perrons (lokale Meter, z nach oben)
function geometrie() {
  const pos = [], nor = [], col = [], C = {};
  const farbe = h => C[h] || (C[h] = new THREE.Color(h));
  const quad = (a, b, c, d, h) => { const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]]; let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]; const l = Math.hypot(...n) || 1; n = n.map(q => q / l);
    const f = farbe(h); for (const q of [a, b, c, a, c, d]) { pos.push(q[0], q[1], q[2]); nor.push(n[0], n[1], n[2]); col.push(f.r, f.g, f.b); } };
  // Quader entlang des Perrons: Längsbereich s0…s1, Querbereich t0…t1 (von der Kante weg), Höhe z0…z1 über dem Gelände
  const kiste = (p, s0, s1, t0, t1, z0, z1, oben, seiten, mitSeiten = true) => {
    const P = (s, t, z) => { const k = (s + p.L / 2) / p.L * 6, i = Math.max(0, Math.min(5, Math.floor(k))), g = p.zs[i] + (p.zs[i + 1] - p.zs[i]) * (k - i);
      return [p.cx + p.ux * s + p.nx * (t - p.W / 2), p.cy + p.uy * s + p.ny * (t - p.W / 2), g + z]; };
    const schritt = Math.max(1, Math.ceil((s1 - s0) / 25));
    for (let k = 0; k < schritt; k++) {
      const a = s0 + (s1 - s0) * k / schritt, b = s0 + (s1 - s0) * (k + 1) / schritt;
      quad(P(a, t0, z1), P(b, t0, z1), P(b, t1, z1), P(a, t1, z1), oben);
      if (mitSeiten) { quad(P(a, t0, z0), P(b, t0, z0), P(b, t0, z1), P(a, t0, z1), seiten); quad(P(b, t1, z0), P(a, t1, z0), P(a, t1, z1), P(b, t1, z1), seiten); }
    }
    if (mitSeiten) { quad(P(s0, t1, z0), P(s0, t0, z0), P(s0, t0, z1), P(s0, t1, z1), seiten); quad(P(s1, t0, z0), P(s1, t1, z0), P(s1, t1, z1), P(s1, t0, z1), seiten); }
  };
  for (const p of daten || []) {
    const L2 = p.L / 2;
    kiste(p, -L2, L2, 0, p.W, -.4, HOEHE, "#c4c2bd", "#a5a29c");                       // Perron
    kiste(p, -L2, L2, 0, .3, HOEHE, HOEHE + .01, "#f1f0ec", null, false);               // weisse Kante (Gleisseite)
    kiste(p, -L2, L2, .75, .87, HOEHE, HOEHE + .012, "#e8c21c", null, false);           // gelbe Sicherheitslinie
    if (p.W >= 4.5) {                                                                     // Perrondach mit Stützen
      const d = p.L * p.dach / 2, w0 = .6, w1 = p.W - .6;
      kiste(p, -d, d, w0, w1, HOEHE + 3.5, HOEHE + 3.75, "#6e757b", "#5d6368");
      for (let s = -d + 4; s <= d - 4; s += 12) kiste(p, s - .15, s + .15, p.W / 2 - .15, p.W / 2 + .15, HOEHE, HOEHE + 3.5, "#8b9196", "#7c8287");
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
  const neu = () => { clearTimeout(t); t = setTimeout(() => { bauen(); map.triggerRepaint(); if (!daten && map.getZoom() >= ZBF && BF.an) neu(); }, 700); };   // nach den Gleisen (gleise.js baut nach 200 ms)
  const laden = () => { if (geladen || map.getZoom() < ZBF - .5) return; geladen = true; ladeThree().then(() => { try { map.addLayer(schicht(), map.getLayer("zuege3d") ? "zuege3d" : map.getLayer("fz") ? "fz" : undefined); } catch (e) { console.error(e); } neu(); }); };
  map.on("moveend", () => { laden(); neu(); });
  map.on("terrain", neu);
  ebene({ id: "bahnhoefe", name: "Bahnhöfe (Perrons, 3D)", an: true, setze: an => { BF.an = an; if (an) { laden(); neu(); } else { daten = null; version++; } map.triggerRepaint(); } });
  laden();
}
