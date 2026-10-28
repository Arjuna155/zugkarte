// ZugKarte – Tunnel und Brücken auf den Bahnstrecken (für die Karte: Linie im Tunnel gestrichelt, Züge im Tunnel verdeckt).
// Quelle: swisstopo-Vektorkacheln (ch.swisstopo.base.vt, Zoom 13), Ebene «transportation», class=rail, brunnel=tunnel|bridge.
// Der Server lädt die Kacheln entlang aller Strecken einmal (zwischengespeichert, nach 60 Tagen neu), rechnet in einem eigenen
// Prozess aus, welche Stücke jedes Streckenteils im Tunnel bzw. auf einer Brücke liegen, und liefert das unter /api/bauwerke.
"use strict";
const fs = require("fs"), path = require("path"), zlib = require("zlib"), { spawn } = require("child_process");

const TILEJSON = process.env.ZK_TILEJSON || "https://vectortiles.geo.admin.ch/tiles/ch.swisstopo.base.vt/v1.0.0/tiles.json";
const Z = 13, VERSION = 1;

// ---- Mapbox Vector Tile lesen (nur was wir brauchen: Ebenen, Merkmale mit Eigenschaften, Linien) ----
function mvt(buf) {
  let p = 0;
  const varint = () => { let r = 0, s = 0, b; do { b = buf[p++]; r += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80); return r; };
  const zz = n => (n % 2 ? -(n + 1) / 2 : n / 2);
  function lies(ende, feld) { while (p < ende) { const t = varint(), f = Math.floor(t / 8), w = t & 7; if (w === 2) { const l = varint(), e = p + l; feld(f, w, e); p = e; } else if (w === 0) feld(f, w, varint()); else if (w === 5) { feld(f, w, buf.readFloatLE(p)); p += 4; } else if (w === 1) { feld(f, w, buf.readDoubleLE(p)); p += 8; } else throw new Error("Wiretyp " + w); } }
  const ebenen = [];
  lies(buf.length, (f, w, e) => {
    if (f !== 3) return;
    const L = { name: "", extent: 4096, keys: [], values: [], features: [] };
    lies(e, (f2, w2, e2) => {
      if (f2 === 1) L.name = buf.toString("utf8", p, e2);
      else if (f2 === 5 && w2 === 0) L.extent = e2;
      else if (f2 === 3) L.keys.push(buf.toString("utf8", p, e2));
      else if (f2 === 4) { let v = null; lies(e2, (f3, w3, x) => { if (f3 === 1) v = buf.toString("utf8", p, x); else if (w3 === 0) v = f3 === 6 ? zz(x) : f3 === 7 ? !!x : x; else v = x; }); L.values.push(v); }
      else if (f2 === 2) {
        const F = { tags: [], typ: 0, geo: [] };
        lies(e2, (f3, w3, x) => {
          if (f3 === 3 && w3 === 0) F.typ = x;
          else if (f3 === 2) while (p < x) F.tags.push(varint());
          else if (f3 === 4) while (p < x) F.geo.push(varint());
        });
        L.features.push(F);
      }
    });
    ebenen.push(L);
  });
  // Geometrie → Linien in Kachelkoordinaten
  for (const L of ebenen) for (const F of L.features) {
    const props = {}; for (let i = 0; i < F.tags.length; i += 2) props[L.keys[F.tags[i]]] = L.values[F.tags[i + 1]]; F.props = props;
    const linien = []; let x = 0, y = 0, cur = null, i = 0; const g = F.geo;
    while (i < g.length) { const c = g[i++], cmd = c & 7, n = c >> 3; if (cmd === 7) continue; for (let k = 0; k < n; k++) { x += zz(g[i++]); y += zz(g[i++]); if (cmd === 1) { cur = [[x, y]]; linien.push(cur); } else cur.push([x, y]); } }
    F.linien = linien;
  }
  return ebenen;
}

// ---- Koordinaten ----
function wgs(x, y) {   // Kartenkoordinaten (LV95/100) → WGS84
  const E = x * 100 + 2480000, N = 1300000 - y * 100, yy = (E - 2600000) / 1e6, xx = (N - 1200000) / 1e6;
  const l = 2.6779094 + 4.728982 * yy + 0.791484 * yy * xx + 0.1306 * yy * xx * xx - 0.0436 * yy * yy * yy;
  const ph = 16.9023892 + 3.238272 * xx - 0.270978 * yy * yy - 0.002528 * xx * xx - 0.0447 * yy * yy * xx - 0.0140 * xx * xx * xx;
  return [l * 100 / 36, ph * 100 / 36];
}
function lv(lat, lon) {   // WGS84 → Kartenkoordinaten
  const p = (lat * 3600 - 169028.66) / 10000, l = (lon * 3600 - 26782.5) / 10000;
  const E = 2600072.37 + 211455.93 * l - 10938.51 * l * p - 0.36 * l * p * p - 44.54 * l * l * l;
  const N = 1200147.07 + 308807.95 * p + 3745.25 * l * l + 76.63 * p * p - 194.56 * l * l * p + 119.79 * p * p * p;
  return [(E - 2480000) / 100, (1300000 - N) / 100];
}
const kachel = (lon, lat) => { const n = 2 ** Z, x = Math.floor((lon + 180) / 360 * n), r = lat * Math.PI / 180, y = Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n); return [x, y]; };
const kachelZuWgs = (x, y, px, py, ext) => { const n = 2 ** Z, lon = (x + px / ext) / n * 360 - 180, m = Math.PI - 2 * Math.PI * (y + py / ext) / n; return [lon, 180 / Math.PI * Math.atan(Math.sinh(m))]; };

