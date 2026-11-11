// Sektoren der Perrons: Sektortafeln der SBB (Open Data, data.sbb.ch «sektortafel», ohne Schlüssel). Je Tafel Bahnhof
// (UIC), Gleis, Lage und die Buchstaben auf Vorder- und Rückseite: gleich = Mitte eines Sektors, verschieden = Grenze
// zwischen zwei Sektoren, «-» = Perronende. Die Lage entlang des Gleises gibt der Kilometer der Linie.
// Einmal pro Monat geladen, gespeichert in DATA_DIR/sektoren.json, ausgeliefert ganz (/api/sektoren, gzip ~50 KB).
// Damit hält der Zug mit der Mitte zwischen den Sektoren, die ihm der Formation-Dienst für diesen Halt angibt.
"use strict";
const fs = require("fs"), path = require("path"), zlib = require("zlib");

const URL_SEK = process.env.ZK_SEKTOREN_URL || "https://data.sbb.ch/api/explore/v2.1/catalog/datasets/sektortafel/exports/json?select=bpuic,kundengleisnummer,sektor_vorderseite,sektor_ruckseiter,geopos,km,linie";
const ALTER = 30 * 86400e3;

function lv95(lat, lon) {   // WGS84 → LV95 (Näherung swisstopo)
  const p = (lat * 3600 - 169028.66) / 10000, l = (lon * 3600 - 26782.5) / 10000;
  return [2600072.37 + 211455.93 * l - 10938.51 * l * p - 0.36 * l * p * p - 44.54 * l ** 3, 1200147.07 + 308807.95 * p + 3745.25 * l * l + 76.63 * p * p - 194.56 * l * l * p + 119.79 * p ** 3];
}
const buchstabe = s => /^[A-Z]$/.test(String(s || "").trim()) ? String(s).trim() : "-";
const gleisName = g => { g = String(g == null ? "" : g).trim(); return /^0+\d+$/.test(g) ? String(+g) : g; };

// Liste der Tafeln → {u: {UIC: {Gleis: [[m, E, N, "VR"], …]}}} (m = Meter entlang der Linie, aufsteigend; E/N ganze Meter LV95)
function aufbereiten(liste) {
  const gruppen = new Map(); let n = 0;
  for (const t of liste || []) {
    const uic = String(t.bpuic || ""), gl = gleisName(t.kundengleisnummer), g = t.geopos;
    if (!/^\d{7}$/.test(uic) || !gl || !g || typeof g.lat !== "number" || typeof t.km !== "number") continue;
    const v = buchstabe(t.sektor_vorderseite), r = buchstabe(t.sektor_ruckseiter); if (v === "-" && r === "-") continue;
    const k = uic + "|" + gl + "|" + (t.linie || 0);
    const [E, N] = lv95(g.lat, g.lon); (gruppen.get(k) || gruppen.set(k, []).get(k)).push([Math.round(t.km * 1000), Math.round(E), Math.round(N), v + r]); n++;
  }
  // Ein Gleis kann Tafeln mehrerer Linien haben (Kilometer nicht vergleichbar) → die Linie mit den meisten Tafeln
  const u = {}, beste = {};
  for (const [k, l] of gruppen) {
    const [uic, gl] = k.split("|"), id = uic + "|" + gl; if (beste[id] && beste[id] >= l.length) continue; beste[id] = l.length;
    l.sort((a, b) => a[0] - b[0]); const m0 = l[0][0];
    (u[uic] || (u[uic] = {}))[gl] = l.map(([m, E, N, s]) => [m - m0, E, N, s]);
  }
  return { u, n };
}

function start({ DATA_DIR, log }) {
  const DATEI = path.join(DATA_DIR, "sektoren.json");
  let D = null, gz = null, fehler = null, letzte = null, laeuft = false;
  const packen = () => { gz = D ? zlib.gzipSync(JSON.stringify({ zeit: D.zeit, u: D.u })) : null; };
  try { D = JSON.parse(fs.readFileSync(DATEI, "utf8")); packen(); } catch { }
  async function laden() {
    if (laeuft) return; laeuft = true;
    try {
      const r = await fetch(URL_SEK, { headers: { "User-Agent": "ZugKarte (privat; Sektortafeln 1x pro Monat)", Accept: "application/json" }, signal: AbortSignal.timeout(120e3) });
      if (!r.ok) throw new Error("data.sbb.ch HTTP " + r.status);
      const { u, n } = aufbereiten(await r.json()); if (!n) throw new Error("keine Sektortafeln erhalten");
      D = { zeit: Date.now(), n, u }; fs.writeFileSync(DATEI + ".tmp", JSON.stringify(D)); fs.renameSync(DATEI + ".tmp", DATEI); packen();
      fehler = null; letzte = Date.now(); log("Sektoren:", n, "Sektortafeln,", Object.keys(u).length, "Bahnhöfe");
    } catch (e) { fehler = e.message; letzte = Date.now(); log("Sektoren:", e.message); }
    laeuft = false;
  }
  setTimeout(() => { if (!D || Date.now() - D.zeit > ALTER) laden(); }, +(process.env.ZK_SEKTOREN_START_MS || 150000)).unref();
  setInterval(() => { if (!D || Date.now() - D.zeit > ALTER || (fehler && Date.now() - (letzte || 0) > 6 * 3600e3)) laden(); }, 6 * 3600e3).unref();
  return {
    gz: () => gz,
    status: () => ({ tafeln: D ? D.n : 0, bahnhoefe: D ? Object.keys(D.u).length : 0, stand: D ? new Date(D.zeit).toISOString() : null, fehler, laeuft }),
  };
}
module.exports = { start, aufbereiten };
