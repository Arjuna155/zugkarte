// Strassengraph und Wegsuche für die Busse – ohne Karte, damit es auch mit echten Kacheln ausserhalb der Seite prüfbar ist
// (siehe strassen.js). Koordinaten in Kartenkoordinaten (LV95 / 100, 1 Einheit = 100 m).
//
// Erkenntnisse aus der Prüfung mit echten swisstopo-Kacheln (Luzern, 02.11.2026):
// - Strassen treffen oft mitten auf ein Stück einer anderen Strasse (T-Kreuzung ohne gemeinsamen Punkt, typisch an
//   Brückenenden) → offene Enden an die nächste Strasse ≤ 2,5 m anschliessen, sonst fehlt die Brücke und der Bus fährt
//   gerade durch den Fluss.
// - Haltestellen liegen oft näher an einer Autobahnrampe oder einem Tunnel als an ihrer Strasse (Luzern Kasernenplatz:
//   2 m von der Rampe) → mehrere Strassen in Reichweite als Start/Ziel, Rampen/Autobahn/Tunnel mit Zuschlag.
export const KLASSEN = new Set(["motorway", "trunk", "primary", "secondary", "tertiary", "minor", "service", "busway", "bus_guideway"]);
const ZELLE = .5;   // Raster für die Suche: 50 m
const REICH = .6;   // Haltestelle bis 60 m von der Strasse
const ANSCHLUSS = .025;   // offene Enden bis 2,5 m an eine andere Strasse anschliessen

// Wasserflächen (Ringe in Kartenkoordinaten) für die Prüfung «Haltestelle → Strasse nicht übers Wasser»
function wasserIndex(polys) {
  const G = new Map(), Z = 1;   // Raster 100 m
  for (const ringe of polys) { let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9; for (const r of ringe) for (const q of r) { x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]); }
    const e = { ringe, x0, x1, y0, y1 }; if ((x1 - x0) * (y1 - y0) > 4e4) continue;   // riesige Fläche (ganzer See über viele Kacheln): Rand reicht über die Teilstücke
    for (let i = Math.floor(x0 / Z); i <= Math.floor(x1 / Z); i++) for (let j = Math.floor(y0 / Z); j <= Math.floor(y1 / Z); j++) { const k = i + "," + j; let l = G.get(k); if (!l) G.set(k, l = []); l.push(e); } }
  return (x, y) => { const l = G.get(Math.floor(x / Z) + "," + Math.floor(y / Z)); if (!l) return false;
    for (const w of l) { if (x < w.x0 || x > w.x1 || y < w.y0 || y > w.y1) continue; let inn = false;
      for (const r of w.ringe) for (let i = 0, j = r.length - 1; i < r.length; j = i++) if ((r[i][1] > y) !== (r[j][1] > y) && x < (r[j][0] - r[i][0]) * (y - r[i][1]) / (r[j][1] - r[i][1]) + r[i][0]) inn = !inn;
      if (inn) return true; }
    return false; };
}
const uebersWasser = (N, x0, y0, x1, y1) => { if (!N.wasser) return false; for (let k = 1; k < 8; k++) if (N.wasser(x0 + (x1 - x0) * k / 8, y0 + (y1 - y0) * k / 8)) return true; return false; };

