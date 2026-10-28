// Fahrplan: Tagesfahrplan vom Server (/api/fahrplan, offizieller GTFS-Fahrplan je Datum), sonst Ersatzfahrplan nach Wochentag.
// Zeilenformat: «Kat,Linie,Ziel[,Zugnr,Verwaltung]|Halt;Halt» mit Halt = BahnhofIdx(hex),Ankunft[,Abfahrt] (Minuten ab Mitternacht).
// Für die Leistung hat jeder Tag einen Zeitindex: welche Fahrten in welchem 10-Minuten-Fenster unterwegs sein können.
import { B } from "./basis.js";
import { zh, dayType } from "./zeit.js";
import { melde } from "../util.js";

export const TCLS = c => c === "S" ? "s" : c === "Tram" || c === "M" ? "tr" : c === "BAT" || c === "FAE" ? "sch" : /^(IC|IR|EC|ECE|ICE|TGV|RJX|RJ|EN|NJ)$/.test(c) ? "fv" : "rv";
let RID = 0;
function parseDay(txt) {
  const L = txt.split("\n"), D = L.shift().split("|");
  return L.filter(Boolean).map(l => {
    const bar = l.indexOf("|"), [cat, num, di, zn, ag] = l.slice(0, bar).split(",");
    const st = l.slice(bar + 1).split(";").map(x => { const a = x.split(","); const t1 = +a[1], t2 = a.length > 2 ? +a[2] : t1; return { i: parseInt(a[0], 16), a: t1, d: t2 }; });
    return { id: RID++, cat, num, zn, ag, label: cat === "S" ? "S" + num : num ? cat + " " + num : cat, to: D[+di] || "", cls: TCLS(cat), st, t0: st[0].d, t1: st[st.length - 1].a, legs: null };
  });
}
// Zeitindex: Fenster zu 10 Minuten; eine Fahrt steht in allen Fenstern von 5 Min. vor Abfahrt bis 90 Min. nach Ankunft (Verspätungen)
const FENSTER = 10, VOR = 5, NACH = 90;
function mitIndex(runs) {
  const idx = [];
  for (const r of runs) for (let k = Math.max(0, Math.floor((r.t0 - VOR) / FENSTER)); k <= Math.floor((r.t1 + NACH) / FENSTER); k++)(idx[k] || (idx[k] = [])).push(r);
  runs.idx = idx; return runs;
}
export const aktiv = (runs, t) => (runs && runs.idx && runs.idx[Math.floor(t / FENSTER)]) || [];

export const DATED = {}; const fpStatus = {}; export const FP = { feed: null };
let ERSATZ = null, ersatzLaedt = false;
async function ersatzLaden() {
  if (ERSATZ || ersatzLaedt) return; ersatzLaedt = true;
  try { const j = await (await fetch(B.ersatzUrl)).json(); ERSATZ = {}; for (const k in j) ERSATZ[k] = mitIndex(parseDay(j[k])); melde("fahrplan"); }
  catch (e) { ersatzLaedt = false; }
}
export function tagRuns(z) {
  if (DATED[z.date]) return DATED[z.date];
  const s = fpStatus[z.date]; if (s && !s.lauf && !s.ok) ersatzLaden();   // Server hat (noch) keinen Fahrplan → Ersatz
  return ERSATZ ? ERSATZ[dayType(z.wd)] : null;
}
export const istDatiert = date => !!DATED[date];
async function fpLaden(datum) {
  const s = fpStatus[datum]; if (s && (s.ok || s.lauf || Date.now() - s.t < 10 * 60000)) return;
  fpStatus[datum] = { lauf: true, t: Date.now() };
  try {
    const r = await fetch("/api/fahrplan?d=" + datum); if (!r.ok) throw 0; const j = await r.json(); if (j.v !== B.FPV || !j.tt) throw 0;
    DATED[datum] = mitIndex(parseDay(j.tt)); if (datum === zh(Date.now()).date) FP.feed = j.feed; fpStatus[datum] = { ok: true };
    melde("fahrplan", datum);
  } catch (e) { fpStatus[datum] = { t: Date.now() }; if (datum === zh(Date.now()).date) ersatzLaden(); }
}
// gestern, heute, morgen bereithalten (Züge nach Mitternacht gehören zum Vortag)
export function fpBrauche(ms) { for (const d of [-1, 0, 1]) { const z = zh(ms + d * 86400000); if (!DATED[z.date]) fpLaden(z.date); } }
// Aktive Betriebstage: heute (Versatz 0) und gestern (Versatz +1440, Züge nach Mitternacht)
export function services(ms) {
  const z = zh(ms), zg = zh(ms - 86400000);
  return [{ runs: tagRuns(zg), o: 1440, t: z.t + 1440, datum: zg.date }, { runs: tagRuns(z), o: 0, t: z.t, datum: z.date }];
}
// alle Fahrten, die zwischen t0 und t1 unterwegs sein können (für die Abfahrten eines Bahnhofs)
export function aktivZwischen(runs, t0, t1) {
  const out = new Set(); if (!runs || !runs.idx) return out;
  for (let k = Math.max(0, Math.floor(t0 / FENSTER)); k <= Math.floor(t1 / FENSTER); k++) for (const r of runs.idx[k] || []) out.add(r);
  return out;
}
