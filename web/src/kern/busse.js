// Busse: Halte (/api/busse, beim ersten Hineinzoomen) und Fahrten je 10-km-Kachel und 3-h-Fenster (/api/busse/fahrten).
// Die Halte kommen hinten an die Halteliste (SN), ab «offset» – nach den Bergbahnen, gleich wie auf dem Server.
// Geladen wird nur ab Zoom ZBUS und nur für die Kacheln im Bild; die Fahrten kommen in den Tagesfahrplan (DATED).
import { B } from "./basis.js";
import { zh } from "./zeit.js";
import { DATED, hinzu, neuerTag } from "./fahrplan.js";
import { bbBrauche } from "./bergbahnen.js";
import { lv95, melde } from "../util.js";

export const ZBUS = 12;
export const BUS = { v: null, offset: -1, namen: [], halte: [], laed: null, laedV: null, an: true, kacheln: 0 };

function halteBrauche(v) {
  if (!v || BUS.v === v) return Promise.resolve(BUS.v === v);
  if (BUS.laed && BUS.laedV === v) return BUS.laed;
  BUS.laedV = v;
  return BUS.laed = fetch("/api/busse").then(r => r.ok ? r.json() : null).then(j => { if (j && j.v === v) einbauen(j); return BUS.v === v; }).catch(() => false);
}
function entfernen() {
  for (const n of BUS.namen) { delete B.STX[n]; delete B.SIDX[n]; }
  if (BUS.offset >= 0 && B.SN.length > BUS.offset) B.SN.length = BUS.offset; BUS.namen = []; BUS.halte = []; BUS.v = null;
}
function einbauen(j) {
  entfernen();
  if (B.SN.length !== j.offset) return;   // Bergbahnen fehlen oder Basisdatei passt nicht → keine Busse
  BUS.offset = j.offset;
  j.halte.forEach(([name, E, N], k) => {
    let n = name || "·bus" + k; if (B.ST[n] || B.STX[n]) n = n + " (Bus)"; while (B.ST[n] || B.STX[n]) n += "'";
    B.STX[n] = { n, E, N, a: "bus" }; B.SIDX[n] = B.SN.length; B.SN.push(n); BUS.namen.push(n); if (name) BUS.halte.push([n, E, N]);
  });
  BUS.v = j.v; melde("busse");
}
// Kacheln (10 km, Kartenkoordinaten / 100) im Bild, die Mitte zuerst; höchstens 30
export function kachelnIm(map) {
  const b = map.getBounds(), c = map.getCenter(), ecken = [[b.getWest(), b.getSouth()], [b.getEast(), b.getNorth()], [b.getWest(), b.getNorth()], [b.getEast(), b.getSouth()]].map(([lng, lat]) => lv95(lng, lat));
  const [cE, cN] = lv95(c.lng, c.lat), kx = E => Math.floor((E - 2480000) / 10000), ky = N => Math.floor((1300000 - N) / 10000);
  const x0 = kx(Math.min(...ecken.map(e => e[0]))), x1 = kx(Math.max(...ecken.map(e => e[0]))), y0 = ky(Math.max(...ecken.map(e => e[1]))), y1 = ky(Math.min(...ecken.map(e => e[1])));
  const out = []; for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push([x, y, (x + .5 - (cE - 2480000) / 10000) ** 2 + (y + .5 - (1300000 - cN) / 10000) ** 2]);
  return out.sort((a, b) => a[2] - b[2]).slice(0, 30).map(([x, y]) => x + "_" + y);
}
const ST = new Map();   // «Datum|Fenster|Kachel» → {ok} oder {t} (Fehler: nach 5 Min. wieder versuchen)
async function laden(datum, f, ks) {
  for (const k of ks) ST.set(datum + "|" + f + "|" + k, { lauf: true, t: Date.now() });
  const fehler = () => { for (const k of ks) ST.set(datum + "|" + f + "|" + k, { t: Date.now() }); };
  try {
    const r = await fetch(`/api/busse/fahrten?d=${datum}&f=${f}&k=${ks.join(",")}`); if (!r.ok) throw 0; const j = await r.json();
    if (!(await bbBrauche(j.bbv)) || !(await halteBrauche(j.v))) throw 0;
    const R = DATED[datum] || (DATED[datum] = neuerTag());
    for (const k of ks) { const tt = j.k[k]; if (tt) hinzu(R, tt, true); ST.set(datum + "|" + f + "|" + k, { ok: true }); BUS.kacheln++; }
    melde("fahrplan", datum);
  } catch (e) { fehler(); }
}
// gebraucht wie beim Zugfahrplan: heute ab 10 Min. vor bis 75 Min. nach jetzt, dazu der Vortag (nach Mitternacht)
export function busBrauche(ms, map) {
  if (!BUS.an || !map || map.getZoom() < ZBUS) return;
  const ks = kachelnIm(map), z = zh(ms), zg = zh(ms - 86400000), zm = zh(ms + 86400000), auftraege = [];
  const lade = (datum, von, bis) => { for (let f = Math.max(0, Math.floor(von / 180)); f <= Math.min(15, Math.floor(bis / 180)); f++) {
    const fehlt = ks.filter(k => { const s = ST.get(datum + "|" + f + "|" + k); return !s || (!s.ok && !s.lauf && Date.now() - s.t > 5 * 60000); });
    if (fehlt.length) auftraege.push([datum, f, fehlt]); } };
  lade(z.date, z.t - 10, z.t + 75); lade(zg.date, z.t + 1430, z.t + 1515); if (z.t > 1365) lade(zm.date, 0, z.t + 75 - 1440);
  for (const [d, f, k] of auftraege) laden(d, f, k);
}
