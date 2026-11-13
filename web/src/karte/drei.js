// three.js erst bei Bedarf laden (≈ 150 KB komprimiert); alle 3D-Ebenen teilen sich die Bibliothek
let laden = null;
export function ladeThree() {
  if (!laden) laden = new Promise((ok, fehler) => { const s = document.createElement("script"); s.src = "lib/three.min.js"; s.onload = () => ok(window.THREE); s.onerror = fehler; document.head.appendChild(s); });
  return laden;
}
// gemeinsames Licht und Material für die 3D-Ebenen
// LICHT: Sonnenrichtung (x Ost, y Süd, z oben) und -farbe, gesetzt von tageszeit.js; alle Sonnenlichter und Wasser-Uniforms
// melden sich hier an und werden mitgeführt
export const LICHT = { dir: [-.5, -.4, .9], farbe: [1, 1, 1], lichter: [], wasser: [] };
export function sonnenLicht(staerke) { const d = new THREE.DirectionalLight(0xffffff, staerke); d.position.set(...LICHT.dir); d.color.setRGB(...LICHT.farbe); LICHT.lichter.push(d); return d; }
// Himmelslicht von oben: three.js nimmt +y als «oben», unsere Szenen haben z nach oben (y nach Süden) – vorher kam der
// Himmel von Süden, Flachdächer und Baumkronen bekamen nur halbes Himmelslicht und wirkten grau
export function himmelLicht(staerke) { const h = new THREE.HemisphereLight(0xffffff, 0x7d8a96, staerke); h.position.set(0, 0, 1); return h; }
export function szeneMitLicht() {
  const sz = new THREE.Scene();
  sz.add(himmelLicht(1.7)); sz.add(sonnenLicht(1.5));
  return sz;
}
// ein einziger three.js-Zeichner für alle 3D-Ebenen (gemeinsamer Zwischenspeicher für Shader und Grafikzustand statt acht
// getrennter, die jeder für sich kompilieren); jede Ebene ruft vor dem Zeichnen resetState() auf
let zeichner = null;
export function gemeinsamerZeichner(m, gl) {
  if (!zeichner || zeichner.getContext() !== gl) { zeichner = new THREE.WebGLRenderer({ canvas: m.getCanvas(), context: gl, antialias: true }); zeichner.autoClear = false; zeichner.outputColorSpace = THREE.SRGBColorSpace; }
  return zeichner;
}
