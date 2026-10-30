// Lebendiges Wasser: Seen (und breite Flüsse als Flächen) der Grundkarte als 3D-Flächen auf Seehöhe, mit einem Shader:
// ziehende Wellen aus mehreren Richtungen, Spiegelung des Himmels (Fresnel: flach betrachtet mehr Himmel), Sonnenglanz.
// Nah kräftige Wellen, in der Ferne glatt (kein Flimmern). Ab Zoom ZW, Flächen neu nach jedem Verschieben.
// Bewegung mit höchstens 30 Bildern/s (Handy 15), nur wenn Wasser im Bild ist.
import { K } from "./karte.js";
import { ladeThree } from "./drei.js";
import { ebene } from "../ui/ebenen.js";
import { istHandy } from "../util.js";

export const ZW = 10;
export const WA = { an: true, flaechen: 0, dreiecke: 0 };
const mc = ll => maplibregl.MercatorCoordinate.fromLngLat(ll);
const RUND = [[0, 0]]; for (const d of [25, 50]) for (let k = 0; k < 8; k++) RUND.push([d, k * Math.PI / 4]);   // Umkreis für den Wasserspiegel
let fehlt = false;   // Gelände noch nicht überall geladen → neu, sobald es da ist
let quelle = null, anker = null, ams = 1, version = 0, daten = null, start = null;   // start: fester Bezugspunkt der Wellen (bleiben beim Verschieben stehen)

function quelleSuchen(map) { for (const l of map.getStyle().layers) if (l["source-layer"] === "water") return l.source; return null; }
function bauen() {
  const map = K.map; if (!WA.an || map.getZoom() < ZW) { daten = null; version++; return; }
  if (!quelle) quelle = quelleSuchen(map); if (!quelle) return;
  const o = mc(map.getCenter()), ms = o.meterInMercatorCoordinateUnits(), T = map.getTerrain(), ex = T ? T.exaggeration || 1 : 0;
  const pos = [], gesehen = new Set(); let fl = 0; fehlt = false;
  for (const f of map.querySourceFeatures(quelle, { sourceLayer: "water" })) {
    const g = f.geometry, polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
    for (const poly of polys) {
      if (!poly[0] || poly[0].length < 4) continue;
      const sig = poly[0].length + ":" + poly[0][0][0].toFixed(6) + ":" + poly[0][0][1].toFixed(6); if (gesehen.has(sig)) continue; gesehen.add(sig);   // gleiche Fläche aus mehreren Kacheln
      const ringe = poly.map(r => r.slice(0, -1).map(q => { const m = mc(q); return new THREE.Vector2((m.x - o.x) / ms, (m.y - o.y) / ms); }));
      // Wasserhöhe je Randpunkt: tiefster Geländewert im Umkreis von 50 m (am Ufer selbst mischt das Höhenmodell die Böschung
      // hinein; so liegen beide Ufer eines Flusses gleich hoch, Flüsse fallen trotzdem talwärts). Lange Ufer: nur jeden n-ten
      // Punkt, dazwischen linear; fehlende Werte (Gelände noch nicht geladen) vom nächsten bekannten Punkt – später neu.
      let tri; try { tri = THREE.ShapeUtils.triangulateShape(ringe[0], ringe.slice(1)); } catch (e) { continue; }
      const tief = q => { const kl = Math.cos(q[1] * Math.PI / 180) * 111320; let m = NaN;
        for (const [d, w] of RUND) { const e = map.queryTerrainElevation([q[0] + Math.cos(w) * d / kl, q[1] + Math.sin(w) * d / 111320]); if (e !== null && e !== undefined && !(e >= m)) m = e; }
        return m; };
      const hz = poly.map(r => { const n = r.length - 1, z = new Float32Array(Math.max(n, 1)); if (!ex) return z;
        const sch = Math.max(1, Math.ceil(n / 200)), stuetz = [];
        for (let i = 0; i < n; i += sch) stuetz.push([i, tief(r[i])]);
        let gut = stuetz.findIndex(q => !isNaN(q[1])); if (gut < 0) { fehlt = true; return null; }
        for (let k = 1; k <= stuetz.length; k++) { const q = stuetz[(gut + k) % stuetz.length]; if (isNaN(q[1])) { q[1] = stuetz[(gut + k - 1) % stuetz.length][1]; fehlt = true; } }
        for (let k = 0; k < stuetz.length; k++) { const [i0, e0] = stuetz[k], [i1, e1] = stuetz[(k + 1) % stuetz.length], L = ((i1 - i0 + n) % n) || n; for (let j = 0; j < L && i0 + j < n; j++) z[i0 + j] = e0 + (e1 - e0) * j / L; }
        return z; });
      if (hz.some(z => !z)) continue;
      const alle = ringe.flat(), alleZ = hz.flatMap(z => Array.from(z));
      for (const [a, b, c] of tri) for (const i of [a, b, c]) pos.push(alle[i].x, alle[i].y, alleZ[i] || 0);
      fl++;
    }
  }
  if (!start) start = o; anker = o; ams = ms; daten = new Float32Array(pos); version++; WA.flaechen = fl; WA.dreiecke = pos.length / 9;
}

