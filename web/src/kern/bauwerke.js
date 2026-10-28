// Tunnel und Brücken auf den Bahnstrecken (/api/bauwerke, vom Server aus den swisstopo-Kacheln berechnet).
// Je Strecke und Teilstück Bereiche [von, bis] als Anteil der Länge.
import { B } from "./basis.js";
import { melde } from "../util.js";
export const BW = { v: 0, tunnel: null, bruecke: null };
export async function bauwerkeLaden() {
  try {
    const r = await fetch("/api/bauwerke"); if (!r.ok) throw 0; const j = await r.json();
    if (!j.tunnel || j.tunnel.length !== B.LINES.length) throw 0;
    BW.tunnel = j.tunnel; BW.bruecke = j.bruecke; BW.v++; melde("bauwerke");
  } catch (e) { setTimeout(bauwerkeLaden, 10 * 60000); }   // noch nicht berechnet → später nochmals
}
// Bereiche eines Teilstücks (i = Strecke, j = Teilstück) in Metern … als Anteil
export const tunnelVon = (i, j) => (BW.tunnel && BW.tunnel[i] && BW.tunnel[i][j]) || [];
