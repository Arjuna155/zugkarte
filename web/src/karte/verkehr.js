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

export const VK = { stellen: [], an: true, ketten: [], zeit: 0 };
const mc = ll => maplibregl.MercatorCoordinate.fromLngLat(ll);
const N_MAX = istHandy() ? 1800 : 5000;
let quelle = null, anker = null, ankerMs = 1;

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
  // Ketten: Stücke mit gemeinsamem Endpunkt (gleiche Art, Einweg) zusammenhängen
  const ende = new Map(), k5 = q => q[0].toFixed(5) + "," + q[1].toFixed(5);
  for (const s of stuecke) { for (const q of [s.ll[0], s.ll[s.ll.length - 1]]) { const k = k5(q); (ende.get(k) || ende.set(k, []).get(k)).push(s); } }
  const benutzt = new Set(), ketten = [];
  for (const s of stuecke) {
    if (benutzt.has(s)) continue; benutzt.add(s);
    let pts = s.ll.map(q => [q[0], q[1], s.tun, s.bru]);
    // höchstens ~4 km je Kette, damit jede Kette die Werte der Messstelle in ihrer Nähe bekommt
    const lang = q => { let m = 0; for (let i = 1; i < q.length; i++) m += Math.hypot((q[i][0] - q[i - 1][0]) * 75500, (q[i][1] - q[i - 1][1]) * 111000); return m; };
    const weiter = (vorne) => { for (let g = 0; g < 400; g++) { if (lang(pts) > 4000) return;
      const q = vorne ? pts[0] : pts[pts.length - 1], kand = (ende.get(k5(q)) || []).filter(t => !benutzt.has(t) && t.einweg === s.einweg && t.rampe === s.rampe); if (kand.length !== 1) return;
      const t = kand[0]; benutzt.add(t); let tp = t.ll.map(r => [r[0], r[1], t.tun, t.bru]);
      if (vorne) { if (k5(tp[tp.length - 1]) !== k5(q)) { if (s.einweg) return; tp.reverse(); } pts = tp.slice(0, -1).concat(pts); }
      else { if (k5(tp[0]) !== k5(q)) { if (s.einweg) return; tp.reverse(); } pts = pts.concat(tp.slice(1)); }
    } };
    weiter(false); weiter(true);
    // lokale Meter (relativ zum Anker), Länge, Höhe (Gelände; Brücken gerade zwischen den Enden, Tunnels ohne Fahrzeuge)
    const n = pts.length, x = new Float64Array(n), y = new Float64Array(n), cum = new Float64Array(n), z = new Float32Array(n), tun = new Uint8Array(n);
    for (let i = 0; i < n; i++) { const m = mc([pts[i][0], pts[i][1]]); x[i] = m.x; y[i] = m.y; tun[i] = pts[i][2] ? 1 : 0; if (i) cum[i] = cum[i - 1] + Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]) / ankerMs;
      const e = ex ? map.queryTerrainElevation([pts[i][0], pts[i][1]]) : 0; z[i] = e === null || e === undefined ? NaN : e; }
    for (let i = 0; i < n; i++) if (isNaN(z[i])) z[i] = i ? z[i - 1] : 0;
    for (let i = 0; i < n;) { if (!pts[i][3]) { i++; continue; } let j = i; while (j + 1 < n && pts[j + 1][3]) j++; const a = z[Math.max(0, i - 1)], b = z[Math.min(n - 1, j + 1)];
      for (let q = i; q <= j; q++) z[q] = Math.max(z[q], a + (b - a) * (q - i + 1) / (j - i + 2)); i = j + 1; }
    if (cum[n - 1] < 30) continue;
    const mitte = pts[n >> 1]; ketten.push({ pts, x, y, cum, z, tun, len: cum[n - 1], einweg: s.einweg, rampe: s.rampe, art: s.art, mitte });
  }
  VK.ketten = ketten; for (const k of ketten) zuordnen(k); lageZeichnen(); fahrzeugeVerteilen();
}
// nächste Messstelle (bis 15 km; Verkehrslage nur bis 6 km)
function zuordnen(k) {
  let best = null, bd = 15000;
  for (const s of VK.stellen) { const d = Math.hypot((s.lon - k.mitte[0]) * 75500, (s.lat - k.mitte[1]) * 111000); if (d < bd && s.q !== null) { bd = d; best = s; } }
  const faktor = k.rampe ? .12 : k.art === "trunk" ? .45 : 1;
  k.q = (best ? best.q : 1400) * faktor; k.v = best && best.v ? best.v : k.rampe ? 60 : 100; k.lkw = best ? best.lkw || .08 : .08; k.lage = best && bd < 6000 && best.v ? best.v : null;
}
function lageZeichnen() {
  const map = K.map, src = map && map.getSource("verkehr-lage"); if (!src) return;
  src.setData(fc(VK.an ? VK.ketten.filter(k => k.lage !== null && !k.rampe).map(k => ({ type: "Feature", properties: { v: k.lage }, geometry: { type: "LineString", coordinates: k.pts.map(p => [p[0], p[1]]) } })) : []));
}