const VS = `varying vec3 vPos; void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const FS = `precision highp float;
varying vec3 vPos; uniform vec3 uCam; uniform float uT; uniform vec3 uSonne; uniform vec3 uTief; uniform vec3 uHimmel; uniform vec3 uHorizont; uniform vec2 uAnker;
// Wellen: Summe gerichteter Sinuswellen; liefert die Neigung (dh/dx, dh/dy)
float px;   // Meter pro Bildpunkt an dieser Stelle
vec2 welle(vec2 p, vec2 d, float l, float a, float s){ float k = 6.2831 / l, ph = dot(d, p) * k + uT * s * k; return d * a * k * cos(ph) * (1.0 - smoothstep(l * .1, l * .3, px)); }   // kürzer als ~4 Bildpunkte: ausblenden (kein Flimmern)
void main(){
  vec2 p = vPos.xy + uAnker; float dist = length(uCam - vPos); px = length(fwidth(vPos.xy));
  float nah = clamp(1.0 - dist / 2500.0, 0.0, 1.0);                       // Wellen nur nah, in der Ferne glatt
  vec2 g = vec2(0.0);
  g += welle(p, normalize(vec2(1.0, .3)), 23.0, .16, 1.6);
  g += welle(p, normalize(vec2(.6, -1.0)), 11.0, .11, 1.1);
  g += welle(p, normalize(vec2(-1.0, .7)), 5.3, .05, .8);
  g += welle(p, normalize(vec2(.2, 1.0)), 2.7, .025, .55);
  g += welle(p, normalize(vec2(-.8, -.45)), 7.9, .06, .95);
  g += welle(p, normalize(vec2(.95, -.25)), 3.9, .03, .7);
  g += welle(p + vec2(13.0 * sin(p.y * .021), 0.0), normalize(vec2(.1, -1.0)), 17.0, .12, 1.3);
  g *= .9 * nah;
  vec3 n = normalize(vec3(-g, 1.0));
  vec3 v = normalize(uCam - vPos);
  float fres = .04 + .96 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
  vec3 r = reflect(-v, n);
  vec3 himmel = mix(uHorizont, uHimmel, clamp(r.z * 2.5, 0.0, 1.0));
  vec3 farbe = mix(uTief, himmel, clamp(fres * .85 + .08, 0.0, 1.0));
  float fein = 1.0 - smoothstep(.27, .81, px);   // sind die kleinen Wellen noch sichtbar?
  float sd = max(dot(r, uSonne), 0.0), glanz = pow(sd, 220.0) * (.5 + 1.4 * nah) * fein + pow(sd, 40.0) * .22 * (1.0 - fein);   // nah scharf glitzernd, fern mattes Band
  farbe += vec3(1.0, .97, .88) * glanz;
  gl_FragColor = vec4(farbe, .93);
  #include <colorspace_fragment>
}`;

function schicht() {
  return {
    id: "wasser3d", type: "custom", renderingMode: "3d",
    onAdd(m, gl) {
      this.cam = new THREE.Camera(); this.szene = new THREE.Scene();
      this.r = new THREE.WebGLRenderer({ canvas: m.getCanvas(), context: gl, antialias: true }); this.r.autoClear = false;
      const sonne = new THREE.Vector3(-.35, .7, .55).normalize();   // Sonne im Südwesten (y zeigt nach Süden)
      this.mat = new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, transparent: true, depthWrite: false, side: THREE.DoubleSide,
        uniforms: { uCam: { value: new THREE.Vector3() }, uT: { value: 0 }, uSonne: { value: sonne }, uAnker: { value: new THREE.Vector2() },
          uTief: { value: new THREE.Color("#2c5f7c") }, uHimmel: { value: new THREE.Color("#8fb9dc") }, uHorizont: { value: new THREE.Color("#dde8ee") } } });
      this.netz = null; this.v = -1; this.I = new THREE.Matrix4(); this.C = new THREE.Vector4(); this.t0 = performance.now(); this.naechstes = 0;
    },
    render(gl, args) {
      const map = K.map;
      if (this.v !== version) {
        this.v = version; if (this.netz) { this.szene.remove(this.netz); this.netz.geometry.dispose(); this.netz = null; }
        if (daten && daten.length) { const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(daten, 3)); this.netz = new THREE.Mesh(g, this.mat); this.netz.frustumCulled = false; this.szene.add(this.netz); }
      }
      if (!this.netz || !WA.an || map.getZoom() < ZW) return;
      const mm = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix), lm = new THREE.Matrix4().makeTranslation(anker.x, anker.y, 0).scale(new THREE.Vector3(ams, ams, ams));
      this.cam.projectionMatrix = mm.multiply(lm);
      // Kamera in lokalen Metern: der Punkt, dessen Bild w = 0 hat (Nullrichtung der Projektion)
      this.I.copy(this.cam.projectionMatrix).invert(); this.C.set(0, 0, 1, 0).applyMatrix4(this.I);
      const U = this.mat.uniforms; if (Math.abs(this.C.w) > 1e-12) U.uCam.value.set(this.C.x / this.C.w, this.C.y / this.C.w, this.C.z / this.C.w);
      U.uT.value = (performance.now() - this.t0) / 1000; U.uAnker.value.set((anker.x - start.x) / ams, (anker.y - start.y) / ams);   // Wellen fest im Raum
      const hb = 1 + 156543 * Math.cos(map.getCenter().lat * Math.PI / 180) / 2 ** map.getZoom() * .25;   // knapp über dem Gelände (Seefläche im Höhenmodell)
      this.netz.position.z = hb;
      this.r.resetState(); this.r.render(this.szene, this.cam);
      // nur weiterlaufen, wenn nah genug für sichtbare Wellen (sonst steht das Bild still und spart Strom)
      const jetzt = performance.now(); if (map.getZoom() >= 12.5 && jetzt >= this.naechstes) { this.naechstes = jetzt + (istHandy() ? 66 : 33); setTimeout(() => map.triggerRepaint(), istHandy() ? 66 : 33); }
    },
  };
}
export function wasserStarten() {
  const map = K.map; let geladen = false, t = 0;
  const neu = () => { clearTimeout(t); t = setTimeout(() => { bauen(); map.triggerRepaint(); }, 350); };
  const laden = () => { if (geladen || map.getZoom() < ZW - .5) return; geladen = true; ladeThree().then(() => { try { map.addLayer(schicht(), map.getLayer("fz") ? "fz" : undefined); } catch (e) { console.error(e); } neu(); }); };
  map.on("moveend", () => { laden(); neu(); });
  map.on("sourcedata", e => { if (quelle && e.sourceId === quelle && e.isSourceLoaded && map.getZoom() >= ZW) neu(); });
  map.on("terrain", neu);
  map.on("sourcedata", e => { if (fehlt && e.sourceId === "dem" && e.isSourceLoaded) neu(); });   // Gelände nachgeladen
  ebene({ id: "wasser", name: "Wasser (Wellen und Glanz)", an: true, setze: an => { WA.an = an; if (an) { laden(); neu(); } map.triggerRepaint(); } });
  laden();
}
