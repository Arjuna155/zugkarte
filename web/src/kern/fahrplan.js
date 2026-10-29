// Fahrplan: Tagesfahrplan vom Server (/api/fahrplan, offizieller GTFS-Fahrplan je Datum), sonst Ersatzfahrplan nach Wochentag.
// Zeilenformat: «Kat,Linie,Ziel[,Zugnr,Verwaltung]|Halt;Halt» mit Halt = BahnhofIdx(hex),Ankunft[,Abfahrt][@Gleis] (Minuten ab Mitternacht).
// Für die Leistung hat jeder Tag einen Zeitindex: welche Fahrten in welchem 10-Minuten-Fenster unterwegs sein können.
import { B } from "./basis.js";
import { zh, dayType } from "./zeit.js";
import { melde } from "../util.js";
import { bbBrauche, BBNAME } from "./bergbahnen.js";

export const TCLS = c => c === "S" ? "s" : c === "Tram" || c === "M" ? "tr" : c === "BAT" || c === "FAE" ? "sch" : BBNAME[c] ? "bb" : /^(IC|IR|EC|ECE|ICE|TGV|RJX|RJ|EN|NJ)$/.test(c) ? "fv" : "rv";
let RID = 0;
function zeile(l, D) {
  const bar = l.indexOf("|"), [cat, num, di, zn, ag] = l.slice(0, bar).split(",");
  const st = l.slice(bar + 1).split(";").map(x => { const g = x.indexOf("@"), gl = g < 0 ? "" : x.slice(g + 1), a = (g < 0 ? x : x.slice(0, g)).split(","); const t1 = +a[1], t2 = a.length > 2 ? +a[2] : t1; return { i: parseInt(a[0], 16), a: t1, d: t2, gl }; });   // «@Gleis» am Halt
  return { id: RID++, cat, num, zn, ag, label: cat === "S" ? "S" + num : BBNAME[cat] ? BBNAME[cat] : num ? cat + " " + num : cat, to: D[+di] || "", cls: TCLS(cat), st, t0: st[0].d, t1: st[st.length - 1].a, legs: null };
}
// Zeilen zu einem Tag hinzufügen (Fahrten, die in mehreren Zeitfenstern vorkommen, nur einmal)
function hinzu(R, txt) {
  const L = txt.split("\n"), D = L.shift().split("|");
  const n = B.SN.length;
  for (const l of L) { if (!l || R.keys.has(l)) continue; const r = zeile(l, D); if (r.st.some(s => !(s.i < n))) continue; R.keys.add(l); R.push(r); indexiere(R, r); }   // unbekannte Halte (Bergbahn-Netz fehlt): weglassen
  return R;
}
const neuerTag = () => { const R = []; R.idx = []; R.keys = new Set(); return R; };
function parseDay(txt) { return hinzu(neuerTag(), txt); }
// Zeitindex: Fenster zu 10 Minuten; eine Fahrt steht in allen Fenstern von 5 Min. vor Abfahrt bis 90 Min. nach Ankunft (Verspätungen)
const FENSTER = 10, VOR = 5, NACH = 90;
function indexiere(R, r) { for (let k = Math.max(0, Math.floor((r.t0 - VOR) / FENSTER)); k <= Math.floor((r.t1 + NACH) / FENSTER); k++)(R.idx[k] || (R.idx[k] = [])).push(r); }
export const aktiv = (runs, t) => (runs && runs.idx && runs.idx[Math.floor(t / FENSTER)]) || [];

export const DATED = {}; const fpStatus = {}; export const FP = { feed: null };
let ERSATZ = null, ersatzLaedt = false;
async function ersatzLaden() {
  if (ERSATZ || ersatzLaedt) return; ersatzLaedt = true;
  try { const j = await (await fetch(B.ersatzUrl)).json(); ERSATZ = {}; for (const k in j) ERSATZ[k] = parseDay(j[k]); melde("fahrplan"); }
  catch (e) { ersatzLaedt = false; }
}
// Fahrplan vom Server in Zeitfenstern zu 3 Stunden (/api/fahrplan?d=…&f=…): geladen wird nur, was gerade gebraucht wird
const FMIN = 180;
export function tagRuns(z) {
  if (DATED[z.date]) return DATED[z.date];
  const s = fpStatus[z.date]; if (s && s.fehler) ersatzLaden();   // Server hat (noch) keinen Fahrplan → Ersatz
  return ERSATZ ? ERSATZ[dayType(z.wd)] : null;
}
export const istDatiert = date => !!DATED[date];
async function fpLaden(datum, f) {
  const key = datum + "|" + f, s = fpStatus[key]; if (s && (s.ok || s.lauf || Date.now() - s.t < 10 * 60000)) return;
  fpStatus[key] = { lauf: true, t: Date.now() };
  try {
    const r = await fetch("/api/fahrplan?d=" + datum + "&f=" + f); if (!r.ok) throw 0; const j = await r.json(); if (j.v !== B.FPV || !j.tt) throw 0; await bbBrauche(j.bbv);
    hinzu(DATED[datum] || (DATED[datum] = neuerTag()), j.tt); if (datum === zh(Date.now()).date) FP.feed = j.feed;
    fpStatus[key] = { ok: true }; melde("fahrplan", datum);
  } catch (e) { fpStatus[key] = { t: Date.now() }; fpStatus[datum] = { fehler: true }; if (!DATED[datum]) ersatzLaden(); }
}
// gebraucht: heute ab 10 Min. vor bis 75 Min. nach der aktuellen Zeit, dasselbe für den Vortag (Fahrten nach Mitternacht)
// und kurz vor Mitternacht der Anfang von morgen (Abfahrten)
export function fpBrauche(ms) {
  const z = zh(ms), zg = zh(ms - 86400000), zm = zh(ms + 86400000);
  const lade = (datum, von, bis) => { for (let f = Math.max(0, Math.floor(von / FMIN)); f <= Math.min(15, Math.floor(bis / FMIN)); f++)fpLaden(datum, f); };
  lade(z.date, z.t - 10, z.t + 75); lade(zg.date, z.t + 1430, z.t + 1515); if (z.t > 1365) lade(zm.date, 0, z.t + 75 - 1440);
}
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
