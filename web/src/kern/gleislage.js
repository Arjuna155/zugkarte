// Lage der Gleise (Bahnsteigkanten) je Bahnhof aus dem GTFS des Servers (/api/gleise): damit halten Züge am richtigen
// Gleis. Wird erst geladen, wenn 3D-Züge gezeichnet werden.
import { B } from "./basis.js";
export const GLAGE = { daten: null, laed: false };
export function gleiseLaden() {
  if (GLAGE.laed) return; GLAGE.laed = true;
  fetch("/api/gleise").then(r => r.ok ? r.json() : null).then(j => { if (j && j.basis === B.FPV) GLAGE.daten = j.gleise; }).catch(() => { });
}
// Kartenkoordinaten (x, y) der Kante «gl» im Bahnhof mit Index i, sonst null
export function gleisPunkt(i, gl) {
  const g = GLAGE.daten && GLAGE.daten[i]; if (!g || !gl) return null;
  const p = g[gl] || g[gl.replace(/[A-Z]$/, "")] || null; return p ? [(p[0] - 2480000) / 100, (1300000 - p[1]) / 100] : null;
}
