// 3D-Welt, erste Fassung: Gebäude (Höhen aus den swisstopo-Vektorkacheln), Brücken und Tunnelportale.
// Alles kommt aus den Kacheln, die die Grundkarte ohnehin lädt – keine zusätzlichen Daten. Brücken und Portale baut
// three.js nach jedem Verschieben für den sichtbaren Ausschnitt neu (ab Zoom 14, nur mit Gelände).
import { K } from "./karte.js";
import { ladeThree, szeneMitLicht } from "./drei.js";
import { ebene } from "../ui/ebenen.js";
import { FASSADE, ZD, H_MIN, H_MAX, DACH_ANTEIL, DACH_MIN, DACH_MAX } from "./daecher.js";

export const W3 = { an: true, gebaeudeAn: true, gebaeude: false, bauwerke: 0, quelle: null };
const ZOOM_GEBAEUDE = 14, ZOOM_BAUWERKE = 14;

// Quelle und Ebenennamen der Grundkarte suchen (Namen hängen von der Stilversion ab)
function grundquelle(map) {
  const st = map.getStyle(); let quelle = null, gebaeude = null, verkehr = null;
  for (const l of st.layers) {
    if (l["source-layer"] === "building" && !gebaeude) { gebaeude = l; quelle = l.source; }
    if (l["source-layer"] === "transportation" && !verkehr) verkehr = l;
  }
  return { quelle: quelle || (verkehr && verkehr.source), gebaeude, verkehr: verkehr ? "transportation" : null };
}

// ---- Gebäude: Höhe «render_height» (Mittel), Unterkante «render_min_height» ----
const H_EXPR = ["to-number", ["coalesce", ["get", "render_height"], ["get", "height"], 8]];
function gebaeudeAn(map, g) {
  if (!g.gebaeude || map.getLayer("gebaeude-3d")) return;
  const vor = map.getLayer("schiff") ? "schiff" : undefined;
  map.addLayer({
    id: "gebaeude-3d", type: "fill-extrusion", source: g.quelle, "source-layer": "building", minzoom: ZOOM_GEBAEUDE,
    paint: {
      "fill-extrusion-color": ["case", [">", ["coalesce", ["get", "render_height"], 8], 22], ["interpolate", ["linear"], ["coalesce", ["get", "render_height"], 8], 22, "#dedad3", 80, "#d3d0ca"],
        ["to-color", ["at", ["%", ["abs", ["round", ["to-number", ["id"], 0]]], 6], ["literal", FASSADE]]]],   // Fassaden wie die Giebel der Dächer (daecher.js)
      // ab Zoom ZD enden die Mauern der Häuser an der Traufe – das Dach (daecher.js) reicht bis zur Gesamthöhe
      "fill-extrusion-height": ["interpolate", ["linear"], ["zoom"], ZOOM_GEBAEUDE, 0, ZOOM_GEBAEUDE + .6, H_EXPR, ZD - .05, H_EXPR, ZD + .05,
        ["case", ["all", [">=", H_EXPR, H_MIN], ["<=", H_EXPR, H_MAX], ["<=", ["coalesce", ["get", "render_min_height"], ["get", "min_height"], 0], 0]],
          ["-", H_EXPR, ["max", DACH_MIN, ["min", DACH_MAX, ["*", DACH_ANTEIL, H_EXPR]]]], H_EXPR]],
      "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], ["get", "min_height"], 0],
      "fill-extrusion-opacity": .93, "fill-extrusion-vertical-gradient": true
    }
  }, vor);
  W3.gebaeude = true;
}

// ---- Brücken und Tunnelportale ----
// Breite nach Art (Meter); Fusswege, Feldwege usw. werden weggelassen
const BREITE = { rail: 6, transit: 5, motorway: 13, trunk: 11, primary: 9, secondary: 8, tertiary: 7, minor: 6 };
const HOEHE_PORTAL = { rail: 7.5, transit: 6.5 };
const FARBE = { deck: [.73, .72, .69], seite: [.62, .61, .58], bruestung: [.80, .79, .76], pfeiler: [.64, .63, .60], portal: [.69, .67, .63], loch: [.11, .12, .13] };
const lin = c => c.map(v => v <= .04045 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4));
for (const k in FARBE) FARBE[k] = lin(FARBE[k]);

