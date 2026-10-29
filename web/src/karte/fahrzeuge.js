// Fahrzeuge: eigene WebGL-Ebene (Punkte), ohne GeoJSON-Umweg. Pro Bild nur die Fahrten, die laut Zeitindex unterwegs
// sein können; nur sichtbare werden gezeichnet. Ab Zoom Z3D werden Züge zu 3D-Modellen (zuege3d.js).
import { B } from "../kern/basis.js";
import { services, aktiv } from "../kern/fahrplan.js";
import { trainPos } from "../kern/wege.js";
import { rtFor, delayNow } from "../kern/echtzeit.js";
import { fmtDelay } from "../kern/zeit.js";
import { S, DCLS } from "../zustand.js";
import { K } from "./karte.js";
import { Z3, Z3D, z3Laden, z3Beginn, z3Zug, z3Ende } from "./zuege3d.js";
import { wgs, fc, melde } from "../util.js";
import { strassenBild } from "./strassen.js";
import { ZBUS, BUS } from "../kern/busse.js";

const SCHRIFT = "Frutiger Neue Condensed Bold";
// Farben aus dem Stylesheet (hell/dunkel)
let F = {};
function farben() {
  const cs = getComputedStyle(document.documentElement), g = n => hex(cs.getPropertyValue(n).trim());
  F = { d0: g("--ok"), d1: g("--late"), d2: hex("#e5484d"), dn: hex("#9aa5ab"), late: g("--late"), fv: g("--tfv"), rv: g("--trv"), s: g("--ts"), tr: g("--ttr"), sch: g("--tsch"), bb: g("--tbb"), bus: g("--tbus"), sel: hex("#e3a008"), weiss: [1, 1, 1] };
}
function hex(h) { if (!h || h[0] !== "#") return [.5, .5, .5]; if (h.length === 4) h = "#" + h[1] + h[1] + h[2] + h[2] + h[3] + h[3]; const n = parseInt(h.slice(1, 7), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; }

// Sichtbare Fahrzeuge dieses Bildes (für Klicks, Hinweise, Beschriftung)
export const FZ = { liste: [], anzahl: 0 };
const POOL = [], STRIDE = 12;
let letzteVoll = 0, erzwingeVoll = true, kandidaten = [];
let puffer = new Float32Array(2048 * STRIDE), ursprung = [0, 0], hoeheCache = new Map(), letzteBerechnung = 0, letzteBeschriftung = 0, zuletztSim = 0;
const merc = (lng, lat) => [(lng + 180) / 360, (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360))) / 360];

