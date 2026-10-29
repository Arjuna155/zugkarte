// Wetter als Animation (three.js-Ebene «wetter3d», bei jedem Zoom):
// – Regen (Striche) und Schnee (Flocken) fallen nur dort, wo das Wetterfeld Niederschlag hat; Wind treibt sie schräg.
//   Die Tropfen entstehen an zufälligen Bildpunkten (gleich dicht auf dem Bildschirm), Fallhöhe und Tempo passen sich
//   dem Massstab an, damit es herausgezoomt wie hineingezoomt nach Regen aussieht.
// – Nebel als Nebelmeer: Fläche auf der Nebelobergrenze mit ziehenden Schwaden; das Gelände ragt hindurch.
// – Regenwolken als graue Schwaden über den Regengebieten.
import { K } from "./karte.js";
import { ladeThree } from "./drei.js";
import { WE, feldBei, tempBei } from "./wetter.js";
import { istHandy } from "../util.js";

const mc = ll => maplibregl.MercatorCoordinate.fromLngLat(ll);
let gestartet = false;
export function wetter3dStarten() {
  if (gestartet) return; gestartet = true;
  ladeThree().then(() => { try { K.map.addLayer(ebene(), K.map.getLayer("fz") ? "fz" : undefined); } catch (e) { console.error(e); } });
}
// Kameralage aus Zoom, Neigung und Drehung (Sichtfeld wie MapLibre, ~37°)
function kamera(map) {
  const c = map.getCenter(), mpp = 40075016 * Math.cos(c.lat * Math.PI / 180) / (512 * 2 ** map.getZoom()), D = map.getCanvas().clientHeight / 2 / Math.tan(.3218) * mpp;
  const pi = map.getPitch() * Math.PI / 180; return { mpp, abst: D * Math.sin(pi), hoch: D * Math.cos(pi), breite: map.getCanvas().clientWidth * mpp };
}

const NEBEL_VS = `attribute float a; varying float vA; varying vec2 vW; uniform vec2 uOff;
void main(){ vA=a; vW=position.xy+uOff; gl_Position=projectionMatrix*vec4(position,1.0); }`;
const NEBEL_FS = `precision highp float; varying float vA; varying vec2 vW; uniform float uZeit, uSkala, uDeck; uniform vec3 uFarbe; uniform vec2 uWind;
float h(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
float n(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f); return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y); }
float fbm(vec2 p){ float s=0.0, a=.5; for(int k=0;k<5;k++){ s+=a*n(p); p=p*2.03+vec2(17.0,9.0); a*=.5; } return s; }
void main(){ vec2 p=vW*uSkala - uWind*uZeit; float m=fbm(p) * .65 + fbm(p*.37 + vec2(uZeit*.013, -uZeit*.009)) * .55;
  float d=smoothstep(.15,.95, vA*1.15) * clamp(uDeck + (m-.55)*1.6, 0.0, 1.0);
  if(d<.01) discard; gl_FragColor=vec4(uFarbe*(.92+.12*m), d); }`;

