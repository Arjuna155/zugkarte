// Gemeinsamer Zustand der Seite (Zeit, Auswahl, Filter, Anzeige)
export const S = {
  simMs: Date.now(), speed: 1, lastReal: performance.now(),
  sel: null,            // ausgewählter Zug {tr, o}
  selSt: null,          // ausgewählter Bahnhof (Name)
  selLn: null,          // ausgewählte Strecke (Index)
  onT: { fv: true, rv: true, sm: true },                    // Streckenarten sichtbar
  onTr: { fv: true, rv: true, s: true, tr: true, sch: true, bb: true }, // Zugarten sichtbar
  colMode: "art",       // Zugfarbe: «art» (Zugart) oder «vsp» (Verspätung)
  zaehler: { fv: 0, rv: 0, s: 0, tr: 0, sch: 0, bb: 0 }, zaehlerD: { d0: 0, d1: 0, d2: 0, dn: 0 }, spaet: 0, ausfall: 0,
};
try { S.colMode = localStorage.getItem("zkFarbe") === "vsp" ? "vsp" : "art"; } catch (e) { }
export const KLASSEN = ["fv", "rv", "s", "tr", "sch", "bb"];
export const TNAME = { fv: "Fernverkehr", rv: "Regio & RegioExpress", s: "S-Bahn", tr: "Tram & Metro", sch: "Schiff", bb: "Bergbahn" };
export const DNAME = { d0: "Pünktlich (unter 3 Min.)", d1: "3–5 Min. verspätet", d2: "Ab 6 Min. verspätet", dn: "Ohne Echtzeitdaten" };
export const DCLS = dl => dl == null ? "dn" : dl < 180 ? "d0" : dl < 360 ? "d1" : "d2";
export const TYPES = { fv: { name: "Fernverkehrsachsen", short: "Fernverkehr" }, rv: { name: "Regionalstrecken", short: "Regional" }, sm: { name: "Schmalspur & Privatbahnen", short: "Schmalspur" } };
