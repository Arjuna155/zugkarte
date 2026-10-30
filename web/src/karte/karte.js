// Karte: MapLibre GL mit swisstopo-Grundkarte und 3D-Gelände (Mapterhorn); Strecken, Bahnhöfe, Trams, Schiffe, Sperrungen
import { B } from "../kern/basis.js";
import { SPERR } from "../kern/wege.js";
import { tunnelVon } from "../kern/bauwerke.js";
import { BB } from "../kern/bergbahnen.js";
import { BUS } from "../kern/busse.js";
import { ebene } from "../ui/ebenen.js";
import { landschaftStil, DEM_URL } from "./landschaft.js";
import { S } from "../zustand.js";
import { $, X, Y, wgs, fc, dekodiere, glatt, melde, an, istHandy } from "../util.js";

export const CH_BOX = [[5.95, 45.82], [10.49, 47.81]];
export const K = { map: null, bereit: false, mit3d: true, fzTreffer: null, fzTip: null, linienAn: false };
const STIL_URL = "https://vectortiles.geo.admin.ch/styles/ch.swisstopo.lightbasemap.vt/style.json";
const SCHRIFT = "Frutiger Neue Condensed Bold", SCHRIFT_M = "Frutiger Neue Condensed Medium";
export const SCHRIFTEN = { SCHRIFT, SCHRIFT_M };
const FARBE_LN = { fv: "#16222b", rv: "#22808f", sm: "#b5612a" };

export function fit(box) { const a = wgs(box[0], box[3]), b = wgs(box[2], box[1]); K.map.fitBounds([a, b], { padding: 60, maxZoom: 14, duration: 900 }); }
export function hinZu(x, y, z) { K.map.easeTo({ center: wgs(x, y), zoom: Math.max(K.map.getZoom(), z), duration: 900 }); }
export function setze3d(an) {
  K.mit3d = an; try { localStorage.setItem("zk3d", an ? "an" : "aus"); } catch (e) { }
  $("z3d").setAttribute("aria-pressed", an); if (!K.bereit) return;
  const map = K.map;
  if (an) { map.setTerrain({ source: "dem", exaggeration: 1.3 }); if (map.getPitch() < 20) map.easeTo({ pitch: 55, duration: 900 }); }
  else { map.setTerrain(null); map.easeTo({ pitch: 0, bearing: 0, duration: 900 }); }
}
export function showTip(t, e) { const r = $("wrap").getBoundingClientRect(), tp = $("tip"); tp.textContent = t; tp.style.left = (e.clientX - r.left) + "px"; tp.style.top = (e.clientY - r.top) + "px"; tp.hidden = false; }
export function hideTip() { $("tip").hidden = true; }

