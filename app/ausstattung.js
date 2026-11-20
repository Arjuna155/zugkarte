// Strassenausstattung aus OpenStreetMap – nur, was dort wirklich erfasst ist:
//   l  Strassenlampen (highway=street_lamp)
//   s  Fussgängerstreifen (highway=crossing, markiert: crossing=zebra/marked/uncontrolled/traffic_signals, crossing:markings, crossing_ref=zebra)
//   t  Strassen mit Trottoir als Merkmal (sidewalk=both|left|right|yes, sidewalk:both|left|right=yes) → Seite 1 links, 2 rechts, 3 beide
//   g  eigene Trottoir-Linien (footway=sidewalk)
//   b  Leitplanken (barrier=guard_rail → 1) und Betonelemente (barrier=jersey_barrier → 2)
//   e  elektrifizierte Gleise (railway=rail|light_rail|narrow_gauge|tram|subway mit electrified=contact_line|yes) für die Fahrleitungen
// Einmal pro Monat über die Overpass-API (ganze Schweiz, je Art eine Abfrage, nacheinander), gespeichert in
// DATA_DIR/ausstattung.json, ausgeliefert je 10-km-Kachel wie die Perrons (/api/ausstattung?k=x_y,…).
// Koordinaten LV95 in dm; Linien als [Art, E0, N0, dE, dN, …]. OSM-Daten © OpenStreetMap-Mitwirkende (ODbL).
"use strict";
const fs = require("fs"), path = require("path"), zlib = require("zlib");

const URL_OVERPASS = process.env.ZK_OVERPASS_URL || "https://overpass-api.de/api/interpreter";
// Die ganze Schweiz in einer Abfrage war Overpass zu viel (504) → je Art 20 Gebiete (5 × 4 über die Schweiz) nacheinander.
const KOPF = `[out:json][timeout:300][maxsize:536870912];`;
const ABFRAGEN = {
  l: b => `node["highway"="street_lamp"](${b});out skel qt;`,
  s: b => `node["highway"="crossing"](${b});out qt;`,
  t: b => `(way["highway"]["sidewalk"~"^(both|left|right|yes)$"](${b});way["highway"]["sidewalk:both"="yes"](${b});way["highway"]["sidewalk:left"="yes"](${b});way["highway"]["sidewalk:right"="yes"](${b}););out geom qt;`,
  g: b => `way["footway"="sidewalk"](${b});out skel geom qt;`,
  b: b => `way["barrier"~"^(guard_rail|jersey_barrier)$"](${b});out geom qt;`,
  e: b => `way["railway"~"^(rail|light_rail|narrow_gauge|tram|subway)$"]["electrified"~"contact_line|yes"](${b});out skel geom qt;`,
};
const GEBIETE = []; for (let j = 0; j < 4; j++) for (let i = 0; i < 5; i++) { const w = 5.9 + i * .93, s = 45.8 + j * .52; GEBIETE.push([s, w, s + .52, w + .93].map(v => +v.toFixed(3)).join(",")); }
const ALTER = 30 * 86400e3, PAUSE = +(process.env.ZK_AUSSTATTUNG_PAUSE_MS || 8000);

function lv95(lat, lon) {   // WGS84 → LV95 (Näherung swisstopo)
  const p = (lat * 3600 - 169028.66) / 10000, l = (lon * 3600 - 26782.5) / 10000;
  return [2600072.37 + 211455.93 * l - 10938.51 * l * p - 0.36 * l * p * p - 44.54 * l ** 3, 1200147.07 + 308807.95 * p + 3745.25 * l * l + 76.63 * p * p - 194.56 * l * l * p + 119.79 * p ** 3];
}
const kachel = (E, N) => Math.floor((E - 2480000) / 10000) + "_" + Math.floor((1300000 - N) / 10000);

// markierter Fussgängerstreifen? (in der Schweiz gelb; unmarkierte Querungen nicht)
function markiert(t) {
  if (!t) return false;
  const c = t.crossing || "", m = t["crossing:markings"] || "";
  if (/^(no|unmarked|informal)$/.test(c) || m === "no") return false;
  return /^(zebra|marked|uncontrolled|traffic_signals)$/.test(c) || (m && m !== "no") || t.crossing_ref === "zebra";
}
function seite(t) {
  const s = t.sidewalk || "";
  let l = s === "both" || s === "yes" || s === "left" || t["sidewalk:both"] === "yes" || t["sidewalk:left"] === "yes";
  let r = s === "both" || s === "yes" || s === "right" || t["sidewalk:both"] === "yes" || t["sidewalk:right"] === "yes";
  if (t["sidewalk:left"] === "no" || t["sidewalk:left"] === "separate") l = false;
  if (t["sidewalk:right"] === "no" || t["sidewalk:right"] === "separate") r = false;
  return (l ? 1 : 0) + (r ? 2 : 0);
}

