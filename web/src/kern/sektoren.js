// Sektoren der Perrons (Sektortafeln der SBB, /api/sektoren): wo die Sektoren A, B, C … an einem Gleis liegen. Zusammen
// mit dem Formation-Dienst (welche Sektoren der Zug an diesem Halt belegt) hält der Zug an der richtigen Stelle des Perrons.
// Wird erst geladen, wenn 3D-Züge gezeichnet werden.
import { B } from "./basis.js";
export const SEK = { u: null, laed: false };
export function sektorenLaden() {
  if (SEK.laed) return; SEK.laed = true;
  fetch("/api/sektoren").then(r => r.ok ? r.json() : null).then(j => { if (j && j.u) SEK.u = j.u; }).catch(() => { });
}
const cache = new Map();
// Mitte der belegten Sektoren «ab» (z. B. "BD") am Gleis gl im Bahnhof i → Kartenkoordinaten (x, y), sonst null.
// Tafeln: [m entlang der Linie, E, N, Vorder-+Rückseite] – gleiche Buchstaben = Sektormitte, verschiedene = Grenze.
// Ausdehnung = alle Tafeln, die einen der Sektoren a … b nennen; eine Sektormitte am Rand zählt einen halben Tafelabstand weiter.
export function sektorPunkt(i, gl, ab, uics) {
  if (!SEK.u || !gl || !ab) return null;
  const k = i + "|" + gl + "|" + ab; if (cache.has(k)) return cache.get(k);
  let erg = null; const a = ab[0], b = ab[ab.length - 1], g2 = gl.replace(/[A-Z]+$/, "");
  for (const u of uics || B.STUIC[i] || []) {
    const G = SEK.u[u]; const L = G && (G[gl] || G[g2]); if (!L || L.length < 2) continue;
    const drin = c => c >= a && c <= b && c !== "-";
    // typische Sektorlänge: Ausdehnung der Tafeln / Anzahl Sektoren an diesem Gleis
    const alle = new Set(); for (const x of L) for (const c of x[3]) if (c !== "-") alle.add(c);
    const sl = Math.max(20, Math.min(120, (L[L.length - 1][0] - L[0][0]) / Math.max(1, alle.size - 1)));
    let lo = Infinity, hi = -Infinity, loInnen = false, hiInnen = false;
    for (let t = 0; t < L.length; t++) {
      const [m, , , s] = L[t]; if (!drin(s[0]) && !drin(s[1])) continue;
      let m0 = m, m1 = m;
      if (s[0] === s[1]) {   // Sektormitte: halber Abstand zur Nachbartafel nach aussen
        const vor = t > 0 ? L[t - 1][0] : null, nach = t + 1 < L.length ? L[t + 1][0] : null;
        m0 = vor !== null ? m - (m - vor) / 2 : m - sl / 2; m1 = nach !== null ? m + (nach - m) / 2 : m + sl / 2;
      }
      const innen = s[0] !== s[1] && drin(s[0]) && drin(s[1]);   // Grenze zwischen zwei belegten Sektoren
      if (m0 < lo) { lo = m0; loInnen = innen; } if (m1 > hi) { hi = m1; hiInnen = innen; }
    }
    if (lo > hi) continue;
    if (loInnen) lo -= sl; if (hiInnen) hi += sl;   // dahinter keine Tafel mehr: der Sektor reicht noch eine Länge weiter
    const mitte = (lo + hi) / 2;   // auf der Linie zwischen den Tafeln einsetzen
    let t = 0; while (t < L.length - 2 && L[t + 1][0] < mitte) t++;
    const P = L[t], Q = L[t + 1], f = Q[0] > P[0] ? Math.max(-.5, Math.min(1.5, (mitte - P[0]) / (Q[0] - P[0]))) : 0;
    const E = P[1] + (Q[1] - P[1]) * f, N = P[2] + (Q[2] - P[2]) * f;
    erg = [(E - 2480000) / 100, (1300000 - N) / 100]; break;
  }
  cache.set(k, erg); return erg;
}
