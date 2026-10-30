// Perrons (Bahnsteige) aus OpenStreetMap: echte Umrisse (auch gebogen), Länge, Gleisnummern, überdacht ja/nein.
// Einmal pro Monat über die Overpass-API (ganze Schweiz, eine Abfrage), gespeichert in DATA_DIR/perrons.json, ausgeliefert
// je 10-km-Kachel wie die Busse (/api/perrons?k=x_y,…). Fehler: neuer Versuch nach 6 Stunden.
// OSM-Daten © OpenStreetMap-Mitwirkende (ODbL).
"use strict";
const fs = require("fs"), path = require("path"), zlib = require("zlib");

const URL_OVERPASS = process.env.ZK_OVERPASS_URL || "https://overpass-api.de/api/interpreter";
const ABFRAGE = `[out:json][timeout:300];area["ISO3166-1"="CH"][admin_level=2]->.ch;
(way["railway"="platform"](area.ch);way["public_transport"="platform"]["train"="yes"](area.ch);way["public_transport"="platform"]["railway"](area.ch););out geom;`;
const ALTER = 30 * 86400e3;

function lv95(lat, lon) {   // WGS84 → LV95 (Näherung swisstopo)
  const p = (lat * 3600 - 169028.66) / 10000, l = (lon * 3600 - 26782.5) / 10000;
  return [2600072.37 + 211455.93 * l - 10938.51 * l * p - 0.36 * l * p * p - 44.54 * l ** 3, 1200147.07 + 308807.95 * p + 3745.25 * l * l + 76.63 * p * p - 194.56 * l * l * p + 119.79 * p ** 3];
}
const kachel = (E, N) => Math.floor((E - 2480000) / 10000) + "_" + Math.floor((1300000 - N) / 10000);   // wie busKachel in fahrplan.js

// Overpass-Antwort → {k: {Kachel: [[geschlossen, überdacht (0 nein, 1 ja, 2 teilweise), Gleise, E0,N0, dE,dN, …] (dm)]}}
function aufbereiten(j) {
  const k = {}; let n = 0;
  for (const el of j.elements || []) {
    if (el.type !== "way" || !el.geometry || el.geometry.length < 2) continue;
    const t = el.tags || {};
    if (t.highway || (t.bus === "yes" && t.train !== "yes")) continue;   // Bushaltekanten weg
    const pts = el.geometry.map(g => lv95(g.lat, g.lon).map(v => Math.round(v * 10)));
    const zu = pts.length > 3 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1];
    const dach = /^(yes|roof|full)$/.test(t.covered || t.shelter || "") ? 1 : t.covered === "partial" ? 2 : 0;
    const gl = String(t.ref || t["railway:track_ref"] || t.local_ref || "").replace(/[;|]/g, "/").slice(0, 20);
    const flach = [zu ? 1 : 0, dach, gl, pts[0][0], pts[0][1]]; for (let i = 1; i < pts.length; i++) flach.push(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    const ks = new Set(pts.map(([E, N]) => kachel(E / 10, N / 10)));
    for (const kk of ks) (k[kk] || (k[kk] = [])).push(flach);
    n++;
  }
  return { k, n };
}

function start({ DATA_DIR, log }) {
  const DATEI = path.join(DATA_DIR, "perrons.json");
  let D = null, fehler = null, letzte = null, laeuft = false;
  try { D = JSON.parse(fs.readFileSync(DATEI, "utf8")); } catch { }
  async function laden() {
    if (laeuft) return; laeuft = true;
    try {
      const r = await fetch(URL_OVERPASS, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "ZugKarte (privat; Perrons 1x pro Monat)" }, body: "data=" + encodeURIComponent(ABFRAGE), signal: AbortSignal.timeout(400e3) });
      if (!r.ok) throw new Error("Overpass HTTP " + r.status);
      const { k, n } = aufbereiten(await r.json()); if (!n) throw new Error("keine Perrons erhalten");
      D = { zeit: Date.now(), n, k }; fs.writeFileSync(DATEI + ".tmp", JSON.stringify(D)); fs.renameSync(DATEI + ".tmp", DATEI);
      fehler = null; letzte = Date.now(); log("Perrons:", n, "aus OpenStreetMap");
    } catch (e) { fehler = e.message; log("Perrons:", e.message); }
    laeuft = false;
  }
  const pruefen = () => { if (!D || Date.now() - D.zeit > ALTER) laden(); };
  setTimeout(pruefen, +(process.env.ZK_PERRONS_START_MS || 120000)).unref();
  setInterval(() => { if (!D || Date.now() - D.zeit > ALTER || (fehler && Date.now() - (letzte || 0) > 6 * 3600e3)) laden(); }, 6 * 3600e3).unref();
  return {
    kacheln(ks) { if (!D) return null; const k = {}; for (const x of ks) k[x] = D.k[x] || []; return zlib.gzipSync(JSON.stringify({ zeit: D.zeit, k })); },
    status: () => ({ perrons: D ? D.n : 0, stand: D ? new Date(D.zeit).toISOString() : null, fehler, laeuft }),
  };
}
module.exports = { start, aufbereiten };
