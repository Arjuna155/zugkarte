// Fahrleitungen über den Gleisen – nur, wo das Gleis in OpenStreetMap als elektrifiziert eingetragen ist
// (/api/ausstattung, Art «e»: electrified=contact_line|yes). Gezeichnet entlang der Kartengleise (swisstopo), damit Draht
// und Masten genau über den Schienen und Zügen liegen; ein Kartengleis gilt als elektrisch, wenn ein OSM-Gleis mit
// Fahrleitung ≤ 5 m daneben in gleicher Richtung läuft.
// Bahn: Masten alle ~55 m. Ein Gleis → ein Mast mit Ausleger, zwei Gleise → Masten beidseits mit je einem Ausleger,
// ab drei Gleisen (Bahnhöfe) → Quertragwerk (Joch) über alle Gleise mit Masten an den Enden. Fahrdraht 5,5 m über
// Schiene mit Zickzack (±20 cm), Tragseil 6,8 m. Tram: Masten am Strassenrand alle ~35 m, Querdraht, Fahrdraht 5,8 m.
// Ab Zoom 15, Umkreis 1,2 km (Computer 1,8 km). Ebene «fahrleitung».
import { K } from "./karte.js";
import { ladeThree, gemeinsamerZeichner, szeneMitLicht, ohneUmkehr } from "./drei.js";
import { VOR_3D } from "./tageszeit.js";
import { Geo, W3 } from "./welt3d.js";
import { deckHoehe, DECK } from "./decks.js";
import { AU, ausstattungLaden, ausstattungHoeren } from "./strassen3d.js";
import { ebene } from "../ui/ebenen.js";
import { nachLaden, beiRuhe, quellMerkmale, istHandy, wgs, lv95, an } from "../util.js";

export const FL = { an: true, gleise: 0, elektrisch: 0, masten: 0, joche: 0, ms: 0 };
const Z_AB = 15, SCHRITT = 4;
const lin = c => c.map(v => v <= .04045 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4)), hex = h => lin([1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255));
const mc = ll => maplibregl.MercatorCoordinate.fromLngLat(ll);

