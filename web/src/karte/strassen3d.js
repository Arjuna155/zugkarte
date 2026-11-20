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
import { lichtAnmelden } from "./lichter.js";
import { nachLaden, beiRuhe, quellMerkmale, istHandy } from "../util.js";

export const S3 = { n: 0, ms: 0, lampen: 0, trottoir: 0 };
const Z_AB = 16.2, SCHRITT = 5;
const lin = c => c.map(v => v <= .04045 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4)), hex = h => lin([1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255));
const mc = ll => maplibregl.MercatorCoordinate.fromLngLat(ll);
// Rand neben dem Asphalt (m) je Klasse; Zufahrten ohne
const RAND = { motorway: .8, trunk: .8, primary: 1.2, secondary: 1.2, tertiary: 1.2, minor: 1.1 };
const BREIT = { service: 3.6 };
const STADT = ["primary", "secondary", "tertiary", "minor"];   // Klassen mit Trottoir und (ab tertiary) Strassenlampen im Siedlungsgebiet
const SIEDLUNG = new Set(["residential", "suburb", "neighbourhood", "village", "town", "city", "commercial", "retail", "industrial"]);
const ZELLE = 15;   // Siedlungsraster (m)

function bauen(map, quelle) {
  const z = map.getZoom(); if (z < Z_AB || !map.getTerrain() || !quelle) return null;
  const t0 = performance.now(), o = mc(map.getCenter()), ms = o.meterInMercatorCoordinateUnits(), R = (z >= 18 ? 320 : z >= 17 ? 480 : 700) * (istHandy() ? .7 : 1);
  const lokal = ll => { const m = mc(ll); return [(m.x - o.x) / ms, (m.y - o.y) / ms]; };
  const hoehe = q => { const e = map.queryTerrainElevation(new maplibregl.MercatorCoordinate(o.x + q[0] * ms, o.y + q[1] * ms).toLngLat()); return e == null ? null : e; };
  const ASPHALT = hex(STRASSENFARBE.haupt), KANTE = hex(STRASSENFARBE.rand), BANKETT = hex(STRASSENFARBE.bankett), WEISS = hex(STRASSENFARBE.linie);
  const F = quellMerkmale(map, quelle, "transportation"); let zmax = 0; for (const f of F) if (f.tile && f.tile.z > zmax) zmax = f.tile.z;
  const G = new Geo(), gesehen = new Set(), stuecke = [], enden = new Map(); let n = 0;
  const ek = q => Math.round(q[0]) + "," + Math.round(q[1]);
  for (const f of F) {
    const p = f.properties, art = p.class; if (art === "rail" || art === "transit") continue;   // Gleise nicht als Asphalt
    const w = BREIT[art] || strassenBreite(art, p.oneway === 1, p.ramp === 1); if (!w || p.brunnel === "tunnel" || p.brunnel === "bridge") continue;
    if (f.tile && f.tile.z !== zmax) continue;   // gröbere Kacheln (weiter weg geladen) haben dieselben Strassen nochmals, vereinfacht
    const g = f.geometry, linien = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [];
    for (const ll of linien) {
      if (ll.length < 2) continue; const roh0 = ll.map(lokal), roh = [roh0[0]];
      // fast gleiche Punkte weg (sonst kippt die Querrichtung am Ende → Striche quer über die Strasse)
      for (let i = 1; i < roh0.length; i++) { const a = roh[roh.length - 1], b = roh0[i]; if (Math.hypot(b[0] - a[0], b[1] - a[1]) >= .8) roh.push(b); else if (i === roh0.length - 1 && roh.length > 1) roh[roh.length - 1] = b; }
      if (roh.length < 2 || !roh.some(q => Math.hypot(q[0], q[1]) < R + 60)) continue;
      const key = art + "|" + ek(roh[0]) + "|" + ek(roh[roh.length - 1]) + "|" + roh.length; if (gesehen.has(key)) continue; gesehen.add(key);
      stuecke.push({ roh, art, w, einweg: p.oneway === 1, rampe: p.ramp === 1 });
      for (const q of [roh[0], roh[roh.length - 1]]) { const k = ek(q); enden.set(k, (enden.get(k) || 0) + 1); }
    }
  }
  // Siedlungsgebiet als Raster (landuse-Flächen der Grundkarte): dort Trottoirs und Strassenlampen
  const RN = Math.ceil(R / ZELLE) + 2, NZ = 2 * RN, stadtR = new Uint8Array(NZ * NZ);
  for (const f of quellMerkmale(map, quelle, "landuse")) {
    if (!SIEDLUNG.has(f.properties.class) || (f.tile && f.tile.z !== zmax)) continue;
    const g = f.geometry, polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
    for (const poly of polys) {
      const ringe = poly.map(r => r.map(lokal)); let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
      for (const q of ringe[0]) { x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]); }
      const i0 = Math.max(0, Math.floor(x0 / ZELLE) + RN), i1 = Math.min(NZ - 1, Math.floor(x1 / ZELLE) + RN), j0 = Math.max(0, Math.floor(y0 / ZELLE) + RN), j1 = Math.min(NZ - 1, Math.floor(y1 / ZELLE) + RN);
      for (let j = j0; j <= j1; j++) { const y = (j - RN + .5) * ZELLE; const xs = [];   // Zeilenfüllung: Schnittpunkte aller Ringe mit der Zeile
        for (const r of ringe) for (let k = 0, m = r.length - 1; k < r.length; m = k++) { const a = r[m], b = r[k]; if ((a[1] > y) !== (b[1] > y)) xs.push(a[0] + (y - a[1]) / (b[1] - a[1]) * (b[0] - a[0])); }
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) { const ia = Math.max(i0, Math.ceil(xs[k] / ZELLE - .5) + RN), ib = Math.min(i1, Math.floor(xs[k + 1] / ZELLE - .5) + RN); for (let i = ia; i <= ib; i++) stadtR[j * NZ + i] = 1; } }
    }
  }
  const stadtBei = q => { const i = Math.floor(q[0] / ZELLE) + RN, j = Math.floor(q[1] / ZELLE) + RN; return i >= 0 && j >= 0 && i < NZ && j < NZ && stadtR[j * NZ + i] === 1; };
  const lampen = [], LAMPEN_MAX = istHandy() ? 500 : 1500; let trottoir = 0;
  const STEIN = hex("#c3c0b8"), STEIN_SEITE = hex("#9c9992"), TROTTOIR = hex("#b6b3ab"), METALL = hex("#b4b9bd"), METALL_D = hex("#7f858a"), MAST = hex("#6f757a"), LEUCHTE = hex("#dcdad2");
  // Randlinien enden vor Verzweigungen, Einmündungen und offenen Enden (dort kreuzen sich sonst die Linien der Fahrbahnen);
  // nur wo genau zwei Stücke zusammenstossen (Kachelrand, gewöhnlicher Knick), laufen sie durch
  const KUERZ = 14;
  for (const s of stuecke) {
    const { roh, art, w } = s;
    const pts = [roh[0]], D = [0]; for (let i = 1; i < roh.length; i++) { const a = roh[i - 1], b = roh[i], l = Math.hypot(b[0] - a[0], b[1] - a[1]), k = Math.max(1, Math.ceil(l / SCHRITT)); for (let j = 1; j <= k; j++) { pts.push([a[0] + (b[0] - a[0]) * j / k, a[1] + (b[1] - a[1]) * j / k]); D.push(D[D.length - 1] + l / k); } }
    const L = D[D.length - 1], t0 = enden.get(ek(roh[0])) === 2 ? 0 : KUERZ, t1 = enden.get(ek(roh[roh.length - 1])) === 2 ? L : L - KUERZ;
    let lauf = [], ls = []; const fertig = () => { if (lauf.length > 1) { band(lauf, ls, t0, t1, w, art, s.einweg, s.rampe); n++; } lauf = []; ls = []; };
    for (let i = 0; i < pts.length; i++) { const q = pts[i]; if (Math.hypot(q[0], q[1]) > R) { fertig(); continue; } const zc = hoehe(q); if (zc == null) { fertig(); continue; } lauf.push([q[0], q[1], zc]); ls.push(D[i]); }
    fertig();
  }
  function band(P, S, t0, t1, w, art, einweg, rampe) {
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
    // Markierungen nur im Bereich [t0, t1] des ganzen Stücks (mindestens 15 m lang)
    let i0 = 0, i1 = M - 1; while (i0 < M - 1 && S[i0] < t0) i0++; while (i1 > 0 && S[i1] > t1) i1--;
    const mark = t1 - t0 >= 15 && i1 > i0;
    if (auto && mark) { const r = rampe ? MARKE.rampe : MARKE.rand; for (const sg of [1, -1]) G.streifen(P, N, sg * (r - .1), zq(sg * (r - .1), .15), sg * (r + .1), zq(sg * (r + .1), .15), WEISS, "auf", i0, i1); }
    const strich = (an, takt) => { if (!mark) return; for (let i = i0 + 1; i <= i1; i++) { const a = P[i - 1], b = P[i], l = D[i] - D[i - 1]; if (l < .01) continue; const o = S[i - 1] - D[i - 1]; const nx = -(b[1] - a[1]) / l * .09, ny = (b[0] - a[0]) / l * .09;
      for (let k = Math.floor((D[i - 1] + o) / takt); k * takt < D[i] + o; k++) { const s0 = Math.max(D[i - 1], k * takt - o), s1 = Math.min(D[i], k * takt + an - o); if (s1 <= s0) continue;
        const at = s => { const u = (s - D[i - 1]) / l; return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u + .15]; }, A = at(s0), B = at(s1);
        G.quad([A[0] + nx, A[1] + ny, A[2]], [B[0] + nx, B[1] + ny, B[2]], [B[0] - nx, B[1] - ny, B[2]], [A[0] - nx, A[1] - ny, A[2]], WEISS, [0, 0, 1]); } } };
    if (auto && !rampe) strich(6, 18); else if (["primary", "secondary", "tertiary"].includes(art) && !einweg) strich(3, 9);
    // Trottoir mit Randstein (12 cm) beidseits, wo die Strasse durchs Siedlungsgebiet führt
    if (STADT.includes(art)) {
      const St = P.map(q => stadtBei(q)), TB = art === "minor" ? 1.6 : 2;
      for (let a = 0; a < M; a++) { if (!St[a]) continue; let b = a; while (b + 1 < M && St[b + 1]) b++;
        if (b > a) { trottoir++; for (const sg of [1, -1]) { const q0 = sg * w / 2, q1 = sg * (w / 2 + TB);
          G.streifen(P, N, q0, zq(q0, .1), q0, zq(q0, .22), STEIN_SEITE, sg, a, b);                 // Randstein (zur Fahrbahn)
          G.streifen(P, N, q0, zq(q0, .22), sg * (w / 2 + .15), zq(q0, .22), STEIN, "auf", a, b);   // Randstein oben
          G.streifen(P, N, sg * (w / 2 + .15), zq(q0, .22), q1, zq(q1, .22), TROTTOIR, "auf", a, b);
          G.streifen(P, N, q1, zq(q1, .22), q1, zq(q1, 0), STEIN_SEITE, sg, a, b); } }
        // Strassenlampen alle ~30 m auf einer Seite (Hauptstrassen)
        if (art !== "minor" && mark) for (let i = Math.max(a, i0); i <= Math.min(b, i1) && lampen.length < LAMPEN_MAX; i++) {
          if (Math.floor(S[i] / 30) === Math.floor((i > 0 ? S[i - 1] : -99) / 30)) continue;
          const q = w / 2 + TB - .45, n0 = N[i], fx = P[i][0] + n0[0] * q, fy = P[i][1] + n0[1] * q, z0 = P[i][2] + zq(q, .2)(i), h = 7;
          const ax = P[i][0] + n0[0] * (w / 2 - .6), ay = P[i][1] + n0[1] * (w / 2 - .6);
          G.balken([fx - .07 * n0[1], fy + .07 * n0[0]], [fx + .07 * n0[1], fy - .07 * n0[0]], .14, z0, z0 + h, z0, z0 + h, MAST, MAST);          // Mast
          G.balken([fx, fy], [ax, ay], .09, z0 + h - .12, z0 + h, z0 + h - .12, z0 + h, MAST, MAST);                                            // Ausleger
          G.balken([ax + n0[0] * .35, ay + n0[1] * .35], [ax - n0[0] * .25, ay - n0[1] * .25], .3, z0 + h - .3, z0 + h - .08, z0 + h - .3, z0 + h - .08, MAST, LEUCHTE);   // Leuchte
          lampen.push(ax, ay, z0 + h - .35, P[i][2] + zq(w / 2 - .6, .25)(i));
        } }
    }
    // Leitplanken an Autobahn/Autostrasse (bei getrennten Fahrbahnen ist die linke die Mittelleitplanke), nicht über Verzweigungen
    if (auto && mark) for (const sg of [1, -1]) {
      const q = sg * (w / 2 + Math.max(.4, rb - .35));
      G.streifen(P, N, q, zq(q, .48), q, zq(q, .8), METALL, sg, i0, i1);
      G.streifen(P, N, q, zq(q, .8), q + sg * .08, zq(q, .8), METALL_D, "auf", i0, i1);
      for (let i = i0; i <= i1; i++) { if (i > i0 && Math.floor(S[i] / 4) === Math.floor(S[i - 1] / 4)) continue;   // Pfosten alle 4 m
        const n0 = N[i], px = P[i][0] + n0[0] * (q + sg * .1), py = P[i][1] + n0[1] * (q + sg * .1), z0 = P[i][2] + zq(q, 0)(i);
        G.balken([px - .05 * n0[1], py + .05 * n0[0]], [px + .05 * n0[1], py - .05 * n0[0]], .1, z0, z0 + .74, z0, z0 + .74, METALL_D, METALL_D); }
    }
  }
  S3.n = n; S3.ms = Math.round(performance.now() - t0); S3.lampen = lampen.length / 4; S3.trottoir = trottoir;
  if (lampen.length) S3.lampe = new maplibregl.MercatorCoordinate(o.x + lampen[0] * ms, o.y + lampen[1] * ms).toLngLat();   // zum Prüfen
  return { G, o, lampen };
}

