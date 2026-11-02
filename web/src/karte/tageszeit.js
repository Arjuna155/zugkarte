// Tageszeit in Echtzeit: Sonnenstand für die Schweiz → Himmel, Licht (Gebäude, 3D-Ebenen, Wasserglanz) und eine
// Abdunkelung der ganzen Landschaft (Ebene «nacht», Multiplikation mit einer Tönung: Tag 1, Abendrot warm, Nacht blau).
// Die Karteninformationen (Linien, Bahnhöfe, Fahrzeugpunkte, Beschriftungen) liegen darüber und bleiben hell.
// Nachts leuchten Siedlungen und Strassen schwach warm (Ebenen ls-nachtlicht, ls-strassenlicht).
// Vorschau: ?uhr=21:30 zeigt die Beleuchtung dieser Uhrzeit (heute), der Fahrplan bleibt Echtzeit.
import { K } from "./karte.js";
import { S } from "../zustand.js";
import { LICHT } from "./drei.js";

export const TZ = { hoehe: 45, azimut: 180, nacht: 0, toenung: [1, 1, 1], uhr: null, };
const BREITE = 46.8, LAENGE = 8.2, RAD = Math.PI / 180;

// Sonnenstand (NOAA-Näherung, genau auf ~0,5°): Höhe über dem Horizont und Azimut (0 = Nord, im Uhrzeigersinn) in Grad
export function sonne(ms, lat = BREITE, lng = LAENGE) {
  const d = ms / 864e5 + 2440587.5 - 2451545.0, g = (357.529 + .98560028 * d) * RAD, q = 280.459 + .98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + .02 * Math.sin(2 * g)) * RAD, e = (23.439 - .00000036 * d) * RAD;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)), dek = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24, lha = ((gmst * 15 + lng) * RAD - ra), phi = lat * RAD;
  const h = Math.asin(Math.sin(phi) * Math.sin(dek) + Math.cos(phi) * Math.cos(dek) * Math.cos(lha));
  const az = Math.atan2(-Math.sin(lha), Math.tan(dek) * Math.cos(phi) - Math.sin(phi) * Math.cos(lha));
  return { hoehe: h / RAD, azimut: ((az / RAD) + 360) % 360 };
}

