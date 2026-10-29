// Verkehr auf Autobahnen und Autostrassen: Messwerte der Verkehrszähler (/api/verkehr, jede Minute vom Server).
// Die Strassen kommen aus der Grundkarte (transportation class=motorway|trunk) für den sichtbaren Ausschnitt; jede
// Strasse bekommt die Werte der nächsten Messstelle. Darauf fahren Autos und Lastwagen als Animation: so viele, wie
// laut Messung unterwegs sind (Fahrzeuge pro Stunde ÷ Geschwindigkeit = Fahrzeuge pro km), so schnell wie gemessen.
// Herausgezoomt Punkte und farbige Verkehrslage (grün flüssig, orange zähflüssig, rot Stau), nah 3D-Fahrzeuge.
import { K } from "./karte.js";
import { ladeThree } from "./drei.js";
import { ebene } from "../ui/ebenen.js";
import { S } from "../zustand.js";
import { fc, istHandy } from "../util.js";

export const VK = { stellen: [], an: true, ketten: [], zeit: 0, fz: [], lage: f => lage(f) };
const mc = ll => maplibregl.MercatorCoordinate.fromLngLat(ll);
const N_MAX = istHandy() ? 1800 : 5000;
let quelle = null, anker = null, ankerMs = 1, KID = 0;

async function laden() {
  try {
    const r = await fetch("/api/verkehr"); if (!r.ok) return; const j = await r.json(), f = j.felder;
    VK.stellen = j.stellen.map(a => { const o = {}; f.forEach((k, i) => o[k] = a[i]); return o; }); VK.zeit = j.zeit;
    for (const k of VK.ketten) zuordnen(k); lageZeichnen(); fahrzeugeVerteilen();
  } catch (e) { }
}
function quelleSuchen(map) { for (const l of map.getStyle().layers) if (l["source-layer"] === "transportation") return l.source; return null; }

