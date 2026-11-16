// Strassen nah an der Kamera als echte Flächen: Die Strassenbänder der Grundkarte werden aufs Gelände «gemalt», und die
// Kartendaten reichen nur bis Zoom 14 – ganz nah (ab ~Zoom 17) sind sie deshalb unscharf und verwaschen. Hier werden die
// Strassen im Umkreis der Bildmitte als Bänder mit scharfen Kanten gebaut (wie die Brücken in welt3d.js): Asphalt, heller
// Rand, Markierungen. Jedes Band folgt dem Gelände an Mitte und beiden Rändern (liegt also auch am Hang auf).
// Die gemalten Bänder bleiben darunter (in der Ferne sieht man nur sie).
import { K } from "./karte.js";
import { ladeThree, gemeinsamerZeichner } from "./drei.js";
import { VOR_3D } from "./tageszeit.js";
import { Geo, W3 } from "./welt3d.js";
import { STRASSENFARBE, MARKE, strassenBreite } from "./landschaft.js";
import { nachLaden, beiRuhe, quellMerkmale, istHandy } from "../util.js";

export const S3 = { n: 0, ms: 0 };
const Z_AB = 16.2, SCHRITT = 5;
const lin = c => c.map(v => v <= .04045 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4)), hex = h => lin([1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255));
const mc = ll => maplibregl.MercatorCoordinate.fromLngLat(ll);
// Rand neben dem Asphalt (m) je Klasse; Zufahrten ohne
const RAND = { motorway: .8, trunk: .8, primary: 1.2, secondary: 1.2, tertiary: 1.2, minor: 1.1 };
const BREIT = { service: 3.6 };

function bauen(map, quelle) {
  const z = map.getZoom(); if (z < Z_AB || !map.getTerrain() || !quelle) return null;
  const t0 = performance.now(), o = mc(map.getCenter()), ms = o.meterInMercatorCoordinateUnits(), R = (z >= 18 ? 320 : z >= 17 ? 480 : 700) * (istHandy() ? .7 : 1);
  const lokal = ll => { const m = mc(ll); return [(m.x - o.x) / ms, (m.y - o.y) / ms]; };
  const hoehe = q => { const e = map.queryTerrainElevation(new maplibregl.MercatorCoordinate(o.x + q[0] * ms, o.y + q[1] * ms).toLngLat()); return e == null ? null : e; };
  const ASPHALT = hex(STRASSENFARBE.haupt), KANTE = hex(STRASSENFARBE.rand), BANKETT = hex(STRASSENFARBE.bankett), WEISS = hex(STRASSENFARBE.linie);
  const F = quellMerkmale(map, quelle, "transportation"); let zmax = 0; for (const f of F) if (f.tile && f.tile.z > zmax) zmax = f.tile.z;
  const G = new Geo(), gesehen = new Set(); let n = 0;
  for (const f of F) {
    const p = f.properties, art = p.class, w = BREIT[art] || strassenBreite(art, p.oneway === 1, p.ramp === 1); if (!w || p.brunnel === "tunnel" || p.brunnel === "bridge") continue;
    if (f.tile && f.tile.z !== zmax) continue;   // gröbere Kacheln (weiter weg geladen) haben dieselben Strassen nochmals, vereinfacht
    const g = f.geometry, linien = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [];
    for (const ll of linien) {
      if (ll.length < 2) continue; const roh = ll.map(lokal);
      if (!roh.some(q => Math.hypot(q[0], q[1]) < R + 60)) continue;
      const key = art + "|" + Math.round(roh[0][0]) + "," + Math.round(roh[0][1]) + "|" + Math.round(roh[roh.length - 1][0]) + "," + Math.round(roh[roh.length - 1][1]) + "|" + roh.length; if (gesehen.has(key)) continue; gesehen.add(key);
      // verdichten und in Stücke innerhalb des Umkreises teilen
      const pts = [roh[0]]; for (let i = 1; i < roh.length; i++) { const a = roh[i - 1], b = roh[i], k = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / SCHRITT)); for (let j = 1; j <= k; j++) pts.push([a[0] + (b[0] - a[0]) * j / k, a[1] + (b[1] - a[1]) * j / k]); }
      let lauf = []; const fertig = () => { if (lauf.length > 1) { band(lauf, w, art, p.oneway === 1, p.ramp === 1); n++; } lauf = []; };
      for (const q of pts) { if (Math.hypot(q[0], q[1]) > R) { fertig(); continue; } const zc = hoehe(q); if (zc == null) { fertig(); continue; } lauf.push([q[0], q[1], zc]); }
      fertig();
    }
  }
  function band(P, w, art, einweg, rampe) {
    const M = P.length, N = [], D = [0], ZL = [], ZR = [], rb = RAND[art] || 0, auto = art === "motorway" || art === "trunk";
    for (let i = 0; i < M; i++) {
      const a = P[Math.max(0, i - 1)], b = P[i], c = P[Math.min(M - 1, i + 1)]; let u1 = [b[0] - a[0], b[1] - a[1]], u2 = [c[0] - b[0], c[1] - b[1]]; const l1 = Math.hypot(u1[0], u1[1]);
      if (i) D.push(D[i - 1] + l1); if (!l1) u1 = u2; if (!Math.hypot(u2[0], u2[1])) u2 = u1;
      const L1 = Math.hypot(u1[0], u1[1]) || 1, L2 = Math.hypot(u2[0], u2[1]) || 1, n1 = [-u1[1] / L1, u1[0] / L1], n2 = [-u2[1] / L2, u2[0] / L2];
      let mx = n1[0] + n2[0], my = n1[1] + n2[1]; const l = Math.hypot(mx, my) || 1; mx /= l; my /= l; const k = 1 / Math.max(.5, mx * n1[0] + my * n1[1]); N.push([mx * k, my * k]);
      // Gelände an den Rändern (inkl. Randstreifen), höchstens 1,2 m anders als in der Mitte (Mauern, Böschungskanten im Höhenmodell)
      const q = w / 2 + rb, zl = hoehe([b[0] + mx * q, b[1] + my * q]), zr = hoehe([b[0] - mx * q, b[1] - my * q]), kl = v => v == null ? 0 : Math.max(-1.2, Math.min(1.2, v - b[2]));
      ZL.push(kl(zl)); ZR.push(kl(zr));
    }
    // Höhe über der Mitte an der Querlage q (linear zwischen Mitte und Rand), plus Abstand über dem Gelände
    const Q = w / 2 + rb, zq = (q, plus) => i => (q >= 0 ? ZL[i] : ZR[i]) * Math.abs(q) / Q + plus;
    if (rb) for (const sg of [1, -1]) G.streifen(P, N, sg * Q, zq(sg * Q, .07), sg * w / 2, zq(sg * w / 2, .07), auto ? BANKETT : KANTE, "auf");
    G.streifen(P, N, -w / 2, zq(-w / 2, .1), 0, .1, ASPHALT, "auf"); G.streifen(P, N, 0, .1, w / 2, zq(w / 2, .1), ASPHALT, "auf");
    if (auto) { const r = rampe ? MARKE.rampe : MARKE.rand; for (const sg of [1, -1]) G.streifen(P, N, sg * (r - .1), zq(sg * (r - .1), .15), sg * (r + .1), zq(sg * (r + .1), .15), WEISS, "auf"); }
    const strich = (an, takt) => { for (let i = 1; i < M; i++) { const a = P[i - 1], b = P[i], l = D[i] - D[i - 1]; if (l < .01) continue; const nx = -(b[1] - a[1]) / l * .09, ny = (b[0] - a[0]) / l * .09;
      for (let k = Math.floor(D[i - 1] / takt); k * takt < D[i]; k++) { const s0 = Math.max(D[i - 1], k * takt), s1 = Math.min(D[i], k * takt + an); if (s1 <= s0) continue;
        const at = s => { const u = (s - D[i - 1]) / l; return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u + .15]; }, A = at(s0), B = at(s1);
        G.quad([A[0] + nx, A[1] + ny, A[2]], [B[0] + nx, B[1] + ny, B[2]], [B[0] - nx, B[1] - ny, B[2]], [A[0] - nx, A[1] - ny, A[2]], WEISS, [0, 0, 1]); } } };
    if (auto && !rampe) strich(6, 18); else if (["primary", "secondary", "tertiary"].includes(art) && !einweg) strich(3, 9);
  }
  S3.n = n; S3.ms = Math.round(performance.now() - t0);
  return { G, o };
}