function bauen(map, quelle) {
  const z = map.getZoom(); if (!FL.an || z < Z_AB || !map.getTerrain() || !quelle) return null;
  const t0 = performance.now(), o = mc(map.getCenter()), ms = o.meterInMercatorCoordinateUnits(), R = (z >= 17 ? 700 : 1200) * (istHandy() ? .7 : 1.5);
  const lokal = ll => { const m = mc(ll); return [(m.x - o.x) / ms, (m.y - o.y) / ms]; };
  const merc = q => [o.x + q[0] * ms, o.y + q[1] * ms];
  const gelaende = q => { const e = map.queryTerrainElevation(new maplibregl.MercatorCoordinate(o.x + q[0] * ms, o.y + q[1] * ms).toLngLat()); return e == null ? null : e; };
  // elektrifizierte OSM-Gleise im Umkreis (LV95 → lokal), als Raster
  const c0 = map.getCenter(), [cE, cN] = lv95(c0.lng, c0.lat), ks = [];
  for (const dx of [-1, 1]) for (const dy of [-1, 1]) { const k = Math.floor((cE + dx * R - 2480000) / 10000) + "_" + Math.floor((1300000 - cN - dy * R) / 10000); if (!ks.includes(k)) ks.push(k); }
  ausstattungLaden(ks);
  const lokalLV = ([E, N]) => lokal(wgs((E - 2480000) / 100, (1300000 - N) / 100));
  const ER = new Map(), EZ = 20, ek = (x, y) => Math.floor(x / EZ) + "," + Math.floor(y / EZ); let nE = 0;
  for (const k of ks) { const a = AU.get(k); if (!a || !a.e) continue;
    for (const f of a.e) { const P = f.pts.map(lokalLV); if (!P.some(q => Math.hypot(q[0], q[1]) < R + 50)) continue; nE++;
      for (let i = 1; i < P.length; i++) { const a2 = P[i - 1], b = P[i], l = Math.hypot(b[0] - a2[0], b[1] - a2[1]); if (l < .3) continue; const e = { a: a2, l, ux: (b[0] - a2[0]) / l, uy: (b[1] - a2[1]) / l };
        for (let s0 = 0; s0 <= l + 9; s0 += 10) { const u = Math.min(l, s0), kk = ek(a2[0] + e.ux * u, a2[1] + e.uy * u); let L = ER.get(kk); if (!L) ER.set(kk, L = []); if (L[L.length - 1] !== e) L.push(e); } } } }
  if (!nE) { FL.gleise = 0; FL.elektrisch = 0; FL.masten = 0; FL.joche = 0; return null; }
  const elektrisch = (x, y, ux, uy) => { for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const e of ER.get(Math.floor(x / EZ + dx) + "," + Math.floor(y / EZ + dy)) || []) {
    if (Math.abs(ux * e.ux + uy * e.uy) < .85) continue; const t = Math.max(0, Math.min(e.l, (x - e.a[0]) * e.ux + (y - e.a[1]) * e.uy)); if (Math.hypot(e.a[0] + e.ux * t - x, e.a[1] + e.uy * t - y) <= 5) return true; } return false; };

  // Kartengleise (feinste Kachelstufe, ohne Tunnel), alle 4 m, mit Höhe (Brücke: Fahrbahn der 3D-Brücke)
  const F = quellMerkmale(map, quelle, "transportation"); let zmax = 0; for (const f of F) if (f.tile && f.tile.z > zmax) zmax = f.tile.z;
  const gleise = [], gesehen = new Set(), rk = q => Math.round(q[0]) + "," + Math.round(q[1]);
  for (const f of F) {
    const p = f.properties; if ((p.class !== "rail" && p.class !== "transit") || p.brunnel === "tunnel" || (f.tile && f.tile.z !== zmax)) continue;
    if (/funicular|rack|cable/.test(p.subclass || "")) continue;
    const g = f.geometry, linien = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [];
    for (const ll of linien) {
      if (ll.length < 2) continue; const roh = ll.map(lokal); if (!roh.some(q => Math.hypot(q[0], q[1]) < R)) continue;
      const key = rk(roh[0]) + "|" + rk(roh[roh.length - 1]) + "|" + roh.length; if (gesehen.has(key)) continue; gesehen.add(key);
      const P = []; for (let i = 1; i < roh.length; i++) { const a = roh[i - 1], b = roh[i], l = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(l / SCHRITT)); if (l < .2) continue;
        for (let j = P.length ? 1 : 0; j <= n; j++) P.push({ x: a[0] + (b[0] - a[0]) * j / n, y: a[1] + (b[1] - a[1]) * j / n, ux: (b[0] - a[0]) / l, uy: (b[1] - a[1]) / l }); }
      if (P.length < 2) continue;
      const tram = p.class === "transit" && /tram/.test(p.subclass || "tram"), bru = p.brunnel === "bridge";
      for (const q of P) { q.in = Math.hypot(q.x, q.y) < R; q.el = q.in && elektrisch(q.x, q.y, q.ux, q.uy);
        let zz = null; if (bru && DECK.n) { const m = merc([q.x, q.y]); zz = deckHoehe(m[0], m[1], true, 1.5, [q.ux, q.uy]); }
        q.z = zz != null ? zz : gelaende([q.x, q.y]); }
      // Lage entlang des Gleises (für die Mastabstände)
      let s = 0; P[0].s = 0; for (let i = 1; i < P.length; i++) { s += Math.hypot(P[i].x - P[i - 1].x, P[i].y - P[i - 1].y); P[i].s = s; }
      gleise.push({ P, tram, id: gleise.length });
    }
  }
  FL.gleise = gleise.length;
  // Raster aller elektrischen Gleispunkte (für Querschnitte: welche Gleise liegen nebeneinander?)
  const GR = new Map(), GZ = 15, gk = (x, y) => Math.floor(x / GZ) + "," + Math.floor(y / GZ); let nEl = 0;
  for (const g of gleise) for (const q of g.P) if (q.el && q.z != null) { nEl++; const k = gk(q.x, q.y); let L = GR.get(k); if (!L) GR.set(k, L = []); L.push({ g, q }); }
  FL.elektrisch = nEl;
  const querschnitt = (q) => {   // Gleise quer zu q (±30 m), je Gleis der Punkt nächst der Querlinie: [{off, q, g}]
    const nx = -q.uy, ny = q.ux, best = new Map();
    for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) for (const e of GR.get(Math.floor(q.x / GZ + dx) + "," + Math.floor(q.y / GZ + dy)) || []) {
      const ex = e.q.x - q.x, ey = e.q.y - q.y, laengs = ex * q.ux + ey * q.uy, quer = ex * nx + ey * ny; if (Math.abs(laengs) > 2.5 || Math.abs(quer) > 30) continue;
      if (Math.abs(e.q.ux * q.ux + e.q.uy * q.uy) < .92) continue;
      const alt = best.get(e.g.id); if (!alt || Math.abs(laengs) < alt.l) best.set(e.g.id, { off: quer, l: Math.abs(laengs), q: e.q, g: e.g }); }
    return [...best.values()].sort((a, b) => a.off - b.off);
  };

  const G = new Geo(), D = [], MAST = hex("#7d848a"), MAST_D = hex("#5f666c"), JOCH = hex("#8a9197"), DRAHT = [];
  const linie = (a, b) => DRAHT.push(a[0], a[1], a[2], b[0], b[1], b[2]);
  const mast = (x, y, z0, h, ux, uy) => { const w = .14; G.balken([x - ux * w, y - uy * w], [x + ux * w, y + uy * w], .28, z0 - .3, z0 + h, z0 - .3, z0 + h, MAST, MAST_D); };
  let masten = 0, joche = 0;
  for (const g of gleise) {
    const P = g.P, SP = g.tram ? 35 : 55;
    // Fahrdraht (Zickzack ±20 cm zwischen den Masten) und Tragseil
    const hD = g.tram ? 5.8 : 5.5;
    for (let i = 1; i < P.length; i++) { const a = P[i - 1], b = P[i]; if (!a.el || !b.el || a.z == null || b.z == null) continue;
      const zz = s => { const t = (s / SP) % 2; return (t < 1 ? t : 2 - t) * .4 - .2; }, nx = -a.uy, ny = a.ux;
      linie([a.x + nx * zz(a.s), a.y + ny * zz(a.s), a.z + hD], [b.x + nx * zz(b.s), b.y + ny * zz(b.s), b.z + hD]);
      if (!g.tram) linie([a.x, a.y, a.z + 6.8], [b.x, b.y, b.z + 6.8]); }
    // Masten: an Vielfachen von SP entlang des Gleises; erzeugt nur vom äussersten Gleis links im Querschnitt
    for (let i = 1; i < P.length; i++) {
      const q = P[i]; if (!q.el || q.z == null || !q.in || Math.floor(q.s / SP) === Math.floor(P[i - 1].s / SP)) continue;
      const Q = querschnitt(q); if (!Q.length || Q[0].g !== g) continue;
      // Gruppe: zusammenhängende Gleise (Lücke ≤ 12 m)
      const grp = [Q[0]]; for (let k = 1; k < Q.length; k++) { if (Q[k].off - grp[grp.length - 1].off > 12) break; grp.push(Q[k]); }
      const nx = -q.uy, ny = q.ux, at = (off, z) => [q.x + nx * off, q.y + ny * off, z];
      const z0 = Math.min(...grp.map(e => e.q.z)), lo = grp[0].off, hi = grp[grp.length - 1].off;
      const boden = off => { const p = at(off, 0), e = gelaende(p); return e == null || e < z0 - 3 ? z0 : Math.min(e, z0 + 2); };
      if (g.tram) {   // Tram: Masten am Strassenrand, Querdraht, Hänger zu jedem Fahrdraht
        const a = lo - 4, b = hi + 4, za = boden(a), zb = boden(b), h = 7.2;
        mast(...at(a).slice(0, 2), za, h, q.ux, q.uy); mast(...at(b).slice(0, 2), zb, h, q.ux, q.uy); masten += 2;
        linie(at(a, za + h - .4), at(b, zb + h - .4));
        for (const e of grp) linie(at(e.off, z0 + 6.55), at(e.off, e.q.z + 5.8));
        continue;
      }
      if (grp.length >= 3) {   // Joch über alle Gleise
        const a = lo - 3.4, b = hi + 3.4, za = boden(a), zb = boden(b), zt = z0 + 7.6, h = 8.1;
        mast(...at(a).slice(0, 2), za, zt + .5 - za, q.ux, q.uy); mast(...at(b).slice(0, 2), zb, zt + .5 - zb, q.ux, q.uy); masten += 2; joche++;
        const A = at(a), B = at(b); G.balken([A[0], A[1]], [B[0], B[1]], .35, zt, zt + .45, zt, zt + .45, JOCH, MAST_D);
        for (const e of grp) { linie(at(e.off, zt), at(e.off, e.q.z + 6.8)); linie(at(e.off, e.q.z + 6.8), at(e.off, e.q.z + 5.5)); }
        continue;
      }
      // ein oder zwei Gleise: Mast aussen links (und bei zwei Gleisen auch rechts), Ausleger zum nächsten Gleis
      const seiten = grp.length === 1 ? [[lo - 3.2, grp[0]]] : [[lo - 3.2, grp[0]], [hi + 3.2, grp[grp.length - 1]]];
      for (const [mo, e] of seiten) {
        const zb = boden(mo), h = Math.max(7.6, e.q.z + 7.4 - zb); mast(...at(mo).slice(0, 2), zb, h, q.ux, q.uy); masten++;
        const M = at(mo), W = at(e.off), dx = W[0] - M[0], dy = W[1] - M[1], l = Math.hypot(dx, dy) || 1, ex = W[0] + dx / l * .4, ey = W[1] + dy / l * .4;
        G.balken([M[0], M[1]], [ex, ey], .07, e.q.z + 6.0, e.q.z + 6.08, e.q.z + 5.7, e.q.z + 5.78, MAST_D, MAST_D);   // Ausleger (Rohr)
        linie([M[0], M[1], zb + h - .1], [ex, ey, e.q.z + 6.85]);   // Abspannung zum Tragseil
        linie([W[0], W[1], e.q.z + 5.74], [W[0], W[1], e.q.z + 5.5]);
      }
    }
  }
  FL.masten = masten; FL.joche = joche; FL.ms = Math.round(performance.now() - t0);
  return { G, DRAHT, o };
}