// ---- Strassen aus der Grundkarte zu Ketten zusammensetzen (Kachelgrenzen schliessen) ----
function bauen() {
  const map = K.map; if (!quelle) quelle = quelleSuchen(map); if (!quelle) return;
  if (map.getZoom() < 8 || !VK.an) { VK.ketten = []; lageZeichnen(); fahrzeugeVerteilen(); return; }
  anker = mc(map.getCenter()); ankerMs = anker.meterInMercatorCoordinateUnits();
  const feats = map.querySourceFeatures(quelle, { sourceLayer: "transportation" }), gesehen = new Set(), stuecke = [];
  const Tr = map.getTerrain(), ex = Tr ? Tr.exaggeration || 1 : 0;
  for (const f of feats) {
    const p = f.properties; if (p.class !== "motorway" && p.class !== "trunk") continue;
    const linien = f.geometry.type === "LineString" ? [f.geometry.coordinates] : f.geometry.type === "MultiLineString" ? f.geometry.coordinates : [];
    for (const ll of linien) {
      if (ll.length < 2) continue;
      const key = ll.map(q => q[0].toFixed(5) + "," + q[1].toFixed(5)).join(";"); if (gesehen.has(key)) continue; gesehen.add(key);
      stuecke.push({ ll, einweg: p.oneway === 1 || p.oneway === "1", rampe: p.ramp === 1 || p.ramp === "1", tun: p.brunnel === "tunnel", bru: p.brunnel === "bridge", art: p.class });
    }
  }
  // Ketten aus einer Punktwolke: jedes Stück alle 10 m abtasten, doppelte Punkte (Kachelränder, gröbere Kacheln) weglassen,
  // dann von Punkt zu Punkt in Fahrtrichtung weiterlaufen. So entstehen durchgehende Fahrbahnen über alle Kachelgrenzen.
  const c0 = map.getCenter(), kx = Math.cos(c0.lat * Math.PI / 180) * 111320, ky = 110574, ZE = 6;
  const P = [], gitter = new Map(), gk = (x, y) => Math.floor(x / ZE) + "," + Math.floor(y / ZE);
  const nahe = (x, y, r, fn) => { const a = Math.floor((x - r) / ZE), b = Math.floor((x + r) / ZE), c = Math.floor((y - r) / ZE), d = Math.floor((y + r) / ZE);
    for (let i = a; i <= b; i++) for (let j = c; j <= d; j++) for (const q of gitter.get(i + "," + j) || []) fn(q); };
  // genauere Stücke zuerst (mehr Punkte je km = feinere Kachel), gröbere Kacheln fallen dann als doppelt weg
  const dichte = st => { let m = 0; for (let i = 1; i < st.ll.length; i++) m += Math.hypot((st.ll[i][0] - st.ll[i - 1][0]) * 75500, (st.ll[i][1] - st.ll[i - 1][1]) * 111000); return st.ll.length / Math.max(1, m); };
  for (const st of stuecke) st.d = dichte(st); stuecke.sort((u, v) => v.d - u.d);
  for (const st of stuecke) {
    const q = st.ll.map(p => [(p[0] - c0.lng) * kx, (p[1] - c0.lat) * ky]);
    for (let i = 1; i < q.length; i++) {
      const ax = q[i - 1][0], ay = q[i - 1][1], ex = q[i][0] - ax, ey = q[i][1] - ay, l = Math.hypot(ex, ey); if (l < .01) continue;
      const dx = ex / l, dy = ey / l;
      for (let t = 0; t < l; t += 10) {
        const x = ax + dx * t, y = ay + dy * t; let doppelt = false;
        nahe(x, y, 6, o => { if (!doppelt && Math.hypot(o.x - x, o.y - y) < 6 && Math.abs(o.dx * dx + o.dy * dy) > .8 && (!st.einweg || o.dx * dx + o.dy * dy > 0)) doppelt = true; });
        if (doppelt) continue;
        const o = { x, y, dx, dy, st, frei: true }; P.push(o); const key = gk(x, y); (gitter.get(key) || gitter.set(key, []).get(key)).push(o);
      }
    }
  }
  // nächster Punkt in Richtung (dx, dy): 4–16 m voraus, höchstens 3.5 m seitlich, gleiche Art
  const naechster = (o, dx, dy, nurFrei) => { let best = null, bw = 1e9;
    nahe(o.x + dx * 10, o.y + dy * 10, 9, q => { if (q === o || (nurFrei && !q.frei) || q.st.einweg !== o.st.einweg || q.st.rampe !== o.st.rampe) return;
      const vx = q.x - o.x, vy = q.y - o.y, vor = vx * dx + vy * dy, seit = Math.abs(-vx * dy + vy * dx); if (vor < 4 || vor > 16 || seit > 3.5) return;
      const ausr = q.dx * dx + q.dy * dy; if (o.st.einweg ? ausr < .7 : Math.abs(ausr) < .7) return;
      const w = vor + seit * 3; if (w < bw) { bw = w; best = q; } });
    return best; };
  const ketten = [];
  for (const start of P) {
    if (!start.frei) continue; start.frei = false;
    let vorw = [start], d = [start.dx, start.dy], cur = start;
    for (let g = 0; g < 400; g++) { const n = naechster(cur, d[0], d[1], true); if (!n) break; n.frei = false; const s2 = n.dx * d[0] + n.dy * d[1] < 0 ? -1 : 1; d = [n.dx * s2, n.dy * s2]; vorw.push(n); cur = n; }
    let rueckw = []; d = [-start.dx, -start.dy]; cur = start;
    if (vorw.length < 400) for (let g = 0; g < 400 - vorw.length; g++) { const n = naechster(cur, d[0], d[1], true); if (!n) break; n.frei = false; const s2 = n.dx * d[0] + n.dy * d[1] < 0 ? -1 : 1; d = [n.dx * s2, n.dy * s2]; rueckw.push(n); cur = n; }
    const kette = rueckw.reverse().concat(vorw); if (kette.length < 4) continue;
    const st = start.st, pts = kette.map(o => [c0.lng + o.x / kx, c0.lat + o.y / ky, o.st.tun, o.st.bru]);
    const n = pts.length, x = new Float64Array(n), y = new Float64Array(n), cum = new Float64Array(n), z = new Float32Array(n), tun = new Uint8Array(n);
    for (let i = 0; i < n; i++) { const m = mc([pts[i][0], pts[i][1]]); x[i] = m.x; y[i] = m.y; tun[i] = pts[i][2] ? 1 : 0; if (i) cum[i] = cum[i - 1] + Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]) / ankerMs;
      const e = ex ? map.queryTerrainElevation([pts[i][0], pts[i][1]]) : 0; z[i] = e === null || e === undefined ? NaN : e; }
    for (let i = 0; i < n; i++) if (isNaN(z[i])) z[i] = i ? z[i - 1] : 0;
    for (let i = n - 2; i >= 0; i--) if (isNaN(z[i])) z[i] = z[i + 1];
    for (let i = 0; i < n;) { if (!pts[i][3]) { i++; continue; } let j = i; while (j + 1 < n && pts[j + 1][3]) j++; const a = z[Math.max(0, i - 1)], b = z[Math.min(n - 1, j + 1)];
      for (let q = i; q <= j; q++) z[q] = Math.max(z[q], a + (b - a) * (q - i + 1) / (j - i + 2)); i = j + 1; }
    const k = { id: ++KID, pts, x, y, cum, z, tun, len: cum[n - 1], einweg: st.einweg, rampe: st.rampe, art: st.art, mitte: pts[n >> 1], erst: kette[0], letzt: kette[n - 1] };
    for (const o of kette) o.k = k;
    ketten.push(k);
  }
  // Nachfolger: am Kettenende den nächsten Punkt in Fahrtrichtung suchen (auch auf bereits vergebenen Punkten)
  for (const k of ketten) {
    const n = k.pts.length, dEx = (k.x[n - 1] - k.x[n - 2]), dEy = (k.y[n - 1] - k.y[n - 2]);
    const ende = (o, dx, dy) => { const l = Math.hypot(dx, dy) || 1, q = naechster(o, dx / l, -dy / l, false); return q && q.k && q.k !== k ? q : null; };   // Mercator-y nach Süden, lokale y nach Norden
    const qv = ende(k.letzt, dEx, dEy); k.vor = qv ? qv.k : null; k.vorR = qv && qv === qv.k.erst ? 1 : qv && qv === qv.k.letzt ? -1 : 0; if (!k.vorR) k.vor = null;
    const dAx = (k.x[0] - k.x[1]), dAy = (k.y[0] - k.y[1]);
    const qr = !k.einweg ? ende(k.erst, dAx, dAy) : null; k.rueck = qr ? qr.k : null; k.rueckR = qr && qr === qr.k.letzt ? -1 : qr && qr === qr.k.erst ? 1 : 0; if (!k.rueckR) k.rueck = null;
  }
  VK.ketten = ketten; for (const k of ketten) zuordnen(k); lageZeichnen(); fahrzeugeVerteilen();
}
// je Punkt der Kette die nächste Messstelle (bis 15 km; Verkehrslage nur bis 6 km) – hängt nur vom Ort ab, nicht davon,
// wie die Kette gerade zusammengesetzt ist (sonst ändern sich Dichte und Tempo beim Verschieben)
function zuordnen(k) {
  const n = k.pts.length, faktor = k.rampe ? .12 : k.art === "trunk" ? .45 : 1;
  k.qa = new Float32Array(n); k.va = new Float32Array(n); k.lkwa = new Float32Array(n); k.lagea = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = k.pts[i]; let best = null, bd = 15000;
    for (const s of VK.stellen) { const d = Math.hypot((s.lon - p[0]) * 75500, (s.lat - p[1]) * 111000); if (d < bd && s.q !== null) { bd = d; best = s; } }
    k.qa[i] = (best ? best.q : 1400) * faktor; k.va[i] = best && best.v ? Math.max(5, best.v) : k.rampe ? 60 : 100; k.lkwa[i] = best ? best.lkw || .08 : .08; k.lagea[i] = best && bd < 6000 && best.v ? best.v : NaN;
  }
  let n0 = 0; for (let i = 1; i < n; i++) n0 += ((k.qa[i - 1] + k.qa[i]) / 4) / ((k.va[i - 1] + k.va[i]) / 2) * (k.cum[i] - k.cum[i - 1]) / 1000;
  k.n = n0; k.v = k.va[n >> 1];
}
const idxBei = (k, s) => { let lo = 0, hi = k.cum.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (k.cum[m] <= s) lo = m; else hi = m; } return lo; };
function lageZeichnen() {
  const map = K.map, src = map && map.getSource("verkehr-lage"); if (!src) return;
  const kat = v => isNaN(v) ? -1 : v >= 70 ? 2 : v >= 40 ? 1 : 0, feats = [];
  if (VK.an) for (const k of VK.ketten) { if (k.rampe) continue; let start = 0;
    for (let i = 1; i <= k.pts.length; i++) if (i === k.pts.length || kat(k.lagea[i]) !== kat(k.lagea[start])) {
      if (kat(k.lagea[start]) >= 0 && i - start >= 1) feats.push({ type: "Feature", properties: { v: k.lagea[start] }, geometry: { type: "LineString", coordinates: k.pts.slice(start, Math.min(k.pts.length, i + 1)).map(p => [p[0], p[1]]) } });
      start = i; } }
  src.setData(fc(feats));
}

