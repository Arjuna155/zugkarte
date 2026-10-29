// Wetter: aktuelle Messwerte der MeteoSchweiz-Stationen (/api/wetter, alle 10 Min. vom Server geholt).
// Aus den Stationen entsteht ein Wetterfeld über der ganzen Schweiz (Raster 2 km): Regen/Schnee, Nebel mit Obergrenze
// (Hochnebel: tiefe Stationen im Nebel, höhere darüber in der Sonne), Bewölkung. Das Feld steuert die Animationen
// (wetter3d.js): Regen und Schnee fallen nur dort, wo es regnet; Nebel liegt als Nebelmeer, aus dem die Berge ragen.
// Die Messwerte selbst gibt es als eigene Ebene «Wetterstationen» (zum Nachschauen, Klick auf eine Station).
import { K, SCHRIFTEN } from "./karte.js";
import { ebene } from "../ui/ebenen.js";
import { fc, wgs } from "../util.js";
import { wetter3dStarten } from "./wetter3d.js";

export const WE = { stationen: [], zeit: 0, an: true, stationenAn: false, feld: null, jetzt: null, version: 0 };
const HIMMEL = { klar: { "sky-color": "#bcd7ea", "horizon-color": "#e8eef2", "fog-color": "#e8eef2" }, grau: { "sky-color": "#a3adb6", "horizon-color": "#cfd5da", "fog-color": "#cfd5da" } };

// ---- Wetterfeld (Raster 2 km in LV95) ----
const E0 = 2480000, N1 = 1300000, ZELLE = 2000, NX = 180, NY = 116;
export function lv95(lng, lat) {   // WGS84 → LV95 (Näherungsformel swisstopo)
  const p = (lat * 3600 - 169028.66) / 10000, l = (lng * 3600 - 26782.5) / 10000;
  return [2600072.37 + 211455.93 * l - 10938.51 * l * p - 0.36 * l * p * p - 44.54 * l ** 3, 1200147.07 + 308807.95 * p + 3745.25 * l * l + 76.63 * p * p - 194.56 * l * l * p + 119.79 * p ** 3];
}
// Wert an einer Stelle (bilinear); a = Feldname: regen (mm/h), temp (auf Meereshöhe, siehe tempBei), nebel (0–1), nebelOben (m ü. M.), wolken (0–1)
export function feldBei(lng, lat, a) {
  const F = WE.feld; if (!F) return 0; const [E, N] = lv95(lng, lat), fx = (E - E0) / ZELLE - .5, fy = (N1 - N) / ZELLE - .5;
  if (fx < 0 || fy < 0 || fx >= NX - 1 || fy >= NY - 1) return a === "temp" ? 10 : a === "nebelOben" ? 0 : 0;
  const ix = fx | 0, iy = fy | 0, u = fx - ix, v = fy - iy, A = F[a], i = iy * NX + ix;
  return A[i] * (1 - u) * (1 - v) + A[i + 1] * u * (1 - v) + A[i + NX] * (1 - u) * v + A[i + NX + 1] * u * v;
}
export const tempBei = (lng, lat, hoehe) => feldBei(lng, lat, "temp") - .0065 * hoehe;
function feldRechnen() {
  const S = WE.stationen; if (!S.length) return;
  const stunde = +new Date().toLocaleString("en-GB", { hour: "2-digit", hour12: false, timeZone: "Europe/Zurich" }), tag = stunde >= 8 && stunde <= 16;
  const n = NX * NY, F = { regen: new Float32Array(n), temp: new Float32Array(n), nebel: new Float32Array(n), nebelOben: new Float32Array(n), wolken: new Float32Array(n) };
  // Stationsmerkmale: Regen (mm/h aus der letzten Stunde, aktuelle 10 Min. stärker gewichtet), Nebel (Feuchte ≥ 96 %, kaum Regen)
  const st = S.map(s => ({ E: s.E, N: s.N, h: s.hoehe || 500, t: s.t, regen: s.rr1h === null && s.rr === null ? null : Math.max(s.rr1h || 0, (s.rr || 0) * 6 * .8),
    nebel: s.rf === null || s.rf === undefined ? null : s.rf >= 96 && (s.rr1h || 0) < .5 ? 1 : 0,
    wolken: s.so === null || s.so === undefined ? null : !tag ? null : s.so < 1 ? 1 : s.so < 5 ? .5 : 0 }));
  const R_REGEN = 14000, R_NEBEL = 28000, R_WOLKEN = 30000;
  for (let iy = 0; iy < NY; iy++) for (let ix = 0; ix < NX; ix++) {
    const E = E0 + (ix + .5) * ZELLE, N = N1 - (iy + .5) * ZELLE, i = iy * NX + ix;
    let wr = 0, sr = 0, wt = 0, stt = 0, wo = 0, so = 0, wtop = 0, stop = 0, dmin = 1e12;
    for (const s of st) {
      const d2 = (s.E - E) ** 2 + (s.N - N) ** 2; if (d2 < dmin) dmin = d2;
      const g = 1 / Math.max(4e6, d2);
      if (s.t !== null) { wt += g; stt += g * (s.t + .0065 * s.h); }   // auf Meereshöhe umgerechnet (−0,65 °C je 100 m)
      if (s.regen !== null && d2 < R_REGEN * R_REGEN) { const w = g * (1 - d2 / (R_REGEN * R_REGEN)); wr += w; sr += w * s.regen; }
      if (s.wolken !== null && d2 < R_WOLKEN * R_WOLKEN) { wo += g; so += g * s.wolken; }
      if (s.nebel === 1 && d2 < R_NEBEL * R_NEBEL) { wtop += g; stop += g * (s.h + 150); }
    }
    F.regen[i] = wr ? sr / (wr + 1 / (R_REGEN * R_REGEN)) : 0;
    F.temp[i] = wt ? stt / wt : 10; F.wolken[i] = wo ? so / (wo + 1 / (R_WOLKEN * R_WOLKEN)) : 0;
    const oben = wtop ? stop / wtop : 0; F.nebelOben[i] = oben;
    // Nebelanteil: Nebelstationen zählen dafür, klare Stationen nur, wenn sie unter der Nebelobergrenze liegen
    // (eine Station auf dem Berg über dem Nebelmeer spricht nicht gegen Nebel im Tal)
    if (oben) { let wn = 0, sn = 0; for (const s of st) { if (s.nebel === null) continue; const d2 = (s.E - E) ** 2 + (s.N - N) ** 2; if (d2 > R_NEBEL * R_NEBEL) continue; if (!s.nebel && s.h > oben - 50) continue;
      const w = 1 / Math.max(4e6, d2) * (1 - d2 / (R_NEBEL * R_NEBEL)); wn += w; sn += w * s.nebel; }
      F.nebel[i] = wn ? sn / (wn + 1 / (R_NEBEL * R_NEBEL)) : 0; }
  }
  WE.feld = F; WE.version++;
}

