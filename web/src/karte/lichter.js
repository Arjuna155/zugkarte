// Lichter bei Nacht: Fenster der Häuser, Fenster der Züge/Trams/Busse/Schiffe, Scheinwerfer und Rücklichter der Autos.
// Alles, was leuchtet, wird NACH der Abdunkelung (Ebene «nacht», tageszeit.js) gezeichnet und bleibt deshalb hell. Die
// Ebenen melden ihre leuchtenden Teile hier an (`lichtAnmelden`); diese Ebene zeichnet sie mit derselben Kamera wie die
// Ebene selbst (gleiche Tiefe → Fenster hinter Häusern bleiben verdeckt). Am Tag (Nacht-Anteil 0) wird nichts gezeichnet.
import { K } from "./karte.js";
import { TZ } from "./tageszeit.js";
import { S } from "../zustand.js";
import { ladeThree, gemeinsamerZeichner } from "./drei.js";
import { ortslichterStarten } from "./ortslichter.js";

const EINTRAEGE = [];
// e = { aktiv: () => bool, szene: THREE.Scene, matrix: THREE.Matrix4 (lokal → Mercator), ueber: Material (optional, ersetzt alle Materialien) }
export function lichtAnmelden(e) { EINTRAEGE.push(e); return e; }

// Anteil beleuchteter Fenster nach der Uhrzeit (Schweizer Zeit): abends viele, nach Mitternacht wenige, früh morgens wieder mehr
export function fensterAnteil() {
  const h = +new Date(S.simMs || Date.now()).toLocaleString("en-GB", { timeZone: "Europe/Zurich", hour: "2-digit", hour12: false }) % 24,
    m = new Date(S.simMs || Date.now()).getMinutes() / 60, t = h + m;
  const P = [[0, .22], [1, .12], [3, .06], [5, .1], [6, .3], [8, .2], [12, .15], [16, .35], [18, .48], [21, .45], [23, .3], [24, .22]];
  for (let i = 1; i < P.length; i++) if (t <= P[i][0]) { const [a, va] = P[i - 1], [b, vb] = P[i]; return va + (vb - va) * (t - a) / (b - a); }
  return .22;
}

// Leuchtmaterial für die 3D-Fahrzeuge: nur Flächen mit dem Attribut «licht» = 1 (Fensterglas, modelle.js), Rest verworfen
export function fahrzeugLichtMaterial() {
  const m = new THREE.MeshBasicMaterial({ color: 0xfff0c8, transparent: true, side: THREE.DoubleSide, depthWrite: false });
  m.userData.u = { uNacht: { value: 0 } };
  m.onBeforeCompile = sh => {
    sh.uniforms.uNacht = m.userData.u.uNacht;
    sh.vertexShader = "attribute float licht;\nvarying float vLicht;\n" + sh.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\nvLicht = licht;");
    sh.fragmentShader = "uniform float uNacht;\nvarying float vLicht;\n" + sh.fragmentShader.replace("#include <dithering_fragment>", "#include <dithering_fragment>\nif (vLicht < .5) discard;\ngl_FragColor.a = uNacht;");
  };
  return m;
}

function lichtEbene() {
  return {
    id: "lichter3d", type: "custom", renderingMode: "3d",
    onAdd(m, gl) { this.cam = new THREE.Camera(); this.r = gemeinsamerZeichner(m, gl); this.M = new THREE.Matrix4(); },
    render(gl, args) {
      if (!(TZ.nacht > .02)) return;
      const mm = args.defaultProjectionData.mainMatrix;
      for (const e of EINTRAEGE) {
        if (!e.aktiv()) continue; if (e.ueber && e.ueber.userData.u) e.ueber.userData.u.uNacht.value = TZ.nacht; if (e.nacht) e.nacht(TZ.nacht);
        this.cam.projectionMatrix = this.M.fromArray(mm).multiply(e.matrix);
        e.szene.overrideMaterial = e.ueber || null; this.r.resetState(); this.r.render(e.szene, this.cam); e.szene.overrideMaterial = null;
      }
    },
  };
}

export function lichterStarten() {
  const map = K.map; let da = false;
  const laden = () => { if (da || !(TZ.nacht > .02) || map.getZoom() < 9.5) return; da = true;   // ab 9.5: Ortslichter (ortslichter.js), ab 15 Fenster
    ladeThree().then(() => { try { map.addLayer(lichtEbene(), TZ.danach && map.getLayer(TZ.danach) ? TZ.danach : undefined); ortslichterStarten(); } catch (e) { console.error(e); } }); };
  map.on("moveend", laden); setInterval(laden, 20000); laden();
}