function ebene3d() {
  return {
    id: "fahrleitung3d", type: "custom", renderingMode: "3d",
    onAdd(m, gl) {
      this.cam = new THREE.Camera(); this.szene = szeneMitLicht(); this.r = gemeinsamerZeichner(m, gl); this.netz = null; this.draht = null; this.o = null;
      this.mat = ohneUmkehr(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
      this.dmat = new THREE.LineBasicMaterial({ color: 0x2f3438, transparent: true, opacity: .85 });
    },
    setze(e) {
      for (const k of ["netz", "draht"]) if (this[k]) { this.szene.remove(this[k]); this[k].geometry.dispose(); this[k] = null; }
      if (!e) { this.o = null; return; } this.o = e.o;
      if (e.G.p.length) { const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(e.G.p, 3)); g.setAttribute("color", new THREE.Float32BufferAttribute(e.G.c, 3)); g.setAttribute("normal", new THREE.Float32BufferAttribute(e.G.n, 3)); this.netz = new THREE.Mesh(g, this.mat); this.netz.frustumCulled = false; this.szene.add(this.netz); }
      if (e.DRAHT.length) { const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(e.DRAHT, 3)); this.draht = new THREE.LineSegments(g, this.dmat); this.draht.frustumCulled = false; this.szene.add(this.draht); }
    },
    render(gl, args) {
      const map = K.map; if (!this.o || map.getZoom() < Z_AB - .2 || !map.getTerrain()) return;
      const s = this.o.meterInMercatorCoordinateUnits(), m = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix), l = new THREE.Matrix4().makeTranslation(this.o.x, this.o.y, 0).scale(new THREE.Vector3(s, s, s));
      this.cam.projectionMatrix = m.multiply(l); this.r.resetState(); this.r.render(this.szene, this.cam);
    },
  };
}

export function fahrleitungStarten() {
  const map = K.map; let schicht = null, laedt = false;
  const neu = () => nachLaden(map, "fahrleitung", async () => {
    if (!FL.an || map.getZoom() < Z_AB || !map.getTerrain() || !W3.quelle) { if (schicht) { schicht.setze(null); map.triggerRepaint(); } return; }
    if (!schicht) { if (laedt) return; laedt = true; await ladeThree(); schicht = ebene3d(); map.addLayer(schicht, VOR_3D()); }
    schicht.setze(bauen(map, W3.quelle)); map.triggerRepaint();
  }, 300, 6);
  ebene({ id: "fahrleitung", name: "Fahrleitungen (nach OpenStreetMap)", an: true, setze: an => { FL.an = an; neu(); } });
  ausstattungHoeren(neu); beiRuhe(map, neu); map.on("terrain", neu); an("decks", neu);
  map.on("sourcedata", e => { if (W3.quelle && e.sourceId === W3.quelle && e.isSourceLoaded) neu(); });
  window.__fl = FL; neu();
}