function ebene() {
  const N_MAX = istHandy() ? 3500 : 9000;
  return {
    id: "wetter3d", type: "custom", renderingMode: "3d",
    onAdd(m, gl) {
      this.cam = new THREE.Camera(); this.szene = new THREE.Scene();
      this.r = new THREE.WebGLRenderer({ canvas: m.getCanvas(), context: gl, antialias: true }); this.r.autoClear = false;
      // Regen: Striche mit Verlauf (oben durchsichtig), Schnee: Punkte
      this.rp = new Float32Array(N_MAX * 6); this.rc = new Float32Array(N_MAX * 8);
      this.rgeo = new THREE.BufferGeometry(); this.rgeo.setAttribute("position", new THREE.BufferAttribute(this.rp, 3)); this.rgeo.setAttribute("color", new THREE.BufferAttribute(this.rc, 4));
      this.regen = new THREE.LineSegments(this.rgeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
      this.sp = new Float32Array(N_MAX * 3); this.sgeo = new THREE.BufferGeometry(); this.sgeo.setAttribute("position", new THREE.BufferAttribute(this.sp, 3));
      this.schnee = new THREE.Points(this.sgeo, new THREE.PointsMaterial({ color: 0xffffff, size: 3, sizeAttenuation: false, transparent: true, opacity: .95, depthWrite: false }));
      this.regen.frustumCulled = this.schnee.frustumCulled = false; this.regen.renderOrder = this.schnee.renderOrder = 10;   // über den Wolken zeichnen (sonst sieht man von oben keinen Regen)
      this.szene.add(this.regen, this.schnee);
      // Teilchen: Lage (Mercator), Boden, Höhe, Tempo, Alter, Art
      this.T = { x: new Float64Array(N_MAX), y: new Float64Array(N_MAX), b: new Float32Array(N_MAX), z: new Float32Array(N_MAX), v: new Float32Array(N_MAX), alt: new Float32Array(N_MAX), schnee: new Uint8Array(N_MAX), lebt: new Uint8Array(N_MAX) };
      this.N = N_MAX; this.ref = mc([8.2, 46.8]); this.t = performance.now(); this.zeit0 = performance.now();
      // Nebel (zwei Lagen für Tiefe) und Wolken: Flächen über dem Ausschnitt, bei jedem Verschieben neu
      this.flaechen = {};
      const mat = (farbe, deck) => new THREE.ShaderMaterial({ vertexShader: NEBEL_VS, fragmentShader: NEBEL_FS, transparent: true, depthWrite: false,
        uniforms: { uZeit: { value: 0 }, uSkala: { value: .001 }, uDeck: { value: deck }, uFarbe: { value: new THREE.Color(farbe) }, uWind: { value: new THREE.Vector2(.02, .01) }, uOff: { value: new THREE.Vector2() } } });
      for (const [k, farbe, deck] of [["nebel", 0xf3f5f6, .55], ["nebel2", 0xe4e8ea, .35], ["wolken", 0x8d969e, .1]]) {
        const g = new THREE.BufferGeometry(), me = new THREE.Mesh(g, mat(farbe, deck)); me.frustumCulled = false; me.visible = false; this.szene.add(me); this.flaechen[k] = { g, me };
      }
      this.bauAnker = null; this.feldV = -1; this.bauen = () => { this.neuBauen = true; }; m.on("moveend", this.bauen); this.neuBauen = true;
    },
    onRemove(m) { m.off("moveend", this.bauen); },
    // Nebel- und Wolkenflächen für den sichtbaren Ausschnitt (Gitter 56 × 56, Höhe und Deckung aus dem Wetterfeld)
    flaechenBauen(map, anker, ms, ex) {
      const b = map.getBounds(), w = b.getWest(), e = b.getEast(), s = b.getSouth(), n = b.getNorth(), dx = (e - w) * .1, dy = (n - s) * .1, G = 56;
      const mach = (k, wert, hoehe) => {
        const pos = new Float32Array((G + 1) * (G + 1) * 3), al = new Float32Array((G + 1) * (G + 1)); let max = 0;
        for (let j = 0; j <= G; j++) for (let i = 0; i <= G; i++) {
          const lng = w - dx + (e - w + 2 * dx) * i / G, lat = s - dy + (n - s + 2 * dy) * j / G, q = mc([lng, lat]), a = wert(lng, lat), p = (j * (G + 1) + i);
          pos[p * 3] = (q.x - anker.x) / ms; pos[p * 3 + 1] = (q.y - anker.y) / ms; pos[p * 3 + 2] = hoehe(lng, lat) * ex; al[p] = a; if (a > max) max = a;
        }
        const idx = []; for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) { const a = j * (G + 1) + i; idx.push(a, a + 1, a + G + 1, a + 1, a + G + 2, a + G + 1); }
        const F = this.flaechen[k]; F.g.dispose(); F.g = new THREE.BufferGeometry(); F.g.setAttribute("position", new THREE.BufferAttribute(pos, 3)); F.g.setAttribute("a", new THREE.BufferAttribute(al, 1)); F.g.setIndex(idx);
        F.me.geometry = F.g; F.max = max;
      };
      let rm = 0; for (let j = 0; j <= 12; j++) for (let i = 0; i <= 12; i++) rm = Math.max(rm, feldBei(w + (e - w) * i / 12, s + (n - s) * j / 12, "regen")); this.regenMax = rm;
      const nebelOben = (lng, lat) => feldBei(lng, lat, "nebelOben") || 600;
      mach("nebel", (lng, lat) => feldBei(lng, lat, "nebel"), nebelOben);
      mach("nebel2", (lng, lat) => feldBei(lng, lat, "nebel"), (lng, lat) => nebelOben(lng, lat) - 70);
      // Wolken: über Regengebieten dicht, sonst bei bedecktem Himmel leicht; Untergrenze 1800 m ü. M., über den Alpen höher
      mach("wolken", (lng, lat) => .8 * Math.min(1, Math.max(feldBei(lng, lat, "regen") / 1.5, feldBei(lng, lat, "wolken") * .55)), (lng, lat) => { const g = ex ? (map.queryTerrainElevation([lng, lat]) || 0) / ex : 0; return Math.max(1800, g + 700); });
    },
    // neuer Tropfen: zufälliger Bildpunkt, angenommen mit der Regenstärke an dieser Stelle
    spawn(i, map, W, H, Hs, ex) {
      const T = this.T;
      for (let v = 0; v < 6; v++) {
        const ll = map.unproject([Math.random() * W, H * (.06 + .94 * Math.random())]); if (!ll) continue;
        const r = feldBei(ll.lng, ll.lat, "regen"); if (r <= .03 || Math.random() > Math.min(1, .25 + r / 2.5)) continue;
        const q = mc(ll), boden = ex ? (map.queryTerrainElevation(ll) || 0) : 0, schnee = tempBei(ll.lng, ll.lat, ex ? boden / ex : 500) < 1;
        T.x[i] = q.x; T.y[i] = q.y; T.b[i] = boden; T.z[i] = boden + Math.random() * Hs; T.schnee[i] = schnee ? 1 : 0;
        T.v[i] = schnee ? Math.max(1.2, Hs / 8) : Math.max(9, Hs / 1.3); T.alt[i] = 0; T.lebt[i] = 1; return true;
      }
      T.lebt[i] = 0; return false;
    },
    render(gl, args) {
      const map = K.map, jetzt = performance.now(), dt = Math.min(.1, (jetzt - this.t) / 1000); this.t = jetzt;
      const an = WE.an && WE.feld && map.getZoom() >= 6;
      this.regen.visible = this.schnee.visible = false; for (const k in this.flaechen) this.flaechen[k].me.visible = false;
      if (!an) return;
      const c = map.getCenter(), anker = mc(c), ms = anker.meterInMercatorCoordinateUnits(), Tr = map.getTerrain(), ex = Tr ? Tr.exaggeration || 1 : 0, kam = kamera(map);
      // Flächen neu bauen nach Verschieben/Zoomen oder neuen Wetterdaten
      if (this.neuBauen || this.feldV !== WE.version || !this.bauAnker) { this.neuBauen = false; this.feldV = WE.version; this.bauAnker = anker; this.bauMs = ms; this.flaechenBauen(map, anker, ms, ex); }
      const ba = this.bauAnker, zeit = (jetzt - this.zeit0) / 1000, J = WE.jetzt || { ff: 5, dd: 0 };
      const windM = Math.min(60, J.ff) / 3.6, wx = -Math.sin(J.dd) * windM, wy = Math.cos(J.dd) * windM;   // Wind aus Richtung dd (y nach Süden)
      for (const k in this.flaechen) {
        const F = this.flaechen[k]; if (!(F.max > .05)) continue; const u = F.me.material.uniforms;
        u.uZeit.value = zeit; u.uSkala.value = 1 / Math.max(60, kam.breite * (k === "wolken" ? .09 : .06)); u.uOff.value.set((ba.x - this.ref.x) / this.bauMs, (ba.y - this.ref.y) / this.bauMs);
        u.uWind.value.set(wx * u.uSkala.value * 8 + .015, wy * u.uSkala.value * 8 + .01); F.me.visible = true;
        F.me.position.set((ba.x - anker.x) / ms, (ba.y - anker.y) / ms, 0);
      }
      // Niederschlag: Säule vom Boden bis über die Kamera (höchstens bis zu den Wolken), Tempo nach Massstab
      const Wc = map.getCanvas().clientWidth, Hc = map.getCanvas().clientHeight, Hs = Math.max(40, Math.min(9000, kam.hoch * .7));
      const T = this.T; let nR = 0, nS = 0, neu = 0, aktiv = 0;
      const treib = Math.max(1, Hs / 120) * .6, vx = wx * treib, vy = wy * treib;   // seitliches Treiben (herausgezoomt stärker, sonst sieht man es nicht)
      const regenDa = this.regenMax > .03;
      for (let i = 0; i < this.N; i++) {
        if (!T.lebt[i]) { if (!regenDa || neu >= 200) continue; neu++; if (!this.spawn(i, map, Wc, Hc, Hs, ex)) continue; }
        T.alt[i] += dt; const sch = T.schnee[i];
        T.z[i] -= T.v[i] * dt * (sch ? .75 + (i % 7) * .07 : 1);
        T.x[i] += (vx * (sch ? 1.4 : .5) + (sch ? Math.sin(zeit * 1.3 + i) * .4 * treib : 0)) * dt * ms; T.y[i] += vy * (sch ? 1.4 : .5) * dt * ms;
        if (T.z[i] < T.b[i]) { T.lebt[i] = 0; continue; }
        aktiv++;
        const x = (T.x[i] - anker.x) / ms, y = (T.y[i] - anker.y) / ms, z = T.z[i], a = Math.min(1, T.alt[i] / .35);
        if (sch) { const k = nS * 3; this.sp[k] = x; this.sp[k + 1] = y; this.sp[k + 2] = z; nS++; }
        else { const k = nR * 6, q = nR * 8, len = Math.max(1.5, T.v[i] * .07), sx = vx * .5 / T.v[i] * len, sy = vy * .5 / T.v[i] * len;   // schräg wie die Fallrichtung
          this.rp[k] = x; this.rp[k + 1] = y; this.rp[k + 2] = z; this.rp[k + 3] = x - sx; this.rp[k + 4] = y - sy; this.rp[k + 5] = z + len;
          this.rc[q] = .3; this.rc[q + 1] = .38; this.rc[q + 2] = .48; this.rc[q + 3] = .9 * a; this.rc[q + 4] = .55; this.rc[q + 5] = .62; this.rc[q + 6] = .7; this.rc[q + 7] = 0; nR++; }
      }
      if (nR) { this.rgeo.setDrawRange(0, nR * 2); this.rgeo.attributes.position.needsUpdate = true; this.rgeo.attributes.color.needsUpdate = true; this.regen.visible = true; }
      if (nS) { this.sgeo.setDrawRange(0, nS); this.sgeo.attributes.position.needsUpdate = true; this.schnee.visible = true; this.schnee.material.size = (istHandy() ? .8 : 1) * Math.max(1.6, Math.min(3.2, (map.getZoom() - 6) / 2.5)); }
      const mm = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix), l = new THREE.Matrix4().makeTranslation(anker.x, anker.y, 0).scale(new THREE.Vector3(ms, ms, ms));
      this.cam.projectionMatrix = mm.multiply(l); this.r.resetState(); this.r.render(this.szene, this.cam);
      if (aktiv || Object.values(this.flaechen).some(F => F.me.visible)) map.triggerRepaint();   // Animation läuft weiter
    },
  };
}
