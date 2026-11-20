// Grundkarte als gezeichnete Landschaft statt als Karte: Höhenfarben aus dem Geländemodell (Tal grün → Alpweide →
// Fels → Schnee), Wald, Gebüsch, Fels, Geröll, Gletscher und Seen in Naturfarben, Schattierung mit Licht von
// Nordwesten. Keine Namen, Grenzen, Höhenlinien oder Kartenzeichen. Strassen und Bahntrassen erst nah (ab Zoom 14) als
// Asphalt- bzw. Schotterband in echter Breite. Die Quellen kommen aus dem swisstopo-Stil (ändern mit dessen Version).
import { BODEN, BODEN_QUELLE } from "./boden.js";
export const DEM_URL = "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp";

// Breite in Metern → Pixel je Zoomstufe (Schweiz, 46.8° N): Kacheln 512 px → bei Zoom 10 sind es 40 075 017 · cos 46.8° / 512 / 1024
// = 52,3 m je Pixel, also 1 m = 1024 / M_PX Pixel. (Bis 20.11. stand hier 106 000 → alle Bänder waren nur halb so breit.)
const M_PX = 53560;
const meter = m => ["interpolate", ["exponential", 2], ["zoom"], 10, m * 1024 / M_PX, 22, m * 4194304 / M_PX];
// Strassen: Farben, Breiten (m) und Markierungen – auch für die Brücken in welt3d.js (gleicher Belag, gleiche Breite)
// ein Asphaltton für alle Klassen: verschiedene Töne gaben an Einmündungen und Rastplätzen sichtbare Flicken
export const STRASSENFARBE = { klein: "#85888b", haupt: "#85888b", autobahn: "#85888b", schotter: "#988f84", rand: "#b9b6ae", bankett: "#a9a79f", linie: "#edebe5" };
export const STRASSENBREITE = { rail: 4.5, transit: 4.5, minor: 5.5, primary: 8, secondary: 8, tertiary: 8, motorway: 12, trunk: 12 };
export const MARKE = { rand: 3.9, rampe: 2.5 };
// Rampen (Ein-/Ausfahrten) haben einen Fahrstreifen, getrennte Richtungsfahrbahnen und Abbiegespuren von Hauptstrassen
// ebenfalls: schmaler als die volle Strasse – sonst wird ein Anschluss zu einem Knäuel aus überbreiten Bändern
export const RAMPE_BREITE = 6.5, EINBAHN_BREITE = 5;
export const strassenBreite = (art, einweg, rampe) => (art === "motorway" || art === "trunk") ? (rampe ? RAMPE_BREITE : STRASSENBREITE[art]) : (["primary", "secondary", "tertiary"].includes(art) && einweg ? EINBAHN_BREITE : STRASSENBREITE[art]);
const meterX = (ausdruck, plus = 0) => ["interpolate", ["exponential", 2], ["zoom"], 10, ["*", ["+", ausdruck, plus], 1024 / M_PX], 22, ["*", ["+", ausdruck, plus], 4194304 / M_PX]];   // Autobahn: Randlinien ± 3,9 m von der Mitte der Fahrbahn
const FARBE = {
  wiese: "#a3bd7c", wald: "#5b7a43", waldLicht: "#6f8c52", gebuesch: "#83a05f", park: "#9ec47a", rebe: "#a8b36c",
  sumpf: "#8ea88a", fels: "#aba497", geroell: "#bdb6a9", eis: "#eef3f6", wasser: "#4f86a8", fluss: "#5a8fb0",
  siedlung: "#c8c1b2", gewerbe: "#bdb9b2", asphalt: "#8b8d8f", feldweg: "#b9ab8e", pfad: "#c4b694", schotter: "#988f84", dach: "#b9a99a",
};