// ---- Fahrzeuge: je Kette und Richtung so viele, wie gemessen (begrenzt), gleichmässig verteilt mit etwas Zufall ----
const FARBEN = ["#e9ecef", "#2b2f33", "#8a9097", "#c92a2a", "#1c5aa6", "#d0d4d8", "#5c6b3c", "#7a2e2e", "#f1f3f5", "#3b4652"];
let FZ = [];
// Bestehende Fahrzeuge bleiben erhalten: nach jedem Neuaufbau der Ketten (Verschieben, neue Kacheln, neue Messwerte)
// wird jedes Fahrzeug auf die neue Kette an seiner Stelle gesetzt (gleiche Richtung, ≤ 20 m). Nur wo zu wenige oder
// zu viele sind, kommen Fahrzeuge dazu oder fallen weg – so springen sie beim Verschieben nicht.
function lage(f) {   // Mercator-Lage (Mitte der Strasse) und Fahrtrichtung eines Fahrzeugs
  const k = f.k; let lo = 0, hi = k.cum.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (k.cum[m] <= f.s) lo = m; else hi = m; }
  const u = (f.s - k.cum[lo]) / ((k.cum[hi] - k.cum[lo]) || 1);
  return { x: k.x[lo] + (k.x[hi] - k.x[lo]) * u, y: k.y[lo] + (k.y[hi] - k.y[lo]) * u, dx: (k.x[hi] - k.x[lo]) * f.r, dy: (k.y[hi] - k.y[lo]) * f.r };
}
function neuesFz(k, r, s) {
  const i = idxBei(k, s), lkw = Math.random() < k.lkwa[i], vk = k.va[i], spur = k.einweg ? (Math.random() < (lkw ? .85 : .5) ? 1.75 : -1.75) : (lkw ? 1.9 : Math.random() < .5 ? 1.9 : 5.4);
  const faktor = lkw ? Math.min(1, 85 / Math.max(10, vk)) : .9 + Math.random() * .2;
  return { k, r, s, faktor, v: vk / 3.6 * faktor, spur, lkw, farbe: FARBEN[(Math.random() * FARBEN.length) | 0] };
}
function fahrzeugeVerteilen() {
  const soll = new Map(); let summe = 0;
  for (const k of VK.ketten) for (const r of k.einweg ? [1] : [1, -1]) { const n = k.n; soll.set(k.id + "|" + r, { k, r, n, fz: [] }); summe += n; }
  const fak = summe > N_MAX ? N_MAX / summe : 1;
  // Raster der neuen Ketten (Zellen ~50 m in Mercator)
  const Z = 50 * ankerMs, raster = new Map();
  for (const k of VK.ketten) for (let i = 1; i < k.x.length; i++) {
    const a = Math.floor(Math.min(k.x[i - 1], k.x[i]) / Z), b = Math.floor(Math.max(k.x[i - 1], k.x[i]) / Z), c = Math.floor(Math.min(k.y[i - 1], k.y[i]) / Z), d = Math.floor(Math.max(k.y[i - 1], k.y[i]) / Z);
    if ((b - a + 1) * (d - c + 1) > 400) continue;
    for (let gx = a; gx <= b; gx++) for (let gy = c; gy <= d; gy++) { const key = gx + "," + gy; (raster.get(key) || raster.set(key, []).get(key)).push([k, i]); }
  }
  for (const f of FZ) {
    if (!f.k || !f.k.x) continue; const L = lage(f), gx = Math.floor(L.x / Z), gy = Math.floor(L.y / Z), dl = Math.hypot(L.dx, L.dy) || 1;
    let best = null, bd = 20 * ankerMs;
    for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) for (const [k, i] of raster.get((gx + ox) + "," + (gy + oy)) || []) {
      const ax = k.x[i - 1], ay = k.y[i - 1], ex = k.x[i] - ax, ey = k.y[i] - ay, l2 = ex * ex + ey * ey || 1e-18; let t = ((L.x - ax) * ex + (L.y - ay) * ey) / l2; t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(ax + ex * t - L.x, ay + ey * t - L.y); if (d >= bd) continue;
      const cos = (ex * L.dx + ey * L.dy) / (Math.sqrt(l2) * dl), r = cos > .6 ? 1 : cos < -.6 && !k.einweg ? -1 : 0; if (!r) continue;
      bd = d; best = [k, r, k.cum[i - 1] + (k.cum[i] - k.cum[i - 1]) * t];
    }
    if (!best) continue; const e = soll.get(best[0].id + "|" + best[1]); if (!e) continue;
    f.k = best[0]; f.r = best[1]; f.s = best[2]; f.v = f.k.va[idxBei(f.k, f.s)] / 3.6 * (f.faktor || 1); e.fz.push(f);
  }
  const neu = [];
  for (const e of soll.values()) {
    const m = e.n * fak, ziel = Math.floor(m) + (Math.random() < m - Math.floor(m) ? 1 : 0);
    if (e.fz.length > ziel + 1) { e.fz.sort(() => Math.random() - .5); e.fz.length = ziel; }
    for (const f of e.fz) neu.push(f);
    // fehlende Fahrzeuge in die grössten Lücken setzen
    const fehlt = ziel - e.fz.length;
    if (fehlt > 0) {
      const ss = e.fz.map(f => f.s).sort((a, b) => a - b);
      for (let q = 0; q < fehlt; q++) {
        let s;
        if (ss.length < 2) s = Math.random() * e.k.len;
        else { let gi = 0, gl = -1; for (let i = 0; i < ss.length; i++) { const l = (i + 1 < ss.length ? ss[i + 1] : ss[0] + e.k.len) - ss[i]; if (l > gl) { gl = l; gi = i; } } s = (ss[gi] + gl * (.35 + Math.random() * .3)) % e.k.len; }
        ss.push(s); ss.sort((a, b) => a - b); neu.push(neuesFz(e.k, e.r, s));
      }
    }
  }
  FZ = neu; VK.fz = FZ;
}

