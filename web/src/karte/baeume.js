// Bäume in 3D: Wald, lichter Wald, Gebüsch und Obstgärten aus der Landbedeckung der Grundkarte (landcover) werden beim
// Hineinzoomen (ab Zoom ZB) mit einzelnen Bäumen bepflanzt. Raster fest im Raum (7 m, je Zelle ein Baum an zufälliger,
// aber fester Stelle) – weiter weg / weiter draussen eine feste Teilmenge davon, so springen beim Zoomen keine Bäume.
// Nadel- oder Laubbaum nach Höhe über Meer. Gezeichnet mit two InstancedMesh (three.js), Höhen in Portionen pro Bild.
import { K } from "./karte.js";
import { ladeThree, szeneMitLicht } from "./drei.js";
import { ebene } from "../ui/ebenen.js";
import { istHandy } from "../util.js";

export const ZB = 14;
const RASTER = 7, N_MAX = istHandy() ? 12000 : 40000;
export const BA = { an: true, n: 0, fertig: 0, liste: null };
const mc = ll => maplibregl.MercatorCoordinate.fromLngLat(ll);
let msFest = 0; const MS_FEST = () => msFest || (msFest = mc([8.23, 46.8]).meterInMercatorCoordinateUnits());
let quelle = null, anker = null, ams = 1, bauZoom = 0, version = 0, hEx = -1;