function Geo() { this.p = []; this.n = []; this.c = []; }
Geo.prototype.quad = function (a, b, c, d, col) {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
  let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]; const l = Math.hypot(...n) || 1; n = n.map(x => x / l);
  for (const q of [a, b, c, a, c, d]) { this.p.push(...q); this.n.push(...n); this.c.push(...col); }
};
// Quader zwischen zwei Punkten (Grundriss entlang a→b, Breite w), von z0 bis z1 an beiden Enden (za0/za1, zb0/zb1)
Geo.prototype.balken = function (a, b, w, za0, za1, zb0, zb1, colOben, colSeite) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1, nx = -dy / L * w / 2, ny = dx / L * w / 2;
  const A0 = [a[0] + nx, a[1] + ny], A1 = [a[0] - nx, a[1] - ny], B0 = [b[0] + nx, b[1] + ny], B1 = [b[0] - nx, b[1] - ny];
  const P = (q, z) => [q[0], q[1], z];
  this.quad(P(A0, za1), P(B0, zb1), P(B1, zb1), P(A1, za1), colOben);
  this.quad(P(A0, za0), P(B0, zb0), P(B0, zb1), P(A0, za1), colSeite);
  this.quad(P(A1, za1), P(B1, zb1), P(B1, zb0), P(A1, za0), colSeite);
  this.quad(P(A1, za0), P(B1, zb0), P(B0, zb0), P(A0, za0), colSeite);
};

