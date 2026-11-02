// Kamera folgt einem Fahrzeug (Zug, Tram, Schiff, Bus, Bergbahn): nach dem Antippen fliegt die Kamera in 1,4 s hin
// (nah genug für die 3D-Modelle) und hält das Fahrzeug danach in der Bildmitte. Zoomen, Drehen und Neigen bleiben frei;
// Verschieben mit der Hand, «Auswahl aufheben» oder das Ende der Fahrt beenden das Folgen.
// Die Kamera wird mit jumpTo(…, {folgen: true}) gesetzt; Ebenen, die nach dem Verschieben neu aufbauen (beiRuhe in
// util.js), reagieren nur, wenn das Bild seit dem letzten Aufbau ein gutes Stück weitergewandert ist ({weit: true}).
import { K } from "./karte.js";
import { S } from "../zustand.js";
import { zh } from "../kern/zeit.js";
import { trainPos } from "../kern/wege.js";
import { rtFor } from "../kern/echtzeit.js";
import { wgs, melde } from "../util.js";

export const FOLGE = { an: false };
let ziel = null, start = null, t0 = 0, weitAb = null, zuletzt = null, introFertig = false;
const P = {}, DAUER = 1400;

export function folgen(tr, o) {
  const m = K.map; if (!m) return;
  ziel = { tr, o }; FOLGE.an = true; t0 = performance.now(); weitAb = null; zuletzt = null; introFertig = false;
  const z = m.getZoom(), pi = m.getPitch();
  start = { c: m.getCenter(), z, p: pi, zz: z < 13.5 ? 15.3 : z, pz: K.mit3d && pi < 40 ? 55 : pi };
  melde("folgen", true);
}
export function folgenAus() { if (!FOLGE.an) return; FOLGE.an = false; ziel = null; melde("folgen", false); }

// in jedem Bild (main.js): Lage des Fahrzeugs jetzt → Bildmitte
export function folgeBild(now) {
  if (!FOLGE.an) return; const m = K.map;
  if (!S.sel || S.sel.tr !== ziel.tr) { folgenAus(); return; }
  const rt = rtFor(ziel.tr, ziel.o), p = rt && rt.canc ? null : trainPos(ziel.tr, zh(S.simMs).t + ziel.o, rt, P);
  if (!p) { folgenAus(); return; }   // Fahrt zu Ende
  const ll = wgs(p.x, p.y), u = Math.min(1, (now - t0) / DAUER), e = (1 - Math.cos(u * Math.PI)) / 2;
  if (u >= 1 && introFertig && zuletzt) {   // nur bewegen, wenn sich das Fahrzeug um mindestens ½ Bildpunkt verschoben hat
    const a = m.project(zuletzt), b = m.project(ll); if (Math.hypot(a.x - b.x, a.y - b.y) < .5) return;
  }
  const o = { center: u < 1 ? [start.c.lng + (ll[0] - start.c.lng) * e, start.c.lat + (ll[1] - start.c.lat) * e] : ll };
  if (u < 1) { o.zoom = start.z + (start.zz - start.z) * e; o.pitch = start.p + (start.pz - start.p) * e; }
  else if (!introFertig) { introFertig = true; o.zoom = start.zz; o.pitch = start.pz; }   // auch wenn das Gerät zu langsam für Zwischenbilder war
  // weit genug gewandert (¼ der kleineren Bildseite), damit Gebäude, Bäume, Gleise … nachgeladen werden?
  let weit = false;
  if (u >= 1) {
    const c = m.getCanvas(), lim = Math.min(c.clientWidth, c.clientHeight) / 4;
    if (!weitAb) weit = true; else { const a = m.project(weitAb), b = m.project(ll); weit = Math.hypot(a.x - b.x, a.y - b.y) > lim; }
    if (weit) weitAb = ll;
  }
  zuletzt = ll;
  m.jumpTo(o, { folgen: true, weit });
}

export function folgenStarten() {
  const m = K.map;
  // selbst verschieben = nicht mehr folgen; Zoomen mit zwei Fingern, Mausrad oder Drehen geht weiter
  m.on("dragstart", e => { const t = e && e.originalEvent && e.originalEvent.touches; if (t && t.length > 1) return; folgenAus(); });
}