function quelleSuchen(map) { for (const l of map.getStyle().layers) if (l["source-layer"] === "landcover") return l.source; for (const l of map.getStyle().layers) if (l["source-layer"] === "transportation") return l.source; return null; }
// fester Zufall je Rasterzelle (0 … 1)
function hash(a, b, s) { let h = (a * 374761393 + b * 668265263 + s * 2147483647) | 0; h = (h ^ (h >>> 13)) * 1274126177 | 0; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
// Art je Landbedeckung: Anteil der Zellen, Grösse, Gebüsch/Obst
function art(p) {
  const s = p.subclass, c = p.class;
  if (s === "forest" || s === "wood" || c === "wood") return { dichte: 1, typ: "wald" };
  if (s === "loose_forest") return { dichte: .35, typ: "wald" };
  if (s === "scrub" || s === "woody_plant") return { dichte: .5, typ: "busch" };
  if (s === "orchard") return { dichte: .22, typ: "obst" };
  if (s === "park" || s === "recreation_ground") return { dichte: .06, typ: "laub" };
  return null;
}
function bauen() {
  const map = K.map; if (!BA.an || !map || map.getZoom() < ZB) { BA.liste = null; BA.n = 0; return; }
  if (!quelle) quelle = quelleSuchen(map); if (!quelle) return;
  const z = map.getZoom(), c = map.getCenter(), o = mc(c), ms = o.meterInMercatorCoordinateUnits();
  // Umkreis (m) und Anteil nach Zoom: nah alles, weiter draussen eine feste Teilmenge
  const R = z >= 16 ? 1300 : z >= 15 ? 2200 : 3200, anteil = z >= 16 ? 1 : z >= 15 ? .55 : .28;
  // Raster fest im Raum: Zellgrösse aus einem festen Bezugspunkt (Mitte der Schweiz), nicht aus der Bildmitte – sonst
  // verschiebt sich das Raster beim Verschieben der Karte und jede Zelle bekäme einen anderen Baum
  const zelle = RASTER * MS_FEST(), kand = [], gesehen = new Set();
  for (const f of map.querySourceFeatures(quelle, { sourceLayer: "landcover" })) {
    const a = art(f.properties); if (!a) continue; const g = f.geometry;
    const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
    for (const poly of polys) {
      // Ringe in Mercator; Zeilen-Füllung (gerade/ungerade, Löcher inklusive)
      const ringe = poly.map(r => r.map(q => { const m = mc(q); return [m.x, m.y]; }));
      let y0 = Infinity, y1 = -Infinity, x0 = Infinity, x1 = -Infinity; for (const r of ringe[0]) { y0 = Math.min(y0, r[1]); y1 = Math.max(y1, r[1]); x0 = Math.min(x0, r[0]); x1 = Math.max(x1, r[0]); }
      if (x1 < o.x - R * ms || x0 > o.x + R * ms || y1 < o.y - R * ms || y0 > o.y + R * ms) continue;
      for (let iy = Math.floor(Math.max(y0, o.y - R * ms) / zelle); iy * zelle <= Math.min(y1, o.y + R * ms); iy++) {
        const yc = (iy + .5) * zelle, xs = [];
        for (const r of ringe) for (let k = 0, n = r.length; k < n; k++) { const A = r[k], Bq = r[(k + 1) % n]; if ((A[1] <= yc) !== (Bq[1] <= yc)) xs.push(A[0] + (yc - A[1]) / (Bq[1] - A[1]) * (Bq[0] - A[0])); }
        xs.sort((p, q) => p - q);
        for (let k = 0; k + 1 < xs.length; k += 2) for (let ix = Math.ceil(Math.max(xs[k], o.x - R * ms) / zelle - .5); (ix + .5) * zelle <= Math.min(xs[k + 1], o.x + R * ms); ix++) {
          const h = hash(ix, iy, 1); if (h >= a.dichte * anteil) continue;
          const key = ix + "," + iy; if (gesehen.has(key)) continue; gesehen.add(key);
          const mx = (ix + .15 + .7 * hash(ix, iy, 2)) * zelle, my = (iy + .15 + .7 * hash(ix, iy, 3)) * zelle, d = Math.hypot(mx - o.x, my - o.y) / ms; if (d > R) continue;
          kand.push({ mx, my, h: h / a.dichte, d, typ: a.typ, r: hash(ix, iy, 4), g: hash(ix, iy, 5) });
        }
      }
    }
  }
  // zu viele: nur nach dem festen Zufall der Zelle auswählen (nicht nach der Lage zur Bildmitte) – so bleibt beim
  // Verschieben jeder Baum, der vorher stand, auch stehen
  if (kand.length > N_MAX) { kand.sort((a, b) => a.h - b.h); kand.length = N_MAX; }
  anker = o; ams = ms; bauZoom = z; version++;
  BA.liste = kand.map(k => ({ ...k, x: (k.mx - o.x) / ms, y: (k.my - o.y) / ms, z: NaN })); BA.n = BA.liste.length; BA.fertig = 0; hEx = -1;
}
// Geländehöhe in Portionen (≤ 5 ms pro Bild); Nadelbaum-Anteil nach Höhe
function hoehen() {
  const L = BA.liste, map = K.map; if (!L) return false; const T = map.getTerrain(), ex = T ? T.exaggeration || 1 : 0;
  if (ex !== hEx) { hEx = ex; BA.fertig = 0; }
  if (BA.fertig >= L.length) return false;
  const bis = performance.now() + 5;
  while (BA.fertig < L.length && performance.now() < bis) {
    for (let n = 0; n < 200 && BA.fertig < L.length; n++) {
      const b = L[BA.fertig++], ll = new maplibregl.MercatorCoordinate(b.mx, b.my).toLngLat();
      const e = ex ? map.queryTerrainElevation(ll) : 0; b.z = e === null || e === undefined ? NaN : e;
      const meer = ex ? b.z / ex : 600, nadel = Math.max(.38, Math.min(.92, .38 + (meer - 600) / 1600));
      b.nadel = b.typ === "wald" ? b.g < nadel : false;
    }
  }
  return true;
}
// Geometrie (z nach oben, Höhe 1, Fuss bei 0) mit Farbe je Ecke
function geo(teile) {
  const p = [], n = [], c = [];
  for (const [g, farbe] of teile) { const q = g.index ? g.toNonIndexed() : g, P = q.attributes.position.array, N = q.attributes.normal.array, C = new THREE.Color(farbe); for (let i = 0; i < P.length; i += 3) { p.push(P[i], P[i + 1], P[i + 2]); n.push(N[i], N[i + 1], N[i + 2]); c.push(C.r, C.g, C.b); } }
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(p, 3)); g.setAttribute("normal", new THREE.Float32BufferAttribute(n, 3)); g.setAttribute("color", new THREE.Float32BufferAttribute(c, 3)); return g;
}
const hoch = (g, z) => { g.rotateX(Math.PI / 2); g.translate(0, 0, z); return g; };
function nadelGeo() { return geo([[hoch(new THREE.CylinderGeometry(.035, .045, .2, 5), .1), "#5a4532"], [hoch(new THREE.ConeGeometry(.3, .55, 7), .4), "#2f5a35"], [hoch(new THREE.ConeGeometry(.23, .45, 7), .68), "#335f39"], [hoch(new THREE.ConeGeometry(.15, .3, 6), .86), "#386640"]]); }
function laubGeo() { const k = new THREE.IcosahedronGeometry(.36, 1); k.scale(1, 1, .85); return geo([[hoch(new THREE.CylinderGeometry(.04, .05, .42, 5), .21), "#5e4a36"], [hoch(k, .62), "#4f7a3a"]]); }