// Werte nach Sonnenhöhe (Grad), dazwischen linear
const STUFEN = [   // h, Tönung, Himmel, Horizont, Dunst (Zielfarben auf dem Bildschirm), Lichtfarbe
  [-18, [.23, .27, .44], "#070d1e", "#141f3a", "#131c33", "#8090c0"],
  [-8, [.26, .30, .47], "#0b1530", "#1d2a48", "#1a2440", "#8a98c8"],
  [-3, [.42, .42, .58], "#26355f", "#9a6f6c", "#5e5870", "#a0a0d0"],
  [0, [.74, .62, .60], "#5d79aa", "#eea676", "#d9b398", "#ffb07a"],
  [3, [.92, .80, .70], "#7fa2cc", "#f5c99a", "#e6d0bc", "#ffc896"],
  [8, [1, .94, .87], "#93bade", "#ece6dc", "#e3e3e0", "#fff0dc"],
  [15, [1, 1, 1], "#9cc3e2", "#e6eef3", "#e1e9ee", "#fffaf0"],
];
const hex = s => [parseInt(s.slice(1, 3), 16) / 255, parseInt(s.slice(3, 5), 16) / 255, parseInt(s.slice(5, 7), 16) / 255];
const zuHex = c => "#" + c.map(v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("");
const mische = (a, b, u) => a.map((v, i) => v + (b[i] - v) * u);
function stufe(h) {
  let i = 0; while (i < STUFEN.length - 2 && h > STUFEN[i + 1][0]) i++;
  const A = STUFEN[i], B = STUFEN[i + 1], u = Math.max(0, Math.min(1, (h - A[0]) / (B[0] - A[0])));
  return { toenung: mische(A[1], B[1], u), himmel: mische(hex(A[2]), hex(B[2]), u), horizont: mische(hex(A[3]), hex(B[3]), u), dunst: mische(hex(A[4]), hex(B[4]), u), licht: mische(hex(A[5]), hex(B[5]), u) };
}
const GRAU = { himmel: hex("#a3adb6"), horizont: hex("#cfd5da"), dunst: hex("#cfd5da") };

// Uhrzeit für die Vorschau (?uhr=HH:MM)
try { const m = /^(\d{1,2}):(\d{2})$/.exec(new URLSearchParams(location.search).get("uhr") || ""); if (m) TZ.uhr = +m[1] * 60 + +m[2]; } catch (e) { }
function zeitFuerSonne() {
  const jetzt = S.simMs || Date.now(); if (TZ.uhr === null) return jetzt;
  const d = new Date(jetzt), z = new Date(d.toLocaleString("en-US", { timeZone: "Europe/Zurich" })), versatz = z - d;   // Schweizer Zeit
  const mitternacht = new Date(z.getFullYear(), z.getMonth(), z.getDate()).getTime() - versatz;
  return mitternacht + TZ.uhr * 60000;
}

export function tageszeitAktualisieren() {
  const map = K.map; if (!map || !K.bereit) return;
  const { hoehe, azimut } = sonne(zeitFuerSonne()); TZ.hoehe = hoehe; TZ.azimut = azimut;
  const st = stufe(hoehe); TZ.toenung = st.toenung; TZ.nacht = Math.max(0, Math.min(1, (2 - hoehe) / 8));
  // Himmel: Zielfarbe ÷ Tönung (die Abdunkelung multipliziert den Himmel mit), bei grauem Wetter Richtung Grau
  const g = K.himmelGrau ? .75 * Math.max(0, Math.min(1, (hoehe + 4) / 10)) : 0, T = st.toenung;
  const vor = c => zuHex(c.map((v, i) => v / T[i]));
  try {
    map.setSky({ "sky-color": vor(mische(st.himmel, GRAU.himmel, g)), "horizon-color": vor(mische(st.horizont, GRAU.horizont, g)), "fog-color": vor(mische(st.dunst, GRAU.dunst, g)),
      "sky-horizon-blend": .6, "horizon-fog-blend": K.himmelGrau ? .25 : .4, "fog-ground-blend": K.himmelGrau ? .35 : .6, "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 12, .6, 14, 0] });
  } catch (e) { }
  // Licht der Gebäude (fill-extrusion): aus Richtung der Sonne, flach am Abend
  const hl = Math.max(12, hoehe);
  try { map.setLight({ anchor: "map", position: [1.4, azimut, Math.max(20, Math.min(80, 90 - hl))], color: zuHex(st.licht), intensity: .35 }); } catch (e) { }
  // 3D-Ebenen (three.js): Richtung (x Ost, y Süd, z oben) und Farbe des Sonnenlichts; Wasserglanz
  const a = azimut * RAD, h = hl * RAD, dx = Math.sin(a) * Math.cos(h), dy = -Math.cos(a) * Math.cos(h), dz = Math.sin(h);
  LICHT.dir = [dx, dy, dz]; LICHT.farbe = st.licht;
  for (const d of LICHT.lichter) { d.position.set(dx, dy, dz); d.color.setRGB(...st.licht); }
  for (const u of LICHT.wasser) u.value.set(dx, dy, dz).normalize();
  // Lichter der Siedlungen und Strassen
  const o = TZ.nacht;
  for (const [id, f] of [["ls-nachtlicht", .5], ["ls-strassenlicht", .85]]) if (map.getLayer(id)) {
    map.setLayoutProperty(id, "visibility", o > .02 ? "visible" : "none");
    map.setPaintProperty(id, id === "ls-nachtlicht" ? "fill-opacity" : "line-opacity", o * f);
  }
  map.triggerRepaint();
}

// Abdunkelung als eigene Ebene (renderingMode «3d»: als «2d» würde sie mit Gelände nur auf das Gelände gelegt und die
// 3D-Ebenen davor – Wasser, Häuser, Züge – blieben hell): ein Dreieck über das ganze Bild, multipliziert mit der Tönung (eigenes kleines WebGL-Programm)
function nachtEbene() {
  let prog = null, buf = null, uT = null, aP = 0;
  return {
    id: "nacht", type: "custom", renderingMode: "3d",
    onAdd(m, gl) {
      const sh = (t, q) => { const s = gl.createShader(t); gl.shaderSource(s, q); gl.compileShader(s); return s; };
      prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, "attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }"));
      gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, "precision mediump float; uniform vec3 t; void main(){ gl_FragColor = vec4(t, 1.0); }"));
      gl.linkProgram(prog); uT = gl.getUniformLocation(prog, "t"); aP = gl.getAttribLocation(prog, "p");
      buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    },
    render(gl) {
      const T = TZ.toenung; if (T[0] > .995 && T[1] > .995 && T[2] > .995) return;   // am Tag nichts zu tun
      gl.useProgram(prog); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.enableVertexAttribArray(aP); gl.vertexAttribPointer(aP, 2, gl.FLOAT, false, 0, 0);
      gl.disable(gl.DEPTH_TEST); gl.disable(gl.STENCIL_TEST); gl.disable(gl.CULL_FACE); gl.depthMask(false);
      gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.DST_COLOR, gl.ZERO, gl.ZERO, gl.ONE);   // Farbe × Tönung, Deckkraft bleibt
      gl.uniform3f(uT, T[0], T[1], T[2]); gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}

