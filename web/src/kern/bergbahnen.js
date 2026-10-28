// Bergbahnen (Standseil- und Luftseilbahnen): Halte und gerade Kanten kommen nicht aus der Basisdatei, sondern vom Server
// (/api/bergbahnen, aus dem GTFS erzeugt). Sie werden hinten an die Halteliste (SN) gehängt – ab Index «offset», gleich
// wie im Tagesfahrplan des Servers. Kennung «bbv» steht in jedem Fahrplanfenster.
import { B } from "./basis.js";
import { laenge, melde } from "../util.js";

export const BB = { v: null, offset: -1, namen: [], kanten: [], laed: null, laedV: null };
export const BBNAME = { FUN: "Standseilbahn", PB: "Luftseilbahn", GB: "Gondelbahn", SL: "Sesselbahn", LB: "Luftseilbahn", SB: "Seilbahn", KB: "Kabinenbahn" };

export function bbBrauche(v) {
  if (!v || BB.v === v) return Promise.resolve(true);
  if (BB.laed && BB.laedV === v) return BB.laed;
  BB.laedV = v;
  return BB.laed = fetch("/api/bergbahnen").then(r => r.ok ? r.json() : null).then(j => { if (j && j.v === v) einbauen(j); return BB.v === v; }).catch(() => false);
}
function entfernen() {   // altes Bergbahn-Netz weg (neue Fahrplanausgabe)
  for (const n of BB.namen) { delete B.STX[n]; delete B.SIDX[n]; delete B.G[n]; }
  if (BB.offset >= 0) B.SN.length = BB.offset; BB.namen = []; BB.kanten = []; BB.v = null;
}
function einbauen(j) {
  entfernen();
  if (B.SN.length !== j.offset) return;   // Basisdatei passt nicht zum Server (ältere Seite) → keine Bergbahnen
  BB.offset = j.offset;
  j.halte.forEach(([name, E, N], k) => {
    let n = name || "·bb" + k; if (B.ST[n] || B.STX[n]) n = n + " (Bergbahn)"; while (B.ST[n] || B.STX[n]) n += "'";
    B.STX[n] = { n, E, N, a: "b" }; B.SIDX[n] = B.SN.length; B.SN.push(n); BB.namen.push(n);
  });
  const xy = s => [(s.E - 2480000) / 100, (1300000 - s.N) / 100];
  for (const [a, b, kat] of j.kanten) {
    const A = B.SN[a], Z = B.SN[b]; if (!A || !Z) continue;
    const pts = [xy(B.STX[A]), xy(B.STX[Z])], len = laenge(pts);
    (B.G[A] = B.G[A] || []).push({ to: Z, pts, len }); (B.G[Z] = B.G[Z] || []).push({ to: A, pts: pts.slice().reverse(), len });
    BB.kanten.push([A, Z, pts, kat || "PB"]);
  }
  BB.v = j.v; melde("bergbahnen");
}