const mc = ll => maplibregl.MercatorCoordinate.fromLngLat(ll);
// Kacheln liefern Linien in Stücken (an Kachelgrenzen geschnitten, mit Überlappung). Für die Höhe einer Brücke zählt nur,
// wo sie wirklich beginnt und endet: ein echtes Ende hat eine gleichartige Strasse/Bahn ohne Brücke als Fortsetzung.
function bauwerkeBauen(map, g) {
  const feats = map.querySourceFeatures(g.quelle, { sourceLayer: "transportation" });
  const c = map.getCenter(), o = mc(c), ms = o.meterInMercatorCoordinateUnits();
  const lokal = ([lng, lat]) => { const m = mc([lng, lat]); return [(m.x - o.x) / ms, (m.y - o.y) / ms]; };
  const hoehe = p => { const e = map.queryTerrainElevation(p); return e == null ? null : e; };
  // normale (Nicht-Brücken-)Strecken je Art in einem Raster (für «echtes Ende?»)
  const raster = new Map(), R = 20, rk = (x, y) => Math.floor(x / R) + "," + Math.floor(y / R);
  const stuecke = [];
  for (const f of feats) {
    const p = f.properties, art = p.class; if (!BREITE[art]) continue;
    const linien = f.geometry.type === "LineString" ? [f.geometry.coordinates] : f.geometry.type === "MultiLineString" ? f.geometry.coordinates : [];
    for (const ll of linien) {
      if (ll.length < 2) continue;
      if (p.brunnel === "bridge" || p.brunnel === "tunnel") stuecke.push({ art, typ: p.brunnel, ll, xy: ll.map(lokal) });
      else for (const q of ll.map(lokal)) { const k = rk(q[0], q[1]); (raster.get(k) || raster.set(k, []).get(k)).push(art); }
    }
  }
  const fortsetzung = (q, art) => { for (let dx = -1; dx <= 1; dx++)for (let dy = -1; dy <= 1; dy++) { const a = raster.get((Math.floor(q[0] / R) + dx) + "," + (Math.floor(q[1] / R) + dy)); if (a && a.includes(art)) return true; } return false; };
  // doppelte Stücke (Überlappung an Kachelgrenzen) nur einmal
  const gesehen = new Set(); const G = new Geo(); let n = 0;
  for (const s of stuecke) {
    const key = s.typ + s.art + s.xy.map(q => Math.round(q[0]) + ":" + Math.round(q[1])).join("|"); if (gesehen.has(key)) continue; gesehen.add(key);
    const w = BREITE[s.art];
    if (s.typ === "tunnel") {   // Portal an echten Enden: Rahmen quer zur Fahrrichtung, dunkle Öffnung
      if (!HOEHE_PORTAL[s.art] && !["motorway", "trunk", "primary"].includes(s.art)) continue;
      const hP = HOEHE_PORTAL[s.art] || 7;
      for (const [i, j] of [[0, 1], [s.xy.length - 1, s.xy.length - 2]]) {
        const a = s.xy[i], b = s.xy[j]; if (!fortsetzung(a, s.art)) continue;
        const z = hoehe(s.ll[i]); if (z == null) continue;
        const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L, nx = -uy, ny = ux, B = w / 2 + 1.6;
        const P = (q, t) => [a[0] + ux * t + nx * q, a[1] + uy * t + ny * q];   // q quer, t längs (in den Berg)
        G.balken(P(B - .1, -.4), P(B - .1, 2.5), 1.6, z - 1, z + hP + 1.2, z - 1, z + hP + 1.2, FARBE.portal, FARBE.portal);
        G.balken(P(-B + .1, -.4), P(-B + .1, 2.5), 1.6, z - 1, z + hP + 1.2, z - 1, z + hP + 1.2, FARBE.portal, FARBE.portal);
        G.balken(P(0, -.4), P(0, 2.5), 2 * B + 1.6, z + hP, z + hP + 1.2, z + hP, z + hP + 1.2, FARBE.portal, FARBE.portal);
        G.balken(P(0, .2), P(0, 2.4), 2 * B - 1.6, z - .5, z + hP, z - .5, z + hP, FARBE.loch, FARBE.loch);   // Öffnung (dunkel)
        n++;
      }
      continue;
    }
    // Brücke: Gelände entlang des Stücks (± 150 m Verlängerung), Fahrbahn auf «Wasserstand» zwischen den Talseiten
    const pts = s.xy, m = pts.length, d = [0]; for (let i = 1; i < m; i++)d.push(d[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const ter = s.ll.map(hoehe); if (ter.some(z => z == null)) continue;
    const ext = (i0, i1, dist) => { const a = s.ll[i0], b = s.ll[i1], z = []; for (let t = 25; t <= dist; t += 25) { const f = t / (Math.hypot(pts[i0][0] - pts[i1][0], pts[i0][1] - pts[i1][1]) || 1); const e = hoehe([a[0] + (a[0] - b[0]) * f, a[1] + (a[1] - b[1]) * f]); if (e != null) z.push(e); } return z; };
    const anfangEcht = fortsetzung(pts[0], s.art), endeEcht = fortsetzung(pts[m - 1], s.art);
    const links = anfangEcht ? ter[0] : Math.max(ter[0], ...ext(0, 1, 150)), rechts = endeEcht ? ter[m - 1] : Math.max(ter[m - 1], ...ext(m - 1, m - 2, 150));
    const zf = []; let ml = links; for (let i = 0; i < m; i++) { ml = Math.max(ml, ter[i]); zf.push(ml); }
    let mr = rechts; for (let i = m - 1; i >= 0; i--) { mr = Math.max(mr, ter[i]); zf[i] = Math.min(zf[i], mr) + .3; }
    for (let i = 1; i < m; i++) {
      const a = pts[i - 1], b = pts[i], za = zf[i - 1], zb = zf[i];
      G.balken(a, b, w, za - 1.3, za, zb - 1.3, zb, FARBE.deck, FARBE.seite);   // Fahrbahn
      for (const sg of [1, -1]) {   // Brüstungen
        const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1, ox = -dy / L * (w / 2 - .15) * sg, oy = dx / L * (w / 2 - .15) * sg;
        G.balken([a[0] + ox, a[1] + oy], [b[0] + ox, b[1] + oy], .3, za, za + 1.1, zb, zb + 1.1, FARBE.bruestung, FARBE.bruestung);
      }
    }
    // Pfeiler etwa alle 35 m, wo die Fahrbahn mehr als 4 m über dem Gelände liegt
    for (let t = 17; t < d[m - 1]; t += 35) {
      let i = 1; while (i < m - 1 && d[i] < t) i++; const u = (t - d[i - 1]) / ((d[i] - d[i - 1]) || 1);
      const q = [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * u, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * u];
      const zDeck = zf[i - 1] + (zf[i] - zf[i - 1]) * u, ll = [s.ll[i - 1][0] + (s.ll[i][0] - s.ll[i - 1][0]) * u, s.ll[i - 1][1] + (s.ll[i][1] - s.ll[i - 1][1]) * u];
      const zg = hoehe(ll); if (zg == null || zDeck - zg < 4) continue;
      const dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1], L = Math.hypot(dx, dy) || 1, ux = dx / L * 1.2, uy = dy / L * 1.2;
      G.balken([q[0] - ux, q[1] - uy], [q[0] + ux, q[1] + uy], w * .55, zg - 2, zDeck - 1.3, zg - 2, zDeck - 1.3, FARBE.pfeiler, FARBE.pfeiler);
    }
    n++;
  }
  return { G, o, n };
}

function bauwerkEbene() {
  return {
    id: "bauwerke-3d", type: "custom", renderingMode: "3d",
    onAdd(m, gl) {
      this.cam = new THREE.Camera(); this.szene = szeneMitLicht(); this.mesh = null; this.o = null;
      this.r = new THREE.WebGLRenderer({ canvas: m.getCanvas(), context: gl, antialias: true }); this.r.autoClear = false; this.r.outputColorSpace = THREE.SRGBColorSpace;
      this.mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    },
    setze(G, o) {
      if (this.mesh) { this.szene.remove(this.mesh); this.mesh.geometry.dispose(); this.mesh = null; }
      this.o = o; if (!G.p.length) return;
      const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(G.p, 3)); g.setAttribute("normal", new THREE.Float32BufferAttribute(G.n, 3)); g.setAttribute("color", new THREE.Float32BufferAttribute(G.c, 3));
      this.mesh = new THREE.Mesh(g, this.mat); this.mesh.frustumCulled = false; this.szene.add(this.mesh);
    },
    render(gl, args) {
      const map = K.map; if (!W3.an || !this.mesh || !this.o || map.getZoom() < ZOOM_BAUWERKE || !map.getTerrain()) return;
      const s = this.o.meterInMercatorCoordinateUnits();
      const m = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix), l = new THREE.Matrix4().makeTranslation(this.o.x, this.o.y, this.o.z).scale(new THREE.Vector3(s, s, s));
      this.cam.projectionMatrix = m.multiply(l); this.r.resetState(); this.r.render(this.szene, this.cam);
    }
  };
}