// polygonOffset: vor das Gelände gezogen – das gezeichnete Geländenetz ist gröber als queryTerrainElevation, sonst sägezahnartige Ränder
function ebene3d() {
  return {
    id: "strassen3d", type: "custom", renderingMode: "3d",
    onAdd(m, gl) {
      this.cam = new THREE.Camera(); this.szene = new THREE.Scene(); this.r = gemeinsamerZeichner(m, gl); this.netz = null; this.o = null;
      this.mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -40 });
      // feine Struktur im Belag (Körnung ~1 m, Flecken ~8 m, Fahrspuren etwas dunkler wäre zu viel) – fest am Ort: Lage modulo 1024 m
      this.uOff = { value: new THREE.Vector2() };
      this.mat.onBeforeCompile = sh => {
        sh.uniforms.uOff = this.uOff;
        sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nvarying vec2 vOrt;").replace("#include <begin_vertex>", "#include <begin_vertex>\nvOrt = position.xy;");
        sh.fragmentShader = sh.fragmentShader.replace("#include <common>", `#include <common>
varying vec2 vOrt; uniform vec2 uOff;
float zh(vec2 p) { p = mod(p, 1024.0); return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float zr(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(zh(i), zh(i + vec2(1, 0)), f.x), mix(zh(i + vec2(0, 1)), zh(i + vec2(1, 1)), f.x), f.y); }`)
          .replace("#include <color_fragment>", `#include <color_fragment>
{ vec2 p = vOrt + uOff; float n = zr(p * 1.3) * .5 + zr(p / 8.0) * .35 + zr(p / 40.0) * .15; diffuseColor.rgb *= .93 + .14 * n; }`);
      };
      const cv = document.createElement("canvas"); cv.width = cv.height = 32; const g2 = cv.getContext("2d"), gr = g2.createRadialGradient(16, 16, 0, 16, 16, 16);
      gr.addColorStop(0, "rgba(255,240,205,1)"); gr.addColorStop(.35, "rgba(255,222,160,.55)"); gr.addColorStop(1, "rgba(255,210,140,0)"); g2.fillStyle = gr; g2.fillRect(0, 0, 32, 32);
      const cv2 = document.createElement("canvas"); cv2.width = cv2.height = 64; const g3 = cv2.getContext("2d"), gr2 = g3.createRadialGradient(32, 32, 0, 32, 32, 32);
      gr2.addColorStop(0, "rgba(255,255,255,1)"); gr2.addColorStop(.3, "rgba(255,255,255,.45)"); gr2.addColorStop(.65, "rgba(255,255,255,.12)"); gr2.addColorStop(1, "rgba(255,255,255,0)"); g3.fillStyle = gr2; g3.fillRect(0, 0, 64, 64);
      this.kmat = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv2), color: 0x4a361f, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -10, polygonOffsetUnits: -60 });
      this.lmat = new THREE.PointsMaterial({ map: new THREE.CanvasTexture(cv), size: 5, sizeAttenuation: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 });
      this.lszene = new THREE.Scene(); this.lm = new THREE.Matrix4(); this.lpunkte = null; this.lkegel = null;
      lichtAnmelden({ aktiv: () => !!this.lpunkte && K.map.getZoom() >= Z_AB - .2, szene: this.lszene, matrix: this.lm, nacht: t => { this.lmat.opacity = Math.min(1, t * 1.4); this.kmat.opacity = Math.min(1, t * 1.2); } });
    },
    setze(e) {
      if (this.netz) { this.szene.remove(this.netz); this.netz.geometry.dispose(); this.netz = null; }
      if (this.lpunkte) { this.lszene.remove(this.lpunkte); this.lpunkte.geometry.dispose(); this.lpunkte = null; }
      if (!e || !e.G.p.length) { this.o = null; return; } this.o = e.o;
      const s = e.o.meterInMercatorCoordinateUnits(); this.uOff.value.set((e.o.x / s) % 1024, (e.o.y / s) % 1024);
      if (this.lkegel) { this.lszene.remove(this.lkegel); this.lkegel.geometry.dispose(); this.lkegel = null; }
      if (e.lampen.length) {
        const L = e.lampen, kopf = [], boden = [], uv = [];
        for (let i = 0; i < L.length; i += 4) { kopf.push(L[i], L[i + 1], L[i + 2]); const x = L[i], y = L[i + 1], z = L[i + 3], r = 7;
          for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]]) { boden.push(x + a * r, y + b * r, z); uv.push((a + 1) / 2, (b + 1) / 2); } }
        const lg = new THREE.BufferGeometry(); lg.setAttribute("position", new THREE.Float32BufferAttribute(kopf, 3)); this.lpunkte = new THREE.Points(lg, this.lmat); this.lpunkte.frustumCulled = false; this.lszene.add(this.lpunkte);
        // Lichtkegel auf der Strasse unter jeder Lampe (warm, weich auslaufend)
        const bg = new THREE.BufferGeometry(); bg.setAttribute("position", new THREE.Float32BufferAttribute(boden, 3)); bg.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
        this.lkegel = new THREE.Mesh(bg, this.kmat); this.lkegel.frustumCulled = false; this.lszene.add(this.lkegel);
      }
      const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(e.G.p, 3)); g.setAttribute("color", new THREE.Float32BufferAttribute(e.G.c, 3));
      this.netz = new THREE.Mesh(g, this.mat); this.netz.frustumCulled = false; this.szene.add(this.netz);
    },
    render(gl, args) {
      const map = K.map; if (!this.netz || !this.o || map.getZoom() < Z_AB - .2 || !map.getTerrain()) return;
      const s = this.o.meterInMercatorCoordinateUnits(), m = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix), l = new THREE.Matrix4().makeTranslation(this.o.x, this.o.y, 0).scale(new THREE.Vector3(s, s, s));
      this.lm.copy(l); this.cam.projectionMatrix = m.multiply(l); this.r.resetState(); this.r.render(this.szene, this.cam);
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