// feats: [{ pr: Eigenschaften, linien: [[[x, y], …], …] }] (Kartenkoordinaten); wasser: [Ringe, …] (optional)
export function netzBauen(feats, wasser) {
  const id = new Map(), X = [], Y = [], A = [], R = new Map(), kanten = new Set(), BR = new Map();   // BR: Brückenstücke im 50-m-Raster (Höhe der Busse)
  const knoten = (x, y) => { const k = Math.round(x * 100) + "," + Math.round(y * 100); let i = id.get(k); if (i === undefined) { i = X.length; id.set(k, i); X.push(x); Y.push(y); A.push([]); } return i; };
  const zelle = (x, y) => Math.floor(x / ZELLE) + "," + Math.floor(y / ZELLE);
  // Kante a→b (zweiseitig, ausser Einbahn); im Raster mit Zuschlag für die Haltestellen-Zuordnung
  const kante = (a, b, einweg, zu) => {
    const k = a < b ? a + "-" + b : b + "-" + a; if (kanten.has(k)) return; kanten.add(k);
    const L = Math.hypot(X[b] - X[a], Y[b] - Y[a]); A[a].push(b, L); if (!einweg) A[b].push(a, L);
    const n = Math.max(1, Math.ceil(L / ZELLE)), zs = new Set();
    for (let i = 0; i <= n; i++) zs.add(zelle(X[a] + (X[b] - X[a]) * i / n, Y[a] + (Y[b] - Y[a]) * i / n));
    for (const c of zs) { let l = R.get(c); if (!l) R.set(c, l = []); l.push(a, b, zu); }
  };
  for (const f of feats) {
    const p = f.pr; if (!KLASSEN.has(p.class)) continue;
    const schnell = p.class === "motorway" || p.class === "trunk" || p.ramp == 1, tunnel = p.brunnel === "tunnel";
    const einweg = (p.oneway === 1 || p.oneway === "1" || p.oneway === true) && schnell;
    const zu = (schnell ? .5 : 0) + (tunnel ? .3 : 0);   // Haltestellen lieber an gewöhnliche Strassen (+50 m / +30 m)
    for (const ll of f.linien) { let v = -1; for (const q of ll) { const i = knoten(q[0], q[1]); if (v >= 0 && v !== i) kante(v, i, einweg, zu); v = i; } }
    if (p.brunnel === "bridge") for (const ll of f.linien) for (let k = 1; k < ll.length; k++) {
      const a = ll[k - 1], b = ll[k], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / ZELLE)), zs = new Set();
      for (let i = 0; i <= n; i++) zs.add(zelle(a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n));
      for (const c of zs) { let l = BR.get(c); if (!l) BR.set(c, l = []); l.push(a, b); }
    }
  }
  // offene Enden (Kachelrand, T-Kreuzung): an den nächsten Punkt einer anderen Strasse ≤ 2,5 m anschliessen
  const nk = X.length, neu = [];
  for (let i = 0; i < nk; i++) {
    if (A[i].length > 2) continue;
    const cx = Math.floor(X[i] / ZELLE), cy = Math.floor(Y[i] / ZELLE); let best = null, bd = ANSCHLUSS;
    for (let u = -1; u <= 1; u++) for (let w = -1; w <= 1; w++) {
      const l = R.get((cx + u) + "," + (cy + w)); if (!l) continue;
      for (let k = 0; k < l.length; k += 3) {
        const a = l[k], b = l[k + 1]; if (a === i || b === i || A[i].includes(a) || A[i].includes(b)) continue;
        const ex = X[b] - X[a], ey = Y[b] - Y[a], l2 = ex * ex + ey * ey || 1e-12, t = Math.max(0, Math.min(1, ((X[i] - X[a]) * ex + (Y[i] - Y[a]) * ey) / l2));
        const d = Math.hypot(X[a] + ex * t - X[i], Y[a] + ey * t - Y[i]); if (d < bd) { bd = d; best = { a, b, t, zu: l[k + 2] }; }
      }
    }
    if (best) neu.push([i, best]);
  }
  for (const [i, { a, b, t, zu }] of neu) {
    const m = t < .02 ? a : t > .98 ? b : knoten(X[a] + (X[b] - X[a]) * t, Y[a] + (Y[b] - Y[a]) * t);
    if (m !== a && m !== b) { const ein = !A[b].includes(a); kante(a, m, ein, zu); kante(m, b, ein, zu); }   // Stück teilen (Richtung bleibt)
    if (m !== i) kante(i, m, false, zu);
  }
  return { X, Y, A, R, BR, n: kanten.size, wasser: wasser && wasser.length ? wasserIndex(wasser) : null };
}

// Strassen in Reichweite eines Punkts (≤ 60 m), je Kante der nächste Fusspunkt; sortiert nach Abstand + Zuschlag
function inReichweite(N, x, y, max = 4) {
  const cx = Math.floor(x / ZELLE), cy = Math.floor(y / ZELLE), out = new Map();
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    const l = N.R.get((cx + i) + "," + (cy + j)); if (!l) continue;
    for (let k = 0; k < l.length; k += 3) {
      const a = l[k], b = l[k + 1], key = a + "-" + b; if (out.has(key)) continue;
      const ex = N.X[b] - N.X[a], ey = N.Y[b] - N.Y[a], l2 = ex * ex + ey * ey || 1e-12, t = Math.max(0, Math.min(1, ((x - N.X[a]) * ex + (y - N.Y[a]) * ey) / l2));
      const px = N.X[a] + ex * t, py = N.Y[a] + ey * t, d = Math.hypot(px - x, py - y);
      if (d < REICH) out.set(key, { a, b, px, py, d, w: d + l[k + 2] + (d > .05 && uebersWasser(N, x, y, px, py) ? 2 : 0) });   // nicht übers Wasser zur Strasse (+200 m)
    }
  }
  return [...out.values()].sort((p, q) => p.w - q.w).slice(0, max);
}
export const strasseNah = (N, x, y) => inReichweite(N, x, y, 1)[0] || null;

