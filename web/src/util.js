// Kleine Hilfsfunktionen ohne Abhängigkeiten
export const $ = id => document.getElementById(id);
export const fmt = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, "'");
export const pad = n => String(n).padStart(2, "0");
export const norm = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
export const fc = f => ({ type: "FeatureCollection", features: f });

// Kartenkoordinaten: LV95 / 100, x = (E − 2 480 000) / 100, y = (1 300 000 − N) / 100
export const X = s => (s.E - 2480000) / 100, Y = s => (1300000 - s.N) / 100;
// Kartenkoordinaten → WGS84 (Näherungsformeln swisstopo)
export function wgs(x, y) {
  const E = x * 100 + 2480000, N = 1300000 - y * 100, yy = (E - 2600000) / 1e6, xx = (N - 1200000) / 1e6;
  const l = 2.6779094 + 4.728982 * yy + 0.791484 * yy * xx + 0.1306 * yy * xx * xx - 0.0436 * yy * yy * yy;
  const p = 16.9023892 + 3.238272 * xx - 0.270978 * yy * yy - 0.002528 * xx * xx - 0.0447 * yy * yy * xx - 0.0140 * xx * xx * xx;
  return [l * 100 / 36, p * 100 / 36];
}
// Ecken leicht runden (Chaikin, höchstens 15 m je Ecke – der Verlauf selbst ist genau)
export function glatt(p, n = 2) {
  for (let r = 0; r < n && p.length > 2; r++) {
    const q = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i], b = p[i + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, f = Math.min(.25, .15 / L);
      q.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], [b[0] + (a[0] - b[0]) * f, b[1] + (a[1] - b[1]) * f]);
    }
    q.push(p[p.length - 1]); p = q;
  }
  return p;
}
// Delta-kodierte Punktfolge «x,y;dx,dy;…» dekodieren; f(x, y) rechnet in Kartenkoordinaten um
export function dekodiere(v, f) {
  let x = 0, y = 0;
  return v.split(";").map((q, i) => { const [a, b] = q.split(",").map(Number); if (i) { x += a; y += b } else { x = a; y = b } return f(x, y); });
}
export function laenge(pt) { let m = 0; for (let k = 1; k < pt.length; k++)m += Math.hypot(pt[k][0] - pt[k - 1][0], pt[k][1] - pt[k - 1][1]); return m; }
// einfache Ereignisse zwischen den Modulen
const hoerer = {};
export const an = (ev, fn) => (hoerer[ev] || (hoerer[ev] = [])).push(fn);
export const melde = (ev, ...a) => (hoerer[ev] || []).forEach(fn => fn(...a));
export const istHandy = () => matchMedia("(max-width:760px)").matches;