function dekodiere(v) { let x = 0, y = 0; return v.split(";").map((q, i) => { const [a, b] = q.split(",").map(Number); if (i) { x += a; y += b; } else { x = a; y = b; } return [x / 10 - 24800, 13000 - y / 10]; }); }

// ---- Berechnung (eigener Prozess) ----
async function erzeugen(DATA_DIR) {
  const log = (...a) => console.log(new Date().toISOString(), "Bauwerke:", ...a);
  const pub = path.join(__dirname, "public"), idx = JSON.parse(fs.readFileSync(path.join(pub, "daten", "index.json"), "utf8"));
  const basis = JSON.parse(fs.readFileSync(path.join(pub, idx.basis), "utf8"));
  const lines = basis.lines.map(l => l[3].split("/").map(dekodiere));
  // benötigte Kacheln: entlang aller Teilstücke alle ~500 m (und Nachbarn, damit nichts am Rand fehlt)
  const noetig = new Set();
  for (const L of lines) for (const P of L) for (let k = 1; k < P.length; k++) {
    const a = P[k - 1], b = P[k], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 5));
    for (let i = 0; i <= n; i++) { const [lon, lat] = wgs(a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n), [x, y] = kachel(lon, lat); noetig.add(x + "/" + y); }
  }
  const DIR = path.join(DATA_DIR, "kacheln", String(Z)); fs.mkdirSync(DIR, { recursive: true });
  const tj = await (await fetch(TILEJSON, { signal: AbortSignal.timeout(30000) })).json(), vorlage = tj.tiles[0];
  log(noetig.size, "Kacheln nötig");
  let geladen = 0, fehler = 0; const liste = [...noetig];
  const holen = async xy => {
    const f = path.join(DIR, xy.replace("/", "_") + ".pbf");
    try { const st = fs.statSync(f); if (Date.now() - st.mtimeMs < 60 * 86400000) return fs.readFileSync(f); } catch { }
    const [x, y] = xy.split("/"); const url = vorlage.replace("{z}", Z).replace("{x}", x).replace("{y}", y);
    for (let v = 0; v < 3; v++) {
      try { const r = await fetch(url, { headers: { "User-Agent": "ZugKarte" }, signal: AbortSignal.timeout(30000) }); if (r.status === 204 || r.status === 404) { fs.writeFileSync(f, ""); return Buffer.alloc(0); } if (!r.ok) throw new Error(r.status);
        let b = Buffer.from(await r.arrayBuffer()); if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b); fs.writeFileSync(f, b); geladen++; return b; }
      catch (e) { await new Promise(o => setTimeout(o, 2000 * (v + 1))); }
    }
    fehler++; return null;
  };
  // Tunnel- und Brückenstücke (Bahn) sammeln, in Kartenkoordinaten, Raster 200 m
  const raster = { tunnel: new Map(), bridge: new Map() }, RZ = 2;
  // Stücke sind kurz (Kachelgeometrie); eingetragen in alle Rasterzellen, die sie berühren
  const eintragen = (art, a, b) => { const m = raster[art], seg = [a[0], a[1], b[0], b[1]], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / RZ)), ks = new Set();
    for (let i = 0; i <= n; i++) ks.add(Math.floor((a[0] + (b[0] - a[0]) * i / n) / RZ) + "," + Math.floor((a[1] + (b[1] - a[1]) * i / n) / RZ));
    for (const k of ks) { let s = m.get(k); if (!s) m.set(k, s = []); s.push(seg); } };
  for (let i = 0; i < liste.length; i += 6) {
    const bufs = await Promise.all(liste.slice(i, i + 6).map(holen));
    bufs.forEach((b, j) => {
      if (!b || !b.length) return; const [x, y] = liste[i + j].split("/").map(Number);
      let eb; try { eb = mvt(b); } catch (e) { return; }
      for (const L of eb) if (L.name === "transportation") for (const F of L.features) {
        const pr = F.props; if (!(pr.class === "rail" || pr.class === "transit") || !(pr.brunnel === "tunnel" || pr.brunnel === "bridge")) continue;
        for (const lin of F.linien) { const pts = lin.map(([px, py]) => { const [lon, lat] = kachelZuWgs(x, y, px, py, L.extent); return lv(lat, lon); }); for (let k = 1; k < pts.length; k++) eintragen(pr.brunnel, pts[k - 1], pts[k]); }
      }
    });
    if (i % 300 === 0) log(i, "/", liste.length);
  }
  log("Kacheln:", geladen, "neu geladen,", fehler, "Fehler");
  // je Teilstück: alle 10 m prüfen, ob ein Tunnel-/Brückenstück näher als 15 m liegt
  const abst = (q, s) => { const dx = s[2] - s[0], dy = s[3] - s[1], L2 = dx * dx + dy * dy || 1e-12; let t = ((q[0] - s[0]) * dx + (q[1] - s[1]) * dy) / L2; t = Math.max(0, Math.min(1, t)); return Math.hypot(q[0] - s[0] - t * dx, q[1] - s[1] - t * dy); };
  const nahe = (art, q) => { const m = raster[art], kx = Math.floor(q[0] / RZ), ky = Math.floor(q[1] / RZ);
    for (let dx = -1; dx <= 1; dx++)for (let dy = -1; dy <= 1; dy++) { const s = m.get((kx + dx) + "," + (ky + dy)); if (s) for (const z of s) if (abst(q, z) < .15) return true; } return false; };
  const out = { v: VERSION, basis: idx.basis, tunnel: [], bruecke: [] }; let km = { tunnel: 0, bridge: 0 };
  for (const L of lines) {
    const zt = [], zb = [];
    for (const P of L) {
      const cum = [0]; for (let k = 1; k < P.length; k++)cum.push(cum[k - 1] + Math.hypot(P[k][0] - P[k - 1][0], P[k][1] - P[k - 1][1]));
      const len = cum[cum.length - 1], n = Math.max(2, Math.ceil(len / .1) + 1), ft = [], fb = [];
      let seg = 1;
      for (let i = 0; i < n; i++) {
        const s = len * i / (n - 1); while (seg < P.length - 1 && cum[seg] < s) seg++;
        const u = (s - cum[seg - 1]) / ((cum[seg] - cum[seg - 1]) || 1), q = [P[seg - 1][0] + (P[seg][0] - P[seg - 1][0]) * u, P[seg - 1][1] + (P[seg][1] - P[seg - 1][1]) * u];
        ft.push(nahe("tunnel", q)); fb.push(nahe("bridge", q));
      }
      const bereiche = (f, minL, art) => { const r = []; let a = -1; for (let i = 0; i <= n; i++) { if (i < n && f[i]) { if (a < 0) a = i; } else if (a >= 0) { const L_ = (i - 1 - a) * len / (n - 1); if (L_ >= minL) { r.push([+(a / (n - 1)).toFixed(4), +((i - 1) / (n - 1)).toFixed(4)]); km[art] += L_ / 10; } a = -1; } } return r; };
      zt.push(bereiche(ft, .5, "tunnel")); zb.push(bereiche(fb, .2, "bridge"));
    }
    out.tunnel.push(zt); out.bruecke.push(zb);
  }
  fs.writeFileSync(path.join(DATA_DIR, "bauwerke.json"), JSON.stringify(out));
  log(`fertig: ${km.tunnel.toFixed(0)} km Tunnel, ${km.bridge.toFixed(0)} km Brücken`);
}