// Lage aller Fahrzeuge zur aktuellen Simulationszeit; zählt nebenbei für die Legende
export function fahrzeugeBerechnen(now) {
  const map = K.map, zoom = map.getZoom();
  // Neu berechnen erst, wenn ein schneller Zug (200 km/h) sich um einen halben Pixel bewegt haben kann:
  // herausgezoomt etwa 1-mal pro Sekunde, ganz nah bei jedem Bild. Spart Rechenzeit und neues Zeichnen der Karte.
  const mpp = 156543 * Math.cos(map.getCenter().lat * Math.PI / 180) / 2 ** zoom, takt = Math.min(1000, 500 * mpp / (55 * Math.max(S.speed, 1e-3) || 1));
  if (now - letzteBerechnung < takt && Math.abs(S.simMs - zuletztSim) < 60000) return false;
  letzteBerechnung = now; zuletztSim = S.simMs; strassenBild();
  // Voller Durchgang (alle Fahrten, Zähler für die Legende) höchstens 2-mal pro Sekunde; dazwischen nur die Fahrten,
  // die beim letzten vollen Durchgang in oder nahe beim Bildausschnitt waren (Rand ≈ 5 km).
  const voll = now - letzteVoll > 500 || erzwingeVoll; if (voll) { letzteVoll = now; erzwingeVoll = false; kandidaten = []; }
  const b = map.getBounds(), W0 = b.getWest() - .02, E0 = b.getEast() + .02, S0 = b.getSouth() - .02, N0 = b.getNorth() + .02;
  const RW = b.getWest() - .07, RE = b.getEast() + .07, RS = b.getSouth() - .05, RN = b.getNorth() + .05;
  const z = { fv: 0, rv: 0, s: 0, tr: 0, sch: 0, bb: 0, bus: 0 }, zd = { d0: 0, d1: 0, d2: 0, dn: 0 };
  let spaet = 0, ausfall = 0, n = 0;
  const gesehen = new Set(), mit3d = zoom >= Z3D; if (mit3d) z3Laden();
  const z3 = mit3d && Z3.bereit; if (z3) z3Beginn();
  const ter = map.getTerrain(), c = map.getCenter(); ursprung = merc(c.lng, c.lat);
  const mpu = maplibregl.MercatorCoordinate.fromLngLat(c).meterInMercatorCoordinateUnits();
  const svs = services(S.simMs);
  const eine = (tr, sv) => {
    const t = sv.t, rt = rtFor(tr, sv.o);
    if (rt && rt.canc) { if (voll && t >= rt.t0 - 5 && t <= rt.t1) ausfall++; return; }
    const T0 = rt ? rt.t0 : tr.t0, T1 = rt ? rt.t1 : tr.t1; if (t < T0 || t > T1) return;
    if (tr.cls === "bus" && (zoom < ZBUS || !S.onTr.bus || !BUS.an)) return;   // Busse nur beim Hineinzoomen (Weg auf der Strasse)
    const v = POOL[n] || (POOL[n] = { p: {} });
    const p = trainPos(tr, t, rt, v.p); if (!p) return;
    const sk = tr.label + "|" + tr.st[0].i + "|" + (tr.t0 - sv.o); if (sv.o) gesehen.add(sk); else if (gesehen.has(sk)) return;   // gleicher Zug in beiden Betriebstagen
    const dl = delayNow(rt, p);
    if (voll) { if (dl >= 180) spaet++; z[tr.cls]++; zd[DCLS(rt ? dl : null)]++; }
    if (!S.onTr[tr.cls] || (tr.cls === "tr" && zoom < 11) || (tr.cls === "bb" && zoom < 10)) return;
    const ll = wgs(p.x, p.y);
    if (voll && ll[0] > RW && ll[0] < RE && ll[1] > RS && ll[1] < RN) kandidaten.push(tr, sv.o);
    if (ll[0] < W0 || ll[0] > E0 || ll[1] < S0 || ll[1] > N0) return;
    v.tr = tr; v.o = sv.o; v.rt = rt; v.dl = dl; v.ll = ll; v.m = merc(ll[0], ll[1]); v.sel = !!S.sel && S.sel.tr === tr;
    v.d3 = z3 && z3Zug(tr, sv.o, p, v.sel, rt);
    // Höhe auf dem Gelände (zwischengespeichert, alle 2 s neu)
    if (ter) { const k = tr.id + "|" + sv.o; let h = hoeheCache.get(k); if (!h || now - h.t > 2000) { h = { e: map.queryTerrainElevation(ll) || 0, t: now }; hoeheCache.set(k, h); } v.e = h.e * mpu; } else v.e = 0;
    n++;
  };
  if (voll) { for (const sv of svs) for (const tr of aktiv(sv.runs, sv.t)) eine(tr, sv); }
  else for (let i = 0; i < kandidaten.length; i += 2) eine(kandidaten[i], kandidaten[i + 1] ? svs[0] : svs[1]);
  if (z3) z3Ende();
  if (hoeheCache.size > 4000) hoeheCache.clear();
  FZ.liste = POOL.slice(0, n); FZ.anzahl = n;
  if (voll) Object.assign(S, { zaehler: z, zaehlerD: zd, spaet, ausfall });
  // Puffer für die Punkte-Ebene
  if (puffer.length < n * STRIDE) puffer = new Float32Array(n * STRIDE * 2);
  const g7 = zoom <= 7 ? 2.6 : zoom <= 11 ? 2.6 + (zoom - 7) / 4 * 1.8 : zoom <= 15 ? 4.4 + (zoom - 11) / 4 * 2.6 : 7;
  let k = 0;
  // Reihenfolge: Trams und Schiffe unten, Fernverkehr oben, Auswahl zuoberst
  const reihe = { bus: 0, tr: 0, bb: 0, sch: 1, s: 2, rv: 3, fv: 4 };
  FZ.liste.sort((a, b) => (a.sel - b.sel) || (reihe[a.tr.cls] - reihe[b.tr.cls]));
  for (const v of FZ.liste) {
    const tr = v.tr, late = S.colMode !== "vsp" && v.dl >= 180;
    const fill = S.colMode === "vsp" ? F[DCLS(v.rt ? v.dl : null)] : F[tr.cls], rand = v.sel ? F.sel : late ? F.late : F.weiss;
    const r = (tr.cls === "tr" || tr.cls === "bus" ? .72 : 1) * (v.sel ? 1.5 : 1) * g7, w = v.sel ? 3.5 : late ? 2.4 : 1.3;
    puffer.set([v.m[0] - ursprung[0], v.m[1] - ursprung[1], v.e, fill[0], fill[1], fill[2], rand[0], rand[1], rand[2], r, w, v.d3 ? 0 : v.p.tunnel && ter ? .35 : 1], k); k += STRIDE;
  }
  // Beschriftungen (ab Zoom 12.5, Trams ab 14.5) 4-mal pro Sekunde
  if (now - letzteBeschriftung > 250) {
    letzteBeschriftung = now;
    const src = map.getSource("fzl"), leer = zoom < 12.5;
    if (src && !(leer && FZ.leer)) FZ.leer = leer, src.setData(fc(zoom < 12.5 ? [] : FZ.liste.filter(v => (v.tr.cls !== "tr" && v.tr.cls !== "bus") || zoom >= 14.5).slice(0, 300).map(v => ({
      type: "Feature", properties: { l: (v.tr.label + (v.dl >= 60 ? " " + fmtDelay(v.dl) : "")).replace(/[^\x00-\xff]/g, "'") }, geometry: { type: "Point", coordinates: v.ll }
    }))));
  }
  map.triggerRepaint();
  return true;
}