export function welt3dStarten() {
  const map = K.map, g = grundquelle(map); W3.quelle = g.quelle;
  if (!g.quelle) return;
  gebaeudeAn(map, g);
  ebene({ id: "gebaeude", name: "Gebäude (3D)", an: true, setze: an => { W3.gebaeudeAn = an; if (map.getLayer("gebaeude-3d")) map.setLayoutProperty("gebaeude-3d", "visibility", an ? "visible" : "none"); } });
  let schicht = null, laedt = false, timer = 0;
  const neu = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (!W3.an || map.getZoom() < ZOOM_BAUWERKE || !map.getTerrain() || !g.verkehr) return;
      if (!schicht) { if (laedt) return; laedt = true; await ladeThree(); schicht = bauwerkEbene(); map.addLayer(schicht, map.getLayer("fz") ? "fz" : undefined); }
      const { G, o, n } = bauwerkeBauen(map, g); schicht.setze(G, o); W3.bauwerke = n; map.triggerRepaint();
    }, 250);
  };
  map.on("moveend", neu); map.on("terrain", neu);
  ebene({ id: "bauwerke", name: "Brücken & Tunnelportale", an: true, setze: an => { W3.an = an; if (schicht) { if (!an) schicht.setze({ p: [] }, null); else neu(); map.triggerRepaint(); } } });
  map.on("sourcedata", e => { if (e.sourceId === g.quelle && e.isSourceLoaded) neu(); });
  neu();
}
// zum Testen ohne echte Kacheln
export const _test = { bauwerkeBauen, grundquelle };
