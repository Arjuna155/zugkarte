// Wetter-Ebene: aktuelle Messwerte der MeteoSchweiz-Stationen (/api/wetter, alle 10 Min. vom Server geholt).
// Auf der Karte: Temperatur und Wind je Station, Niederschlag der letzten Stunde als blaue Fläche.
// In 3D (ab Zoom 11): Regen oder Schnee um die Bildmitte nach den nächsten Stationen, bedeckter Himmel ohne Sonne.
import { K, SCHRIFTEN } from "./karte.js";
import { ladeThree } from "./drei.js";
import { ebene } from "../ui/ebenen.js";
import { fc, wgs } from "../util.js";

export const WE = { stationen: [], zeit: 0, an: true, jetzt: null };
const HIMMEL = { klar: { "sky-color": "#bcd7ea", "horizon-color": "#e8eef2", "fog-color": "#e8eef2" }, grau: { "sky-color": "#a9b3bb", "horizon-color": "#d3d8dc", "fog-color": "#d3d8dc" } };

async function laden() {
  try {
    const r = await fetch("/api/wetter"); if (!r.ok) return; const j = await r.json(), f = j.felder;
    WE.stationen = j.stationen.map(a => { const o = {}; f.forEach((k, i) => o[k] = a[i]); o.x = (o.E - 2480000) / 100; o.y = (1300000 - o.N) / 100; return o; });
    WE.zeit = j.zeit; zeichnen();
  } catch (e) { }
}
const tFarbe = ["interpolate", ["linear"], ["get", "t"], -15, "#5b3ea6", -5, "#3d6fd1", 0, "#7fb3e6", 8, "#7cc6a1", 16, "#e8cf55", 24, "#ee8a3a", 32, "#d1343a"];
function zeichnen() {
  const map = K.map; if (!map || !map.getSource("wetter")) return;
  map.getSource("wetter").setData(fc(WE.stationen.map(s => ({ type: "Feature", properties: {
    n: s.name, t: s.t, tt: s.t === null ? "" : Math.round(s.t) + "°", rr: s.rr1h || 0, ff: s.ff || 0, dd: s.dd || 0, wind: s.ff !== null && s.ff >= 5 ? 1 : 0, mitT: s.t === null ? 0 : 1,
  }, geometry: { type: "Point", coordinates: wgs(s.x, s.y) } }))));
}
// Windpfeil als Bild (zeigt, wohin der Wind weht)
function pfeil() {
  const c = document.createElement("canvas"); c.width = c.height = 32; const g = c.getContext("2d");
  g.fillStyle = "#24313a"; g.strokeStyle = "#ffffff"; g.lineWidth = 2; g.beginPath(); g.moveTo(16, 2); g.lineTo(25, 18); g.lineTo(18.5, 15.5); g.lineTo(18.5, 30); g.lineTo(13.5, 30); g.lineTo(13.5, 15.5); g.lineTo(7, 18); g.closePath(); g.stroke(); g.fill();
  return g.getImageData(0, 0, 32, 32);
}
function sichtbar(an) {
  const map = K.map; for (const id of ["wetter-regen", "wetter-pfeil", "wetter-pkt", "wetter-txt"]) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", an ? "visible" : "none");
  if (!an) { try { map.setSky({ ...HIMMEL.klar, "sky-horizon-blend": 0.6, "horizon-fog-blend": 0.4, "fog-ground-blend": 0.6 }); } catch (e) { } }
}
export function wetterStarten() {
  const map = K.map;
  map.addSource("wetter", { type: "geojson", data: fc([]) });
  try { map.addImage("wind-pfeil", pfeil()); } catch (e) { }
  const vor = map.getLayer("st2") ? "st2" : undefined;
  map.addLayer({ id: "wetter-regen", type: "heatmap", source: "wetter", maxzoom: 13, filter: [">", ["get", "rr"], 0], paint: {
    "heatmap-weight": ["interpolate", ["linear"], ["get", "rr"], 0, 0, 0.3, .25, 2, .6, 8, 1],
    "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 6, .8, 12, 1.4],
    "heatmap-radius": ["interpolate", ["exponential", 2], ["zoom"], 6, 22, 9, 90, 12, 500],
    "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"], 0, "rgba(40,110,220,0)", .2, "rgba(60,130,230,.25)", .5, "rgba(40,100,220,.42)", .8, "rgba(60,60,200,.55)", 1, "rgba(120,40,190,.65)"],
    "heatmap-opacity": .9 } }, vor);
  map.addLayer({ id: "wetter-pfeil", type: "symbol", source: "wetter", minzoom: 8, filter: ["==", ["get", "wind"], 1], layout: {
    "icon-image": "wind-pfeil", "icon-rotate": ["+", ["get", "dd"], 180], "icon-rotation-alignment": "map", "icon-allow-overlap": true, "icon-ignore-placement": true,
    "icon-size": ["interpolate", ["linear"], ["get", "ff"], 5, .45, 30, .8, 80, 1.2], "icon-offset": [0, -26] } });
  map.addLayer({ id: "wetter-pkt", type: "circle", source: "wetter", minzoom: 6.5, filter: ["==", ["get", "mitT"], 1], paint: {
    "circle-color": tFarbe, "circle-radius": ["interpolate", ["linear"], ["zoom"], 6.5, 3, 9, 9, 13, 12], "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.2, "circle-pitch-alignment": "viewport" } });
  map.addLayer({ id: "wetter-txt", type: "symbol", source: "wetter", minzoom: 8, filter: ["==", ["get", "mitT"], 1], layout: {
    "text-field": ["get", "tt"], "text-font": [SCHRIFTEN.SCHRIFT], "text-size": ["interpolate", ["linear"], ["zoom"], 8, 9, 13, 12], "text-allow-overlap": true, "text-ignore-placement": true },
    paint: { "text-color": "#ffffff", "text-halo-color": "rgba(0,0,0,.35)", "text-halo-width": .6 } });
  // Klick auf eine Station: Messwerte
  map.on("click", "wetter-pkt", e => {
    const p = e.features[0].properties, s = WE.stationen.find(x => x.name === p.n); if (!s) return;
    const zeile = (n, v, e2) => v === null || v === undefined ? "" : `<tr><td>${n}</td><td><b>${v}${e2}</b></td></tr>`;
    const zeit = s.z ? new Date(s.z).toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Zurich" }) : "";
    new maplibregl.Popup({ closeButton: true, maxWidth: "240px" }).setLngLat(e.lngLat).setHTML(`<b>${s.name}</b> <span style="opacity:.7">${s.hoehe ? Math.round(s.hoehe) + " m" : ""}</span><table style="font-size:12px;margin-top:4px">`
      + zeile("Temperatur", s.t, " °C") + zeile("Niederschlag 1 h", s.rr1h, " mm") + zeile("Wind", s.ff, " km/h") + zeile("Böen", s.fx, " km/h") + zeile("Sonne (10 Min.)", s.so, " Min.")
      + zeile("Feuchte", s.rf, " %") + zeile("Schnee", s.hs, " cm") + `</table><div style="font-size:11px;opacity:.7">MeteoSchweiz, ${zeit}</div>`).addTo(map);
  });
  map.on("mouseenter", "wetter-pkt", () => map.getCanvas().style.cursor = "pointer"); map.on("mouseleave", "wetter-pkt", () => map.getCanvas().style.cursor = "");
  ebene({ id: "wetter", name: "Wetter (MeteoSchweiz)", an: true, setze: an => { WE.an = an; sichtbar(an); } });
  laden(); setInterval(laden, 5 * 60000);
  setInterval(lageBeiMitte, 2000);
}

// ---- Wetter an der Bildmitte (gewichtetes Mittel der 3 nächsten Stationen) und 3D-Niederschlag ----
function lageBeiMitte() {
  const map = K.map; if (!map || !WE.stationen.length) return;
  const c = map.getCenter(), z = map.getZoom();
  const nah = WE.stationen.map(s => { const ll = wgs(s.x, s.y), dx = (ll[0] - c.lng) * 75500, dy = (ll[1] - c.lat) * 111000; return { s, d: Math.hypot(dx, dy) }; }).sort((a, b) => a.d - b.d).slice(0, 4);
  let w = 0, rr = 0, t = 0, ff = 0, so = 0, wt = 0, ux = 0, uy = 0;
  for (const { s, d } of nah) { const g = 1 / Math.max(500, d) ** 2; w += g; rr += g * (s.rr1h || 0); ff += g * (s.ff || 0); if (s.t !== null) { t += g * s.t; wt += g; } so += g * (s.so === null ? 5 : s.so);
    const a = (s.dd || 0) * Math.PI / 180; ux += g * Math.sin(a); uy += g * Math.cos(a); }
  if (!w) return;
  const L = { rr: rr / w, t: wt ? t / wt : 10, ff: ff / w, so: so / w, dd: Math.atan2(ux, uy), naechste: nah[0].d };
  WE.jetzt = L;
  if (!WE.an) return;
  // Himmel: tagsüber ohne Sonne bedeckt (grau)
  const stunde = +new Date().toLocaleString("en-GB", { hour: "2-digit", hour12: false, timeZone: "Europe/Zurich" });
  const grau = (L.so < 2 && stunde >= 8 && stunde <= 17) || L.rr > 0.1, H = grau ? HIMMEL.grau : HIMMEL.klar;
  if (WE.himmel !== grau) { WE.himmel = grau; try { map.setSky({ ...H, "sky-horizon-blend": 0.6, "horizon-fog-blend": grau ? 0.25 : 0.4, "fog-ground-blend": grau ? 0.35 : 0.6 }); } catch (e) { } }
  if (z >= 11 && L.rr > 0.05 && L.naechste < 25000) niederschlagStarten();
}

const N_MAX = 7000;
let NS = null;
function niederschlagStarten() {
  if (NS) return; NS = { laden: true };
  ladeThree().then(() => { try { K.map.addLayer(niederschlagEbene(), "fz"); } catch (e) { console.error(e); } });
}
function niederschlagEbene() {
  const mc = ll => maplibregl.MercatorCoordinate.fromLngLat(ll);
  return {
    id: "wetter3d", type: "custom", renderingMode: "3d",
    onAdd(m, gl) {
      this.cam = new THREE.Camera(); this.szene = new THREE.Scene();
      this.r = new THREE.WebGLRenderer({ canvas: m.getCanvas(), context: gl, antialias: true }); this.r.autoClear = false;
      this.pos = new Float32Array(N_MAX * 6); this.geo = new THREE.BufferGeometry(); this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
      this.regen = new THREE.LineSegments(this.geo, new THREE.LineBasicMaterial({ color: 0x6f8296, transparent: true, opacity: .6 }));
      this.pgeo = new THREE.BufferGeometry(); this.ppos = new Float32Array(N_MAX * 3); this.pgeo.setAttribute("position", new THREE.BufferAttribute(this.ppos, 3));
      this.schnee = new THREE.Points(this.pgeo, new THREE.PointsMaterial({ color: 0xffffff, size: 2.6, sizeAttenuation: false, transparent: true, opacity: .9 }));
      this.regen.frustumCulled = this.schnee.frustumCulled = false; this.szene.add(this.regen, this.schnee);
      this.anker = null; this.t = performance.now(); this.tropfen = null;
    },
    render(gl, args) {
      const map = K.map, L = WE.jetzt, jetzt = performance.now(), dt = Math.min(.1, (jetzt - this.t) / 1000); this.t = jetzt;
      const aktiv = WE.an && L && L.rr > 0.05 && map.getZoom() >= 11 && L.naechste < 25000;
      this.regen.visible = this.schnee.visible = false; if (!aktiv) return;
      const c = map.getCenter(), om = mc(c), ms = om.meterInMercatorCoordinateUnits(), Tr = map.getTerrain(), ex = Tr ? Tr.exaggeration || 1 : 0;
      // Kasten zwischen Kamera und Bildmitte (dort sieht man den Niederschlag), Höhe vom Boden bis über die Kamera
      // Kameralage aus Zoom, Neigung und Drehung (Sichtfeld wie MapLibre, ~37°)
      const mpp = 40075016 * Math.cos(c.lat * Math.PI / 180) / (512 * 2 ** map.getZoom()), D = map.getCanvas().clientHeight / 2 / Math.tan(.3218) * mpp;
      const pi = map.getPitch() * Math.PI / 180, be = map.getBearing() * Math.PI / 180, abst = D * Math.sin(pi), hoch = D * Math.cos(pi), boden = ex ? (map.queryTerrainElevation(c) || 0) : 0;
      const o = { x: om.x - Math.sin(be) * abst * .45 * ms, y: om.y + Math.cos(be) * abst * .45 * ms }, W = Math.max(250, Math.min(4000, abst * .8 + 150)), Hh = Math.max(150, Math.min(3000, hoch + 60));
      const n = Math.min(N_MAX, Math.round(1500 + 1500 * Math.min(3, L.rr))), schnee = L.t < 1;
      if (!this.tropfen || !this.anker || Math.hypot(o.x - this.anker.x, o.y - this.anker.y) / ms > W * .5 || Math.abs(this.tropfen.W - W) > W * .3 || Math.abs(this.tropfen.H - Hh) > Hh * .3) {
        this.anker = o; this.tropfen = { W, H: Hh, x: new Float32Array(N_MAX), y: new Float32Array(N_MAX), z: new Float32Array(N_MAX) };
        for (let i = 0; i < N_MAX; i++) { this.tropfen.x[i] = (Math.random() - .5) * 2 * W; this.tropfen.y[i] = (Math.random() - .5) * 2 * W; this.tropfen.z[i] = boden + Math.random() * Hh; }
      }
      const T = this.tropfen, v = schnee ? 1.2 : 9, wind = Math.min(15, L.ff / 3.6) * (schnee ? .8 : .35), wx = -Math.sin(L.dd) * wind, wy = Math.cos(L.dd) * wind;   // Wind aus Richtung dd (y nach Süden)
      const lang = schnee ? 0 : Math.max(2, Math.min(30, W * .012));
      for (let i = 0; i < n; i++) {
        let x = T.x[i] + wx * dt, y = T.y[i] + wy * dt, z = T.z[i] - v * dt * (schnee ? (.7 + (i % 7) * .08) : 1);
        if (schnee) { x += Math.sin(jetzt / 900 + i) * .4 * dt; }
        if (z < boden) { z += Hh; x = (Math.random() - .5) * 2 * W; y = (Math.random() - .5) * 2 * W; }
        if (x > W) x -= 2 * W; else if (x < -W) x += 2 * W; if (y > W) y -= 2 * W; else if (y < -W) y += 2 * W;
        T.x[i] = x; T.y[i] = y; T.z[i] = z;
        if (schnee) { this.ppos[i * 3] = x; this.ppos[i * 3 + 1] = y; this.ppos[i * 3 + 2] = z; }
        else { const k = i * 6, f = lang / v; this.pos[k] = x; this.pos[k + 1] = y; this.pos[k + 2] = z; this.pos[k + 3] = x - wx * f; this.pos[k + 4] = y - wy * f; this.pos[k + 5] = z + lang; }
      }
      if (schnee) { this.pgeo.setDrawRange(0, n); this.pgeo.attributes.position.needsUpdate = true; this.schnee.visible = true; }
      else { this.geo.setDrawRange(0, n * 2); this.geo.attributes.position.needsUpdate = true; this.regen.visible = true; }
      const m = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix), l = new THREE.Matrix4().makeTranslation(this.anker.x, this.anker.y, 0).scale(new THREE.Vector3(ms, ms, ms));
      this.cam.projectionMatrix = m.multiply(l); this.r.resetState(); this.r.render(this.szene, this.cam); map.triggerRepaint();
    },
  };
}