// ---- WebGL-Ebene ----
const VS = `precision highp float;
uniform mat4 u_m; uniform float u_dpr;
attribute vec3 a_pos; attribute vec3 a_fill; attribute vec3 a_rand; attribute vec3 a_gr;
varying vec3 v_fill; varying vec3 v_rand; varying float v_r; varying float v_s; varying float v_a; varying float v_g;
void main(){ gl_Position=u_m*vec4(a_pos,1.0); v_r=a_gr.x*u_dpr; v_s=a_gr.y*u_dpr; v_g=2.0*(v_r+v_s)+2.0; gl_PointSize=v_g;
  v_fill=a_fill; v_rand=a_rand; v_a=a_gr.z; }`;
const FS = `precision mediump float;
varying vec3 v_fill; varying vec3 v_rand; varying float v_r; varying float v_s; varying float v_a; varying float v_g;
void main(){ float d=length(gl_PointCoord-0.5)*v_g; float aussen=v_r+v_s;
  float a=(1.0-smoothstep(aussen-1.0,aussen,d))*v_a; if(a<=0.0) discard;
  vec3 c=mix(v_fill,v_rand,smoothstep(v_r-0.75,v_r+0.25,d)); gl_FragColor=vec4(c*a,a); }`;
export function fahrzeugEbene() {
  let prog, buf, loc = {};
  return {
    id: "fz", type: "custom", renderingMode: "2d",
    onAdd(m, gl) {
      const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(o)); return o; };
      prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
      for (const a of ["a_pos", "a_fill", "a_rand", "a_gr"]) loc[a] = gl.getAttribLocation(prog, a);
      loc.u_m = gl.getUniformLocation(prog, "u_m"); loc.u_dpr = gl.getUniformLocation(prog, "u_dpr");
      buf = gl.createBuffer(); farben();
    },
    render(gl, args) {
      const n = FZ.anzahl; if (!n) return;
      const M = args.defaultProjectionData.mainMatrix, ox = ursprung[0], oy = ursprung[1], U = new Float32Array(16);
      for (let i = 0; i < 16; i++)U[i] = M[i];
      for (let i = 0; i < 4; i++)U[12 + i] = M[i] * ox + M[4 + i] * oy + M[12 + i];   // Ursprung nahe der Kartenmitte (Genauigkeit)
      gl.useProgram(prog); gl.uniformMatrix4fv(loc.u_m, false, U); gl.uniform1f(loc.u_dpr, devicePixelRatio || 1);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, puffer.subarray(0, n * STRIDE), gl.DYNAMIC_DRAW);
      const st = STRIDE * 4;
      [["a_pos", 0], ["a_fill", 3], ["a_rand", 6], ["a_gr", 9]].forEach(([a, o]) => { gl.enableVertexAttribArray(loc[a]); gl.vertexAttribPointer(loc[a], 3, gl.FLOAT, false, st, o * 4); });
      gl.disable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.POINTS, 0, n);
      [["a_pos"], ["a_fill"], ["a_rand"], ["a_gr"]].forEach(([a]) => gl.disableVertexAttribArray(loc[a]));
    }
  };
}
// Klick und Hinweis: nächstes Fahrzeug (oder 3D-Wagen) unter dem Mauszeiger
export function fahrzeugBei(pt) {
  const map = K.map; let best = null, bd = 14 * 14;
  for (const v of FZ.liste) { const q = map.project(v.ll), d = (q.x - pt.x) ** 2 + (q.y - pt.y) ** 2; if (d < bd) { bd = d; best = v; } }
  if (!best && Z3.bereit) { const w = Z3.wagenBei(pt); if (w) best = w; }
  return best;
}
export function fahrzeugeStarten() {
  const map = K.map;
  map.addSource("fzl", { type: "geojson", data: fc([]) });
  map.addLayer(fahrzeugEbene());
  map.addLayer({ id: "fz-l", type: "symbol", source: "fzl", layout: { "text-field": ["get", "l"], "text-font": [SCHRIFT], "text-size": 11, "text-anchor": "bottom-left", "text-offset": [0.6, -0.4], "text-optional": true }, paint: { "text-color": "#16222b", "text-halo-color": "#ffffff", "text-halo-width": 1.5 } });
  // beim Verschieben/Zoomen sofort neu berechnen (neu sichtbare Gegend), höchstens 10-mal pro Sekunde
  let zuletzt = 0; map.on("move", () => { const t = performance.now(); if (t - zuletzt > 100) { zuletzt = t; letzteBerechnung = 0; erzwingeVoll = true; } });
  K.fzTreffer = pt => { const v = fahrzeugBei(pt); if (v) { melde("zug", v.tr, v.o); return true; } return false; };
  K.fzTip = pt => { const v = fahrzeugBei(pt); return v ? v.tr.label + " → " + v.tr.to : null; };
  try { matchMedia("(prefers-color-scheme: dark)").addEventListener("change", farben); } catch (e) { }
}
