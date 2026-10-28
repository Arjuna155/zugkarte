// three.js erst bei Bedarf laden (≈ 150 KB komprimiert); alle 3D-Ebenen teilen sich die Bibliothek
let laden = null;
export function ladeThree() {
  if (!laden) laden = new Promise((ok, fehler) => { const s = document.createElement("script"); s.src = "lib/three.min.js"; s.onload = () => ok(window.THREE); s.onerror = fehler; document.head.appendChild(s); });
  return laden;
}
// gemeinsames Licht und Material für die 3D-Ebenen
export function szeneMitLicht() {
  const sz = new THREE.Scene();
  sz.add(new THREE.HemisphereLight(0xffffff, 0x7d8a96, 1.7)); const d = new THREE.DirectionalLight(0xffffff, 1.5); d.position.set(-.5, -.4, .9); sz.add(d);
  return sz;
}