// kleiner Binärheap für A*
function heap() {
  const k = [], v = [];
  return {
    get n() { return k.length; },
    push(key, val) { k.push(key); v.push(val); let i = k.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= k[i]) break; [k[p], k[i]] = [k[i], k[p]]; [v[p], v[i]] = [v[i], v[p]]; i = p; } },
    pop() { const top = v[0], lk = k.pop(), lv = v.pop(); if (k.length) { k[0] = lk; v[0] = lv; let i = 0; for (; ;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < k.length && k[l] < k[m]) m = l; if (r < k.length && k[r] < k[m]) m = r; if (m === i) break; [k[m], k[i]] = [k[i], k[m]]; [v[m], v[i]] = [v[i], v[m]]; i = m; } } return top; }
  };
}
// kürzester Weg von (xa, ya) nach (xb, yb): mehrere Strassen in Reichweite als Start und Ziel (mit Zuschlag), A*.
// Ergebnis: Punktliste (Halt → Strasse → … → Strasse → Halt) oder null (kein Weg oder unplausibler Umweg)
export function wegSuchen(N, xa, ya, xb, yb) {
  const AS = inReichweite(N, xa, ya), ZS = inReichweite(N, xb, yb); if (!AS.length || !ZS.length) return null;
  const luft = Math.hypot(xb - xa, yb - ya), grenze = 2.5 * luft + 1.5;   // Umweg höchstens 2,5 × Luftlinie + 150 m (Kehren am Hang)
  const { X, Y, A } = N;
  // gleiche Kante: direkt
  let direkt = null;
  for (const s of AS) for (const z of ZS) if (s.a === z.a && s.b === z.b && (!direkt || s.w + z.w < direkt.w)) direkt = { s, z, w: s.w + z.w + Math.hypot(z.px - s.px, z.py - s.py) };
  const g = new Map(), vor = new Map(), H = heap(), zx = ZS[0].px, zy = ZS[0].py, h = i => Math.max(0, Math.hypot(X[i] - zx, Y[i] - zy) - REICH);
  const startBei = new Map();
  const start = (i, d, s) => { if (!g.has(i) || d < g.get(i)) { g.set(i, d); vor.set(i, -1); startBei.set(i, s); H.push(d + h(i), i); } };
  for (const s of AS) { start(s.a, s.w + Math.hypot(X[s.a] - s.px, Y[s.a] - s.py), s); start(s.b, s.w + Math.hypot(X[s.b] - s.px, Y[s.b] - s.py), s); }
  const ziel = new Map();
  for (const z of ZS) for (const e of [z.a, z.b]) { const c = z.w + Math.hypot(X[e] - z.px, Y[e] - z.py); if (!ziel.has(e) || c < ziel.get(e).c) ziel.set(e, { c, z }); }
  let best = direkt ? direkt.w : Infinity, bestI = -1, schritte = 0; const fertig = new Set();
  while (H.n && schritte++ < 30000) {
    const u = H.pop(); if (fertig.has(u)) continue; fertig.add(u); const gu = g.get(u);
    if (gu + h(u) >= best || gu > grenze) break;
    const zz = ziel.get(u); if (zz && gu + zz.c < best) { best = gu + zz.c; bestI = u; }
    const n = A[u]; for (let k = 0; k < n.length; k += 2) { const w = n[k], d = gu + n[k + 1]; if (!g.has(w) || d < g.get(w)) { g.set(w, d); vor.set(w, u); startBei.set(w, startBei.get(u)); H.push(d + h(w), w); } }
  }
  if (best > grenze + 1.2) return null;   // Zuschläge (bis 2 × 80 m) nicht zum Umweg zählen
  let pts;
  if (bestI < 0) { if (!direkt) return null; pts = [[direkt.s.px, direkt.s.py], [direkt.z.px, direkt.z.py]]; }
  else {
    const z = ziel.get(bestI).z, s = startBei.get(bestI);
    pts = [[z.px, z.py]]; for (let c = bestI; c >= 0; c = vor.get(c)) pts.push([X[c], Y[c]]); pts.push([s.px, s.py]); pts.reverse();
  }
  pts.unshift([xa, ya]); pts.push([xb, yb]);
  return pts;
}

// liegt der Punkt auf einer Brücke (≤ 6 m von einem Brückenstück)? Für die Höhe der Busse (sonst folgen sie dem Gelände
// hinunter ins Flussbett)
export function aufBruecke(N, x, y) {
  if (!N || !N.BR) return false; const cx = Math.floor(x / ZELLE), cy = Math.floor(y / ZELLE);
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    const l = N.BR.get((cx + i) + "," + (cy + j)); if (!l) continue;
    for (let k = 0; k < l.length; k += 2) { const a = l[k], b = l[k + 1], ex = b[0] - a[0], ey = b[1] - a[1], l2 = ex * ex + ey * ey || 1e-12, t = Math.max(0, Math.min(1, ((x - a[0]) * ex + (y - a[1]) * ey) / l2));
      if (Math.hypot(a[0] + ex * t - x, a[1] + ey * t - y) < .06) return true; }
  }
  return false;
}