// ---- im Server: bei Bedarf im Hintergrund neu berechnen, Ergebnis ausliefern ----
function start({ DATA_DIR, log }) {
  const datei = path.join(DATA_DIR, "bauwerke.json"); let gz = null, laeuft = false, stand = null;
  const pub = path.join(__dirname, "public");
  const lesen = () => { try { const t = fs.readFileSync(datei, "utf8"), j = JSON.parse(t), idx = JSON.parse(fs.readFileSync(path.join(pub, "daten", "index.json"), "utf8")); if (j.v === VERSION && j.basis === idx.basis) { gz = zlib.gzipSync(t); stand = fs.statSync(datei).mtimeMs; return true; } } catch { } return false; };
  const pruefen = () => {
    if (laeuft) return; const ok = lesen(); if (ok && Date.now() - stand < 60 * 86400000) return;
    laeuft = true; log("Bauwerke (Tunnel/Brücken) werden neu berechnet …");
    const p = spawn(process.execPath, [__filename, "--erzeugen", DATA_DIR], { stdio: ["ignore", "inherit", "inherit"] });
    p.on("exit", code => { laeuft = false; if (code === 0) lesen(); else log("Bauwerke: Berechnung fehlgeschlagen (" + code + ")"); });
  };
  setTimeout(pruefen, 90000).unref(); setInterval(pruefen, 24 * 3600000).unref();
  lesen();
  return { gz: () => gz, status: () => ({ bereit: !!gz, laeuft, stand }) };
}
module.exports = { start, mvt };
if (require.main === module && process.argv[2] === "--erzeugen") erzeugen(process.argv[3]).catch(e => { console.error(e); process.exit(1); });