// Vor dieser Ebene werden die 3D-Ebenen eingefügt (damit sie abgedunkelt werden); die Kartenlinien und Punkte liegen darüber
export const VOR_3D = () => K.map && K.map.getLayer("nacht") ? "nacht" : K.map && K.map.getLayer("fz") ? "fz" : undefined;

export function tageszeitStarten() {
  const map = K.map;
  // Abdunkelung direkt nach den Gebäuden, vor den Kartenlinien
  const naechste = map.getStyle().layers.map(l => l.id), i = naechste.indexOf("gebaeude-3d"), danach = i >= 0 ? naechste[i + 1] : naechste.find(id => !id.startsWith("ls-"));
  map.addLayer(nachtEbene(), danach);
  // Nachtlichter: über der Abdunkelung, also hell
  const basis = map.getLayer("ls-siedlung") && map.getLayer("ls-siedlung").source;
  if (basis) {
    map.addLayer({ id: "ls-nachtlicht", type: "fill", source: basis, "source-layer": "landuse", layout: { visibility: "none" },
      filter: ["match", ["get", "class"], ["residential", "suburb", "neighbourhood", "village", "town", "city", "commercial", "retail", "industrial"], true, false],
      paint: { "fill-color": "#ffc46b", "fill-opacity": 0, "fill-antialias": false } }, danach);
    map.addLayer({ id: "ls-strassenlicht", type: "line", source: basis, "source-layer": "transportation", minzoom: 11, layout: { visibility: "none", "line-cap": "round", "line-join": "round" },
      filter: ["all", ["match", ["get", "class"], ["motorway", "trunk", "primary", "secondary", "tertiary", "minor"], true, false], ["!=", ["get", "brunnel"], "tunnel"]],
      paint: { "line-color": "#ffd28a", "line-opacity": 0, "line-blur": ["interpolate", ["linear"], ["zoom"], 11, 1, 16, 6],
        "line-width": ["interpolate", ["exponential", 2], ["zoom"], 11, ["match", ["get", "class"], ["motorway", "trunk", "primary"], 1.2, .5], 16, ["match", ["get", "class"], ["motorway", "trunk", "primary"], 14, 7]] } }, danach);
  }
  K.himmelNeu = tageszeitAktualisieren;
  tageszeitAktualisieren();
  setInterval(tageszeitAktualisieren, 20000);   // die Sonne bewegt sich ~1° in 4 Minuten
  window.__tz = { TZ, setze: hhmm => { TZ.uhr = hhmm === null ? null : (([h, m]) => +h * 60 + +m)(String(hhmm).split(":")); tageszeitAktualisieren(); } };
}