// eine Overpass-Antwort einer Art → in die Kacheln K einsortieren; gibt die Anzahl zurück
function einsortieren(art, j, K, ids) {
  const neu = k => { const v = K[k] || (K[k] = { l: [], s: [], t: [], g: [], b: [], e: [] }); if (!v.e) v.e = []; return v; }; let n = 0;
  for (const el of j.elements || []) {
    if (ids) { const id = el.type + el.id; if (el.id != null && ids.has(id)) continue; ids.add(id); }   // Linien über Gebietsgrenzen nur einmal
    if (art === "l" || art === "s") {
      if (el.type !== "node" || el.lat == null) continue;
      if (art === "s" && !markiert(el.tags)) continue;
      const [E, N] = lv95(el.lat, el.lon); neu(kachel(E, N))[art].push(Math.round(E * 10), Math.round(N * 10)); n++; continue;
    }
    if (el.type !== "way" || !el.geometry || el.geometry.length < 2) continue;
    let code = 0;
    if (art === "t") { code = seite(el.tags || {}); if (!code) continue; }
    if (art === "e") code = 1;
    if (art === "b") code = (el.tags || {}).barrier === "jersey_barrier" ? 2 : 1;
    const pts = el.geometry.filter(g => g && g.lat != null).map(g => lv95(g.lat, g.lon).map(v => Math.round(v * 10))); if (pts.length < 2) continue;
    const flach = [code, pts[0][0], pts[0][1]]; for (let i = 1; i < pts.length; i++) flach.push(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    for (const k of new Set(pts.map(([E, N]) => kachel(E / 10, N / 10)))) neu(k)[art].push(flach);
    n++;
  }
  return n;
}

function start({ DATA_DIR, log }) {
  const DATEI = path.join(DATA_DIR, "ausstattung.json"), TEIL = DATEI + ".teil";
  let D = null, fehler = null, letzte = null, laeuft = false, schritt = null;
  try { D = JSON.parse(fs.readFileSync(DATEI, "utf8")); } catch { }
  async function laden() {
    if (laeuft) return; laeuft = true;
    try {
      // Zwischenstand nach jedem Gebiet sichern – ein Neustart (neue Version) macht dort weiter, statt von vorne
      let T = null; try { T = JSON.parse(fs.readFileSync(TEIL, "utf8")); if (Date.now() - T.start > 86400e3) T = null; } catch { }
      const K = T ? T.K : {}, n = T ? T.n : {}, fehlend = T ? T.fehlend : [], fertig = new Set(T ? T.fertig : []), start = T ? T.start : Date.now(), warte = ms => new Promise(ok => setTimeout(ok, ms));
      const idsAlle = T ? Object.fromEntries(Object.entries(T.ids).map(([a, l]) => [a, new Set(l)])) : {};
      if (T) log("Ausstattung: mache beim Zwischenstand weiter (" + fertig.size + " Abfragen fertig)");
      for (const art of Object.keys(ABFRAGEN)) {
        const ids = idsAlle[art] || (idsAlle[art] = new Set()); if (n[art] == null) n[art] = 0;
        for (let g = 0; g < GEBIETE.length; g++) {
          if (fertig.has(art + g)) continue;
          schritt = art + " " + (g + 1) + "/" + GEBIETE.length; let ok = false;
          for (let versuch = 0; versuch < 3 && !ok; versuch++) {
            try {
              const r = await fetch(URL_OVERPASS, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "ZugKarte (privat; Strassenausstattung 1x pro Monat)" }, body: "data=" + encodeURIComponent(KOPF + ABFRAGEN[art](GEBIETE[g])), signal: AbortSignal.timeout(400e3) });
              if (!r.ok) throw new Error("HTTP " + r.status);
              n[art] += einsortieren(art, await r.json(), K, ids); ok = true;
            } catch (e) { log("Ausstattung:", art, "Gebiet", g + 1, e.message, versuch < 2 ? "– neuer Versuch" : "– übersprungen"); await warte(60e3 * (versuch + 1)); }
          }
          if (!ok) fehlend.push(art + g);
          fertig.add(art + g);
          try { fs.writeFileSync(TEIL, JSON.stringify({ start, K, n, fehlend, fertig: [...fertig], ids: Object.fromEntries(Object.entries(idsAlle).map(([a, st]) => [a, a === "l" || a === "s" ? [] : [...st]])) })); } catch (e) { log("Ausstattung: Zwischenstand:", e.message); }
          await warte(PAUSE);   // Overpass schonen
        }
        log("Ausstattung:", art, n[art]);
      }
      if (!n.l && !n.s && !n.t) throw new Error("keine Daten erhalten");
      try { fs.unlinkSync(TEIL); } catch { }
      D = { zeit: fehlend.length ? Date.now() - ALTER + 2 * 86400e3 : Date.now(), n, k: K, fehlend };   // Lücken → in 2 Tagen nochmals fs.writeFileSync(DATEI + ".tmp", JSON.stringify(D)); fs.renameSync(DATEI + ".tmp", DATEI);
      fehler = null; letzte = Date.now(); log("Ausstattung aus OpenStreetMap:", JSON.stringify(n));
    } catch (e) { fehler = e.message; letzte = Date.now(); log("Ausstattung:", e.message); }
    laeuft = false; schritt = null;
  }
  const faellig = () => !D || Date.now() - D.zeit > ALTER || (fehler && Date.now() - (letzte || 0) > 6 * 3600e3);
  setTimeout(() => { if (faellig()) laden(); }, +(process.env.ZK_AUSSTATTUNG_START_MS || 240000)).unref();
  setInterval(() => { if (faellig()) laden(); }, 6 * 3600e3).unref();
  return {
    kacheln(ks) { if (!D) return null; const k = {}; for (const x of ks) if (D.k[x]) k[x] = D.k[x]; return zlib.gzipSync(JSON.stringify({ zeit: D.zeit, k })); },
    status: () => ({ stand: D ? new Date(D.zeit).toISOString() : null, anzahl: D ? D.n : null, fehlendeGebiete: D ? (D.fehlend || []).length : null, fehler, laeuft, schritt }),
  };
}
module.exports = { start, einsortieren, markiert, seite };