// ---- Zeichnen (three.js): herausgezoomt Punkte, ab Zoom 13 Fahrzeugmodelle ----
const ZOOM_3D = 13;
function autoGeo(L, b, h, lkw) {
  const g = new THREE.BoxGeometry(L, b, h); g.translate(0, 0, h / 2 + .25);
  if (lkw) return g;
  const d = new THREE.BoxGeometry(L * .5, b * .9, h * .55); d.translate(-L * .05, 0, h + .25 + h * .27);
  const pos = [...g.attributes.position.array, ...d.attributes.position.array], nor = [...g.attributes.normal.array, ...d.attributes.normal.array];
  const idx = [...g.index.array, ...d.index.array.map(i => i + g.attributes.position.count)];
  const m = new THREE.BufferGeometry(); m.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); m.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3)); m.setIndex(idx); return m;
}
function ebene3d() {
  return {
    id: "verkehr3d", type: "custom", renderingMode: "3d",
    onAdd(m, gl) {
      this.cam = new THREE.Camera(); this.szene = new THREE.Scene();
      this.szene.add(new THREE.HemisphereLight(0xffffff, 0x7d8a96, 1.8)); const d = new THREE.DirectionalLight(0xffffff, 1.3); d.position.set(-.5, -.4, .9); this.szene.add(d);
      this.r = new THREE.WebGLRenderer({ canvas: m.getCanvas(), context: gl, antialias: true }); this.r.autoClear = false;
      const mat = new THREE.MeshLambertMaterial();
      this.autos = new THREE.InstancedMesh(autoGeo(4.4, 1.8, .85, false), mat, N_MAX); this.lkws = new THREE.InstancedMesh(autoGeo(14, 2.5, 3.2, true), mat, N_MAX);
      for (const x of [this.autos, this.lkws]) { x.frustumCulled = false; x.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(N_MAX * 3).fill(1), 3); this.szene.add(x); }
      this.pp = new Float32Array(N_MAX * 3); this.pc = new Float32Array(N_MAX * 3); this.pg = new THREE.BufferGeometry();
      this.pg.setAttribute("position", new THREE.BufferAttribute(this.pp, 3)); this.pg.setAttribute("color", new THREE.BufferAttribute(this.pc, 3));
      this.punkte = new THREE.Points(this.pg, new THREE.PointsMaterial({ vertexColors: true, size: 3.2, sizeAttenuation: false })); this.punkte.frustumCulled = false; this.szene.add(this.punkte);
      this.M = new THREE.Matrix4(); this.Q = new THREE.Quaternion(); this.E = new THREE.Euler(); this.V = new THREE.Vector3(); this.Sk = new THREE.Vector3(1, 1, 1); this.C = new THREE.Color();
      this.t = performance.now();
    },
    render(gl, args) {
      const map = K.map, jetzt = performance.now(), dt = Math.min(.25, (jetzt - this.t) / 1000) * (S.speed > 0 ? 1 : 0); this.t = jetzt;
      this.autos.count = this.lkws.count = 0; this.punkte.visible = false;
      if (!VK.an || !FZ.length || map.getZoom() < 8) return;
      const c = mc(map.getCenter()), ms = c.meterInMercatorCoordinateUnits(), nah = map.getZoom() >= ZOOM_3D, Tr = map.getTerrain();
      let na = 0, nl = 0, np = 0;
      for (const f of FZ) {
        let k = f.k; f.s += f.r * f.v * dt; if (f.s > k.len) { if (k.vor && f.r === 1) { const n = k.vor; f.s -= k.len; f.r = k.vorR; if (f.r < 0) f.s = n.len - f.s; f.k = n; } else f.s -= k.len; }   // weiter auf der nächsten Kette, sonst von vorne
        else if (f.s < 0) { if (k.rueck && f.r === -1) { const n = k.rueck; f.r = k.rueckR; f.s = f.r < 0 ? n.len + f.s : -f.s; f.k = n; } else f.s += k.len; }
        k = f.k; if (f.s < 0 || f.s > k.len) f.s = Math.max(0, Math.min(k.len, f.s));
        // Lage auf der Kette (Binärsuche)
        let lo = 0, hi = k.cum.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (k.cum[m] <= f.s) lo = m; else hi = m; }
        if (k.tun[lo] && k.tun[hi]) continue;   // im Tunnel unsichtbar
        f.v = k.va[lo] / 3.6 * (f.faktor || 1);   // Tempo der Messstelle an dieser Stelle
        const u = (f.s - k.cum[lo]) / ((k.cum[hi] - k.cum[lo]) || 1), dx = (k.x[hi] - k.x[lo]) / ankerMs, dy = (k.y[hi] - k.y[lo]) / ankerMs, l = Math.hypot(dx, dy) || 1;
        const nx = -dy / l * f.r, ny = dx / l * f.r;   // rechts in Fahrtrichtung (y nach Süden: Normale so gedreht, dass Rechtsverkehr entsteht)
        const px = (k.x[lo] + (k.x[hi] - k.x[lo]) * u - c.x) / ms + nx * f.spur, py = (k.y[lo] + (k.y[hi] - k.y[lo]) * u - c.y) / ms + ny * f.spur, pz = Tr ? k.z[lo] + (k.z[hi] - k.z[lo]) * u : 0;
        if (nah) {
          const ziel = f.lkw ? this.lkws : this.autos, i = f.lkw ? nl++ : na++;
          this.E.set(0, Math.atan2(k.z[hi] - k.z[lo], (k.cum[hi] - k.cum[lo]) || 1) * -f.r, Math.atan2(dy * f.r, dx * f.r), "ZYX"); this.Q.setFromEuler(this.E); this.V.set(px, py, pz); this.M.compose(this.V, this.Q, this.Sk);
          ziel.setMatrixAt(i, this.M); ziel.setColorAt(i, this.C.set(f.lkw ? "#d9dcdf" : f.farbe));
        } else {
          const q = np * 3; this.pp[q] = px; this.pp[q + 1] = py; this.pp[q + 2] = pz + 2;
          const v = k.lagea[lo]; this.C.set(isNaN(v) ? "#5b6670" : v >= 70 ? "#2f9e44" : v >= 40 ? "#f08c00" : "#e03131"); this.pc[q] = this.C.r; this.pc[q + 1] = this.C.g; this.pc[q + 2] = this.C.b; np++;
        }
      }
      if (nah) { this.autos.count = na; this.lkws.count = nl; for (const x of [this.autos, this.lkws]) { x.instanceMatrix.needsUpdate = true; if (x.instanceColor) x.instanceColor.needsUpdate = true; } }
      else { this.pg.setDrawRange(0, np); this.pg.attributes.position.needsUpdate = true; this.pg.attributes.color.needsUpdate = true; this.punkte.visible = true; this.punkte.material.size = map.getZoom() < 10 ? 2.2 : 3.2; }
      const mm = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix), lm = new THREE.Matrix4().makeTranslation(c.x, c.y, 0).scale(new THREE.Vector3(ms, ms, ms));
      this.cam.projectionMatrix = mm.multiply(lm); this.r.resetState(); this.r.render(this.szene, this.cam); map.triggerRepaint();
    },
  };
}

