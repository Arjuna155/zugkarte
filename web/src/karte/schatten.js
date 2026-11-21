// Echte Schatten im Umkreis ~1 km (Arjuna 20.11.: Häuser, Bäume, Brücken, Züge, Autos, Masten; weiter weg bleiben die
// weichen Flecken). Ablauf je Bild:
// 1. Schattenkarte: alle 3D-Ebenen, die sich mit schattenWerfer() gemeldet haben, werden aus Sicht der Sonne
//    (orthografisch, 2 × 1,1 km) als Tiefe in ein Bild gezeichnet (MeshDepthMaterial, RGBA-gepackt). Häuser: die Mauern
//    zeichnet MapLibre (fill-extrusion), deshalb hier eigene Klötze aus den Grundrissen von daecher.js (nur für die Karte).
// 2. Empfänger: ein Netz, das dem Gelände folgt (Gitter 128 × 128, 0,4 m über dem Boden), zeichnet nur dort dunkel,
//    wo die Schattenkarte etwas zwischen Sonne und Boden hat (weich gefiltert). Dächer und Mauern bekommen keinen Schatten.
// Aus bei Nacht, schwächer bei bedecktem Himmel, nur mit Gelände, ab Zoom 15. Ebene «schatten».
import { K } from "./karte.js";
import { ladeThree, gemeinsamerZeichner, LICHT, SCHATTEN } from "./drei.js";
import { VOR_3D, TZ } from "./tageszeit.js";
import { hausDaten } from "./daecher.js";
import { ebene } from "../ui/ebenen.js";
import { beiRuhe, istHandy } from "../util.js";

const Z_AB = 15, W = 1000, TIEFE = 2500, GITTER = 128;
const mc = ll => maplibregl.MercatorCoordinate.fromLngLat(ll);