// Grundkarte: swisstopo-Stil laden und zur Landschaft umbauen (landschaft.js); ?grundkarte=karte zeigt die alte Karte
export function karteStarten() {
  let alt = false; try { alt = new URLSearchParams(location.search).get("grundkarte") === "karte"; } catch (e) { }
  if (alt) return karteBauen(STIL_URL);
  fetch(STIL_URL).then(r => r.ok ? r.json() : Promise.reject()).then(s => karteBauen(landschaftStil(s))).catch(() => karteBauen(STIL_URL));
}
function karteBauen(stil) {
  maplibregl.setWorkerUrl("lib/maplibre-gl-csp-worker.js?v=" + ((window.ZK_LOCAL && window.ZK_LOCAL.version) || "1"));
  try { K.mit3d = localStorage.getItem("zk3d") !== "aus"; } catch (e) { }
  if (K.map) { try { K.map.remove(); } catch (e) { } K.map = null; }
  const map = K.map = new maplibregl.Map({
    container: "map", style: stil,
    bounds: CH_BOX, fitBoundsOptions: { padding: 20 }, pitch: K.mit3d ? 35 : 0, maxPitch: 80,
    attributionControl: { compact: true, customAttribution: "Gelände © <a href='https://mapterhorn.com/attribution'>Mapterhorn</a> · Fahrplan opentransportdata.swiss · Tram/Schiff/Perrons © OpenStreetMap" }
  });
  // Sicherung: Fehler im Landschaftsstil (z. B. neue swisstopo-Version) → bisherige Grundkarte
  if (typeof stil !== "string") { let geladen = false; map.once("load", () => geladen = true);
    map.on("error", e => { if (!geladen && !K.ersatzStil && /layers\[|style|Style/.test(String(e && e.error && e.error.message))) { K.ersatzStil = true; console.warn("Landschaftsstil fehlerhaft, nehme Karte:", e.error.message); setTimeout(() => karteBauen(STIL_URL), 0); } }); }
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
  try { new ResizeObserver(() => map.resize()).observe($("map")); } catch (e) { }
  $("zin").onclick = () => map.zoomIn(); $("zout").onclick = () => map.zoomOut();
  $("zreset").onclick = () => map.fitBounds(CH_BOX, { padding: 20, pitch: K.mit3d ? 35 : 0, bearing: 0, duration: 1000 });
  $("z3d").setAttribute("aria-pressed", K.mit3d); $("z3d").onclick = () => setze3d(!K.mit3d);
  map.on("load", () => {
    const L = B.LINES;
    const bahnFC = bahnDaten();
    const stFC = fc(B.names.map((n, j) => ({ type: "Feature", id: j, properties: { n, t: B.tier(n) }, geometry: { type: "Point", coordinates: wgs(X(B.ST[n]), Y(B.ST[n])) } })));
    const oevFC = a => fc(B.OEV[a].map(k => ({ type: "Feature", properties: { n: k.replace("|", " - ") }, geometry: { type: "LineString", coordinates: glatt(dekodiere(B.KANTEN[k], (x, y) => [x / B.KF(k), y / B.KF(k)])).map(q => wgs(q[0], q[1])) } })));
    map.addSource("dem", { type: "raster-dem", tiles: [DEM_URL], encoding: "terrarium", tileSize: 512, maxzoom: 14 });
    if (typeof stil === "string") try { map.setSky({ "sky-color": "#bcd7ea", "horizon-color": "#e8eef2", "fog-color": "#e8eef2", "sky-horizon-blend": 0.6, "horizon-fog-blend": 0.4, "fog-ground-blend": 0.6 }); } catch (e) { }
    map.addSource("schiff", { type: "geojson", data: B.MIT_OEV ? oevFC("s") : fc([]) });
    map.addSource("tram", { type: "geojson", data: B.MIT_OEV ? oevFC("t") : fc([]) });
    const bbFC = () => fc(BB.kanten.map(([a, z, p, kat]) => ({ type: "Feature", properties: { n: a + " - " + z, fun: kat === "FUN" ? 1 : 0 }, geometry: { type: "LineString", coordinates: p.map(q => wgs(q[0], q[1])) } })));
    map.addSource("bergbahn", { type: "geojson", data: bbFC() }); an("bergbahnen", () => map.getSource("bergbahn").setData(bbFC()));
    const busFC = () => fc(BUS.halte.map(([n, E, N]) => ({ type: "Feature", properties: { n, l: n.replace(/ \(Bus\)'*$/, "").replace(/[^\x00-\xff]/g, "-") }, geometry: { type: "Point", coordinates: wgs((E - 2480000) / 100, (1300000 - N) / 100) } })));
    map.addSource("bushalte", { type: "geojson", data: busFC() }); an("busse", () => map.getSource("bushalte").setData(busFC()));
    map.addSource("bahn", { type: "geojson", data: bahnFC });
    an("bauwerke", () => { map.getSource("bahn").setData(bahnDaten()); kartenAuswahl(); });
    map.addSource("sperren", { type: "geojson", data: fc([]) });
    map.addSource("st", { type: "geojson", data: stFC });
    map.addLayer({ id: "schiff", type: "line", source: "schiff", paint: { "line-color": "#3d86b8", "line-width": 1.4, "line-dasharray": [3, 2], "line-opacity": .8 } });
    map.addLayer({ id: "bergbahn", type: "line", source: "bergbahn", minzoom: 9, paint: { "line-color": "#6b4a2b", "line-width": ["interpolate", ["linear"], ["zoom"], 9, .7, 16, 2], "line-dasharray": [4, 1, 1, 1], "line-opacity": .85 }, filter: ["==", ["get", "fun"], 0] });
    map.addLayer({ id: "bergbahn-fun", type: "line", source: "bergbahn", minzoom: 9, filter: ["==", ["get", "fun"], 1], paint: { "line-color": "#6b4a2b", "line-width": ["interpolate", ["linear"], ["zoom"], 9, 1, 16, 3], "line-opacity": .9 } });
    map.addLayer({ id: "tram", type: "line", source: "tram", minzoom: 11, paint: { "line-color": "#5f7380", "line-width": ["interpolate", ["linear"], ["zoom"], 11, .8, 16, 2.5], "line-opacity": .75 } });
    map.addLayer({ id: "bahn-hl", type: "line", source: "bahn", filter: ["==", ["get", "i"], -1], layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#e3a008", "line-width": ["interpolate", ["linear"], ["zoom"], 7, 6, 14, 10] } });
    map.addLayer({
      id: "bahn", type: "line", source: "bahn", layout: { "line-join": "round", "line-cap": "round" }, paint: {
        "line-color": ["match", ["get", "t"], "fv", FARBE_LN.fv, "sm", FARBE_LN.sm, FARBE_LN.rv],
        "line-width": ["interpolate", ["linear"], ["zoom"], 7, ["match", ["get", "t"], "fv", 2, 1.4], 14, ["match", ["get", "t"], "fv", 4.5, 3.2]],
        "line-opacity": ["case", ["boolean", ["feature-state", "dim"], false], .18, 1]
      }
    });
    // Tunnel: gestrichelt und blasser (die Linie liegt sonst über dem Berg)
    map.addLayer({
      id: "bahn-tunnel", type: "line", source: "bahn", filter: ["==", ["get", "tun"], 1], paint: {
        "line-color": ["match", ["get", "t"], "fv", FARBE_LN.fv, "sm", FARBE_LN.sm, FARBE_LN.rv], "line-dasharray": [1.2, 1.4],
        "line-width": ["interpolate", ["linear"], ["zoom"], 7, ["match", ["get", "t"], "fv", 1.6, 1.1], 14, ["match", ["get", "t"], "fv", 3.2, 2.4]],
        "line-opacity": ["case", ["boolean", ["feature-state", "dim"], false], .1, .45]
      }
    }, "bahn");
    map.addLayer({ id: "sperren", type: "line", source: "sperren", filter: ["==", ["geometry-type"], "LineString"], paint: { "line-color": "#e5484d", "line-width": ["interpolate", ["linear"], ["zoom"], 7, 3, 14, 6], "line-dasharray": [2, 1.5] } });
    map.addLayer({ id: "sperren-z", type: "circle", source: "sperren", filter: ["==", ["geometry-type"], "Point"], paint: { "circle-color": "#e5484d", "circle-radius": 7, "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.5, "circle-pitch-alignment": "viewport" } });
    map.addLayer({ id: "sperren-zt", type: "symbol", source: "sperren", filter: ["==", ["geometry-type"], "Point"], layout: { "text-field": "-", "text-font": [SCHRIFT], "text-size": 18, "text-allow-overlap": true, "text-ignore-placement": true }, paint: { "text-color": "#ffffff" } });
    // Bushaltestellen (erst nah: Punkte ab Zoom 14.5, Namen ab 16)
    map.addLayer({ id: "bushalte", type: "circle", source: "bushalte", minzoom: 14.5, paint: { "circle-color": "#ffffff", "circle-stroke-color": "#5b7f1a", "circle-stroke-width": 1.6, "circle-radius": ["interpolate", ["linear"], ["zoom"], 14.5, 2.5, 18, 5], "circle-pitch-alignment": "viewport" } });
    map.addLayer({ id: "bushalte-l", type: "symbol", source: "bushalte", minzoom: 16, layout: { "text-field": ["get", "l"], "text-font": [SCHRIFT_M], "text-size": 11, "text-anchor": "left", "text-offset": [0.7, 0], "text-optional": true }, paint: { "text-color": "#3f5a12", "text-halo-color": "#ffffff", "text-halo-width": 1.4 } });
    // Achtung: Schriften der Grundkarte nur für Zeichen bis U+00FF – andere Zeichen lassen ganze Ebenen ausfallen
    for (const t of [2, 1, 0]) map.addLayer({
      id: "st" + t, type: "circle", source: "st", filter: ["==", ["get", "t"], t], minzoom: [10, 8, 0][t], paint: {
        "circle-color": ["case", ["boolean", ["feature-state", "sel"], false], "#e3a008", "#ffffff"], "circle-stroke-color": "#16222b",
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 7, [4.5, 3.5, 2.5][t], 13, [7, 5.5, 4.5][t]], "circle-stroke-width": [2, 1.6, 1.2][t], "circle-pitch-alignment": "viewport"
      }
    });
    for (const t of [2, 1, 0]) map.addLayer({
      id: "stl" + t, type: "symbol", source: "st", filter: ["==", ["get", "t"], t], minzoom: [11.5, 9, 6.5][t], layout: {
        "text-field": ["get", "n"], "text-font": [t === 0 ? SCHRIFT : SCHRIFT_M], "text-size": [14, 12.5, 11.5][t], "text-anchor": "left", "text-offset": [0.8, 0], "text-optional": true
      }, paint: { "text-color": "#16222b", "text-halo-color": "#ffffff", "text-halo-width": 1.6 }
    });
    // Hinweise beim Überfahren; Fahrzeuge zuerst (eigene Ebene, siehe fahrzeuge.js)
    const ebenen = ["bushalte", "st0", "st1", "st2", "bahn", "bahn-tunnel", "tram", "schiff", "bergbahn", "bergbahn-fun", "sperren", "sperren-z"];
    const text = f => f.layer.id === "tram" ? "Tram: " + f.properties.n : f.layer.id === "schiff" ? "Schiff: " + f.properties.n : f.layer.id.startsWith("bergbahn") ? "Bergbahn: " + f.properties.n : f.layer.id === "bushalte" ? "Bushaltestelle: " + f.properties.l : f.layer.id.startsWith("sperren") ? "Gesperrt: heute kein Zugverkehr (Bahnersatz)" : f.properties.n;
    let tipT = 0;
    map.on("mousemove", e => {
      const jetzt = performance.now(); if (jetzt - tipT < 50) return; tipT = jetzt;
      const fz = K.fzTip && K.fzTip(e.point);
      if (fz) { map.getCanvas().style.cursor = "pointer"; showTip(fz, e.originalEvent); return; }
      const p = e.point, f = map.queryRenderedFeatures([[p.x - 4, p.y - 4], [p.x + 4, p.y + 4]], { layers: ebenen })[0];
      if (f) { map.getCanvas().style.cursor = "pointer"; showTip(text(f), e.originalEvent); } else { map.getCanvas().style.cursor = ""; hideTip(); }
    });
    map.on("click", e => {
      const p = e.point, box = [[p.x - 8, p.y - 8], [p.x + 8, p.y + 8]];
      if (K.fzTreffer && K.fzTreffer(p)) return;
      const s = map.queryRenderedFeatures(box, { layers: ["st0", "st1", "st2", "bushalte"] })[0]; if (s) { melde("bahnhof", s.properties.n); return; }
      const l = map.queryRenderedFeatures(box, { layers: ["bahn", "bahn-tunnel"] })[0]; if (l) { melde("strecke", l.properties.i); return; }
      melde("leer");
    });
    map.on("movestart", hideTip);
    if (istHandy()) {
      const a = document.querySelector(".maplibregl-ctrl-attrib"); if (a) a.classList.remove("maplibregl-compact-show");
      setTimeout(() => { map.resize(); map.fitBounds(CH_BOX, { padding: 20, duration: 0 }); }, 300);   // Seitenleiste ist inzwischen zugeklappt
    }
    ebene({ id: "busse", name: "Busse (beim Hineinzoomen)", an: true, setze: an => { BUS.an = an; for (const l of ["bushalte", "bushalte-l"]) if (map.getLayer(l)) map.setLayoutProperty(l, "visibility", an ? "visible" : "none"); } });
    // Kartenlinien (Bahnnetz, Tram, Schiff, Bergbahn, Verkehrslage): standardmässig aus – die Grundkarte ist eine Landschaft
    ebene({ id: "strecken", name: "Kartenlinien (Bahn, Tram, Schiff, Verkehrslage)", an: false, setze: an => { K.linienAn = an; for (const l of ["bahn", "bahn-tunnel", "tram", "schiff", "bergbahn", "bergbahn-fun", "verkehr-lage"]) if (map.getLayer(l)) map.setLayoutProperty(l, "visibility", an && (l !== "verkehr-lage" || !K.verkehrAus) ? "visible" : "none"); } });
    K.bereit = true; setze3d(K.mit3d); kartenAuswahl(); sperrenKarte(); melde("karte");
  });
  an("sperren", sperrenKarte);
}

// Strecken als GeoJSON: je Strecke ein Merkmal für die offenen Stücke (id = i) und eines für die Tunnel (id = 100000 + i)
function bahnDaten() {
  const fs = [];
  B.LINES.forEach((Ln, i) => {
    const offen = [], tunnel = [];
    Ln.parts.forEach((pt, j) => {
      const ber = tunnelVon(i, j); if (!ber.length) { offen.push(pt); return; }
      const cum = [0]; for (let k = 1; k < pt.length; k++)cum.push(cum[k - 1] + Math.hypot(pt[k][0] - pt[k - 1][0], pt[k][1] - pt[k - 1][1]));
      const T = cum[cum.length - 1], stueck = (a, b) => {   // Teil zwischen den Längen a und b
        const r = []; const bei = s => { let k = 1; while (k < pt.length - 1 && cum[k] < s) k++; const u = (s - cum[k - 1]) / ((cum[k] - cum[k - 1]) || 1); return [pt[k - 1][0] + (pt[k][0] - pt[k - 1][0]) * u, pt[k - 1][1] + (pt[k][1] - pt[k - 1][1]) * u]; };
        r.push(bei(a)); for (let k = 0; k < pt.length; k++) if (cum[k] > a && cum[k] < b) r.push(pt[k]); r.push(bei(b)); return r;
      };
      let pos = 0;
      for (const [a, b] of ber) { if (a * T > pos) offen.push(stueck(pos, a * T)); tunnel.push(stueck(a * T, b * T)); pos = b * T; }
      if (pos < T) offen.push(stueck(pos, T));
    });
    const ll = arr => arr.filter(p => p.length > 1).map(p => p.map(q => wgs(q[0], q[1])));
    fs.push({ type: "Feature", id: i, properties: { i, t: Ln.type, n: Ln.name, tun: 0 }, geometry: { type: "MultiLineString", coordinates: ll(offen) } });
    if (tunnel.length) fs.push({ type: "Feature", id: 100000 + i, properties: { i, t: Ln.type, n: Ln.name + " (Tunnel)", tun: 1 }, geometry: { type: "MultiLineString", coordinates: ll(tunnel) } });
  });
  return fc(fs);
}

let stSel = null;
export function markSt(n) {
  const map = K.map;
  if (K.bereit && stSel !== null && stSel >= 0) map.setFeatureState({ source: "st", id: stSel }, { sel: false });
  stSel = n === null ? null : B.names.indexOf(n);
  if (K.bereit && stSel !== null && stSel >= 0) map.setFeatureState({ source: "st", id: stSel }, { sel: true });
}
// Auswahl und Filter der Strecken auf die Karte übertragen
export function kartenAuswahl() {
  if (!K.bereit) return; const map = K.map;
  const arten = ["literal", Object.keys(S.onT).filter(t => S.onT[t])];
  map.setFilter("bahn", ["all", ["in", ["get", "t"], arten], ["!=", ["get", "tun"], 1]]);
  map.setFilter("bahn-tunnel", ["all", ["in", ["get", "t"], arten], ["==", ["get", "tun"], 1]]);
  map.setFilter("bahn-hl", ["==", ["get", "i"], S.selLn === null ? -1 : S.selLn]);
  B.LINES.forEach((L, i) => { const dim = (S.selLn !== null && S.selLn !== i) || (!!S.selSt && !B.byStation[S.selSt].lines.has(i)); map.setFeatureState({ source: "bahn", id: i }, { dim }); map.setFeatureState({ source: "bahn", id: 100000 + i }, { dim }); });
}
// Gesperrte Abschnitte (Bahnersatz): rote Linie mit Zeichen in der Mitte
function sperrenKarte() {
  const namen = new Set(), fs = [];
  for (const id of SPERR.teile) {
    const [i, j] = id.split(":").map(Number), L = B.LINES[i]; if (!L || !L.parts[j]) continue; const pt = L.parts[j]; namen.add(L.name);
    fs.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: pt.map(q => wgs(q[0], q[1])) } });
    let tot = 0; for (let q = 1; q < pt.length; q++)tot += Math.hypot(pt[q][0] - pt[q - 1][0], pt[q][1] - pt[q - 1][1]); let acc = 0, m = pt[0];
    for (let q = 1; q < pt.length; q++) { const d = Math.hypot(pt[q][0] - pt[q - 1][0], pt[q][1] - pt[q - 1][1]); if (acc + d >= tot / 2) { const u = (tot / 2 - acc) / (d || 1); m = [pt[q - 1][0] + (pt[q][0] - pt[q - 1][0]) * u, pt[q - 1][1] + (pt[q][1] - pt[q - 1][1]) * u]; break; } acc += d; }
    fs.push({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: wgs(m[0], m[1]) } });
  }
  if (K.bereit) K.map.getSource("sperren").setData(fc(fs));
  const box = $("sperrInfo");
  if (SPERR.teile.size && box) { box.hidden = false; box.innerHTML = `<span aria-hidden="true">⚠</span><span><b>Heute gesperrt</b> (Bahnersatz): ${[...namen].sort().join(", ")}. Auf diesen Abschnitten fahren heute keine Züge.</span>`; }
  else if (box) box.hidden = true;
}
