// Ortslichter: nachts von weitem (unter Zoom 15, wo die Hausfenster noch fehlen) viele kleine, scharfe Lichtpunkte in
// den Siedlungen – wie man ein Dorf aus der Ferne sieht, ohne flächigen Schein. Punkte auf einem festen Raster (25 m, wie
// die Bäume fest im Raum, damit sie beim Verschieben nicht wechseln) in den Siedlungsflächen der Grundkarte (landuse),
// Höhe aus dem Gelände. Welche brennen, entscheidet die Uhrzeit (fensterAnteil). Gezeichnet von lichter.js.
import { K } from "./karte.js";
import { TZ } from "./tageszeit.js";
import { lichtAnmelden, fensterAnteil } from "./lichter.js";
import { istHandy, nachLaden, beiRuhe, quellMerkmale } from "../util.js";

const RASTER = 25, N_MAX = istHandy() ? 15000 : 50000, Z_BIS = 15.2, Z_AB = 9.5;
const KLASSEN = { residential: .5, suburb: .5, neighbourhood: .5, village: .45, town: .5, city: .55, commercial: .35, retail: .4, industrial: .22 };
const mc = ll => maplibregl.MercatorCoordinate.fromLngLat(ll);
let msFest = 0; const MS_FEST = () => msFest || (msFest = mc([8.23, 46.8]).meterInMercatorCoordinateUnits());
function hash(a, b, s) { let h = (a * 374761393 + b * 668265263 + s * 2147483647) | 0; h = (h ^ (h >>> 13)) * 1274126177 | 0; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
export const OL = { n: 0, fertig: 0 };
let quelle = null, liste = null, anker = null, ams = 1, version = 0, hEx = -1;

function bauen() {
  const map = K.map, z = map.getZoom(); liste = null; OL.n = 0; version++;
  if (!(TZ.nacht > .02) || z < Z_AB || z >= Z_BIS) return;
  if (!quelle) for (const l of map.getStyle().layers) if (l["source-layer"] === "landuse") { quelle = l.source; break; } if (!quelle) return;
  const b = map.getBounds(), dx = (b.getEast() - b.getWest()) * .15, dy = (b.getNorth() - b.getSouth()) * .15;
  const A = mc([b.getWest() - dx, b.getNorth() + dy]), Bm = mc([b.getEast() + dx, b.getSouth() - dy]), o = mc(map.getCenter()), ms = o.meterInMercatorCoordinateUnits();
  // herausgezoomt nur jede n-te Zelle (fester Teil: Zufallswert der Zelle), damit es nicht zu viele werden
  const anteil = z >= 13.5 ? 1 : z >= 12 ? .5 : z >= 11 ? .25 : .12;
  const zelle = RASTER * MS_FEST(), kand = [], gesehen = new Set();
  for (const f of quellMerkmale(map, quelle, "landuse")) {
    const dichte = KLASSEN[f.properties.class]; if (!dichte) continue; const g = f.geometry;
    for (const poly of g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : []) {
      const ringe = poly.map(r => r.map(q => { const m = mc(q); return [m.x, m.y]; }));
      let y0 = Infinity, y1 = -Infinity; for (const r of ringe[0]) { y0 = Math.min(y0, r[1]); y1 = Math.max(y1, r[1]); }
      for (let iy = Math.floor(Math.max(y0, A.y) / zelle); iy * zelle <= Math.min(y1, Bm.y); iy++) {
        const yc = (iy + .5) * zelle, xs = [];
        for (const r of ringe) for (let k = 0, n = r.length; k < n; k++) { const P = r[k], Q = r[(k + 1) % n]; if ((P[1] <= yc) !== (Q[1] <= yc)) xs.push(P[0] + (yc - P[1]) / (Q[1] - P[1]) * (Q[0] - P[0])); }
        xs.sort((p, q) => p - q);
        for (let k = 0; k + 1 < xs.length; k += 2) for (let ix = Math.ceil(Math.max(xs[k], A.x) / zelle - .5); (ix + .5) * zelle <= Math.min(xs[k + 1], Bm.x); ix++) {
          const h = hash(ix, iy, 7); if (h >= dichte * anteil) continue;
          const key = ix + "," + iy; if (gesehen.has(key)) continue; gesehen.add(key);
          kand.push({ mx: (ix + .2 + .6 * hash(ix, iy, 8)) * zelle, my: (iy + .2 + .6 * hash(ix, iy, 9)) * zelle, h: h / dichte, r: hash(ix, iy, 10), c: hash(ix, iy, 11) });
        }
      }
    }
  }
  if (kand.length > N_MAX) { kand.sort((a, b) => a.h - b.h); kand.length = N_MAX; }   // Auswahl nur nach dem festen Zufall
  anker = o; ams = ms; liste = kand.map(k => ({ x: (k.mx - o.x) / ms, y: (k.my - o.y) / ms, z: NaN, r: k.r, c: k.c, ll: null, mx: k.mx, my: k.my }));
  OL.n = liste.length; OL.fertig = 0; hEx = -1;
}
// Geländehöhe in Portionen (≤ 4 ms pro Bild)
function hoehen() {
  if (!liste) return false; const map = K.map, T = map.getTerrain(), ex = T ? T.exaggeration || 1 : 0;
  if (ex !== hEx) { hEx = ex; OL.fertig = 0; } if (OL.fertig >= liste.length) return false;
  const bis = performance.now() + 4;
  while (OL.fertig < liste.length && performance.now() < bis) for (let k = 0; k < 100 && OL.fertig < liste.length; k++) {
    const p = liste[OL.fertig++]; if (!ex) { p.z = 0; continue; }
    const e = map.queryTerrainElevation(new maplibregl.MercatorCoordinate(p.mx, p.my).toLngLat()); p.z = e === null || e === undefined ? NaN : e;
  }
  return true;
}

export function ortslichterStarten() {
  const map = K.map, szene = new THREE.Scene(), matrix = new THREE.Matrix4();
  const FARBEN = ["#ffd38a", "#ffe2a6", "#ffc773", "#fff0d0", "#ffdb99"].map(c => new THREE.Color(c));
  const mat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, vertexColors: true,
    uniforms: { uNacht: { value: 0 }, uAnteil: { value: .4 }, uGr: { value: 2 } },
    vertexShader: "attribute float rnd; varying float vR; varying vec3 vC; uniform float uGr; void main(){ vR = rnd; vC = color; gl_PointSize = uGr * (0.7 + 0.6 * fract(rnd * 7.31)); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: "uniform float uNacht; uniform float uAnteil; varying float vR; varying vec3 vC; void main(){ if (vR > uAnteil) discard; vec2 d = gl_PointCoord - 0.5; float a = smoothstep(0.5, 0.15, length(d)); gl_FragColor = vec4(vC * a * uNacht, a * uNacht); }" });
  let pkt = null, v = -1, f = -1;
  lichtAnmelden({
    aktiv: () => {
      const z = map.getZoom(); if (!liste || z >= Z_BIS || z < Z_AB) return false;
      const neu = hoehen();
      if (v !== version || (f !== OL.fertig && (OL.fertig === OL.n || OL.fertig - f > OL.n / 4))) {
        v = version; f = OL.fertig; const pos = [], col = [], rnd = [];
        for (let i = 0; i < OL.fertig; i++) { const p = liste[i]; if (isNaN(p.z)) continue; pos.push(p.x, p.y, p.z + 5); const C = FARBEN[Math.floor(p.c * FARBEN.length)]; col.push(C.r, C.g, C.b); rnd.push(p.r * .9); }
        if (pkt) { szene.remove(pkt); pkt.geometry.dispose(); pkt = null; }
        if (pos.length) { const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3)); g.setAttribute("rnd", new THREE.Float32BufferAttribute(rnd, 1));
          pkt = new THREE.Points(g, mat); pkt.frustumCulled = false; szene.add(pkt); }
      }
      if (neu) map.triggerRepaint();
      if (!pkt) return false;
      matrix.makeTranslation(anker.x, anker.y, 0).scale(new THREE.Vector3(ams, ams, ams));
      return true;
    },
    szene, matrix,
    nacht: n => { const z = map.getZoom(), aus = Math.max(0, Math.min(1, (Z_BIS - z) / .6));   // vor Zoom 15 sanft ausblenden (dann übernehmen die Fenster)
      mat.uniforms.uNacht.value = n * aus; mat.uniforms.uAnteil.value = Math.min(.9, fensterAnteil() * 1.6); mat.uniforms.uGr.value = (istHandy() ? 1.6 : 2) * (z < 11 ? 1.4 : z < 13 ? 1.7 : 2.1) * Math.min(devicePixelRatio || 1, 2); },
  });
  const neu = () => nachLaden(map, "ortslichter", bauen, 400, 8);
  beiRuhe(map, neu); map.on("sourcedata", e => { if (quelle && e.sourceId === quelle && e.isSourceLoaded && TZ.nacht > .02) neu(); });
  let warNacht = false; setInterval(() => { const n = TZ.nacht > .02; if (n !== warNacht) { warNacht = n; neu(); } }, 20000);
  window.__ol = OL; neu();
}