async function laden() {
  try {
    const r = await fetch("/api/wetter"); if (!r.ok) return; const j = await r.json(), f = j.felder;
    WE.stationen = j.stationen.map(a => { const o = {}; f.forEach((k, i) => o[k] = a[i]); o.x = (o.E - 2480000) / 100; o.y = (1300000 - o.N) / 100; return o; });
    WE.zeit = j.zeit; feldRechnen(); zeichnen(); lageBeiMitte();
  } catch (e) { console.error(e); }
}

// ---- Ebene «Wetterstationen»: Messwerte zum Nachschauen ----
const tFarbe = ["interpolate", ["linear"], ["get", "t"], -15, "#5b3ea6", -5, "#3d6fd1", 0, "#7fb3e6", 8, "#7cc6a1", 16, "#e8cf55", 24, "#ee8a3a", 32, "#d1343a"];
function zeichnen() {
  const map = K.map; if (!map || !map.getSource("wetter")) return;
  map.getSource("wetter").setData(fc(WE.stationen.map(s => ({ type: "Feature", properties: {
    n: s.name, t: s.t, tt: s.t === null ? "" : Math.round(s.t) + "°", ff: s.ff || 0, dd: s.dd || 0, wind: s.ff !== null && s.ff >= 5 ? 1 : 0, mitT: s.t === null ? 0 : 1,
  }, geometry: { type: "Point", coordinates: wgs(s.x, s.y) } }))));
}
function pfeil() {   // Windpfeil (zeigt, wohin der Wind weht)
  const c = document.createElement("canvas"); c.width = c.height = 32; const g = c.getContext("2d");
  g.fillStyle = "#24313a"; g.strokeStyle = "#ffffff"; g.lineWidth = 2; g.beginPath(); g.moveTo(16, 2); g.lineTo(25, 18); g.lineTo(18.5, 15.5); g.lineTo(18.5, 30); g.lineTo(13.5, 30); g.lineTo(13.5, 15.5); g.lineTo(7, 18); g.closePath(); g.stroke(); g.fill();
  return g.getImageData(0, 0, 32, 32);
}
function stationenSichtbar(an) { const map = K.map; for (const id of ["wetter-pfeil", "wetter-pkt", "wetter-txt"]) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", an ? "visible" : "none"); }

export function wetterStarten() {
  const map = K.map;
  map.addSource("wetter", { type: "geojson", data: fc([]) });
  try { map.addImage("wind-pfeil", pfeil()); } catch (e) { }
  map.addLayer({ id: "wetter-pfeil", type: "symbol", source: "wetter", minzoom: 8, filter: ["==", ["get", "wind"], 1], layout: { visibility: "none",
    "icon-image": "wind-pfeil", "icon-rotate": ["+", ["get", "dd"], 180], "icon-rotation-alignment": "map", "icon-allow-overlap": true, "icon-ignore-placement": true,
    "icon-size": ["interpolate", ["linear"], ["get", "ff"], 5, .45, 30, .8, 80, 1.2], "icon-offset": [0, -26] } });
  map.addLayer({ id: "wetter-pkt", type: "circle", source: "wetter", minzoom: 6.5, filter: ["==", ["get", "mitT"], 1], layout: { visibility: "none" }, paint: {
    "circle-color": tFarbe, "circle-radius": ["interpolate", ["linear"], ["zoom"], 6.5, 3, 9, 9, 13, 12], "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.2, "circle-pitch-alignment": "viewport" } });
  map.addLayer({ id: "wetter-txt", type: "symbol", source: "wetter", minzoom: 8, filter: ["==", ["get", "mitT"], 1], layout: { visibility: "none",
    "text-field": ["get", "tt"], "text-font": [SCHRIFTEN.SCHRIFT], "text-size": ["interpolate", ["linear"], ["zoom"], 8, 9, 13, 12], "text-allow-overlap": true, "text-ignore-placement": true },
    paint: { "text-color": "#ffffff", "text-halo-color": "rgba(0,0,0,.35)", "text-halo-width": .6 } });
  map.on("click", "wetter-pkt", e => {
    const p = e.features[0].properties, s = WE.stationen.find(x => x.name === p.n); if (!s) return;
    const zeile = (n, v, e2) => v === null || v === undefined ? "" : `<tr><td>${n}</td><td><b>${v}${e2}</b></td></tr>`;
    const zeit = s.z ? new Date(s.z).toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Zurich" }) : "";
    new maplibregl.Popup({ closeButton: true, maxWidth: "240px" }).setLngLat(e.lngLat).setHTML(`<b>${s.name}</b> <span style="opacity:.7">${s.hoehe ? Math.round(s.hoehe) + " m" : ""}</span><table style="font-size:12px;margin-top:4px">`
      + zeile("Temperatur", s.t, " °C") + zeile("Niederschlag 1 h", s.rr1h, " mm") + zeile("Wind", s.ff, " km/h") + zeile("Böen", s.fx, " km/h") + zeile("Sonne (10 Min.)", s.so, " Min.")
      + zeile("Feuchte", s.rf, " %") + zeile("Schnee", s.hs, " cm") + `</table><div style="font-size:11px;opacity:.7">MeteoSchweiz, ${zeit}</div>`).addTo(map);
  });
  map.on("mouseenter", "wetter-pkt", () => map.getCanvas().style.cursor = "pointer"); map.on("mouseleave", "wetter-pkt", () => map.getCanvas().style.cursor = "");
  ebene({ id: "wetter", name: "Wetter (Regen, Schnee, Nebel)", an: true, setze: an => { WE.an = an; himmel(true); map.triggerRepaint(); } });
  ebene({ id: "wetterstationen", name: "Wetterstationen (Messwerte)", an: false, setze: an => { WE.stationenAn = an; stationenSichtbar(an); } });
  wetter3dStarten();
  laden(); setInterval(laden, 5 * 60000);
  setInterval(lageBeiMitte, 2000);
}

// ---- Wetter an der Bildmitte: Himmel und Wind für die Animationen ----
function lageBeiMitte() {
  const map = K.map; if (!map || !WE.stationen.length) return;
  const c = map.getCenter();
  const nah = WE.stationen.map(s => { const ll = wgs(s.x, s.y), dx = (ll[0] - c.lng) * 75500, dy = (ll[1] - c.lat) * 111000; return { s, d: Math.hypot(dx, dy) }; }).sort((a, b) => a.d - b.d).slice(0, 4);
  let w = 0, ff = 0, ux = 0, uy = 0;
  for (const { s, d } of nah) { if (s.ff === null) continue; const g = 1 / Math.max(500, d) ** 2; w += g; ff += g * s.ff; const a = (s.dd || 0) * Math.PI / 180; ux += g * Math.sin(a); uy += g * Math.cos(a); }
  WE.jetzt = { ff: w ? ff / w : 0, dd: Math.atan2(ux, uy), regen: feldBei(c.lng, c.lat, "regen"), wolken: feldBei(c.lng, c.lat, "wolken"), nebel: feldBei(c.lng, c.lat, "nebel") };
  himmel(false);
}
function himmel(immer) {
  const J = WE.jetzt, grau = WE.an && !!J && (J.wolken > .6 || J.regen > .2 || J.nebel > .6);
  if (!immer && WE.himmel === grau) return; WE.himmel = grau; const H = grau ? HIMMEL.grau : HIMMEL.klar;
  try { K.map.setSky({ ...H, "sky-horizon-blend": 0.6, "horizon-fog-blend": grau ? 0.25 : 0.4, "fog-ground-blend": grau ? 0.35 : 0.6 }); } catch (e) { }
}
