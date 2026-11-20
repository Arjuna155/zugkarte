// Strassen nah an der Kamera als echte Flächen: Die Strassenbänder der Grundkarte werden aufs Gelände «gemalt», und die
// Kartendaten reichen nur bis Zoom 14 – ganz nah (ab ~Zoom 17) sind sie deshalb unscharf und verwaschen. Hier werden die
// Strassen im Umkreis der Bildmitte als Bänder mit scharfen Kanten gebaut (wie die Brücken in welt3d.js): Asphalt, heller
// Rand, Markierungen. Jedes Band folgt dem Gelände an Mitte und beiden Rändern (liegt also auch am Hang auf).
// Die gemalten Bänder bleiben darunter (in der Ferne sieht man nur sie).
import { K } from "./karte.js";
import { ladeThree, gemeinsamerZeichner } from "./drei.js";
import { VOR_3D } from "./tageszeit.js";
import { Geo, W3 } from "./welt3d.js";
import { STRASSENFARBE, MARKE, strassenBreite } from "./landschaft.js";
import { lichtAnmelden } from "./lichter.js";
import { nachLaden, beiRuhe, quellMerkmale, istHandy, wgs, lv95 } from "../util.js";

export const S3 = { n: 0, ms: 0, lampen: 0, trottoir: 0, streifen: 0, leitplanken: 0, gehwege: 0, kacheln: 0 };

// ---- Ausstattung aus OpenStreetMap (/api/ausstattung): nur, was dort erfasst ist ----
// je Kachel {l: [[E, N]], s: [[E, N]], t: [{c, pts}], g: [{pts}], b: [{c, pts}]} in LV95-Metern
export const AU = new Map(); const auHoerer = new Set();
export const ausstattungHoeren = fn => auHoerer.add(fn);
const auLinien = L => L.map(f => { const pts = [[f[1] / 10, f[2] / 10]]; for (let i = 3; i + 1 < f.length; i += 2) pts.push([pts[pts.length - 1][0] + f[i] / 10, pts[pts.length - 1][1] + f[i + 1] / 10]); return { c: f[0], pts }; });
const auPunkte = A => { const o = []; for (let i = 0; i + 1 < A.length; i += 2) o.push([A[i] / 10, A[i + 1] / 10]); return o; };
export function ausstattungLaden(ks) {
  const fehlt = ks.filter(k => { const a = AU.get(k); return !a || (a.fehler && Date.now() - a.t > 10 * 60000); }); if (!fehlt.length) return;
  for (const k of fehlt) AU.set(k, { lauf: true });
  fetch("/api/ausstattung?k=" + fehlt.join(",")).then(r => r.ok ? r.json() : Promise.reject(r.status)).then(j => {
    for (const k of fehlt) { const d = j.k[k] || {}; AU.set(k, { l: auPunkte(d.l || []), s: auPunkte(d.s || []), t: auLinien(d.t || []), g: auLinien(d.g || []), b: auLinien(d.b || []), e: auLinien(d.e || []) }); }
    S3.kacheln = AU.size; for (const fn of auHoerer) fn();
  }).catch(() => { for (const k of fehlt) AU.set(k, { fehler: true, t: Date.now() }); });
}
const Z_AB = 16.2, SCHRITT = 5;
const ZR_ = .03, ZA = .12, ZM = .17;   // Höhe über dem Gelände: Rand, Asphalt, Markierung
const lin = c => c.map(v => v <= .04045 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4)), hex = h => lin([1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255));
const mc = ll => maplibregl.MercatorCoordinate.fromLngLat(ll);
// Rand neben dem Asphalt (m) je Klasse; Zufahrten ohne
const RAND = { motorway: .8, trunk: .8, primary: 1.2, secondary: 1.2, tertiary: 1.2, minor: 1.1 };
const BREIT = { service: 3.6 };
const STADT = ["primary", "secondary", "tertiary", "minor", "service"];   // Klassen, die ein Trottoir haben können (Seiten aus OSM)

