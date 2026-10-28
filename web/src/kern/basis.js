// Grunddaten: Bahnhöfe, Strecken mit Gleisverlauf, ÖV-Kanten, UIC-Nummern (daten/basis.*.json, lange zwischengespeichert)
import { glatt, dekodiere, laenge } from "../util.js";

export const B = {
  FPV: "", ST: {}, STX: {}, SN: [], SIDX: {}, LINES: [], byStation: {}, KANTEN: {}, OEV: { t: [], s: [] },
  TIER0: [], TIER1: [], UIC2IDX: {}, G: {}, names: [], MIT_OEV: false,
  tier: n => B.TIER0.includes(n) ? 0 : B.TIER1.includes(n) ? 1 : 2,
};

export async function ladeBasis() {
  const idx = window.ZK_DATEN || await (await fetch("daten/index.json", { cache: "no-cache" })).json();
  const d = await (await fetch(idx.basis)).json();
  B.ersatzUrl = idx.ersatz;
  B.FPV = d.fpv; B.TIER0 = d.tier0; B.TIER1 = d.tier1; B.OEV = d.oev; B.KANTEN = d.kanten;
  for (const [n, [E, N, lat, lon]] of Object.entries(d.st)) B.ST[n] = { n, E, N, lat, lon };
  for (const [n, [E, N, a]] of Object.entries(d.stx)) B.STX[n] = { n, E, N, a };
  B.SN = Object.keys(B.ST).concat(Object.keys(B.STX)); B.SN.forEach((n, i) => B.SIDX[n] = i);
  d.stuic.forEach((l, i) => l.forEach(u => B.UIC2IDX[u] = i));
  B.MIT_OEV = B.OEV.t.length + B.OEV.s.length > 0;
  // Strecken: Gleisverlauf dekodieren (10-m-Raster, Delta-kodiert), Teilstücke je Bahnhofspaar, Ecken leicht gerundet
  B.LINES = d.lines.map(([name, type, stops, geo]) => {
    const parts = geo.split("/").map(p => glatt(dekodiere(p, (x, y) => [x / 10 - 24800, 13000 - y / 10])));
    return { name, type, stops, parts, km: parts.map(p => laenge(p) / 10) };
  });
  B.LINES.forEach((L, i) => L.stops.forEach((s, j) => {
    const o = B.byStation[s] || (B.byStation[s] = { lines: new Set(), nb: new Set() });
    o.lines.add(i); if (j > 0) o.nb.add(L.stops[j - 1]); if (j < L.stops.length - 1) o.nb.add(L.stops[j + 1]);
  }));
  B.names = Object.keys(B.ST).sort((a, b) => B.tier(b) - B.tier(a));
  // Graph aus den Streckenteilen (für die Laufwege der Züge)
  const G = B.G;
  B.LINES.forEach((L, i) => L.stops.forEach((s, j) => {
    if (!j) return; const a = L.stops[j - 1], pt = L.parts[j - 1], id = i + ":" + (j - 1), len = laenge(pt);
    (G[a] = G[a] || []).push({ to: s, pts: pt, len, id, li: i, pj: j - 1, rev: false }); (G[s] = G[s] || []).push({ to: a, pts: pt.slice().reverse(), len, id, li: i, pj: j - 1, rev: true });
  }));
  const K1 = d.kanten1 || {};   // Tram-, Metro- und Schiffskanten auf 1 m genau (Kartenkoordinaten × 100)
  for (const k in K1) B.KANTEN[k] = K1[k]; B.KF = k => k in K1 ? 100 : 10;
  for (const k in B.KANTEN) {   // Tram-, Metro- und Schiffskanten (und Grenzstrecken)
    const f = k in K1 ? 100 : 10, [a, b] = k.split("|"), pt = dekodiere(B.KANTEN[k], (x, y) => [x / f, y / f]), len = laenge(pt);
    (G[a] = G[a] || []).push({ to: b, pts: pt, len }); (G[b] = G[b] || []).push({ to: a, pts: pt.slice().reverse(), len });
  }
  return B;
}
export const stOf = i => B.ST[B.SN[i]] || B.STX[B.SN[i]];