function ebene3d() {
  return {
    id: "schatten3d", type: "custom", renderingMode: "3d",
    onAdd(m, gl) {
      this.r = gemeinsamerZeichner(m, gl); this.cam = new THREE.Camera(); this.lcam = new THREE.Camera();
      const groesse = Math.min(4096, gl.getParameter(gl.MAX_TEXTURE_SIZE));
      this.rt = new THREE.WebGLRenderTarget(groesse, groesse, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
      this.tiefe = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
      this.lvp = new THREE.Matrix4(); this.uL = { value: new THREE.Matrix4() }; this.uSt = { value: .38 }; this.uT = { value: 1 / groesse };
      this.mat = new THREE.ShaderMaterial({
        uniforms: { uKarte: { value: this.rt.texture }, uL: this.uL, uSt: this.uSt, uT: this.uT, uDbg: { value: 0 } },
        vertexShader: "uniform mat4 uL; varying vec4 vL; void main(){ vL = uL * vec4(position, 1.0); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
        fragmentShader: `#include <packing>
uniform sampler2D uKarte; uniform float uSt; uniform float uT; uniform float uDbg; varying vec4 vL;
void main(){
  vec3 p = vL.xyz * .5 + .5; if (uDbg > 2.5) { gl_FragColor = vec4(p, 1.); return; }
  if (uDbg > .5 && uDbg < 1.5) { float d0 = unpackRGBAToDepth(texture2D(uKarte, p.xy)); gl_FragColor = vec4(p.z, d0, 0., .7); return; }
  if (p.x < 0. || p.y < 0. || p.x > 1. || p.y > 1.) discard;
  float s = 0.;
  for (int i = -2; i <= 2; i++) for (int j = -2; j <= 2; j++) { float d = unpackRGBAToDepth(texture2D(uKarte, p.xy + vec2(float(i), float(j)) * uT)); s += p.z - .0004 > d ? 1. : 0.; }
  s /= 25.; if (uDbg > 1.5) { gl_FragColor = vec4(s, 0., 1. - s, .7); return; }
  float rand = 1. - smoothstep(.82, 1., max(abs(vL.x), abs(vL.y)));   // (smoothstep mit vertauschten Grenzen ist in GLSL undefiniert)   // am Rand der Schattenkarte auslaufen
  if (s * rand < .02) discard;
  gl_FragColor = vec4(.05, .07, .1, uSt * s * rand);
}`,
        transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -30,
      });
      this.boden = null; this.o = null; this.haeuser = null; this.hv = -1; this.hSzene = new THREE.Scene(); this.bSzene = new THREE.Scene();
    },
    // Empfänger-Netz um die Bildmitte, dem Gelände folgend
    bodenBauen(map) {
      const o = mc(map.getCenter()), ms = o.meterInMercatorCoordinateUnits(), n = GITTER, R = W, pos = new Float32Array((n + 1) * (n + 1) * 3), idx = [];
      let ok = 0;
      for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) { const x = -R + 2 * R * i / n, y = -R + 2 * R * j / n, e = map.queryTerrainElevation(new maplibregl.MercatorCoordinate(o.x + x * ms, o.y + y * ms).toLngLat()), k = (j * (n + 1) + i) * 3;
        pos[k] = x; pos[k + 1] = y; pos[k + 2] = e == null ? NaN : e + .4; if (e != null) ok++; }
      if (ok < (n + 1) * (n + 1) * .3) return false;
      for (let k = 2; k < pos.length; k += 3) if (isNaN(pos[k])) pos[k] = -9999;   // ohne Höhe: tief unten (unsichtbar)
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1; idx.push(a, c, b, b, c, d); }
      const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(pos, 3)); g.setIndex(idx);
      if (this.boden) { this.bSzene.remove(this.boden); this.boden.geometry.dispose(); }
      this.boden = new THREE.Mesh(g, this.mat); this.boden.frustumCulled = false; this.bSzene.add(this.boden); this.o = o; this.zoom = map.getZoom();
      return true;
    },
    // Häuser als Klötze für die Schattenkarte (Grundriss × Höhe), neu wenn daecher.js neu gebaut hat
    haeuserBauen() {
      const D = hausDaten(); if (!D.liste || !D.fertig || D.v === this.hv) return; this.hv = D.v;
      if (this.haeuser) { this.hSzene.remove(this.haeuser); this.haeuser.geometry.dispose(); this.haeuser = null; }
      const p = []; for (const b of D.liste) { if (!b.P || isNaN(b.z)) continue; const z0 = b.z - 1 + (b.H0 || 0), z1 = b.z + b.H, P = b.P.map(q => [q[0] + b.x, q[1] + b.y]);   // Grundriss relativ zur Hausmitte
        for (let i = 0; i < P.length; i++) { const a = P[i], c = P[(i + 1) % P.length]; p.push(a[0], a[1], z0, c[0], c[1], z0, c[0], c[1], z1, a[0], a[1], z0, c[0], c[1], z1, a[0], a[1], z1); }
        for (let i = 1; i + 1 < P.length; i++) p.push(P[0][0], P[0][1], z1, P[i][0], P[i][1], z1, P[i + 1][0], P[i + 1][1], z1); }   // Deckel (fächerförmig, reicht für die Tiefe)
      if (!p.length) return;
      const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(p, 3));
      this.haeuser = new THREE.Mesh(g, this.tiefe); this.haeuser.frustumCulled = false; this.hSzene.add(this.haeuser);
      this.hAnker = D.anker; this.hMs = D.ams;
    },
    render(gl, args) {
      const map = K.map; if (!SCHATTEN.an || !this.boden || !this.o || map.getZoom() < Z_AB - .2 || !map.getTerrain()) return;
      const nacht = TZ.nacht || 0, grau = K.himmelGrau ? 1 : 0, st = .48 * (1 - Math.min(1, nacht * 1.6)) * (1 - .75 * grau); if (st < .02) return;
      this.uSt.value = st; this.mat.uniforms.uDbg.value = SCHATTEN.dbg || 0; SCHATTEN.bilder = (SCHATTEN.bilder || 0) + 1;
      // Lichtkamera: Mercator, Mitte = Empfänger-Mitte, Richtung = Sonne (mindestens 12° hoch)
      const s = this.o.meterInMercatorCoordinateUnits(), [dx, dy, dz] = LICHT.dir, f = new THREE.Vector3(-dx, -dy, -dz).normalize();
      const up = Math.abs(f.z) > .99 ? new THREE.Vector3(0, -1, 0) : new THREE.Vector3(0, 0, 1), r = new THREE.Vector3().crossVectors(f, up).normalize(), u = new THREE.Vector3().crossVectors(r, f);
      // Höhe der Lichtmitte fest je Empfänger-Mitte (vorher die Bildmitte → beim Verschieben änderte sich die Lichtkamera in jedem Bild)
      if (this.ozFuer !== this.o) { this.ozFuer = this.o; this.oz = map.queryTerrainElevation(this.o.toLngLat()) || 0; }
      const c = new THREE.Vector3(this.o.x, this.o.y, this.oz * s), sx = 1 / (W * s), sz = 1 / (TIEFE * s);
      this.lvp.set(r.x * sx, r.y * sx, r.z * sx, -r.dot(c) * sx, u.x * sx, u.y * sx, u.z * sx, -u.dot(c) * sx, f.x * sz, f.y * sz, f.z * sz, -f.dot(c) * sz, 0, 0, 0, 1);
      // 1. Schattenkarte – nur neu, wenn sich Licht oder Mitte geändert haben, sonst höchstens 4×/s (fahrende Züge, Autos)
      // und nicht während die Karte bewegt wird (die Karte vom letzten Mal passt, die Lichtkamera hängt nicht an der Bildmitte)
      const jetzt = performance.now(), R = this.r, schluessel = this.lvp.elements.join(","), neuL = schluessel !== this.lvpAlt;
      if (neuL || (!map.isMoving() && jetzt - (this.kZeit || 0) > 250)) { this.lvpAlt = schluessel; this.kZeit = jetzt; SCHATTEN.karten = (SCHATTEN.karten || 0) + 1;
      R.resetState(); R.setRenderTarget(this.rt); R.setClearColor(0xffffff, 1); R.clear(true, true, false);
      const versteckt = [];
      for (const [szene, e] of SCHATTEN.werfer) {
        if (jetzt - e.t > 1000) { SCHATTEN.werfer.delete(szene); continue; }
        szene.traverse(x => { if (x.visible && (x.isPoints || x.isLine || (x.material && x.material.transparent))) { x.visible = false; versteckt.push(x); } });   // Lichtpunkte, Drähte, weiche Flecken werfen keinen Schatten
        szene.overrideMaterial = this.tiefe; this.lcam.projectionMatrix.multiplyMatrices(this.lvp, e.l); R.render(szene, this.lcam); szene.overrideMaterial = null;
      }
      for (const x of versteckt) x.visible = true;
      this.haeuserBauen();
      if (this.haeuser) { const hl = new THREE.Matrix4().makeTranslation(this.hAnker.x, this.hAnker.y, 0).scale(new THREE.Vector3(this.hMs, this.hMs, this.hMs)); this.lcam.projectionMatrix.multiplyMatrices(this.lvp, hl); R.render(this.hSzene, this.lcam); }
      R.setRenderTarget(null); R.setClearColor(0x000000, 0); gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight); R.resetState();   // Bildgrösse von MapLibre, nicht die beim Anlegen des Zeichners
      }
      // 2. Empfänger
      const l = new THREE.Matrix4().makeTranslation(this.o.x, this.o.y, 0).scale(new THREE.Vector3(s, s, s)), m = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix);
      this.uL.value.multiplyMatrices(this.lvp, l); this.cam.projectionMatrix = m.multiply(l); R.render(this.bSzene, this.cam);
      // kein eigenes Dauer-Neuzeichnen mehr (vorher alle 100 ms → die ganze Karte zeichnete auch in Ruhe 10×/s): fahrende
      // Züge und Autos fordern ihre Bilder selbst an, ihre Schatten kommen dabei mit
    },
  };
}