function bauen(map, quelle) {
  const z = map.getZoom(); if (z < Z_AB || !map.getTerrain() || !quelle) return null;
  const t0 = performance.now(), o = mc(map.getCenter()), ms = o.meterInMercatorCoordinateUnits(), R = (z >= 18 ? 320 : z >= 17 ? 480 : 700) * (istHandy() ? .7 : 1.5);   // Computer: weiter (Ziel 20.11.)
  const lokal = ll => { const m = mc(ll); return [(m.x - o.x) / ms, (m.y - o.y) / ms]; };
  const hoehe = q => { const e = map.queryTerrainElevation(new maplibregl.MercatorCoordinate(o.x + q[0] * ms, o.y + q[1] * ms).toLngLat()); return e == null ? null : e; };
  const ASPHALT = hex(STRASSENFARBE.haupt), KANTE = hex(STRASSENFARBE.rand), BANKETT = hex(STRASSENFARBE.bankett), WEISS = hex(STRASSENFARBE.linie);
  const F = quellMerkmale(map, quelle, "transportation"); let zmax = 0; for (const f of F) if (f.tile && f.tile.z > zmax) zmax = f.tile.z;
  const G = new Geo(), GR = new Geo(), gesehen = new Set(), stuecke = [], enden = new Map(); let n = 0;
  const ek = q => Math.round(q[0]) + "," + Math.round(q[1]);
  for (const f of F) {
    const p = f.properties, art = p.class; if (art === "rail" || art === "transit") continue;   // Gleise nicht als Asphalt
    const w = BREIT[art] || strassenBreite(art, p.oneway === 1, p.ramp === 1); if (!w || p.brunnel === "tunnel" || p.brunnel === "bridge") continue;
    if (f.tile && f.tile.z !== zmax) continue;   // gröbere Kacheln (weiter weg geladen) haben dieselben Strassen nochmals, vereinfacht
    const g = f.geometry, linien = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [];
    for (const ll of linien) {
      if (ll.length < 2) continue; const roh0 = ll.map(lokal), roh = [roh0[0]];
      // fast gleiche Punkte weg (sonst kippt die Querrichtung am Ende → Striche quer über die Strasse)
      for (let i = 1; i < roh0.length; i++) { const a = roh[roh.length - 1], b = roh0[i]; if (Math.hypot(b[0] - a[0], b[1] - a[1]) >= .8) roh.push(b); else if (i === roh0.length - 1 && roh.length > 1) roh[roh.length - 1] = b; }
      if (roh.length < 2 || !roh.some(q => Math.hypot(q[0], q[1]) < R + 60)) continue;
      const key = art + "|" + ek(roh[0]) + "|" + ek(roh[roh.length - 1]) + "|" + roh.length; if (gesehen.has(key)) continue; gesehen.add(key);
      stuecke.push({ roh, art, w, einweg: p.oneway === 1, rampe: p.ramp === 1 });
      for (const q of [roh[0], roh[roh.length - 1]]) { const k = ek(q); enden.set(k, (enden.get(k) || 0) + 1); }
    }
  }
  // Ausstattung aus OSM im Umkreis (Kacheln 10 km, LV95) → lokale Koordinaten
  const c0 = map.getCenter(), [cE, cN] = lv95(c0.lng, c0.lat), ks = [];
  for (const dx of [-1, 1]) for (const dy of [-1, 1]) { const k = Math.floor((cE + dx * R - 2480000) / 10000) + "_" + Math.floor((1300000 - cN - dy * R) / 10000); if (!ks.includes(k)) ks.push(k); }
  ausstattungLaden(ks);
  const lokalLV = ([E, N]) => lokal(wgs((E - 2480000) / 100, (1300000 - N) / 100));
  const AUS = { l: [], s: [], t: [], g: [], b: [] }, nah = q => Math.hypot(q[0], q[1]) < R + 30;
  for (const k of ks) { const a = AU.get(k); if (!a || !a.l) continue;
    for (const art of ["l", "s"]) for (const q of a[art]) { const p = lokalLV(q); if (nah(p)) AUS[art].push(p); }
    for (const art of ["t", "g", "b"]) for (const f of a[art]) { const P = f.pts.map(lokalLV); if (P.some(nah)) AUS[art].push({ c: f.c, P }); } }
  // doppelte Punkte/Linien aus mehreren Kacheln weg
  const einmal = (L, sig) => { const g = new Set(); return L.filter(x => { const k = sig(x); if (g.has(k)) return false; g.add(k); return true; }); };
  AUS.l = einmal(AUS.l, p => Math.round(p[0] * 2) + "," + Math.round(p[1] * 2)); AUS.s = einmal(AUS.s, p => Math.round(p[0] * 2) + "," + Math.round(p[1] * 2));
  for (const art of ["t", "g", "b"]) AUS[art] = einmal(AUS[art], f => f.c + ":" + f.P.length + ":" + Math.round(f.P[0][0]) + "," + Math.round(f.P[0][1]));
  // Raster der OSM-Strassen mit Trottoir-Merkmal (Abschnitte mit Seite) für die Zuordnung zu unseren Strassen
  const TR = new Map(), TZ_ = 20, tk = (x, y) => Math.floor(x / TZ_) + "," + Math.floor(y / TZ_);
  for (const f of AUS.t) for (let i = 1; i < f.P.length; i++) { const a = f.P[i - 1], b = f.P[i], l = Math.hypot(b[0] - a[0], b[1] - a[1]); if (l < .5) continue;
    for (let s0 = 0; s0 <= l; s0 += 10) { const u = Math.min(1, s0 / l), k = tk(a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u); if (!TR.has(k)) TR.set(k, []); const L = TR.get(k); if (!L.length || L[L.length - 1].a !== a) L.push({ a, b, l, c: f.c }); } }
  // Trottoir-Seiten an einem Punkt unserer Strasse (Richtung ux, uy): [rechts (sg = +1), links (sg = −1)]
  const trottoirBei = (x, y, ux, uy) => { let best = null, bd = 7;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const e of TR.get(Math.floor(x / TZ_ + dx) + "," + Math.floor(y / TZ_ + dy)) || []) {
      const vx = (e.b[0] - e.a[0]) / e.l, vy = (e.b[1] - e.a[1]) / e.l, cs = ux * vx + uy * vy; if (Math.abs(cs) < .85) continue;
      const t = Math.max(0, Math.min(e.l, (x - e.a[0]) * vx + (y - e.a[1]) * vy)), d = Math.hypot(e.a[0] + vx * t - x, e.a[1] + vy * t - y); if (d < bd) { bd = d; best = { c: e.c, gleich: cs > 0 }; } }
    if (!best) return [false, false];
    const l = (best.c & 1) > 0, r = (best.c & 2) > 0; return best.gleich ? [r, l] : [l, r];   // OSM links/rechts in Richtung des OSM-Wegs; y zeigt nach Süden → sg = +1 ist rechts
  };
  // Raster unserer Strassenpunkte (für Lampen-Ausleger und Fussgängerstreifen)
  const SP = new Map(), sk = (x, y) => Math.floor(x / 20) + "," + Math.floor(y / 20);
  const strasseNah = (x, y, max) => { let best = null, bd = max; for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const e of SP.get(Math.floor(x / 20 + dx) + "," + Math.floor(y / 20 + dy)) || []) {
    const t = Math.max(0, Math.min(e.l, (x - e.a[0]) * e.ux + (y - e.a[1]) * e.uy)), px = e.a[0] + e.ux * t, py = e.a[1] + e.uy * t, d = Math.hypot(px - x, py - y); if (d < bd) { bd = d; best = { x: px, y: py, ux: e.ux, uy: e.uy, w: e.w, d }; } } return best; };
  const lampen = [], LAMPEN_MAX = istHandy() ? 800 : 2500; let trottoir = 0, streifen = 0, leitplanken = 0, gehwege = 0;
  const GELB = hex("#f0c22e"), BETON = hex("#bdbab3"), BETON_D = hex("#9a978f"), STEIN = hex("#c3c0b8"), STEIN_SEITE = hex("#9c9992"), TROTTOIR = hex("#b6b3ab"), METALL = hex("#b4b9bd"), METALL_D = hex("#7f858a"), MAST = hex("#6f757a"), LEUCHTE = hex("#dcdad2");
  // Randlinien enden vor Verzweigungen, Einmündungen und offenen Enden (dort kreuzen sich sonst die Linien der Fahrbahnen);
  // nur wo genau zwei Stücke zusammenstossen (Kachelrand, gewöhnlicher Knick), laufen sie durch
  const KUERZ = 14;
  for (const s of stuecke) {
    const { roh, art, w } = s;
    const pts = [roh[0]], D = [0]; for (let i = 1; i < roh.length; i++) { const a = roh[i - 1], b = roh[i], l = Math.hypot(b[0] - a[0], b[1] - a[1]), k = Math.max(1, Math.ceil(l / SCHRITT)); for (let j = 1; j <= k; j++) { pts.push([a[0] + (b[0] - a[0]) * j / k, a[1] + (b[1] - a[1]) * j / k]); D.push(D[D.length - 1] + l / k); } }
    for (let i = 1; i < pts.length; i++) { const a = pts[i - 1], b = pts[i], l = Math.hypot(b[0] - a[0], b[1] - a[1]); if (l < .1 || Math.hypot(a[0], a[1]) > R + 40) continue; const k = sk((a[0] + b[0]) / 2, (a[1] + b[1]) / 2); if (!SP.has(k)) SP.set(k, []); SP.get(k).push({ a, l, ux: (b[0] - a[0]) / l, uy: (b[1] - a[1]) / l, w }); }
    const L = D[D.length - 1], t0 = enden.get(ek(roh[0])) === 2 ? 0 : KUERZ, t1 = enden.get(ek(roh[roh.length - 1])) === 2 ? L : L - KUERZ;
    let lauf = [], ls = []; const fertig = () => { if (lauf.length > 1) { band(lauf, ls, t0, t1, w, art, s.einweg, s.rampe); n++; } lauf = []; ls = []; };
    for (let i = 0; i < pts.length; i++) { const q = pts[i]; if (Math.hypot(q[0], q[1]) > R) { fertig(); continue; } const zc = hoehe(q); if (zc == null) { fertig(); continue; } lauf.push([q[0], q[1], zc]); ls.push(D[i]); }
    fertig();
  }
  function band(P, S, t0, t1, w, art, einweg, rampe) {
    const M = P.length, N = [], D = [0], ZL = [], ZR = [], rb = RAND[art] || 0, auto = art === "motorway" || art === "trunk";
    for (let i = 0; i < M; i++) {
      const a = P[Math.max(0, i - 1)], b = P[i], c = P[Math.min(M - 1, i + 1)]; let u1 = [b[0] - a[0], b[1] - a[1]], u2 = [c[0] - b[0], c[1] - b[1]]; const l1 = Math.hypot(u1[0], u1[1]);
      if (i) D.push(D[i - 1] + l1); if (!l1) u1 = u2; if (!Math.hypot(u2[0], u2[1])) u2 = u1;
      const L1 = Math.hypot(u1[0], u1[1]) || 1, L2 = Math.hypot(u2[0], u2[1]) || 1, n1 = [-u1[1] / L1, u1[0] / L1], n2 = [-u2[1] / L2, u2[0] / L2];
      let mx = n1[0] + n2[0], my = n1[1] + n2[1]; const l = Math.hypot(mx, my) || 1; mx /= l; my /= l; const k = 1 / Math.max(.5, mx * n1[0] + my * n1[1]); N.push([mx * k, my * k]);
      // Gelände an den Rändern (inkl. Randstreifen), höchstens 1,2 m anders als in der Mitte (Mauern, Böschungskanten im Höhenmodell)
      const q = w / 2 + rb, zl = hoehe([b[0] + mx * q, b[1] + my * q]), zr = hoehe([b[0] - mx * q, b[1] - my * q]), kl = v => v == null ? 0 : Math.max(-1.2, Math.min(1.2, v - b[2]));
      ZL.push(kl(zl)); ZR.push(kl(zr));
    }
    // Höhe über der Mitte an der Querlage q (linear zwischen Mitte und Rand), plus Abstand über dem Gelände
    const Q = w / 2 + rb, zq = (q, plus) => i => (q >= 0 ? ZL[i] : ZR[i]) * Math.abs(q) / Q + plus;
    // Rand in eigenem Netz (GR), gezeichnet vor dem Asphalt und ohne Tiefe zu schreiben: so deckt der Asphalt jeder Strasse
    // den Rand der anderen an Kreuzungen, auch wenn die beiden auf leicht verschiedener Geländehöhe liegen
    if (rb) for (const sg of [1, -1]) GR.streifen(P, N, sg * Q, zq(sg * Q, ZR_), sg * w / 2, zq(sg * w / 2, ZR_), auto ? BANKETT : KANTE, "auf");
    G.streifen(P, N, -w / 2, zq(-w / 2, ZA), 0, ZA, ASPHALT, "auf"); G.streifen(P, N, 0, ZA, w / 2, zq(w / 2, ZA), ASPHALT, "auf");
    // runde Enden (wie line-cap round der gemalten Bänder): an Kreuzungen, Einmündungen und Kachelrändern stehen sonst
    // die gerade abgeschnittenen Enden als Ecken über bzw. es bleiben Kerben, wo zwei Stücke im Winkel zusammenstossen
    for (const [i, j] of [[0, 1], [M - 1, M - 2]]) { if (j < 0 || j >= M) continue;
      const c = P[i], ux0 = c[0] - P[j][0], uy0 = c[1] - P[j][1], ul = Math.hypot(ux0, uy0); if (ul < .01) continue;
      const ux = ux0 / ul, uy = uy0 / ul, nx = -uy, ny = ux;
      const scheibe = (G, rad, dz, col) => { const K_ = 10; let a = null;
        for (let k = 0; k <= K_; k++) { const t = Math.PI * k / K_, cx = Math.cos(t), sx = Math.sin(t), seit = (cx >= 0) === (i === M - 1) ? ZL[i] : ZR[i],
            b = [c[0] + (nx * cx + ux * sx) * rad, c[1] + (ny * cx + uy * sx) * rad, c[2] + dz + seit * Math.abs(cx) * rad / Q];
          if (a) G.quad([c[0], c[1], c[2] + dz], a, b, [c[0], c[1], c[2] + dz], col, [0, 0, 1]); a = b; } };
      if (rb) scheibe(GR, Q, ZR_, auto ? BANKETT : KANTE); scheibe(G, w / 2, ZA, ASPHALT); }
    // Markierungen nur im Bereich [t0, t1] des ganzen Stücks (mindestens 15 m lang)
    let i0 = 0, i1 = M - 1; while (i0 < M - 1 && S[i0] < t0) i0++; while (i1 > 0 && S[i1] > t1) i1--;
    const mark = t1 - t0 >= 15 && i1 > i0;
    if (auto && mark) { const r = rampe ? MARKE.rampe : MARKE.rand; for (const sg of [1, -1]) G.streifen(P, N, sg * (r - .1), zq(sg * (r - .1), ZM), sg * (r + .1), zq(sg * (r + .1), ZM), WEISS, "auf", i0, i1); }
    const strich = (an, takt) => { if (!mark) return; for (let i = i0 + 1; i <= i1; i++) { const a = P[i - 1], b = P[i], l = D[i] - D[i - 1]; if (l < .01) continue; const o = S[i - 1] - D[i - 1]; const nx = -(b[1] - a[1]) / l * .09, ny = (b[0] - a[0]) / l * .09;
      for (let k = Math.floor((D[i - 1] + o) / takt); k * takt < D[i] + o; k++) { const s0 = Math.max(D[i - 1], k * takt - o), s1 = Math.min(D[i], k * takt + an - o); if (s1 <= s0) continue;
        const at = s => { const u = (s - D[i - 1]) / l; return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u + ZM]; }, A = at(s0), B = at(s1);
        G.quad([A[0] + nx, A[1] + ny, A[2]], [B[0] + nx, B[1] + ny, B[2]], [B[0] - nx, B[1] - ny, B[2]], [A[0] - nx, A[1] - ny, A[2]], WEISS, [0, 0, 1]); } } };
    if (auto && !rampe) strich(6, 18); else if (["primary", "secondary", "tertiary"].includes(art) && !einweg) strich(3, 9);
    // Trottoir mit Randstein (12 cm) nur auf den Seiten, die in OSM ein Trottoir haben (sidewalk=both|left|right)
    if (STADT.includes(art) && TR.size) {
      const T = P.map((q, i) => { const a = P[Math.max(0, i - 1)], c = P[Math.min(M - 1, i + 1)], l = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1; return trottoirBei(q[0], q[1], (c[0] - a[0]) / l, (c[1] - a[1]) / l); });
      const TB = art === "minor" ? 1.6 : 2;
      for (const [si, sg] of [[0, 1], [1, -1]]) for (let a = 0; a < M; a++) { if (!T[a][si]) continue; let b = a; while (b + 1 < M && T[b + 1][si]) b++;
        if (b > a) { trottoir++; const q0 = sg * w / 2, q1 = sg * (w / 2 + TB);
          G.streifen(P, N, q0, zq(q0, ZA), q0, zq(q0, .22), STEIN_SEITE, sg, a, b);                 // Randstein (zur Fahrbahn)
          G.streifen(P, N, q0, zq(q0, .22), sg * (w / 2 + .15), zq(q0, .22), STEIN, "auf", a, b);   // Randstein oben
          G.streifen(P, N, sg * (w / 2 + .15), zq(q0, .22), q1, zq(q1, .22), TROTTOIR, "auf", a, b);
          G.streifen(P, N, q1, zq(q1, .22), q1, zq(q1, 0), STEIN_SEITE, sg, a, b); }
        a = b; }
    }
  }
  // ---- Ausstattung an ihrer wirklichen Lage (OSM) ----
  const hz = q => { const e = hoehe(q); return e == null ? null : e; };
  // eigene Trottoir-Linien (footway=sidewalk): 1,8 m breit, 12 cm hoch, Randsteine beidseits
  const linieBand = (P0, schritt) => { const P = []; for (let i = 1; i < P0.length; i++) { const a = P0[i - 1], b = P0[i], l = Math.hypot(b[0] - a[0], b[1] - a[1]), k = Math.max(1, Math.ceil(l / schritt)); for (let j = i === 1 ? 0 : 1; j <= k; j++) P.push([a[0] + (b[0] - a[0]) * j / k, a[1] + (b[1] - a[1]) * j / k]); }
    const Q = []; for (const q of P) { if (Math.hypot(q[0], q[1]) > R) { Q.push(null); continue; } const z = hz(q); Q.push(z == null ? null : [q[0], q[1], z]); } return Q; };
  const laeufe = (Q, fn) => { let L = []; for (const q of Q.concat([null])) { if (q) { L.push(q); continue; } if (L.length > 1) { const N = L.map((b, i) => { const a = L[Math.max(0, i - 1)], c = L[Math.min(L.length - 1, i + 1)], l = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1; return [-(c[1] - a[1]) / l, (c[0] - a[0]) / l]; }); fn(L, N); } L = []; } };
  for (const f of AUS.g) laeufe(linieBand(f.P, 4), (L, N) => { gehwege++;
    G.streifen(L, N, -.9, .12, .9, .12, TROTTOIR, "auf");
    for (const sg of [1, -1]) G.streifen(L, N, sg * .9, .12, sg * .9, -.05, STEIN_SEITE, sg); });
  // Leitplanken (barrier=guard_rail) und Betonelemente (jersey_barrier)
  for (const f of AUS.b) laeufe(linieBand(f.P, 4), (L, N) => { leitplanken++;
    if (f.c === 2) { for (let i = 1; i < L.length; i++) G.balken(L[i - 1], L[i], .5, L[i - 1][2], L[i - 1][2] + .8, L[i][2], L[i][2] + .8, BETON, BETON_D); return; }
    for (const sg of [1, -1]) G.streifen(L, N, sg * .04, .48, sg * .04, .8, METALL, sg);
    G.streifen(L, N, -.04, .8, .04, .8, METALL_D, "auf");
    let s0 = -99, sl = 0; for (let i = 0; i < L.length; i++) { if (i) sl += Math.hypot(L[i][0] - L[i - 1][0], L[i][1] - L[i - 1][1]); if (sl - s0 < 4) continue; s0 = sl;
      const n0 = N[i], px = L[i][0] - n0[0] * .1, py = L[i][1] - n0[1] * .1, z0 = L[i][2]; G.balken([px - .05 * n0[1], py + .05 * n0[0]], [px + .05 * n0[1], py - .05 * n0[0]], .1, z0, z0 + .74, z0, z0 + .74, METALL_D, METALL_D); } });
  // Fussgängerstreifen (gelb, wie in der Schweiz): Balken 0,5 m breit, 4 m lang, längs zur Strasse, quer über die Fahrbahn verteilt
  for (const q of AUS.s) {
    const r = strasseNah(q[0], q[1], 6); if (!r) continue; streifen++;
    const ux = r.ux, uy = r.uy, nx = -uy, ny = ux, n = Math.max(2, Math.floor((r.w - .6) / 1)), start = -(n - 1) / 2;
    for (let k = 0; k < n; k++) { const o = (start + k) * 1, cx = r.x + nx * o, cy = r.y + ny * o, z = hz([cx, cy]); if (z == null) continue;
      const A = (lx, qx) => [cx + ux * lx + nx * qx, cy + uy * lx + ny * qx, z + ZM - .01];
      G.quad(A(-2, -.25), A(2, -.25), A(2, .25), A(-2, .25), GELB, [0, 0, 1]); }
  }
  // Strassenlampen an ihrer OSM-Lage: Ausleger zur nächsten Strasse (≤ 15 m), sonst Mastleuchte
  for (const q of AUS.l) {
    if (lampen.length >= LAMPEN_MAX * 4) break;
    const z0 = hz(q); if (z0 == null) continue; const r = strasseNah(q[0], q[1], 15), h = r ? 7 : 4.5;
    G.balken([q[0] - .07, q[1]], [q[0] + .07, q[1]], .14, z0, z0 + h, z0, z0 + h, MAST, MAST);
    let ax = q[0], ay = q[1];
    if (r && r.d > .5) { const dx = (r.x - q[0]) / r.d, dy = (r.y - q[1]) / r.d, al = Math.min(2.2, r.d - .3); ax = q[0] + dx * al; ay = q[1] + dy * al;
      G.balken([q[0], q[1]], [ax, ay], .09, z0 + h - .12, z0 + h, z0 + h - .12, z0 + h, MAST, MAST);
      G.balken([ax + dx * .35, ay + dy * .35], [ax - dx * .25, ay - dy * .25], .3, z0 + h - .3, z0 + h - .08, z0 + h - .3, z0 + h - .08, MAST, LEUCHTE); }
    else G.balken([q[0] - .2, q[1]], [q[0] + .2, q[1]], .4, z0 + h, z0 + h + .5, z0 + h, z0 + h + .5, LEUCHTE, LEUCHTE);   // Mastaufsatzleuchte
    const zb = hz([ax, ay]); lampen.push(ax, ay, z0 + h - .35 + (r ? 0 : .6), (zb == null ? z0 : zb) + .25);
  }
  S3.n = n; S3.ms = Math.round(performance.now() - t0); S3.lampen = lampen.length / 4; S3.trottoir = trottoir; S3.streifen = streifen; S3.leitplanken = leitplanken; S3.gehwege = gehwege;
  if (lampen.length) S3.lampe = new maplibregl.MercatorCoordinate(o.x + lampen[0] * ms, o.y + lampen[1] * ms).toLngLat();   // zum Prüfen
  return { G, GR, o, lampen };
}

