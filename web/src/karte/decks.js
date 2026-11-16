// Fahrbahnhöhe der gebauten 3D-Brücken, damit alles andere dieselbe Höhe nimmt: Züge, Trams und Busse (zuege3d.js),
// Autos (verkehr.js) fahren ÜBER die Brücke statt auf ihrem eigenen Höhenprofil darunter oder darüber, und Bäume
// (baeume.js) wachsen nicht durch die Fahrbahn. welt3d.js meldet nach jedem Aufbau die Brückenlinien (deckSetzen).
import { melde } from "../util.js";

export const DECK = { v: 0, n: 0 };
let raster = new Map(), zelle = 1, stuecke = [];
const key = (a, b) => a + "," + b;

// stuecke: [{ bahn: true/false, w: Breite der Platte (m), P: [[mx, my, z], …] (Mercator, z in Metern) }], ms = Mercator je Meter
export function deckSetzen(liste, ms) {
  stuecke = liste || []; raster = new Map(); zelle = 40 * (ms || 1); DECK.ms = ms || 1;
  stuecke.forEach((s, si) => { for (let i = 1; i < s.P.length; i++) { const a = s.P[i - 1], b = s.P[i], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / zelle));
    for (let k = 0; k <= n; k++) { const kx = Math.floor((a[0] + (b[0] - a[0]) * k / n) / zelle), ky = Math.floor((a[1] + (b[1] - a[1]) * k / n) / zelle), q = key(kx, ky); let z = raster.get(q); if (!z) raster.set(q, z = []);
      if (!z.length || z[z.length - 1][0] !== si || z[z.length - 1][1] !== i) z.push([si, i]); } } });
  DECK.n = stuecke.length; DECK.v++; melde("decks");
}
// Höhe der Fahrbahn bei (mx, my) oder null. bahn: true = nur Bahn-/Trambrücken, false = nur Strassenbrücken, null = alle.
// rand: wie weit neben der Platte noch gilt (m). richtung [dx, dy]: nur Brücken, die etwa in diese Richtung laufen
// (ein Gleis UNTER einer querenden Brücke soll nicht hinaufspringen).
export function deckHoehe(mx, my, bahn, rand = 1.5, richtung) {
  if (!DECK.n) return null; const ms = DECK.ms, cx = Math.floor(mx / zelle), cy = Math.floor(my / zelle); let bd = Infinity, bz = null;
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { const z = raster.get(key(cx + dx, cy + dy)); if (!z) continue;
    for (const [si, i] of z) { const s = stuecke[si]; if (bahn != null && s.bahn !== bahn) continue;
      const a = s.P[i - 1], b = s.P[i], ex = b[0] - a[0], ey = b[1] - a[1], l2 = ex * ex + ey * ey; if (!l2) continue;
      let t = ((mx - a[0]) * ex + (my - a[1]) * ey) / l2; if (t < -.02 || t > 1.02) continue; t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(a[0] + ex * t - mx, a[1] + ey * t - my) / ms; if (d > s.w / 2 + rand || d >= bd) continue;
      if (richtung) { const rl = Math.hypot(richtung[0], richtung[1]) || 1; if (Math.abs(ex * richtung[0] + ey * richtung[1]) / (Math.sqrt(l2) * rl) < .75) continue; }
      bd = d; bz = a[2] + (b[2] - a[2]) * t; } }
  return bz;
}