export function schattenStarten() {
  const map = K.map; let schicht = null, laedt = false;
  const neu = async () => {
    if (!SCHATTEN.an || map.getZoom() < Z_AB || !map.getTerrain()) return;
    if (!schicht) { if (laedt) return; laedt = true; await ladeThree(); schicht = ebene3d(); map.addLayer(schicht, VOR_3D()); SCHATTEN.schicht = schicht; }
    const c = mc(map.getCenter()), ms = c.meterInMercatorCoordinateUnits();
    if (!schicht.o || Math.hypot(c.x - schicht.o.x, c.y - schicht.o.y) / ms > W * .35 || Math.abs(map.getZoom() - schicht.zoom) > 1.5) { if (!schicht.bodenBauen(map)) setTimeout(neu, 1500); map.triggerRepaint(); }
  };
  SCHATTEN.an = !istHandy();
  ebene({ id: "schatten", name: "Schatten (nah)", an: SCHATTEN.an, setze: an => { SCHATTEN.an = an; if (!an) SCHATTEN.werfer.clear(); neu(); map.triggerRepaint(); } });
  let demT = null;   // neue Höhenkacheln: Empfänger-Netz neu, aber höchstens alle 1,5 s
  beiRuhe(map, neu); map.on("terrain", neu); map.on("sourcedata", e => { if (e.sourceId === "dem" && e.isSourceLoaded && schicht && schicht.o && !demT) demT = setTimeout(() => { demT = null; if (schicht.o) { schicht.o = null; neu(); } }, 1500); });
  window.__schatten = SCHATTEN; neu();
}