// ---- Fahrzeuge: je Kette und Richtung so viele, wie gemessen (begrenzt), gleichmässig verteilt mit etwas Zufall ----
const FARBEN = ["#e9ecef", "#2b2f33", "#8a9097", "#c92a2a", "#1c5aa6", "#d0d4d8", "#5c6b3c", "#7a2e2e", "#f1f3f5", "#3b4652"];
let FZ = [];
function fahrzeugeVerteilen() {
  const soll = [];
  let summe = 0;
  for (const k of VK.ketten) { const richtungen = k.einweg ? [1] : [1, -1]; for (const r of richtungen) { const n = (k.q / 2) / Math.max(10, k.v) * k.len / 1000; soll.push([k, r, n]); summe += n; } }
  const f = summe > N_MAX ? N_MAX / summe : 1; FZ = [];
  for (const [k, r, n] of soll) {
    let m = n * f; const ganz = Math.floor(m) + (Math.random() < m - Math.floor(m) ? 1 : 0);
    for (let i = 0; i < ganz; i++) {
      const lkw = Math.random() < k.lkw, spur = k.einweg ? (Math.random() < (lkw ? .85 : .5) ? 1.75 : -1.75) : (lkw ? 1.9 : Math.random() < .5 ? 1.9 : 5.4);
      FZ.push({ k, r, s: (i + Math.random() * .8) / Math.max(1, ganz) * k.len, v: k.v / 3.6 * (lkw ? Math.min(1, 85 / Math.max(10, k.v)) : .9 + Math.random() * .2), spur, lkw, farbe: FARBEN[(Math.random() * FARBEN.length) | 0] });
    }
  }
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
        const k = f.k; f.s += f.r * f.v * dt; if (f.s > k.len) f.s -= k.len; else if (f.s < 0) f.s += k.len;   // am Kettenende von vorne
        // Lage auf der Kette (Binärsuche)
        let lo = 0, hi = k.cum.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (k.cum[m] <= f.s) lo = m; else hi = m; }
        if (k.tun[lo] && k.tun[hi]) continue;   // im Tunnel unsichtbar
        const u = (f.s - k.cum[lo]) / ((k.cum[hi] - k.cum[lo]) || 1), dx = (k.x[hi] - k.x[lo]) / ankerMs, dy = (k.y[hi] - k.y[lo]) / ankerMs, l = Math.hypot(dx, dy) || 1;
        const nx = -dy / l * f.r, ny = dx / l * f.r;   // rechts in Fahrtrichtung (y nach Süden: Normale so gedreht, dass Rechtsverkehr entsteht)
        const px = (k.x[lo] + (k.x[hi] - k.x[lo]) * u - c.x) / ms + nx * f.spur, py = (k.y[lo] + (k.y[hi] - k.y[lo]) * u - c.y) / ms + ny * f.spur, pz = Tr ? k.z[lo] + (k.z[hi] - k.z[lo]) * u : 0;
        if (nah) {
          const ziel = f.lkw ? this.lkws : this.autos, i = f.lkw ? nl++ : na++;
          this.E.set(0, Math.atan2(k.z[hi] - k.z[lo], (k.cum[hi] - k.cum[lo]) || 1) * -f.r, Math.atan2(dy * f.r, dx * f.r), "ZYX"); this.Q.setFromEuler(this.E); this.V.set(px, py, pz); this.M.compose(this.V, this.Q, this.Sk);
          ziel.setMatrixAt(i, this.M); ziel.setColorAt(i, this.C.set(f.lkw ? "#d9dcdf" : f.farbe));
        } else {
          const q = np * 3; this.pp[q] = px; this.pp[q + 1] = py; this.pp[q + 2] = pz + 2;
          const v = k.v; this.C.set(k.lage === null ? "#5b6670" : v >= 70 ? "#2f9e44" : v >= 40 ? "#f08c00" : "#e03131"); this.pc[q] = this.C.r; this.pc[q + 1] = this.C.g; this.pc[q + 2] = this.C.b; np++;
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
  ebene({ id: "verkehr", name: "Verkehr (Autobahn)", an: true, setze: an => { VK.an = an; if (map.getLayer("verkehr-lage")) map.setLayoutProperty("verkehr-lage", "visibility", an ? "visible" : "none"); neu(); map.triggerRepaint(); } });
  laden(); setInterval(laden, 60000);
}