// polygonOffset: vor das Gelände gezogen – das gezeichnete Geländenetz ist gröber als queryTerrainElevation, sonst sägezahnartige Ränder
function ebene3d() {
  return {
    id: "strassen3d", type: "custom", renderingMode: "3d",
    onAdd(m, gl) {
      this.cam = new THREE.Camera(); this.szene = new THREE.Scene(); this.r = gemeinsamerZeichner(m, gl); this.netz = null; this.o = null;
      this.mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -40 });
      this.netzR = null;
      // feine Struktur im Belag (Körnung ~1 m, Flecken ~8 m, Fahrspuren etwas dunkler wäre zu viel) – fest am Ort: Lage modulo 1024 m
      this.uOff = { value: new THREE.Vector2() };
      this.mat.onBeforeCompile = sh => {
        sh.uniforms.uOff = this.uOff;
        sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nvarying vec2 vOrt;").replace("#include <begin_vertex>", "#include <begin_vertex>\nvOrt = position.xy;");
        sh.fragmentShader = sh.fragmentShader.replace("#include <common>", `#include <common>
varying vec2 vOrt; uniform vec2 uOff;
float zh(vec2 p) { p = mod(p, 1024.0); return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float zr(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(zh(i), zh(i + vec2(1, 0)), f.x), mix(zh(i + vec2(0, 1)), zh(i + vec2(1, 1)), f.x), f.y); }`)
          .replace("#include <color_fragment>", `#include <color_fragment>
{ vec2 p = vOrt + uOff; float n = zr(p * 1.3) * .5 + zr(p / 8.0) * .35 + zr(p / 40.0) * .15; diffuseColor.rgb *= .93 + .14 * n; }`);
      };
      const cv = document.createElement("canvas"); cv.width = cv.height = 32; const g2 = cv.getContext("2d"), gr = g2.createRadialGradient(16, 16, 0, 16, 16, 16);
      gr.addColorStop(0, "rgba(255,240,205,1)"); gr.addColorStop(.35, "rgba(255,222,160,.55)"); gr.addColorStop(1, "rgba(255,210,140,0)"); g2.fillStyle = gr; g2.fillRect(0, 0, 32, 32);
      const cv2 = document.createElement("canvas"); cv2.width = cv2.height = 64; const g3 = cv2.getContext("2d"), gr2 = g3.createRadialGradient(32, 32, 0, 32, 32, 32);
      gr2.addColorStop(0, "rgba(255,255,255,1)"); gr2.addColorStop(.3, "rgba(255,255,255,.45)"); gr2.addColorStop(.65, "rgba(255,255,255,.12)"); gr2.addColorStop(1, "rgba(255,255,255,0)"); g3.fillStyle = gr2; g3.fillRect(0, 0, 64, 64);
      this.kmat = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv2), color: 0x4a361f, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -10, polygonOffsetUnits: -60 });
      this.lmat = new THREE.PointsMaterial({ map: new THREE.CanvasTexture(cv), size: 5, sizeAttenuation: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 });
      this.lszene = new THREE.Scene(); this.lm = new THREE.Matrix4(); this.lpunkte = null; this.lkegel = null;
      lichtAnmelden({ aktiv: () => !!this.lpunkte && K.map.getZoom() >= Z_AB - .2, szene: this.lszene, matrix: this.lm, nacht: t => { this.lmat.opacity = Math.min(1, t * 1.4); this.kmat.opacity = Math.min(1, t * 1.2); } });
    },
    setze(e) {
      if (this.netz) { this.szene.remove(this.netz); this.netz.geometry.dispose(); this.netz = null; }
      if (this.netzR) { this.szene.remove(this.netzR); this.netzR.geometry.dispose(); this.netzR = null; }
      if (this.lpunkte) { this.lszene.remove(this.lpunkte); this.lpunkte.geometry.dispose(); this.lpunkte = null; }
      if (!e || !e.G.p.length) { this.o = null; return; } this.o = e.o;
      const s = e.o.meterInMercatorCoordinateUnits(); this.uOff.value.set((e.o.x / s) % 1024, (e.o.y / s) % 1024);
      if (this.lkegel) { this.lszene.remove(this.lkegel); this.lkegel.geometry.dispose(); this.lkegel = null; }
      if (e.lampen.length) {
        const L = e.lampen, kopf = [], boden = [], uv = [];
        for (let i = 0; i < L.length; i += 4) { kopf.push(L[i], L[i + 1], L[i + 2]); const x = L[i], y = L[i + 1], z = L[i + 3], r = 7;
          for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]]) { boden.push(x + a * r, y + b * r, z); uv.push((a + 1) / 2, (b + 1) / 2); } }
        const lg = new THREE.BufferGeometry(); lg.setAttribute("position", new THREE.Float32BufferAttribute(kopf, 3)); this.lpunkte = new THREE.Points(lg, this.lmat); this.lpunkte.frustumCulled = false; this.lszene.add(this.lpunkte);
        // Lichtkegel auf der Strasse unter jeder Lampe (warm, weich auslaufend)
        const bg = new THREE.BufferGeometry(); bg.setAttribute("position", new THREE.Float32BufferAttribute(boden, 3)); bg.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
        this.lkegel = new THREE.Mesh(bg, this.kmat); this.lkegel.frustumCulled = false; this.lszene.add(this.lkegel);
      }
      const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(e.G.p, 3)); g.setAttribute("color", new THREE.Float32BufferAttribute(e.G.c, 3));
      this.netz = new THREE.Mesh(g, this.mat); this.netz.frustumCulled = false; this.szene.add(this.netz);
      if (e.GR.p.length) {
        if (!this.matR) { this.matR = this.mat.clone(); this.matR.depthWrite = false; this.matR.onBeforeCompile = this.mat.onBeforeCompile; }
        const gr = new THREE.BufferGeometry(); gr.setAttribute("position", new THREE.Float32BufferAttribute(e.GR.p, 3)); gr.setAttribute("color", new THREE.Float32BufferAttribute(e.GR.c, 3));
        this.netzR = new THREE.Mesh(gr, this.matR); this.netzR.frustumCulled = false; this.netzR.renderOrder = -1; this.szene.add(this.netzR);
      }
    },
    render(gl, args) {
      const map = K.map; if (!this.netz || !this.o || map.getZoom() < Z_AB - .2 || !map.getTerrain()) return;
      const s = this.o.meterInMercatorCoordinateUnits(), m = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix), l = new THREE.Matrix4().makeTranslation(this.o.x, this.o.y, 0).scale(new THREE.Vector3(s, s, s));
      this.lm.copy(l); this.cam.projectionMatrix = m.multiply(l); this.r.resetState(); this.r.render(this.szene, this.cam);
    },
  };
}

export function strassen3dStarten() {
  const map = K.map; let schicht = null, laedt = false;
  const neu = () => nachLaden(map, "strassen3d", async () => {
    if (map.getZoom() < Z_AB || !map.getTerrain() || !W3.quelle) { if (schicht) { schicht.setze(null); map.triggerRepaint(); } return; }
    if (!schicht) { if (laedt) return; laedt = true; await ladeThree(); schicht = ebene3d(); map.addLayer(schicht, VOR_3D()); }
    schicht.setze(bauen(map, W3.quelle)); map.triggerRepaint();
  }, 250, 4);
  ausstattungHoeren(neu); beiRuhe(map, neu); map.on("terrain", neu); map.on("sourcedata", e => { if (W3.quelle && e.sourceId === W3.quelle && e.isSourceLoaded) neu(); });
  window.__s3 = S3; neu();
}