function ebene3d() {
  return {
    id: "strassen3d", type: "custom", renderingMode: "3d",
    onAdd(m, gl) { this.cam = new THREE.Camera(); this.szene = new THREE.Scene(); this.r = gemeinsamerZeichner(m, gl); this.mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }); this.netz = null; this.o = null; },
    setze(e) {
      if (this.netz) { this.szene.remove(this.netz); this.netz.geometry.dispose(); this.netz = null; }
      if (!e || !e.G.p.length) { this.o = null; return; } this.o = e.o;
      const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(e.G.p, 3)); g.setAttribute("color", new THREE.Float32BufferAttribute(e.G.c, 3));
      this.netz = new THREE.Mesh(g, this.mat); this.netz.frustumCulled = false; this.szene.add(this.netz);
    },
    render(gl, args) {
      const map = K.map; if (!this.netz || !this.o || map.getZoom() < Z_AB - .2 || !map.getTerrain()) return;
      const s = this.o.meterInMercatorCoordinateUnits(), m = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix), l = new THREE.Matrix4().makeTranslation(this.o.x, this.o.y, 0).scale(new THREE.Vector3(s, s, s));
      this.cam.projectionMatrix = m.multiply(l); this.r.resetState(); this.r.render(this.szene, this.cam);
    },
  };
}

export function strassen3dStarten() {
  const map = K.map; let schicht = null, laedt = false;
  const neu = () => nachLaden(map, "strassen3d", async () => {
    if (map.getZoom() < Z_AB || !map.getTerrain() || !W3.quelle) { if (schicht) { schicht.setze(null); map.triggerRepaint(); } return; }
    if (!schicht) { if (laedt) return; laedt = true; await ladeThree(); schicht = ebene3d(); map.addLayer(schicht, VOR_3D()); }
    schicht.setze(bauen(map, W3.quelle)); map.triggerRepaint();
  }, 250, 4);
  beiRuhe(map, neu); map.on("terrain", neu); map.on("sourcedata", e => { if (W3.quelle && e.sourceId === W3.quelle && e.isSourceLoaded) neu(); });
  window.__s3 = S3; neu();
}
