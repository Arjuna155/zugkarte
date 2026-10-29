// Laufwege und Positionen der Züge; gesperrte Abschnitte (Bahnersatz)
import { B, stOf } from "./basis.js";
import { X, Y, melde } from "../util.js";
import { BW, tunnelVon } from "./bauwerke.js";

// Tunnelbereiche eines Laufwegs in Längeneinheiten (zwischengespeichert bis neue Bauwerksdaten kommen)
function tunnelIn(P) {
  if (P._tv === BW.v) return P._tun; P._tv = BW.v; const out = []; let off = 0;
  for (const e of P.seq) {
    if (e.li !== undefined) for (const [a, b] of tunnelVon(e.li, e.pj)) { const u = e.rev ? 1 - b : a, v = e.rev ? 1 - a : b; out.push([off + u * e.len, off + v * e.len]); }
    off += e.len;
  }
  return P._tun = out;
}
const imTunnel = (P, s) => { if (!BW.tunnel) return false; for (const [a, b] of tunnelIn(P)) if (s >= a && s <= b) return true; return false; };

// kürzester Weg zwischen zwei Halten im Netz (Dijkstra, zwischengespeichert)
const pathCache = new Map();
export function legPath(A, Bn) {
  const key = A + ">" + Bn; if (pathCache.has(key)) return pathCache.get(key);
  const G = B.G, dist = new Map([[A, 0]]), prev = new Map(), done = new Set(), Q = [[0, A]];
  while (Q.length) {
    let bi = 0; for (let j = 1; j < Q.length; j++)if (Q[j][0] < Q[bi][0]) bi = j;
    const [d, u] = Q[bi]; Q[bi] = Q[Q.length - 1]; Q.pop(); if (done.has(u)) continue; done.add(u); if (u === Bn) break;
    for (const e of G[u] || []) { const nd = d + e.len; if (!dist.has(e.to) || nd < dist.get(e.to)) { dist.set(e.to, nd); prev.set(e.to, [u, e]); Q.push([nd, e.to]); } }
  }
  if (!dist.has(Bn)) { pathCache.set(key, null); return null; }
  const seq = []; let c = Bn; while (c !== A) { seq.push(prev.get(c)[1]); c = prev.get(c)[0]; } seq.reverse();
  const pts = []; seq.forEach(e => pts.push(...(pts.length ? e.pts.slice(1) : e.pts)));
  const cum = new Float64Array(pts.length); for (let k = 1; k < pts.length; k++)cum[k] = cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
  const P = { pts, cum, len: cum[cum.length - 1], ids: seq.map(e => e.id).filter(Boolean), seq: seq.map(e => ({ li: e.li, pj: e.pj, rev: e.rev, len: e.len })) }; pathCache.set(key, P); return P;
}
export function legs(r) {
  if (!r.legs) { r.legs = []; for (let j = 1; j < r.st.length; j++) { const A = r.st[j - 1], Bs = r.st[j]; r.legs.push(Bs.a > A.d ? legPath(B.SN[A.i], B.SN[Bs.i]) : null); } }
  return r.legs;
}
export function along(P, f, out) {
  const L = P.len * f; let lo = 0, hi = P.cum.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (P.cum[m] < L) lo = m; else hi = m; }
  const seg = P.cum[hi] - P.cum[lo] || 1, u = (L - P.cum[lo]) / seg, a = P.pts[lo], b = P.pts[hi];
  out[0] = a[0] + (b[0] - a[0]) * u; out[1] = a[1] + (b[1] - a[1]) * u; return out;
}

// Gesperrte Streckenteile des heutigen Tages (vom Server aus dem Tagesfahrplan ermittelt, /api/sperrungen)
export const SPERR = { datum: null, teile: new Set(), heute: false };
export const legZu = P => SPERR.heute && !!P && P.ids.some(id => SPERR.teile.has(id));
export async function sperrLaden() {
  try {
    const r = await fetch("/api/sperrungen", { cache: "no-store" }); if (!r.ok) return; const j = await r.json();
    SPERR.datum = j.datum; SPERR.teile = new Set((j.teile || []).map(([i, k]) => i + ":" + k)); melde("sperren");
  } catch (e) { }
}