export function landschaftStil(stil) {
  const quellen = stil.sources || {}, namen = Object.keys(quellen);
  const basis = namen.find(n => /base/.test(quellen[n].url || "") || /base/.test(n)) || namen.find(n => (stil.layers || []).some(l => l.source === n && l["source-layer"] === "transportation"));
  const relief = namen.find(n => /relief/.test(quellen[n].url || "") || /relief/.test(n));
  const L = [];
  L.push({ id: "ls-grund", type: "background", paint: { "background-color": FARBE.wiese } });
  // Höhenfarben (eigene DEM-Quelle; das Gelände für 3D nutzt «dem»)
  L.push({ id: "ls-hoehe", type: "color-relief", source: "dem-farbe", paint: { "color-relief-opacity": .9, "color-relief-color": ["interpolate", ["linear"], ["elevation"],
    0, "#7fa8c4", 150, "#9cbd78", 500, "#a3bd7c", 900, "#9fb877", 1400, "#98ae72", 1900, "#a2a978", 2300, "#aaa48d", 2700, "#aca69c", 3100, "#c6c7c8", 3500, "#e9eef2", 4500, "#f6f9fb"] } });
  // lebendiger Boden: Parzellen und Flecken (boden.js), unter Wald, Siedlung und Wasser
  if (BODEN.an) L.push({ id: "ls-boden", type: "raster", source: "boden", paint: { "raster-opacity": ["interpolate", ["linear"], ["zoom"], 11, 0, 12.5, 1], "raster-resampling": "linear", "raster-fade-duration": 0 } });
  if (basis) {
    const lc = (id, filt, farbe, o = {}) => L.push({ id, type: "fill", source: basis, "source-layer": "landcover", filter: filt, paint: { "fill-color": farbe, "fill-antialias": false, ...o } });
    lc("ls-park", ["match", ["get", "subclass"], ["park", "recreation_ground", "golf_course", "allotments", "plant_nursery"], true, false], FARBE.park, { "fill-opacity": .7 });
    lc("ls-rebe", ["match", ["get", "subclass"], ["orchard", "vineyard"], true, false], FARBE.rebe, { "fill-opacity": .8 });
    lc("ls-sumpf", ["any", ["==", ["get", "subclass"], "swamp"], ["==", ["get", "class"], "wetland"]], FARBE.sumpf, { "fill-opacity": .8 });
    lc("ls-gebuesch", ["match", ["get", "subclass"], ["scrub", "woody_plant"], true, false], FARBE.gebuesch, { "fill-opacity": .9 });
    lc("ls-wald-licht", ["==", ["get", "subclass"], "loose_forest"], FARBE.waldLicht, { "fill-opacity": .9 });
    lc("ls-wald", ["any", ["match", ["get", "subclass"], ["forest", "wood"], true, false], ["==", ["get", "class"], "wood"]], FARBE.wald, { "fill-opacity": .95 });
    lc("ls-sand", ["==", ["get", "class"], "sand"], "#d6c9a3", { "fill-opacity": .8 });
  }
  if (relief) {   // Fels, Geröll und Eis aus dem Relief (swisstopo)
    L.push({ id: "ls-fels", type: "fill", source: relief, "source-layer": "hillshade", filter: ["==", ["get", "mask"], "rock"], paint: { "fill-color": FARBE.fels, "fill-opacity": .85, "fill-antialias": false } });
    L.push({ id: "ls-geroell-m", type: "fill", source: relief, "source-layer": "hillshade", filter: ["==", ["get", "mask"], "scree"], paint: { "fill-color": FARBE.geroell, "fill-opacity": .8, "fill-antialias": false } });
    L.push({ id: "ls-geroell", type: "fill", source: relief, "source-layer": "scree", paint: { "fill-color": FARBE.geroell, "fill-opacity": .55, "fill-antialias": false } });
    L.push({ id: "ls-eis-m", type: "fill", source: relief, "source-layer": "hillshade", filter: ["==", ["get", "mask"], "ice"], paint: { "fill-color": FARBE.eis, "fill-opacity": .95, "fill-antialias": false } });
  }
  if (basis) {
    L.push({ id: "ls-gletscher", type: "fill", source: basis, "source-layer": "landcover", filter: ["any", ["==", ["get", "subclass"], "glacier"], ["match", ["get", "class"], ["glacier", "ice"], true, false]], paint: { "fill-color": FARBE.eis, "fill-opacity": .95, "fill-antialias": false } });
    // Siedlungsflächen leicht getönt (ohne Umrisse)
    L.push({ id: "ls-siedlung", type: "fill", source: basis, "source-layer": "landuse", filter: ["match", ["get", "class"], ["residential", "suburb", "neighbourhood", "village", "town", "city"], true, false], paint: { "fill-color": FARBE.siedlung, "fill-opacity": ["interpolate", ["linear"], ["zoom"], 9, .35, 14, .55], "fill-antialias": false } });
    L.push({ id: "ls-gewerbe", type: "fill", source: basis, "source-layer": "landuse", filter: ["match", ["get", "class"], ["industrial", "commercial", "retail", "railway", "parking", "quarry", "landfill"], true, false], paint: { "fill-color": FARBE.gewerbe, "fill-opacity": .6, "fill-antialias": false } });
  }
  // weicher Schatten am Fuss der Häuser (Umriss weich, die innere Hälfte liegt unter dem Haus)
  if (basis) L.push({ id: "ls-hausschatten", type: "line", source: basis, "source-layer": "building", minzoom: 14.5, layout: { "line-join": "round" }, paint: { "line-color": "#2b3526", "line-width": meter(2.5), "line-blur": meter(2), "line-opacity": ["interpolate", ["linear"], ["zoom"], 14.5, 0, 15.5, .32] } });
  // Schneedecke (schnee.js setzt Grenze und Sichtbarkeit nach den Messstationen); Wald und Felswände schimmern durch
  L.push({ id: "ls-schnee", type: "color-relief", source: "dem-farbe", layout: { visibility: "none" }, paint: { "color-relief-opacity": 1, "color-relief-color": ["interpolate", ["linear"], ["elevation"], 0, "rgba(248,250,253,0)", 9000, "rgba(248,250,253,0)"] } });
  if (basis) L.push({ id: "ls-schnee-wald", type: "fill", source: basis, "source-layer": "landcover", layout: { visibility: "none" }, filter: ["any", ["match", ["get", "subclass"], ["forest", "wood", "loose_forest"], true, false], ["==", ["get", "class"], "wood"]], paint: { "fill-color": FARBE.wald, "fill-opacity": .5, "fill-antialias": false } });
  if (relief) L.push({ id: "ls-schnee-fels", type: "fill", source: relief, "source-layer": "hillshade", layout: { visibility: "none" }, filter: ["==", ["get", "mask"], "rock"], paint: { "fill-color": FARBE.fels, "fill-opacity": .5, "fill-antialias": false } });
  // Schattierung (Licht von Nordwesten, weich von mehreren Seiten)
  L.push({ id: "ls-schatten", type: "hillshade", source: "dem-farbe", paint: { "hillshade-method": "multidirectional", "hillshade-exaggeration": .45, "hillshade-highlight-color": "rgba(255,250,230,0.5)", "hillshade-shadow-color": "rgba(45,58,80,0.42)", "hillshade-accent-color": "rgba(40,50,60,0.25)" } });
  if (basis) {
    L.push({ id: "ls-wasser", type: "fill", source: basis, "source-layer": "water", paint: { "fill-color": FARBE.wasser, "fill-antialias": true } });
    // Ufersaum: heller, weich auslaufender Rand (flaches Wasser, Kies)
    L.push({ id: "ls-ufer", type: "line", source: basis, "source-layer": "water", minzoom: 11.5, layout: { "line-join": "round" }, paint: { "line-color": "#9cc6cc", "line-width": meter(4.5), "line-blur": meter(3), "line-opacity": ["interpolate", ["linear"], ["zoom"], 11.5, 0, 13, .6] } });
    L.push({ id: "ls-fluss", type: "line", source: basis, "source-layer": "waterway", filter: ["!=", ["get", "intermittent"], 1], layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": FARBE.fluss, "line-width": ["interpolate", ["exponential", 2], ["zoom"], 8, ["match", ["get", "class"], "river", .8, .2], 22, ["match", ["get", "class"], "river", 15 * 4194304 / M_PX, 1.5 * 4194304 / M_PX]], "line-opacity": ["interpolate", ["linear"], ["zoom"], 8, .6, 12, .9] } });
    // Wege, Strassen und Bahntrassen nah als Oberfläche in echter Breite (keine Tunnel); bleibt auch für die Suche der
    // Strassen und Gleise durch andere Ebenen im Stil (source-layer transportation)
    const tr = (id, klassen, farbe, m, minzoom) => L.push({ id, type: "line", source: basis, "source-layer": "transportation", minzoom,
      filter: ["all", ["match", ["get", "class"], klassen, true, false], ["!=", ["get", "brunnel"], "tunnel"], ["==", ["geometry-type"], "LineString"]],
      layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": farbe, "line-width": meter(m), "line-opacity": ["interpolate", ["linear"], ["zoom"], minzoom, 0, minzoom + .6, 1] } });
    // Linien auf Brücken als eigene Ebene «…-bruecke»: welt3d.js blendet sie aus, sobald die 3D-Brücke gebaut ist
    // (sonst liegt die Strasse zusätzlich unten im Tal). Ränder und Markierungen gibt es nur neben den Brücken.
    const linie = (id, klassen, bruecke, minzoom, paint, extra, layout) => L.push({ id, type: "line", source: basis, "source-layer": "transportation", minzoom,
      filter: ["all", ["match", ["get", "class"], klassen, true, false], bruecke ? ["==", ["get", "brunnel"], "bridge"] : ["!", ["match", ["get", "brunnel"], ["tunnel", "bridge"], true, false]], ["==", ["geometry-type"], "LineString"], ...(extra || [])],
      layout: layout || { "line-cap": "round", "line-join": "round" }, paint });
    const ein = (z, bis = 1) => ["interpolate", ["linear"], ["zoom"], z, 0, z + .6, bis];
    const band = (id, klassen, farbe, m, minzoom) => { for (const br of [false, true]) linie(id + (br ? "-bruecke" : ""), klassen, br, minzoom, { "line-color": farbe, "line-width": meter(m), "line-opacity": ein(minzoom) }); };
    const KL = ["minor", "service"], HS = ["primary", "secondary", "tertiary"], AB = ["motorway", "trunk"];
    tr("ls-pfad", ["path", "footway", "trail"], FARBE.pfad, 1.5, 15.5);
    tr("ls-feldweg", ["track"], FARBE.feldweg, 3, 14.5);
    // Bahn auf Schotter; Tram (transit/tram) liegt meist in der Strasse → Band in Asphaltfarbe (Schienen zeichnet bahnhoefe3d.js)
    const TRAM = ["==", ["get", "subclass"], "tram"];
    for (const br of [false, true]) {
      linie("ls-bahn" + (br ? "-bruecke" : ""), ["rail", "transit"], br, 13.5, { "line-color": STRASSENFARBE.schotter, "line-width": meter(STRASSENBREITE.rail), "line-opacity": ein(13.5) }, [["!", TRAM]]);
      linie("ls-tram" + (br ? "-bruecke" : ""), ["transit"], br, 14, { "line-color": STRASSENFARBE.haupt, "line-width": meter(3.4), "line-opacity": ein(14) }, [TRAM]);
    }
    // Rand (Randstein, Trottoir, Bankett): etwas breiteres helles Band unter dem Asphalt
    linie("ls-rand-klein", ["minor"], false, 15, { "line-color": STRASSENFARBE.rand, "line-width": meter(STRASSENBREITE.minor + 2.2), "line-opacity": ein(15, .9) });
    const B_HS = ["case", ["==", ["get", "oneway"], 1], EINBAHN_BREITE, STRASSENBREITE.primary], B_AB = ["case", ["==", ["get", "ramp"], 1], RAMPE_BREITE, STRASSENBREITE.motorway];
    linie("ls-rand", HS, false, 14.5, { "line-color": STRASSENFARBE.rand, "line-width": meterX(B_HS, 2.4), "line-opacity": ein(14.5, .9) });
    linie("ls-rand-autobahn", AB, false, 14, { "line-color": STRASSENFARBE.bankett, "line-width": meterX(B_AB, 1.6), "line-opacity": ein(14, .9) });
    // Zufahrten, Parkplatzgassen (service): schmal und ohne Rand, sonst wird ein Rastplatz zu einem Fleck aus dicken Bändern
    for (const br of [false, true]) linie("ls-zufahrt" + (br ? "-b" : ""), ["service"], br, 14.5, { "line-color": STRASSENFARBE.klein, "line-width": meter(3.6), "line-opacity": ein(14.5) });   // Brücken hier nicht in 3D → Band bleibt
    band("ls-strasse-klein", ["minor"], STRASSENFARBE.klein, STRASSENBREITE.minor, 14);
    for (const br of [false, true]) {
      linie("ls-strasse" + (br ? "-bruecke" : ""), HS, br, 13.5, { "line-color": STRASSENFARBE.haupt, "line-width": meterX(B_HS), "line-opacity": ein(13.5) });
      linie("ls-autobahn" + (br ? "-bruecke" : ""), AB, br, 12.5, { "line-color": STRASSENFARBE.autobahn, "line-width": meterX(B_AB), "line-opacity": ein(12.5) });
    }
    // Markierungen (nah): Mittellinie gestrichelt, Autobahn mit Randlinien und Leitlinie
    const stumpf = { "line-cap": "butt", "line-join": "round" }, weiss = STRASSENFARBE.linie;
    linie("ls-mitte", HS, false, 15.5, { "line-color": weiss, "line-width": meter(.18), "line-dasharray": [17, 33], "line-opacity": ein(15.5, .85) }, [["!=", ["get", "oneway"], 1]], stumpf);
    linie("ls-autobahn-rand", AB, false, 15, { "line-color": weiss, "line-width": meter(.2), "line-gap-width": meter(MARKE.rand * 2), "line-opacity": ein(15, .85) }, [["!=", ["get", "ramp"], 1]], stumpf);
    linie("ls-rampe-rand", AB, false, 15.5, { "line-color": weiss, "line-width": meter(.18), "line-gap-width": meter(MARKE.rampe * 2), "line-opacity": ein(15.5, .8) }, [["==", ["get", "ramp"], 1]], stumpf);
    linie("ls-autobahn-mitte", AB, false, 15.5, { "line-color": weiss, "line-width": meter(.18), "line-dasharray": [33, 67], "line-opacity": ein(15.5, .85) }, [["!=", ["get", "ramp"], 1]], stumpf);
    // Dächer flach, bis die 3D-Gebäude übernehmen (die Gebäude-Ebene sucht diese Quelle im Stil)
    L.push({ id: "ls-dach", type: "fill", source: basis, "source-layer": "building", minzoom: 13, paint: { "fill-color": FARBE.dach, "fill-opacity": ["interpolate", ["linear"], ["zoom"], 13, 0, 13.6, .9] } });
  }
  return {
    ...stil, layers: L, terrain: undefined,
    sources: { ...quellen, ...(BODEN.an ? { boden: BODEN_QUELLE } : {}), "dem-farbe": { type: "raster-dem", tiles: [DEM_URL], encoding: "terrarium", tileSize: 512, maxzoom: 12, bounds: [2.5, 41.5, 14.5, 52.0] } },   // wie GEBIET in karte.js
    sky: { "sky-color": "#9cc3e2", "horizon-color": "#e6eef3", "fog-color": "#e1e9ee", "sky-horizon-blend": 0.55, "horizon-fog-blend": 0.45, "fog-ground-blend": 0.55, "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 12, 0.6, 14, 0] },
    light: { anchor: "map", position: [1.4, 300, 40], color: "#fffaf0", intensity: 0.35 },
  };
}