export function verkehrStarten() {
  const map = K.map;
  map.addSource("verkehr-lage", { type: "geojson", data: fc([]) });
  const vor = map.getLayer("bahn-hl") ? "bahn-hl" : undefined;
  map.addLayer({ id: "verkehr-lage", type: "line", source: "verkehr-lage", minzoom: 7, layout: { "line-cap": "round", "line-join": "round" }, paint: {
    "line-color": ["case", [">=", ["get", "v"], 70], "#2f9e44", [">=", ["get", "v"], 40], "#f08c00", "#e03131"],
    "line-width": ["interpolate", ["linear"], ["zoom"], 7, 2, 12, 4, 15, 7], "line-opacity": ["interpolate", ["linear"], ["zoom"], 7, .85, 13, .55, 15, .35] } }, vor);
  ladeThree().then(() => { try { map.addLayer(ebene3d(), map.getLayer("fz") ? "fz" : undefined); } catch (e) { console.error(e); } });
  let t = 0; const neu = () => { clearTimeout(t); t = setTimeout(bauen, 300); };
  map.on("moveend", neu); map.on("sourcedata", e => { if (quelle && e.sourceId === quelle && e.isSourceLoaded) neu(); }); neu();
  ebene({ id: "verkehr", name: "Verkehr (Autobahn)", an: true, setze: an => { VK.an = an; K.verkehrAus = !an; if (map.getLayer("verkehr-lage")) map.setLayoutProperty("verkehr-lage", "visibility", an && K.linienAn ? "visible" : "none"); neu(); map.triggerRepaint(); } });
  laden(); setInterval(laden, 60000);
}
