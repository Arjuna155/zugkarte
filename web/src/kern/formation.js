// Zugzusammensetzung (Formation-Dienst über den Server, /api/formation), sonst typischer Zug der Linie (ZM.rueckfall)
import { B } from "./basis.js";
import { zh } from "./zeit.js";
import { S } from "../zustand.js";
import { ZM } from "../karte/modelle.js";

const FO = {};   // Datum → {evu, f, z, t, v}
async function foLaden(d) {
  const o = FO[d]; if (o && (o.lauf || Date.now() - o.t < 5 * 60000)) return;
  if (o) o.lauf = true; else FO[d] = { lauf: true, t: 0, v: 0, f: [], z: {}, evu: {} };
  try { const r = await fetch("/api/formation?d=" + d); if (!r.ok) throw 0; const j = await r.json(); FO[d] = { evu: j.evu || {}, f: j.f || [], z: j.z || {}, t: Date.now(), v: (o ? o.v : 0) + 1 }; }
  catch (e) { FO[d] = Object.assign(FO[d] || {}, { lauf: false, t: Date.now() }); }
}
const datumVon = o => zh(S.simMs - (o ? 86400000 : 0)).date;
// Zug ausgewählt: Server soll dessen Formation vorziehen
export function foWunsch(tr, o) {
  const d = datumVon(o), F = FO[d]; if (!F || !F.evu || !F.evu[tr.ag] || !tr.zn) return;
  const k = F.evu[tr.ag] + ":" + tr.zn; if (F.z[k] && F.z[k][1]) return; fetch("/api/formation?d=" + d + "&w=" + encodeURIComponent(k)).catch(() => { });
}
// Wagenliste eines Zuges (zwischengespeichert, bis neue Formationsdaten kommen). Wagen, die nur einen Teil des Laufs
// mitfahren (Flügelzüge, Verstärkung), haben von/bis-Halte: kv/kb = Index im Lauf (−1 bzw. 1e9 = ganzer Lauf).
export function wagenVon(tr, o) {
  const d = datumVon(o); foLaden(d); const F = FO[d], ver = F ? F.v : 0;
  if (tr._wg && tr._wgv === ver) return tr._wg;
  let w = null, echt = -1; const key = F && F.evu && F.evu[tr.ag] && tr.zn ? F.evu[tr.ag] + ":" + tr.zn : null;
  if (key && F.z[key]) { const [i, e] = F.z[key]; w = ZM.ausFormation(F.f[i]); echt = e; }
  if (!w || !w.length) { w = ZM.rueckfall(tr.cat, tr.num, tr.ag); echt = -1; }
  const halt = u => { const si = B.UIC2IDX[u]; if (si === undefined) return -2; return tr.st.findIndex(St => St.i === si); };
  for (const v of w) { const a = v.von ? halt(v.von) : -1, b = v.bis ? halt(v.bis) : -1; v.kv = a >= 0 ? a : -1; v.kb = b >= 0 ? b : 1e9; }
  tr._wg = { w, echt, sub: {} }; tr._wgv = ver; return tr._wg;
}
// Wagen, die auf dem aktuellen Abschnitt mitfahren (stehend: alle, die an diesem Halt im Zug sind) → Bauteile mit Lage im Zug
export function wagenJetzt(Z, p) {
  const j = p.j, m = p.moving; let maske = "";
  for (const v of Z.w) maske += (m ? v.kv <= j && v.kb >= j + 1 : v.kv <= j && v.kb >= j) ? "1" : "0";
  const S_ = Z.sub[maske]; if (S_) return S_;
  let w = Z.w.filter((v, i) => maske[i] === "1"); if (!w.length) w = Z.w;
  let off = 0; const teile = ZM.wagenTeile(w).map((W, i) => { const L = w[i].L / 100, s = off + L / 2; off += L; return { W, L, s }; });
  return Z.sub[maske] = { teile, L: off, w };
}
