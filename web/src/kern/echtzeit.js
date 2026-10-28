// Echtzeit (SIRI-ET über den Server, /api/verspaetungen, jede Minute): Abgleich mit dem Fahrplan über Bahnhof + Sollzeit,
// Verspätungen werden vorwärts weitergereicht.
import { B } from "./basis.js";
import { zh } from "./zeit.js";
import { tagRuns } from "./fahrplan.js";
import { S } from "../zustand.js";
import { melde, an } from "../util.js";

const rtMap = new Map();
export const RT = { on: false, at: 0, matched: 0, canc: 0, total: 0, fehler: null, letzt: null };
export function rtFor(tr, o) { if (!RT.on || Math.abs(S.simMs - Date.now()) > 3 * 3600e3) return null; return rtMap.get(tr.id + "|" + o) || null; }
export function delayNow(rt, p) { if (!rt || !p) return 0; return p.moving ? rt.da[p.next] : rt.dd[p.stop]; }

function applyRT(d) {
  RT.letzt = d;
  const nowMs = Date.now(), z = zh(nowMs), mid0 = Math.round(nowMs / 60000 - z.t), nowMin = nowMs / 60000;
  const svs = [{ runs: tagRuns(zh(nowMs - 86400000)), o: 1440, mid: mid0 - 1440 }, { runs: tagRuns(z), o: 0, mid: mid0 }];
  const idx = new Map(), ref = new Map();
  for (const sv of svs) for (const r of sv.runs || []) {
    if (sv.mid + r.t1 < nowMin - 180 || sv.mid + r.t0 > nowMin + 260) continue; ref.set(r.id + "|" + sv.o, { r, o: sv.o });
    const n = r.st.length; r.st.forEach((St, j) => { const last = j === n - 1; const key = St.i + "|" + Math.round(sv.mid + (last ? St.a : St.d)) + (last ? "a" : "d"); let a = idx.get(key); if (!a) idx.set(key, a = []); a.push(r.id + "|" + sv.o); });
  }
  rtMap.clear(); let matched = 0, canc = 0;
  for (const [nr, line, op, jc, calls] of d.z) {
    const votes = new Map();
    for (const c of calls) {
      const si = B.UIC2IDX[c[0]]; if (si === undefined) continue;
      if (c[3] != null) (idx.get(si + "|" + c[3] + "d") || []).forEach(k => votes.set(k, (votes.get(k) || 0) + 1));
      if (c[1] != null) (idx.get(si + "|" + c[1] + "a") || []).forEach(k => votes.set(k, (votes.get(k) || 0) + 1));
    }
    let best = null, bv = 0; const lab = (line || "").replace(/\s+/g, "");
    for (const [k, v] of votes) { const sc = v + (ref.get(k).r.label.replace(/\s+/g, "") === lab ? .5 : 0); if (sc > bv) { bv = sc; best = k; } }
    if (!best || rtMap.has(best)) continue;
    const { r } = ref.get(best), n = r.st.length;
    const da = new Array(n).fill(null), dd = new Array(n).fill(null), sc = new Array(n).fill(0);
    for (const c of calls) { const si = B.UIC2IDX[c[0]]; r.st.forEach((St, j) => { if (St.i === si) { if (c[2] != null) da[j] = c[2]; if (c[4] != null) dd[j] = c[4]; if (c[5]) sc[j] = 1; } }); }
    let carry = 0; for (let j = 0; j < n; j++) { if (da[j] == null) da[j] = dd[j] != null ? dd[j] : carry; if (dd[j] == null) dd[j] = da[j]; carry = dd[j]; }
    const A = [], D = []; let prev = -1e9; r.st.forEach((St, j) => { const a = Math.max(St.a + da[j] / 60, prev); const dep = Math.max(St.d + dd[j] / 60, a); A.push(a); D.push(dep); prev = dep; });
    rtMap.set(best, { nr, line, canc: !!jc, da, dd, sc, A, D, t0: D[0], t1: A[n - 1] }); matched++; if (jc) canc++;
  }
  Object.assign(RT, { on: true, at: d.abgerufen || Date.now(), matched, canc, total: d.z.length, fehler: null });
  melde("echtzeit");
}
async function abfragen() {
  try {
    const r = await fetch("/api/verspaetungen", { cache: "no-store" }); const j = await r.json().catch(() => ({}));
    if (r.ok && j.z) { applyRT(j); return; }
    if (r.status === 401) { rtMap.clear(); RT.on = false; RT.fehler = "Echtzeit ist gerade nicht verfügbar. Die Karte zeigt die Züge nach Fahrplan."; }
    else RT.fehler = (j.fehler || "Echtzeit gerade nicht verfügbar.") + (RT.on ? " Die Karte zeigt die letzten Daten und versucht es in einer Minute wieder." : " Nächster Versuch in einer Minute.");
  } catch (e) { RT.fehler = "Der Server antwortet gerade nicht. Nächster Versuch in einer Minute."; }
  melde("echtzeit");
}
export function echtzeitStart() { abfragen(); setInterval(abfragen, 60000); an("fahrplan", () => { if (RT.letzt) applyRT(RT.letzt); }); }