function schicht() {
  return {
    id: "baeume3d", type: "custom", renderingMode: "3d",
    onAdd(m, gl) {
      this.cam = new THREE.Camera(); this.szene = szeneMitLicht();
      this.r = new THREE.WebGLRenderer({ canvas: m.getCanvas(), context: gl, antialias: true }); this.r.autoClear = false;
      const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
      this.nadel = new THREE.InstancedMesh(nadelGeo(), mat, N_MAX); this.laub = new THREE.InstancedMesh(laubGeo(), mat, N_MAX);
      for (const x of [this.nadel, this.laub]) { x.frustumCulled = false; x.count = 0; x.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(N_MAX * 3).fill(1), 3); this.szene.add(x); }
      this.M = new THREE.Matrix4(); this.Q = new THREE.Quaternion(); this.V = new THREE.Vector3(); this.S = new THREE.Vector3(); this.Z = new THREE.Vector3(0, 0, 1); this.C = new THREE.Color(); this.v = -1; this.f = -1;
    },
    render(gl, args) {
      const map = K.map;
      if (!BA.an || !BA.liste || map.getZoom() < ZB - .3) return;
      const neu = hoehen();
      if (neu || this.v !== version || this.f !== BA.fertig) {
        this.v = version; this.f = BA.fertig; let nn = 0, nl = 0;
        for (let i = 0; i < BA.fertig; i++) {
          const b = BA.liste[i]; if (isNaN(b.z)) continue;
          const busch = b.typ === "busch", obst = b.typ === "obst";
          const H = busch ? 2.5 + 2.5 * b.r : obst ? 6 + 3 * b.r : b.nadel ? 18 + 14 * b.r : 14 + 10 * b.r, W = busch ? H * 1.3 : obst ? H * 1.1 : b.nadel ? H * .55 : H * .8;
          const ziel = b.nadel ? this.nadel : this.laub, k = b.nadel ? nn++ : nl++;
          this.Q.setFromAxisAngle(this.Z, b.g * 6.283); this.V.set(b.x, b.y, b.z - .3); this.S.set(W, W, H); this.M.compose(this.V, this.Q, this.S); ziel.setMatrixAt(k, this.M);
          const t = .82 + .3 * ((b.r * 7.3) % 1); this.C.setRGB(t * (obst ? 1.05 : 1), t * (busch ? 1.05 : 1), t * .95); ziel.setColorAt(k, this.C);
        }
        this.nadel.count = nn; this.laub.count = nl; for (const x of [this.nadel, this.laub]) { x.instanceMatrix.needsUpdate = true; x.instanceColor.needsUpdate = true; }
      }
      const mm = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix), lm = new THREE.Matrix4().makeTranslation(anker.x, anker.y, 0).scale(new THREE.Vector3(ams, ams, ams));
      this.cam.projectionMatrix = mm.multiply(lm); this.r.resetState(); this.r.render(this.szene, this.cam);
      if (neu) map.triggerRepaint();
    },
  };
}
export function baeumeStarten() {
  const map = K.map; let geladen = false, t = 0;
  const neu = () => { clearTimeout(t); t = setTimeout(() => { bauen(); map.triggerRepaint(); }, 400); };
  const laden = () => { if (geladen || map.getZoom() < ZB - .5) return; geladen = true; ladeThree().then(() => { try { map.addLayer(schicht(), map.getLayer("fz") ? "fz" : undefined); } catch (e) { console.error(e); } neu(); }); };
  map.on("moveend", () => { laden(); neu(); });
  map.on("sourcedata", e => { if (quelle && e.sourceId === quelle && e.isSourceLoaded && map.getZoom() >= ZB) neu(); });
  ebene({ id: "baeume", name: "Bäume (3D, beim Hineinzoomen)", an: true, setze: an => { BA.an = an; if (an) { laden(); neu(); } else { BA.liste = null; } map.triggerRepaint(); } });
  laden();
}
