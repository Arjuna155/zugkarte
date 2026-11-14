// 3D-Welt, erste Fassung: Gebäude (Höhen aus den swisstopo-Vektorkacheln), Brücken und Tunnelportale.
// Alles kommt aus den Kacheln, die die Grundkarte ohnehin lädt – keine zusätzlichen Daten. Brücken und Portale baut
// three.js nach jedem Verschieben für den sichtbaren Ausschnitt neu (ab Zoom 14, nur mit Gelände).
import { K } from "./karte.js";
import { ladeThree, szeneMitLicht, gemeinsamerZeichner, ohneUmkehr } from "./drei.js";
import { STRASSENFARBE, STRASSENBREITE, MARKE } from "./landschaft.js";
import { VOR_3D } from "./tageszeit.js";
import { ebene } from "../ui/ebenen.js";
import { FASSADE, ZD, H_MIN, H_MAX, DACH_ANTEIL, DACH_MIN, DACH_MAX } from "./daecher.js";
import { quellMerkmale, nachLaden, beiRuhe } from "../util.js";

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
  const vor = map.getLayer("nacht") ? "nacht" : map.getLayer("schiff") ? "schiff" : undefined;   // unter der Abdunkelung (tageszeit.js)
  map.addLayer({
    id: "gebaeude-3d", type: "fill-extrusion", source: g.quelle, "source-layer": "building", minzoom: ZOOM_GEBAEUDE,
    paint: {
      "fill-extrusion-color": ["case", [">", ["coalesce", ["get", "render_height"], 8], 22], ["interpolate", ["linear"], ["coalesce", ["get", "render_height"], 8], 22, "#dedad3", 80, "#d3d0ca"],
        ["to-color", ["at", ["%", ["abs", ["round", ["to-number", ["id"], 0]]], FASSADE.length], ["literal", FASSADE]]]],   // Fassaden wie die Giebel der Dächer (daecher.js)
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
// Breite der Fahrbahn wie die Strassenbänder der Grundkarte (STRASSENBREITE); Fusswege, Feldwege usw. werden weggelassen
const BREITE = STRASSENBREITE, RAND = .7;   // Platte = Fahrbahn + 2 × RAND (Randstein und Brüstung)
const HOEHE_PORTAL = { rail: 7.5, transit: 6.5 };
const lin = c => c.map(v => v <= .04045 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4));
const hex = h => lin([1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255));
const FARBE = { seite: [.66, .65, .62], rand: [.74, .73, .70], bruestung: [.80, .79, .76], pfeiler: [.64, .63, .60], portal: [.69, .67, .63], loch: [.11, .12, .13] };
for (const k in FARBE) FARBE[k] = lin(FARBE[k]);
// Belag ohne Beleuchtung in genau den Farben der Strassenbänder (damit Strasse und Brücke gleich aussehen)
const BELAG = { rail: hex(STRASSENFARBE.schotter), transit: hex(STRASSENFARBE.haupt), minor: hex(STRASSENFARBE.klein), primary: hex(STRASSENFARBE.haupt), secondary: hex(STRASSENFARBE.haupt), tertiary: hex(STRASSENFARBE.haupt), motorway: hex(STRASSENFARBE.autobahn), trunk: hex(STRASSENFARBE.autobahn) };
const WEISS = hex(STRASSENFARBE.linie), STAHL = lin([.36, .34, .33]), RILLE = lin([.45, .45, .46]);

function Geo() { this.p = []; this.n = []; this.c = []; }
// Viereck; «nach» = Richtung, in die die Fläche zeigen soll (Normale wird danach gedreht)
Geo.prototype.quad = function (a, b, c, d, col, nach) {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
  let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], l = Math.hypot(...n);
  if (l < 1e-9) { const u2 = [c[0] - b[0], c[1] - b[1], c[2] - b[2]]; n = [u[1] * u2[2] - u[2] * u2[1], u[2] * u2[0] - u[0] * u2[2], u[0] * u2[1] - u[1] * u2[0]]; l = Math.hypot(...n); }   // Ecke a = d (auslaufende Brüstung): andere Ecke nehmen
  if (l < 1e-9) { n = nach ? [...nach] : [0, 0, 1]; l = Math.hypot(...n) || 1; }
  n = n.map(x => x / l);
  if (nach && n[0] * nach[0] + n[1] * nach[1] + n[2] * nach[2] < 0) n = n.map(x => -x);
  for (const q of [a, b, c, a, c, d]) { this.p.push(...q); this.n.push(...n); this.c.push(...col); }
};
// Quader zwischen zwei Punkten (Grundriss entlang a→b, Breite w), von z0 bis z1 an beiden Enden (za0/za1, zb0/zb1)
Geo.prototype.balken = function (a, b, w, za0, za1, zb0, zb1, colOben, colSeite) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1, ex = -dy / L, ey = dx / L, nx = ex * w / 2, ny = ey * w / 2;
  const A0 = [a[0] + nx, a[1] + ny], A1 = [a[0] - nx, a[1] - ny], B0 = [b[0] + nx, b[1] + ny], B1 = [b[0] - nx, b[1] - ny];
  const P = (q, z) => [q[0], q[1], z];
  this.quad(P(A0, za1), P(B0, zb1), P(B1, zb1), P(A1, za1), colOben, [0, 0, 1]);
  this.quad(P(A0, za0), P(B0, zb0), P(B0, zb1), P(A0, za1), colSeite, [ex, ey, 0]);
  this.quad(P(A1, za1), P(B1, zb1), P(B1, zb0), P(A1, za0), colSeite, [-ex, -ey, 0]);
  this.quad(P(A1, za0), P(B1, zb0), P(B0, zb0), P(A0, za0), colSeite, [0, 0, -1]);
  this.quad(P(A0, za0), P(A1, za0), P(A1, za1), P(A0, za1), colSeite, [-dx / L, -dy / L, 0]);   // Stirnflächen
  this.quad(P(B0, zb0), P(B1, zb0), P(B1, zb1), P(B0, zb1), colSeite, [dx / L, dy / L, 0]);
};
// Band entlang einer Linie: P = [[x, y, z], …], N = Normale je Punkt (auf Gehrung, damit Knicke geschlossen sind).
// Von (qa quer, za über der Fahrbahn) nach (qb, zb); za/zb als Zahl oder Funktion des Punktes. nach: "auf", "ab", +1/−1 (quer)
Geo.prototype.streifen = function (P, N, qa, za, qb, zb, col, nach, von = 0, bis = P.length - 1) {
  const h = (z, i) => typeof z === "function" ? z(i) : z, pt = (i, q, z) => [P[i][0] + N[i][0] * q, P[i][1] + N[i][1] * q, P[i][2] + h(z, i)];
  for (let i = von + 1; i <= bis; i++) this.quad(pt(i - 1, qa, za), pt(i, qa, za), pt(i, qb, zb), pt(i - 1, qb, zb), col,
    nach === "auf" ? [0, 0, 1] : nach === "ab" ? [0, 0, -1] : [N[i][0] * nach, N[i][1] * nach, 0]);
};