// Position eines Zuges zur Minute t seines Betriebstags (rt: Echtzeit-Zeiten). p wird wiederverwendet (keine Abfälle je Bild).
const tmp = [0, 0];
// Fahrdynamik je Verkehrsmittel: Anfahren a, Bremsen b (m/s²). Zwischen zwei Halten: anfahren, gleichmässig fahren,
// bremsen – so, dass die Fahrzeit des Fahrplans genau aufgeht (Trapez-Profil). Halte mit gleicher Ankunfts- und
// Abfahrtsminute bekommen 30 s Halt (je 15 s von den Nachbarabschnitten), damit Züge sichtbar anhalten.
const DYN = { fv: [.45, .6], rv: [.7, .8], s: [.85, .9], tr: [1.1, 1.2], sch: [.12, .15], bb: [.5, .6] };
function fahrt(u, T, D, cls) {   // Anteil der Strecke nach Anteil u der Fahrzeit
  if (!(T > 0) || !(D > 0)) return u;
  let [a, b] = DYN[cls] || DYN.rv, k = (1 / a + 1 / b) / 2, disk = T * T - 4 * k * D;
  if (disk < 0) { const k2 = T * T / (4 * D) * .999, f = k / k2; a *= f; b *= f; k = k2; disk = T * T - 4 * k * D; }   // knapper Fahrplan: kräftiger anfahren und bremsen
  const v = (T - Math.sqrt(disk)) / (2 * k), t = u * T, t1 = v / a, t2 = T - v / b;
  const s = t < t1 ? .5 * a * t * t : t < t2 ? .5 * a * t1 * t1 + v * (t - t1) : D - .5 * b * (T - t) * (T - t);
  return Math.max(0, Math.min(1, s / D));
}
export function trainPos(r, t, rt, p = {}) {
  const T0 = rt ? rt.t0 : r.t0, T1 = rt ? rt.t1 : r.t1; if (t < T0 || t > T1) return null;
  const n = r.st.length, halt = r.cls !== "sch" && r.cls !== "bb";
  const A = j => { const a = rt ? rt.A[j] : r.st[j].a, d = rt ? rt.D[j] : r.st[j].d; return halt && a === d && j > 0 && j < n - 1 ? a - .25 : a; };
  const Dp = j => { const a = rt ? rt.A[j] : r.st[j].a, d = rt ? rt.D[j] : r.st[j].d; return halt && a === d && j > 0 && j < n - 1 ? d + .25 : d; };
  // Suche ab dem zuletzt gefundenen Halt (die Zeit läuft meist vorwärts)
  let j0 = r._j || 0; if (j0 >= n || t < A(j0)) j0 = 0;
  for (let j = j0; j < n; j++) {
    const a = A(j), d = Dp(j);
    if (t >= a && t <= d) {
      if (SPERR.heute) { const L = legs(r); if ((j === 0 || legZu(L[j - 1])) && (j === n - 1 || legZu(L[j]))) return null; }
      r._j = j; const s = stOf(r.st[j].i); p.x = X(s); p.y = Y(s); p.stop = j; p.j = j; p.f = 0; p.moving = false; p.next = -1; p.tunnel = false; return p;
    }
    if (j < n - 1) {
      const na = A(j + 1);
      if (t > d && t < na) {
        r._j = j; const P = legs(r)[j]; if (!P || legZu(P)) return null;
        const f = fahrt((t - d) / (na - d), (na - d) * 60, P.len * 100, r.cls);   // anfahren, fahren, bremsen
        along(P, f, tmp); p.x = tmp[0]; p.y = tmp[1]; p.next = j + 1; p.j = j; p.f = f; p.moving = true; p.stop = -1; p.tunnel = imTunnel(P, f * P.len); return p;
      }
    }
  }
  return null;
}
