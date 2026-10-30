// ZugKarte – Einstieg: Grunddaten laden, Karte und Seitenleiste starten, Bildschleife
import { ladeBasis } from "./kern/basis.js";
import { bauwerkeLaden } from "./kern/bauwerke.js";
import { fpBrauche } from "./kern/fahrplan.js";
import { sperrLaden, SPERR } from "./kern/wege.js";
import { echtzeitStart } from "./kern/echtzeit.js";
import { zh } from "./kern/zeit.js";
import { S } from "./zustand.js";
import { K, karteStarten } from "./karte/karte.js";
import { fahrzeugeStarten, fahrzeugeBerechnen, FZ } from "./karte/fahrzeuge.js";
import { Z3, zuege3dSchalter } from "./karte/zuege3d.js";
import { welt3dStarten, W3 } from "./karte/welt3d.js";
import { gleiseStarten, GL } from "./karte/gleise.js";
import { wetterStarten, WE } from "./karte/wetter.js";
import { verkehrStarten, VK } from "./karte/verkehr.js";
import { strassenStarten, STR } from "./karte/strassen.js";
import { baeumeStarten, BA } from "./karte/baeume.js";
import { wasserStarten, WA } from "./karte/wasser3d.js";
import { daecherStarten, DA } from "./karte/daecher.js";
import { busBrauche, BUS } from "./kern/busse.js";
import { seiteStarten, seiteTakt, uhr } from "./ui/seite.js";
import { an } from "./util.js";

let takt = 0, sek = -1;
function bild(now) {
  const dt = Math.min(now - S.lastReal, 1000); S.lastReal = now; S.simMs += dt * S.speed;
  SPERR.heute = SPERR.teile.size > 0 && SPERR.datum === zh(S.simMs).date;
  const s = Math.floor(S.simMs / 1000); if (s !== sek) { sek = s; uhr(); }
  if (K.bereit && K.fz) fahrzeugeBerechnen(now);
  if (now - takt > 500) { takt = now; seiteTakt(); if (K.bereit) busBrauche(S.simMs, K.map); }
  requestAnimationFrame(bild);
}
(async () => {
  await ladeBasis();
  fpBrauche(S.simMs);
  seiteStarten(); karteStarten();
  an("karte", () => { welt3dStarten(); baeumeStarten(); wasserStarten(); daecherStarten(); wetterStarten(); verkehrStarten(); gleiseStarten(); strassenStarten(K.map); zuege3dSchalter(); fahrzeugeStarten(); K.fz = true; });
  bauwerkeLaden(); echtzeitStart(); sperrLaden(); setInterval(sperrLaden, 30 * 60000);
  requestAnimationFrame(bild);
  // für Tests und Messungen
  window.__zk = { S, K, zh, FZ, Z3, W3, GL, WE, VK, BUS, STR, BA, WA, DA };
})();