const mc = ll => maplibregl.MercatorCoordinate.fromLngLat(ll);
// Kacheln liefern Linien in Stücken (an Kachelgrenzen geschnitten, mit Überlappung). Für die Höhe einer Brücke zählt nur,
// wo sie wirklich beginnt und endet: ein echtes Ende hat eine gleichartige Strasse/Bahn ohne Brücke als Fortsetzung.
function bauwerkeBauen(map, g) {
  const feats = quellMerkmale(map, g.quelle, "transportation");
  const c = map.getCenter(), o = mc(c), ms = o.meterInMercatorCoordinateUnits();
  const lokal = ([lng, lat]) => { const m = mc([lng, lat]); return [(m.x - o.x) / ms, (m.y - o.y) / ms]; };
  const hoehe = p => { const e = map.queryTerrainElevation(p); return e == null ? null : e; };
  const hoeheXY = q => hoehe(new maplibregl.MercatorCoordinate(o.x + q[0] * ms, o.y + q[1] * ms).toLngLat());
  // normale (Nicht-Brücken-)Strecken je Art in einem Raster (für «echtes Ende?»)
  const raster = new Map(), R = 20, rk = (x, y) => Math.floor(x / R) + "," + Math.floor(y / R);
  const stuecke = [], punkte = [];
  for (const f of feats) {
    const p = f.properties, art = p.class; if (!BREITE[art]) continue;
    const linien = f.geometry.type === "LineString" ? [f.geometry.coordinates] : f.geometry.type === "MultiLineString" ? f.geometry.coordinates : [];
    for (const ll of linien) {
      if (ll.length < 2) continue;
      if (p.brunnel === "bridge" || p.brunnel === "tunnel") stuecke.push({ art, typ: p.brunnel, ll, xy: ll.map(lokal), einweg: p.oneway === 1, rampe: p.ramp === 1 });
      else for (const q of ll.map(lokal)) { const k = rk(q[0], q[1]); (raster.get(k) || raster.set(k, []).get(k)).push(art); punkte.push([q[0], q[1], art]); }
    }
  }
  // Portale brauchen genau am Ende eine offene Fortsetzung (Linie ist am Portal geteilt → gemeinsamer Punkt, ≤ 3 m) und
  // kein weiteres Tunnelstück dort. Das grobe 20-m-Raster genügte nicht: neben parallelen Gleisen (Zermatt, viele kurze
  // Tunnelstücke) bekam sonst jedes Stückende ein Portal.
  const nahR = 4, nk = (x, y) => Math.floor(x / nahR) + "," + Math.floor(y / nahR), nahOffen = new Map(), nahTunnel = new Map();
  const eintragen = (M, x, y, w) => { const k = nk(x, y); (M.get(k) || M.set(k, []).get(k)).push(w); };
  for (const [x, y, art] of punkte) eintragen(nahOffen, x, y, [x, y, art]);
  stuecke.forEach((s, i) => { if (s.typ === "tunnel") for (const q of [s.xy[0], s.xy[s.xy.length - 1]]) eintragen(nahTunnel, q[0], q[1], [q[0], q[1], s.art, i]); });
  const beiPunkt = (M, q, r, ok) => { const cx = Math.floor(q[0] / nahR), cy = Math.floor(q[1] / nahR); for (let dx = -1; dx <= 1; dx++)for (let dy = -1; dy <= 1; dy++) for (const w of M.get((cx + dx) + "," + (cy + dy)) || []) if (Math.hypot(w[0] - q[0], w[1] - q[1]) <= r && ok(w)) return true; return false; };
  const portalEcht = (q, art, i) => beiPunkt(nahOffen, q, 3, w => w[2] === art) && !beiPunkt(nahTunnel, q, 2, w => w[2] === art && w[3] !== i && !gleichesStueck(stuecke[w[3]], stuecke[i]));
  // wirkliches Brückenende: dort beginnt eine offene Linie gleicher Art und kein weiteres Brückenstück (Kachelgrenze)
  const nahBruecke = new Map(); stuecke.forEach((s, i) => { if (s.typ === "bridge") for (const q of [s.xy[0], s.xy[s.xy.length - 1]]) eintragen(nahBruecke, q[0], q[1], [q[0], q[1], s.art, i]); });
  const bruEcht = (q, art, i) => beiPunkt(nahOffen, q, 3, w => w[2] === art) && !beiPunkt(nahBruecke, q, 2, w => w[2] === art && w[3] !== i && !gleichesStueck(stuecke[w[3]], stuecke[i]));
  const gleichesStueck = (a, b) => a.xy.length === b.xy.length && Math.hypot(a.xy[0][0] - b.xy[0][0], a.xy[0][1] - b.xy[0][1]) < .5 && Math.hypot(a.xy[a.xy.length - 1][0] - b.xy[b.xy.length - 1][0], a.xy[a.xy.length - 1][1] - b.xy[b.xy.length - 1][1]) < .5;
  const fortsetzung = (q, art) => { for (let dx = -1; dx <= 1; dx++)for (let dy = -1; dy <= 1; dy++) { const a = raster.get((Math.floor(q[0] / R) + dx) + "," + (Math.floor(q[1] / R) + dy)); if (a && a.includes(art)) return true; } return false; };
  // doppelte Stücke (Überlappung an Kachelgrenzen) nur einmal
  const gesehen = new Set(); const G = new Geo(), GF = new Geo(); let n = 0;   // G beleuchtet (Beton), GF unbeleuchtet (Belag, Markierung, Schienen)
  for (const [si, s] of stuecke.entries()) {
    const key = s.typ + s.art + s.xy.map(q => Math.round(q[0]) + ":" + Math.round(q[1])).join("|"); if (gesehen.has(key)) continue; gesehen.add(key);
    const w = BREITE[s.art];
    if (s.typ === "tunnel") {   // Portal an echten Enden: Rahmen quer zur Fahrrichtung, dunkle Öffnung
      if (!HOEHE_PORTAL[s.art] && !["motorway", "trunk", "primary"].includes(s.art)) continue;
      const hP = HOEHE_PORTAL[s.art] || 7;
      for (const [i, j] of [[0, 1], [s.xy.length - 1, s.xy.length - 2]]) {
        const a = s.xy[i], b = s.xy[j]; if (!portalEcht(a, s.art, si)) continue;
        const z = hoehe(s.ll[i]); if (z == null) continue;
        const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L, nx = -uy, ny = ux, B = w / 2 + (HOEHE_PORTAL[s.art] ? 2.3 : 1.6);
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
    const pts = s.xy, m = pts.length;
    const ter = s.ll.map(hoehe); if (ter.some(z => z == null)) continue;
    const ext = (i0, i1, dist) => { const a = s.ll[i0], b = s.ll[i1], z = []; for (let t = 25; t <= dist; t += 25) { const f = t / (Math.hypot(pts[i0][0] - pts[i1][0], pts[i0][1] - pts[i1][1]) || 1); const e = hoehe([a[0] + (a[0] - b[0]) * f, a[1] + (a[1] - b[1]) * f]); if (e != null) z.push(e); } return z; };
    const anfangEcht = fortsetzung(pts[0], s.art), endeEcht = fortsetzung(pts[m - 1], s.art);
    const links = anfangEcht ? ter[0] : Math.max(ter[0], ...ext(0, 1, 150)), rechts = endeEcht ? ter[m - 1] : Math.max(ter[m - 1], ...ext(m - 1, m - 2, 150));
    const zf = []; let ml = links; for (let i = 0; i < m; i++) { ml = Math.max(ml, ter[i]); zf.push(ml); }
    let mr = rechts; for (let i = m - 1; i >= 0; i--) { mr = Math.max(mr, ter[i]); zf[i] = Math.min(zf[i], mr) + .3; }
    // Linie mit Höhen. An wirklichen Enden (Strasse/Gleis geht dort offen weiter) 6 m ins Land verlängert und knapp unter
    // das Gelände geführt: die Platte verschwindet im Boden statt stumpf zu enden, die Brüstung läuft dort aus.
    const wa = w, ws = wa + 2 * RAND, P = pts.map((q, i) => [q[0], q[1], zf[i]]), HB = pts.map(() => 1);
    const e0 = bruEcht(pts[0], s.art, si), e1 = bruEcht(pts[m - 1], s.art, si);
    const verl = (i, j) => { const a = pts[i], b = pts[j], l = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, q = [a[0] + (a[0] - b[0]) / l * 6, a[1] + (a[1] - b[1]) / l * 6], z = hoeheXY(q); return [q[0], q[1], (z == null ? zf[i] : Math.min(z, zf[i] + 1)) - .35]; };
    if (e0) { P.unshift(verl(0, 1)); HB.unshift(0); } if (e1) { P.push(verl(m - 1, m - 2)); HB.push(0); }
    const M = P.length, N = [], D = [0];
    for (let i = 0; i < M; i++) {   // Normale je Punkt auf Gehrung
      const a = P[Math.max(0, i - 1)], b = P[i], c = P[Math.min(M - 1, i + 1)]; let u1 = [b[0] - a[0], b[1] - a[1]], u2 = [c[0] - b[0], c[1] - b[1]]; const l1 = Math.hypot(u1[0], u1[1]);
      if (i) D.push(D[i - 1] + l1); if (!l1) u1 = u2; if (!Math.hypot(u2[0], u2[1])) u2 = u1;
      const L1 = Math.hypot(u1[0], u1[1]) || 1, L2 = Math.hypot(u2[0], u2[1]) || 1, n1 = [-u1[1] / L1, u1[0] / L1], n2 = [-u2[1] / L2, u2[0] / L2];
      let mx = n1[0] + n2[0], my = n1[1] + n2[1]; const l = Math.hypot(mx, my) || 1; mx /= l; my /= l; const k = 1 / Math.max(.5, mx * n1[0] + my * n1[1]); N.push([mx * k, my * k]);
    }
    const bahn = s.art === "rail" || s.art === "transit", hb = i => .14 + HB[i] * (bahn ? .9 : 1.05);
    GF.streifen(P, N, -wa / 2, s.art === "transit" ? .03 : 0, wa / 2, s.art === "transit" ? .03 : 0, BELAG[s.art], "auf");                       // Belag wie die Strasse / Schotter
    G.streifen(P, N, -ws / 2, -1.2, ws / 2, -1.2, FARBE.seite, "ab");                    // Unterseite
    for (const sg of [1, -1]) {
      G.streifen(P, N, sg * wa / 2, 0, sg * wa / 2, .14, FARBE.rand, -sg);              // Randstein
      G.streifen(P, N, sg * wa / 2, .14, sg * ws / 2, .14, FARBE.rand, "auf");
      G.streifen(P, N, sg * ws / 2, .14, sg * ws / 2, -1.2, FARBE.seite, sg);           // Stirn der Platte
      const q1 = sg * (ws / 2 - .3), q2 = sg * (ws / 2 - .04);                           // Brüstung
      G.streifen(P, N, q1, .14, q1, hb, FARBE.bruestung, -sg); G.streifen(P, N, q1, hb, q2, hb, FARBE.bruestung, "auf"); G.streifen(P, N, q2, hb, q2, .14, FARBE.bruestung, sg);
      if (s.art === "rail") { const q = sg * .7175;                                       // Schienen auf dem Schotter
        GF.streifen(P, N, q - .04, .1, q - .04, .27, STAHL, -sg); GF.streifen(P, N, q - .04, .27, q + .04, .27, STAHL, "auf"); GF.streifen(P, N, q + .04, .27, q + .04, .1, STAHL, sg); }
      else if (bahn) GF.streifen(P, N, sg * .5 - .05, .07, sg * .5 + .05, .07, RILLE, "auf");   // Tram: Rillenschienen bündig im Belag (Meterspur)
      else if ((s.art === "motorway" || s.art === "trunk") && !s.rampe) GF.streifen(P, N, sg * (MARKE.rand - .1), .06, sg * (MARKE.rand + .1), .06, WEISS, "auf");   // Randlinien
    }
    // gestrichelte Mittellinie (wie auf der Strasse)
    const strich = (an, takt) => { for (let i = 1; i < M; i++) { const a = P[i - 1], b = P[i], l = D[i] - D[i - 1]; if (l < .01) continue; const nx = -(b[1] - a[1]) / l * .09, ny = (b[0] - a[0]) / l * .09;
      for (let k = Math.floor(D[i - 1] / takt); k * takt < D[i]; k++) { const t0 = Math.max(D[i - 1], k * takt), t1 = Math.min(D[i], k * takt + an); if (t1 <= t0) continue;
        const at = t => { const u = (t - D[i - 1]) / l; return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u + .06]; }, A = at(t0), B = at(t1);
        GF.quad([A[0] + nx, A[1] + ny, A[2]], [B[0] + nx, B[1] + ny, B[2]], [B[0] - nx, B[1] - ny, B[2]], [A[0] - nx, A[1] - ny, A[2]], WEISS, [0, 0, 1]); } } };
    if ((s.art === "motorway" || s.art === "trunk") && !s.rampe) strich(6, 18); else if (["primary", "secondary", "tertiary"].includes(s.art) && !s.einweg) strich(3, 9);
    // Pfeiler mit Kopf etwa alle 35 m, wo die Fahrbahn mehr als 4 m über dem Gelände liegt
    for (let t = 17; t < D[M - 1] - 8; t += 35) {
      let i = 1; while (i < M - 1 && D[i] < t) i++; const u = (t - D[i - 1]) / ((D[i] - D[i - 1]) || 1);
      const q = [P[i - 1][0] + (P[i][0] - P[i - 1][0]) * u, P[i - 1][1] + (P[i][1] - P[i - 1][1]) * u], zDeck = P[i - 1][2] + (P[i][2] - P[i - 1][2]) * u;
      const zg = hoeheXY(q); if (zg == null || zDeck - zg < 4) continue;
      const dx = P[i][0] - P[i - 1][0], dy = P[i][1] - P[i - 1][1], l = Math.hypot(dx, dy) || 1, ux = dx / l, uy = dy / l;
      G.balken([q[0] - ux * .8, q[1] - uy * .8], [q[0] + ux * .8, q[1] + uy * .8], ws * .42, zg - 2, zDeck - 2, zg - 2, zDeck - 2, FARBE.pfeiler, FARBE.pfeiler);
      G.balken([q[0] - ux * 1.1, q[1] - uy * 1.1], [q[0] + ux * 1.1, q[1] + uy * 1.1], ws * .8, zDeck - 2, zDeck - 1.2, zDeck - 2, zDeck - 1.2, FARBE.pfeiler, FARBE.pfeiler);
    }
    // Widerlager an wirklichen Enden: Block unter dem Plattenende und zwei Flügelmauern schräg ins Land
    const lager = (i, j) => { const a = P[i], b = P[j], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, ux = (b[0] - a[0]) / l, uy = (b[1] - a[1]) / l, nx = -uy, ny = ux, z = a[2];   // u zeigt zur Brückenmitte
      G.balken([a[0] - ux * 1.2, a[1] - uy * 1.2], [a[0] + ux * 1.3, a[1] + uy * 1.3], ws + .8, z - 7, z - 1.2, z - 7, z - 1.2, FARBE.pfeiler, FARBE.pfeiler);
      for (const sg of [1, -1]) { const c = [a[0] + nx * sg * (ws / 2 + .15), a[1] + ny * sg * (ws / 2 + .15)], e = [c[0] - ux * 3.2 + nx * sg * 1.3, c[1] - uy * 3.2 + ny * sg * 1.3]; G.balken(c, e, .45, z - 7, z + .14, z - 7, z - 1.6, FARBE.pfeiler, FARBE.pfeiler); } };
    if (e0) lager(1, 2); if (e1) lager(M - 2, M - 3);
    n++;
  }
  return { G, GF, o, n };
}

function bauwerkEbene() {
  return {
    id: "bauwerke-3d", type: "custom", renderingMode: "3d",
    onAdd(m, gl) {
      this.cam = new THREE.Camera(); this.szene = szeneMitLicht(); this.mesh = null; this.o = null;
      this.r = gemeinsamerZeichner(m, gl);
      this.mat = ohneUmkehr(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
      this.matFlach = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }); this.flach = null;
    },
    setze(G, o, GF) {
      for (const k of ["mesh", "flach"]) if (this[k]) { this.szene.remove(this[k]); this[k].geometry.dispose(); this[k] = null; }
      this.o = o; if (!G.p.length) return;
      const netz = (Q, mat) => { const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(Q.p, 3)); g.setAttribute("normal", new THREE.Float32BufferAttribute(Q.n, 3)); g.setAttribute("color", new THREE.Float32BufferAttribute(Q.c, 3)); const x = new THREE.Mesh(g, mat); x.frustumCulled = false; this.szene.add(x); return x; };
      this.mesh = netz(G, this.mat); if (GF && GF.p.length) this.flach = netz(GF, this.matFlach);
    },
    render(gl, args) {
      const map = K.map; if (!W3.an || !this.mesh || !this.o || map.getZoom() < ZOOM_BAUWERKE || !map.getTerrain()) return;
      const s = this.o.meterInMercatorCoordinateUnits();
      const m = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix), l = new THREE.Matrix4().makeTranslation(this.o.x, this.o.y, this.o.z).scale(new THREE.Vector3(s, s, s));
      this.cam.projectionMatrix = m.multiply(l); this.r.resetState(); this.r.render(this.szene, this.cam);
    }
  };
}

