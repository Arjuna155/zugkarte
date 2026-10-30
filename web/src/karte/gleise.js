// Gleise der Grundkarte (swisstopo-Kacheln, transportation class=rail/transit) für den sichtbaren Ausschnitt.
// Die 3D-Züge rasten darauf ein: jeder Wagen auf das nächste Gleis, bevorzugt das linke in Fahrtrichtung
// (in der Schweiz fahren die Züge auf Doppelspur links). So fahren sie auf den Gleisen, die die Karte zeigt.
import { K } from "./karte.js";

const ZELLE = 25, RADIUS = 7;   // Meter
export const GL = { n: 0, bereit: false };
let raster = new Map(), o = null, ms = 1, quelle = null;
const mc = ll => maplibregl.MercatorCoordinate.fromLngLat(ll);

function quelleSuchen(map) { for (const l of map.getStyle().layers) if (l["source-layer"] === "transportation") return l.source; return null; }
function aufbauen() {
  const map = K.map; if (!quelle) quelle = quelleSuchen(map); if (!quelle || map.getZoom() < 13) { GL.bereit = false; return; }
  const feats = map.querySourceFeatures(quelle, { sourceLayer: "transportation" });
  o = mc(map.getCenter()); ms = o.meterInMercatorCoordinateUnits(); raster = new Map(); let n = 0;
  const gesehen = new Set();
  for (const f of feats) {
    const p = f.properties; if (p.class !== "rail" && p.class !== "transit") continue;
    const linien = f.geometry.type === "LineString" ? [f.geometry.coordinates] : f.geometry.type === "MultiLineString" ? f.geometry.coordinates : [];
    for (const ll of linien) {
      let vor = null;
      for (const q of ll) {
        const m = mc(q), x = (m.x - o.x) / ms, y = (m.y - o.y) / ms;
        if (vor) {
          const key = Math.round(vor[0] * 2) + "," + Math.round(vor[1] * 2) + "," + Math.round(x * 2) + "," + Math.round(y * 2); if (gesehen.has(key)) { vor = [x, y]; continue; } gesehen.add(key);
          const s = [vor[0], vor[1], x, y, p.brunnel === "tunnel" ? 1 : 0], L = Math.hypot(x - vor[0], y - vor[1]), k = Math.max(1, Math.ceil(L / ZELLE)), zellen = new Set();   // s = [x0, y0, x1, y1, Tunnel]
          for (let i = 0; i <= k; i++) zellen.add(Math.floor((vor[0] + (x - vor[0]) * i / k) / ZELLE) + "," + Math.floor((vor[1] + (y - vor[1]) * i / k) / ZELLE));
          for (const z of zellen) { let a = raster.get(z); if (!a) raster.set(z, a = []); a.push(s); } n++;
        }
        vor = [x, y];
      }
    }
  }
  GL.n = n; GL.bereit = n > 0;
}
// Punkt (Mercator) mit Fahrtrichtung (rechts = Rechtsverkehr, Trams) (dx, dy in Mercator, y nach Süden) auf ein Gleis setzen; liefert Mercator-Punkt oder null
export function einrasten(m, dx, dy, rechts, frei) {
  if (!GL.bereit) return null;
  const x = (m.x - o.x) / ms, y = (m.y - o.y) / ms, L = Math.hypot(dx, dy) || 1, lx = dy / L, ly = -dx / L;   // links (y nach Süden)
  const cx = Math.floor(x / ZELLE), cy = Math.floor(y / ZELLE); let best = null, bk = 1e9;
  for (let i = -1; i <= 1; i++)for (let j = -1; j <= 1; j++) {
    const a = raster.get((cx + i) + "," + (cy + j)); if (!a) continue;
    for (const s of a) {
      const ex = s[2] - s[0], ey = s[3] - s[1], l2 = ex * ex + ey * ey || 1e-9; let t = ((x - s[0]) * ex + (y - s[1]) * ey) / l2; t = Math.max(0, Math.min(1, t));
      const px = s[0] + ex * t, py = s[1] + ey * t, d = Math.hypot(px - x, py - y); if (d > RADIUS) continue;
      const seite = (px - x) * lx + (py - y) * ly, kosten = frei ? d : d - 1.2 * Math.max(0, rechts ? -seite : seite);   // Bahn: linke Gleise bevorzugt, Tram: rechte
      if (kosten < bk) { bk = kosten; best = [px, py]; }
    }
  }
  return best ? { x: o.x + best[0] * ms, y: o.y + best[1] * ms } : null;
}
// nächstes Gleis zu einem Punkt (Mercator) im Umkreis r Meter: {d (m, mit Vorzeichen: links +), ux, uy (Richtung, lokal), tun,
// px, py (Fusspunkt, Mercator)} – für die Perrons (bahnhoefe3d.js). ohne = Segment, das nicht zählt.
export function gleisNah(m, r = 25, ohne = null) {
  if (!GL.bereit) return null;
  const x = (m.x - o.x) / ms, y = (m.y - o.y) / ms, k = Math.ceil(r / ZELLE), cx = Math.floor(x / ZELLE), cy = Math.floor(y / ZELLE); let best = null, bd = r;
  for (let i = -k; i <= k; i++) for (let j = -k; j <= k; j++) {
    const a = raster.get((cx + i) + "," + (cy + j)); if (!a) continue;
    for (const s of a) {
      if (s === ohne) continue; const ex = s[2] - s[0], ey = s[3] - s[1], l2 = ex * ex + ey * ey || 1e-9; let t = ((x - s[0]) * ex + (y - s[1]) * ey) / l2; t = Math.max(0, Math.min(1, t));
      const px = s[0] + ex * t, py = s[1] + ey * t, d = Math.hypot(px - x, py - y); if (d >= bd) continue;
      const L = Math.sqrt(l2), ux = ex / L, uy = ey / L; bd = d; best = { d: d * Math.sign((x - px) * uy - (y - py) * ux || 1), ux, uy, tun: !!s[4], s, px: o.x + px * ms, py: o.y + py * ms };
    }
  }
  return best;
}
export const gleisMs = () => ms;
export function gleiseStarten() {
  const map = K.map; let t = 0; const neu = () => { clearTimeout(t); t = setTimeout(aufbauen, 200); };
  map.on("moveend", neu); map.on("sourcedata", e => { if (quelle && e.sourceId === quelle && e.isSourceLoaded) neu(); }); neu();
}