// Strassen- und Gleisbänder auf Brücken (Ebenen «…-bruecke» aus landschaft.js) nur zeigen, solange es keine 3D-Brücken gibt
function brueckenLinien(map) {
  const drei = W3.an && !!map.getTerrain();
  for (const id of ["ls-bahn-bruecke", "ls-tram-bruecke", "ls-strasse-klein-bruecke", "ls-strasse-bruecke", "ls-autobahn-bruecke"]) { const l = map.getLayer(id); if (!l) continue;
    const max = drei ? ZOOM_BAUWERKE + .3 : 24; if (l.maxzoom !== max) map.setLayerZoomRange(id, l.minzoom, max); }
}
export function welt3dStarten() {
  const map = K.map, g = grundquelle(map); W3.quelle = g.quelle;
  if (!g.quelle) return;
  gebaeudeAn(map, g);
  ebene({ id: "gebaeude", name: "Gebäude (3D)", an: true, setze: an => { W3.gebaeudeAn = an; if (map.getLayer("gebaeude-3d")) map.setLayoutProperty("gebaeude-3d", "visibility", an ? "visible" : "none"); } });
  let schicht = null, laedt = false, timer = 0;
  const neu = () => {
    nachLaden(map, "bauwerke", async () => {
      brueckenLinien(map);
      if (!W3.an || map.getZoom() < ZOOM_BAUWERKE || !map.getTerrain() || !g.verkehr) return;
      if (!schicht) { if (laedt) return; laedt = true; await ladeThree(); schicht = bauwerkEbene(); map.addLayer(schicht, VOR_3D()); }
      const { G, GF, o, n } = bauwerkeBauen(map, g); schicht.setze(G, o, GF); W3.bauwerke = n; brueckenLinien(map); map.triggerRepaint();
    }, 250, 6);
  };
  beiRuhe(map, neu); map.on("terrain", neu);
  ebene({ id: "bauwerke", name: "Brücken & Tunnelportale", an: true, setze: an => { W3.an = an; brueckenLinien(map); if (schicht) { if (!an) schicht.setze({ p: [] }, null); else neu(); map.triggerRepaint(); } } });
  map.on("sourcedata", e => { if (e.sourceId === g.quelle && e.isSourceLoaded) neu(); });
  neu();
}
// zum Testen ohne echte Kacheln
export const _test = { bauwerkeBauen, grundquelle };
