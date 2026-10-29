// ZugKarte – automatischer Fahrplan aus dem offiziellen Schweizer GTFS (opentransportdata.swiss, ohne Schlüssel).
//
// Der Server ruft start() auf. Einmal pro Tag (ab 03:00 Schweizer Zeit) wird geprüft, ob es auf
// data.opentransportdata.swiss eine neue GTFS-Ausgabe gibt (zweimal pro Woche); nur dann wird die ZIP-Datei
// (100–300 MB) geladen. Danach rechnet ein eigener Node-Prozess (`node fahrplan.js --erzeugen`) den Fahrplan
// für gestern bis in 8 Tagen in das Format der Karte um (ein Fahrplan pro Datum, mit Baustellen, Feiertagen
// und dem Fahrplanwechsel im Dezember). Die Seite holt ihn über /api/fahrplan?d=JJJJ-MM-TT und fällt sonst
// auf den eingebauten Fahrplan (Mo–Fr/Sa/So) zurück.
//
// Grundlage: fahrplan_basis.json (tools/fahrplan_basis.py) – Kartenbahnhöfe, UIC-Nummern und Streckenverlauf.
"use strict";
const fs = require("fs"), path = require("path"), zlib = require("zlib"), readline = require("readline"), { spawn } = require("child_process");

// ---------- ZIP lesen (mit ZIP64, ohne Abhängigkeiten) ----------
function zipEintraege(file) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size, n = Math.min(size, 65557 + 20);
    const tail = Buffer.alloc(n); fs.readSync(fd, tail, 0, n, size - n);
    let p = -1;
    for (let i = n - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { p = i; break; }
    if (p < 0) throw new Error("ZIP: Verzeichnisende fehlt");
    let cdSize = tail.readUInt32LE(p + 12), cdOff = tail.readUInt32LE(p + 16), anz = tail.readUInt16LE(p + 10);
    if (p >= 20 && tail.readUInt32LE(p - 20) === 0x07064b50) {   // ZIP64
      const off64 = Number(tail.readBigUInt64LE(p - 20 + 8)), z = Buffer.alloc(56); fs.readSync(fd, z, 0, 56, off64);
      if (z.readUInt32LE(0) !== 0x06064b50) throw new Error("ZIP64: Verzeichnisende fehlt");
      anz = Number(z.readBigUInt64LE(32)); cdSize = Number(z.readBigUInt64LE(40)); cdOff = Number(z.readBigUInt64LE(48));
    }
    const cd = Buffer.alloc(cdSize); fs.readSync(fd, cd, 0, cdSize, cdOff);
    const out = new Map(); let q = 0;
    for (let k = 0; k < anz; k++) {
      if (cd.readUInt32LE(q) !== 0x02014b50) throw new Error("ZIP: Verzeichnis beschädigt");
      const meth = cd.readUInt16LE(q + 10); let cs = cd.readUInt32LE(q + 20), us = cd.readUInt32LE(q + 24);
      const nl = cd.readUInt16LE(q + 28), el = cd.readUInt16LE(q + 30), kl = cd.readUInt16LE(q + 32); let off = cd.readUInt32LE(q + 42);
      const name = cd.toString("utf8", q + 46, q + 46 + nl);
      let e = q + 46 + nl; const ee = e + el;
      while (e + 4 <= ee) {
        const id = cd.readUInt16LE(e), len = cd.readUInt16LE(e + 2); let f = e + 4;
        if (id === 1) {
          if (us === 0xffffffff) { us = Number(cd.readBigUInt64LE(f)); f += 8; }
          if (cs === 0xffffffff) { cs = Number(cd.readBigUInt64LE(f)); f += 8; }
          if (off === 0xffffffff) { off = Number(cd.readBigUInt64LE(f)); f += 8; }
        }
        e += 4 + len;
      }
      const lh = Buffer.alloc(30); fs.readSync(fd, lh, 0, 30, off);
      if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error("ZIP: Eintrag beschädigt: " + name);
      out.set(name, { meth, cs, us, start: off + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28) });
      q += 46 + nl + el + kl;
    }
    return out;
  } finally { fs.closeSync(fd); }
}
function eintragStrom(file, e) {
  const raw = fs.createReadStream(file, { start: e.start, end: e.start + e.cs - 1, highWaterMark: 1 << 20 });
  if (e.meth === 0) return raw;
  if (e.meth !== 8) throw new Error("ZIP: Kompression " + e.meth + " nicht unterstützt");
  const inf = zlib.createInflateRaw({ chunkSize: 1 << 20 }); raw.on("error", x => inf.destroy(x)); return raw.pipe(inf);
}

// ---------- CSV ----------
function csv(l) {
  const o = []; let i = 0; const n = l.length;
  if (n && l.charCodeAt(n - 1) === 13) l = l.slice(0, -1);
  while (i <= l.length) {
    if (l[i] === '"') {
      let j = i + 1, s = "";
      for (;;) { const k = l.indexOf('"', j); if (k < 0) { s += l.slice(j); i = l.length + 1; break; }
        s += l.slice(j, k); if (l[k + 1] === '"') { s += '"'; j = k + 2; } else { i = k + 2; break; } }
      o.push(s);
    } else { let k = l.indexOf(",", i); if (k < 0) k = l.length; o.push(l.slice(i, k)); i = k + 1; }
  }
  return o;
}
// Datei zeilenweise lesen; fn(felder, kopf) – kopf = {spaltenname: index}. fn kann (zeile, kopf) => … mit roh=true
async function lesen(file, zip, name, fn, roh) {
  const e = zip.get(name); if (!e) return false;
  const rl = readline.createInterface({ input: eintragStrom(file, e), crlfDelay: Infinity });
  let kopf = null;
  for await (const line of rl) {
    if (!kopf) { kopf = {}; csv(line.replace(/^﻿/, "")).forEach((k, i) => kopf[k.trim()] = i); continue; }
    if (!line) continue;
    fn(roh ? line : csv(line), kopf);
  }
  return true;
}

// ---------- Geometrie ----------
function lv95(lat, lon) {   // Näherungsformel swisstopo (wie beim Kartennetz)
  const p = (lat * 3600 - 169028.66) / 10000, l = (lon * 3600 - 26782.5) / 10000;
  const E = 2600072.37 + 211455.93 * l - 10938.51 * l * p - 0.36 * l * p * p - 44.54 * l ** 3;
  const N = 1200147.07 + 308807.95 * p + 3745.25 * l * l + 76.63 * p * p - 194.56 * l * l * p + 119.79 * p ** 3;
  return [(E - 2480000) / 100, (1300000 - N) / 100];
}
function decGeo(p) { let x = 0, y = 0; return p.split(";").map((q, i) => { const [a, b] = q.split(",").map(Number); if (i) { x += a; y += b; } else { x = a; y = b; } return [x / 10 - 24800, 13000 - y / 10]; }); }
function segAbst(px, py, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  let t = L ? ((px - a[0]) * dx + (py - a[1]) * dy) / L : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy);
}
function graph(B) {
  const adj = new Map();
  for (const [a, b, g] of B.kanten) {
    const pts = decGeo(g); let len = 0; for (let k = 1; k < pts.length; k++) len += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
    if (!adj.has(a)) adj.set(a, []); if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push([b, len, pts]); adj.get(b).push([a, len, pts.slice().reverse()]);
  }
  const cache = new Map();
  return function weg(A, Z) {   // kürzester Weg auf dem Kartennetz: {len (Karteneinheiten = 100 m), pts}
    const key = A + ">" + Z; if (cache.has(key)) return cache.get(key);
    const dist = new Map([[A, 0]]), prev = new Map(), H = [[0, A]], fertig = new Set();
    while (H.length) {
      let bi = 0; for (let j = 1; j < H.length; j++) if (H[j][0] < H[bi][0]) bi = j;
      const [d, u] = H[bi]; H[bi] = H[H.length - 1]; H.pop();
      if (fertig.has(u)) continue; fertig.add(u); if (u === Z) break;
      if (d > 4000) break;   // > 400 km: nicht weitersuchen
      for (const [v, len, pts] of adj.get(u) || []) { const nd = d + len; if (!dist.has(v) || nd < dist.get(v)) { dist.set(v, nd); prev.set(v, [u, pts]); H.push([nd, v]); } }
    }
    let r = null;
    if (fertig.has(Z)) { const seq = []; let c = Z; while (c !== A) { const [u, pts] = prev.get(c); seq.push(pts); c = u; }
      const pts = []; for (const g of seq.reverse()) pts.push(...(pts.length ? g.slice(1) : g)); r = { len: dist.get(Z), pts }; }
    cache.set(key, r); return r;
  };
}

// ---------- Datum ----------
const ymd = d => d.replace(/-/g, "");
const isoAus = s => s.slice(0, 4) + "-" + s.slice(4, 6) + "-" + s.slice(6, 8);
function plusTage(iso, n) { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function heuteZH() { const p = {}; new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zurich", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).forEach(x => p[x.type] = x.value);
  return { datum: process.env.ZK_FP_HEUTE || `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute }; }   // ZK_FP_HEUTE: nur für Tests
// Fahrplanjahr: der Fahrplan JJJJ gilt ab dem zweiten Sonntag im Dezember des Vorjahres
function fpJahr(iso) { const y = +iso.slice(0, 4); const d1 = new Date(Date.UTC(y, 11, 1)); const ersterSo = 1 + (7 - d1.getUTCDay()) % 7; const wechsel = `${y}-12-${String(ersterSo + 7).padStart(2, "0")}`; return iso >= wechsel ? y + 1 : y; }

// ---------- Umrechnung GTFS → Kartenfahrplan ----------
const UMRECHNUNG = 8;   // erhöhen, wenn sich die Umrechnung ändert → Server rechnet neu
const TRAM_JA = new Set(["37/19", "46/18"]);   // Agentur/Linie: Waldenburgerbahn, Forchbahn (in GTFS als Tram geführt, auf der Karte Bahn)
const OEV_NEIN = new Set(["7005", "617", "87_LEX"]);   // Agenturen ohne eigenes Netz auf der Karte (Riffelalp-Tram, Alpintrans, SNCF)
// Bergbahnen: Standseilbahnen (FUN) und Luftseilbahnen (PB Pendelbahn, GB Gondelbahn, SL Sesselbahn). Kein eigenes Netz in der
// Basisdatei: Halte und (gerade) Kanten entstehen hier aus dem GTFS und gehen als bergbahnen.json an die Seite.
const BB_KAT = new Set(["FUN", "PB", "GB", "SL", "LB", "SB", "KB"]);
function bergbahnArt(t, desc) {
  const d = (desc || "").toUpperCase();
  if (t === 3 || (t >= 700 && t < 800)) return null;   // Busse («KB» = Kleinbus, nicht Kabinenbahn)
  if (d === "ASC" || t === 1303 || t === 1305 || t === 1702) return null;   // Aufzüge, Skilifte, Pferdebahn
  if (BB_KAT.has(d)) return d;
  if (t === 7 || (t >= 1400 && t < 1500)) return "FUN";
  if (t === 6 || t === 5 || (t >= 1300 && t < 1400) || (t >= 1700 && t < 1800)) return t === 1304 ? "SL" : t === 1301 || t === 1306 ? "GB" : "PB";
  return null;
}
// tage: ["JJJJ-MM-TT", …]; zips: [Pfad, …]; liefert {datum: {ziele:[…], zeilen:[…], feed}}
async function umrechnen(B, zips, tage, log) {
  const weg = graph(B), tageSet = new Set(tage.map(ymd)), erg = {};
  // Bergbahn-Halte: Index ab BBO (nach allen Kartenhalten), je Station einmal (über alle Feeds dieses Laufs)
  const BBO = B.st.length, BBI = new Map(), BBL = [], bbKanten = new Map(), PL = new Map();
  const bbHalt = h => { if (!isFinite(h[1])) return -1; const k = h[4]; let i = BBI.get(k);
    if (i === undefined) { i = BBO + BBL.length; BBI.set(k, i); BBL.push([h[5], Math.round(h[1] * 100 + 2480000), Math.round(1300000 - h[2] * 100)]); }
    return i; };
  for (const t of tage) erg[t] = { ziele: new Map(), zeilen: new Set(), feed: null };
  const stats = { fahrten: 0, laeufe: 0, ok: 0, verworfen: 0 };
  const erledigt = new Set();   // Datum schon aus einem neueren/passenden Feed
  for (const file of zips) {
    const zip = zipEintraege(file);
    let fStart = "00000000", fEnde = "99999999", fVersion = path.basename(file);
    await lesen(file, zip, "feed_info.txt", (f, k) => { fStart = f[k.feed_start_date] || fStart; fEnde = f[k.feed_end_date] || fEnde; fVersion = f[k.feed_version] || fVersion; });
    const meine = [...tageSet].filter(d => d >= fStart && d <= fEnde && !erledigt.has(d));
    if (!meine.length) continue;
    meine.forEach(d => { erledigt.add(d); erg[isoAus(d)].feed = fVersion; });
    const meineSet = new Set(meine);
    log("Fahrplan:", path.basename(file), "(Ausgabe " + fVersion + ") für", meine.length, "Tage");
    // Linien: Bahn (100–199, dazu Waldenburgerbahn und Forchbahn) auf dem Bahnnetz;
    // Trams (900), Metro (400/401) und Schiffe (1000) auf dem ÖV-Netz (oev in fahrplan_basis.json)
    const linien = new Map(), mitOev = !!(B.oev && Object.keys(B.oev).length);
    await lesen(file, zip, "routes.txt", (f, k) => { const t = +f[k.route_type], ag = f[k.agency_id], kurz = (f[k.route_short_name] || "").trim();
      const bahn = (t >= 100 && t < 200) || (t === 900 && TRAM_JA.has(ag + "/" + kurz));
      const oev = !bahn && mitOev && (t === 900 || t === 400 || t === 401 || t === 1000) && !OEV_NEIN.has(ag);
      const bb = !bahn && !oev ? bergbahnArt(t, f[k.route_desc]) : null;
      if (bb) { linien.set(f[k.route_id], { kat: bb, linie: "", oev: false, bb: true, ag }); return; }
      if (!bahn && !oev) return;
      // Anzeige wie bisher: Linie («S 5», «IR 13», «Tram 4»), sonst Zug-/Kursnummer
      let kat = f[k.route_desc] || kurz || "";
      if (oev && t === 900) kat = "Tram"; else if (oev && (t === 400 || t === 401)) kat = "M";
      const rest = kurz.startsWith(kat) ? kurz.slice(kat.length).trim() : kurz.startsWith("M") && kat === "M" ? kurz.slice(1) : kurz;
      const linie = t === 1000 ? (/^\d{1,3}$/.test(rest) ? rest : "") : /^(\d{1,2}|[A-Z]{2,3})$/.test(rest) ? rest : "";
      linien.set(f[k.route_id], { kat, linie, oev, ag }); });
    // Verkehrstage
    const dienst = new Map(), wdSp = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const wdVon = d => new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8))).getUTCDay();
    await lesen(file, zip, "calendar.txt", (f, k) => {
      for (const d of meine) if (d >= f[k.start_date] && d <= f[k.end_date] && f[k[wdSp[wdVon(d)]]] === "1") { let s = dienst.get(f[k.service_id]); if (!s) dienst.set(f[k.service_id], s = new Set()); s.add(d); }
    });
    await lesen(file, zip, "calendar_dates.txt", (line, k) => {
      const f = csv(line); const d = f[k.date]; if (!meineSet.has(d)) return;
      let s = dienst.get(f[k.service_id]);
      if (f[k.exception_type] === "1") { if (!s) dienst.set(f[k.service_id], s = new Set()); s.add(d); } else if (s) s.delete(d);
    }, true);
    // Fahrten
    const fahrten = new Map();
    await lesen(file, zip, "trips.txt", (line, k) => {
      const f = csv(line); const L = linien.get(f[k.route_id]); if (!L) return;
      const s = dienst.get(f[k.service_id]); if (!s || !s.size) return;
      const zn = (f[k.trip_short_name] || "").trim();
      fahrten.set(f[k.trip_id], { kat: L.kat, oev: L.oev, bb: L.bb, nr: L.linie || zn, zn: /^\d+$/.test(zn) ? String(+zn) : "", ag: L.ag, ziel: (f[k.trip_headsign] || "").replace(/\s*[|\r\n]+\s*/g, " / ").trim(), tage: [...s], halte: [] });
    }, true);
    dienst.clear();
    // Halte → Kartenbahnhof (UIC; sonst naher Halt mit passendem Namen)
    const halt = new Map(), haltListe = [];
    await lesen(file, zip, "stops.txt", (f, k) => {
      const lat = +f[k.stop_lat], lon = +f[k.stop_lon]; const [x, y] = lat && lon ? lv95(lat, lon) : [NaN, NaN];
      let u = f[k.didok] || ""; if (!u) { const id = f[k.stop_id]; const m = id.match(/sloid:(\d+)/i); u = m ? "85" + m[1].padStart(5, "0") : (id.match(/^(\d{7})/) || [])[1] || ""; }
      let i = B.uic[u]; if (i === undefined) i = -1;
      if (i < 0 && isFinite(x)) {   // eigener Halt beim Kartenbahnhof (Locarno FART, Arth-Goldau RB, Brig Bahnhofplatz, «Liestal, Bahnhof» …)
        let best = -1, bd = 4; const nb = B.nbahn || B.st.length; for (let j = 0; j < nb; j++) { const p = B.st[j], d = Math.hypot(p[0] - x, p[1] - y); if (d < bd) { bd = d; best = j; } }
        const nm = f[k.stop_name] || "", kn = best >= 0 ? B.name[best] : "";
        if (best >= 0 && !(bd <= 0.5 || (bd <= 2 && (nm.startsWith(kn + " ") || nm.startsWith(kn + ","))) || /, (Bahnhof|Station)$/.test(nm))) best = -1;
        i = best;
      }
      const o = B.oev ? B.oev[u] : undefined;
      const sta = (f[k.parent_station] || "").trim();   // Bergbahnen: Halt = Station (Mutterhalt), sonst Didok-Nummer
      halt.set(f[k.stop_id], haltListe.length); haltListe.push([i, x, y, o === undefined ? -1 : o, u || sta || f[k.stop_id], f[k.stop_name] || "", (f[k.platform_code] || "").trim().replace(/[^\w.\-\/]/g, "")]);
      // Lage der Gleise (Kante) je Kartenbahnhof
      const gl = (f[k.platform_code] || "").trim().replace(/[^\w.\-\/]/g, ""); if (gl && i >= 0 && isFinite(x)) { const g = PL.get(i) || PL.set(i, {}).get(i); (g[gl] || (g[gl] = [0, 0, 0])); g[gl][0] += x; g[gl][1] += y; g[gl][2]++; }
    });
    // Takt-Fahrten (frequencies.txt)
    const takt = new Map();
    await lesen(file, zip, "frequencies.txt", (f, k) => { if (!fahrten.has(f[k.trip_id])) return; const z = s => { const [h, m, x] = s.split(":").map(Number); return h * 3600 + m * 60 + (x || 0); };
      (takt.get(f[k.trip_id]) || takt.set(f[k.trip_id], []).get(f[k.trip_id])).push([z(f[k.start_time]), z(f[k.end_time]), +f[k.headway_secs]]); });
    // Halte der Fahrten (grösste Datei – nur die ID vorab prüfen)
    const min = s => { if (!s) return null; const [h, m] = s.split(":"); return +h * 60 + +m; };
    await lesen(file, zip, "stop_times.txt", (line, k) => {
      const tid = line.charCodeAt(0) === 34 ? line.slice(1, line.indexOf('"', 1)) : line.slice(0, line.indexOf(","));
      const F = fahrten.get(tid); if (!F) return;
      const f = csv(line), h = halt.get(f[k.stop_id]);
      F.halte.push(+f[k.stop_sequence], min(f[k.arrival_time]) ?? -1, min(f[k.departure_time]) ?? -1, h === undefined ? -1 : h);   // flach: 4 Zahlen je Halt
    }, true);
    // umrechnen
    for (const [tid, F] of fahrten) {
      if (!F.halte.length) continue; stats.fahrten++;
      const H = F.halte, ord = []; for (let q = 0; q < H.length; q += 4) ord.push(q); ord.sort((p, q) => H[p] - H[q]);
      const seq = ord.map(q => { const h = H[q + 3] >= 0 ? haltListe[H[q + 3]] : [-1, NaN, NaN, -1]; let A = H[q + 1], D = H[q + 2]; if (A < 0) A = D; if (D < 0) D = A; return { i: F.bb ? bbHalt(h) : F.oev ? h[3] : h[0], x: h[1], y: h[2], a: A, d: D, g: F.oev || F.bb ? "" : h[6] || "" }; });
      F.halte = null;
      if (F.oev || F.bb) {   // Trams/Schiffe/Bergbahnen: Halte in derselben Minute gleichmässig verteilen, sonst wäre der Abschnitt ohne Fahrzeit
        for (let q = 1; q < seq.length; q++) {
          const t0 = seq[q - 1].d; if (seq[q].a > t0) continue;
          let j = q; while (j < seq.length && seq[j].a <= t0) j++;
          const t1 = j < seq.length ? seq[j].a : t0 + 0.5 * (j - q + 1), n = j - q + 1;
          for (let m = q; m < j; m++) { const v = Math.round((t0 + (t1 - t0) * (m - q + 1) / n) * 100) / 100; if (seq[m].a === seq[m].d) seq[m].a = seq[m].d = v; else seq[m].a = Math.min(v, seq[m].d); }
        }
      }
      const runs = []; let cur = null, last = null, zw = [];
      for (const s of seq) {
        if (s.i < 0) { zw.push(s); continue; }
        if (last && last.i === s.i) { last.d = s.d; if (cur) cur[cur.length - 1][2] = s.d; zw = []; continue; }   // zweiter Halt im selben Bahnhof
        if (last) {
          const dep = last.d, arr = s.a; let gut = false;
          if (F.bb) {   // Bergbahn: gerade Linie, langsam erlaubt
            const A = BBL[last.i - BBO], Z = BBL[s.i - BBO], km = Math.hypot(A[1] - Z[1], A[2] - Z[2]) / 1000;
            gut = arr > dep && km > 0.03 && km < 15 && km / ((arr - dep) / 60) < 60; if (gut) bbKanten.set(Math.min(last.i, s.i) + "-" + Math.max(last.i, s.i), F.kat);
          }
          const P = F.bb ? null : weg(last.i, s.i);
          if (P && arr > dep) {
            const kmh = (P.len / 10) / ((arr - dep) / 60);
            if (kmh > 8 && kmh < 240) {
              gut = true;
              for (const b of zw) { if (!isFinite(b.x)) continue; let m = Infinity; for (let q = 1; q < P.pts.length && m > 15; q++) m = Math.min(m, segAbst(b.x, b.y, P.pts[q - 1], P.pts[q])); if (m > 15) { gut = false; break; } }
            }
          }
          if (gut) { stats.ok++; if (!cur) cur = [[last.i, last.a, last.d, last.g]]; cur.push([s.i, s.a, s.d, s.g]); }
          else { stats.verworfen++; if (cur && cur.length > 1) runs.push(cur); cur = null; }
        }
        last = { i: s.i, a: s.a, d: s.d, g: s.g }; zw = [];
      }
      if (cur && cur.length > 1) runs.push(cur);
      if (!runs.length) continue;
      const nr = /^\d+$/.test(F.nr) ? String(+F.nr) : F.nr;
      const versaetze = [0];
      const tk = takt.get(tid);
      if (tk) { versaetze.length = 0; const t0 = seq[0].d * 60; for (const [von, bis, hw] of tk) if (hw > 0) for (let t = von; t < bis; t += hw) versaetze.push(Math.round((t - t0) / 60)); }
      for (const s of runs) {
        // Standzeit > 20 Min. → Lauf teilen (doppelt vergebene Nummer / Wende)
        const stuecke = [[]];
        s.forEach(([i, a, d, g], k) => { if (stuecke[stuecke.length - 1].length && k > 0 && k < s.length - 1 && d - a > 20) { stuecke[stuecke.length - 1].push([i, a, a, g]); stuecke.push([[i, d, d, g]]); } else stuecke[stuecke.length - 1].push([i, a, d, g]); });
        for (let pc of stuecke) {
          if (pc.length < 2) continue;
          pc = [[pc[0][0], pc[0][2], pc[0][2], pc[0][3]], ...pc.slice(1, -1), [pc[pc.length - 1][0], pc[pc.length - 1][1], pc[pc.length - 1][1], pc[pc.length - 1][3]]];
          for (const v of versaetze) {
            const body = pc.map(([i, a, d, g]) => (a === d ? `${i.toString(16)},${a + v}` : `${i.toString(16)},${a + v},${d + v}`) + (g ? "@" + g : "")).join(";");   // @Gleis
            for (const d of F.tage) { const E = erg[isoAus(d)]; if (!E) continue;
              let zi = E.ziele.get(F.ziel); if (zi === undefined) E.ziele.set(F.ziel, zi = E.ziele.size);
              E.zeilen.add(`${F.kat},${nr},${zi}` + (F.oev || F.bb ? `,,${F.ag}` : !F.zn ? "" : `,${F.zn},${F.ag}`) + `|${body}`); }
            stats.laeufe++;
          }
        }
      }
    }
    fahrten.clear(); halt.clear(); haltListe.length = 0;
  }
  const out = {};
  for (const [d, E] of Object.entries(erg)) if (E.feed) out[d] = { feed: E.feed, tt: [...E.ziele.keys()].join("|") + "\n" + [...E.zeilen].join("\n"), zuege: E.zeilen.size };
  // nur Bergbahn-Halte, die in einem gültigen Lauf vorkommen (Indizes bleiben gleich, ungenutzte bekommen leere Namen)
  const genutzt = new Set(); for (const k of bbKanten.keys()) for (const x of k.split("-")) genutzt.add(+x);
  const bb = { offset: BBO, halte: BBL.map((h, i) => genutzt.has(BBO + i) ? h : ["", 0, 0]), kanten: [...bbKanten].map(([k, kat]) => [...k.split("-").map(Number), kat]) };
  stats.bergbahnHalte = genutzt.size; stats.bergbahnKanten = bbKanten.size;
  // Gleislage: Mittel der Kanten je Bahnhof und Gleis (LV95)
  const gleise = {}; for (const [i, g] of PL) { const o = {}; for (const [gl, [sx, sy, n]] of Object.entries(g)) o[gl] = [Math.round(sx / n * 100 + 2480000), Math.round(1300000 - sy / n * 100)]; gleise[i] = o; }
  return { tage: out, stats, bb, gleise };
}

// ---------- Busse (eigener Durchgang, nur gestern … übermorgen) ----------
// Halte je Haltestelle (Didok), Index ab «offset» (nach Karten- und Bergbahnhalten). Die Fahrten gehen nach Tag,
// Zeitfenster (3 h) und Kachel (10 km) in eigene Dateien – die Seite lädt nur, was sie beim Hineinzoomen sieht.
// Den Weg auf der Strasse rechnet die Seite selbst (Strassen der Grundkarte).
const BUS_KAT = new Set(["B", "BN", "EXB", "KLB", "EV"]);
function busArt(t, desc) {
  const d = (desc || "").toUpperCase();
  if (!(t === 3 || (t >= 700 && t < 800)) || t === 715 || /^(RUB|TX|ALT|RFB|BAT)$/.test(d)) return null;   // ohne Rufbus/Taxi
  return d === "BN" || t === 705 ? "BN" : d === "EXB" || t === 702 ? "EXB" : d === "KB" ? "KLB" : d === "EV" || t === 714 ? "EV" : "B";
}
const busKachel = (x, y) => Math.floor(x / 100) + "_" + Math.floor(y / 100);   // Kartenkoordinaten (100 m) → 10-km-Kachel
async function busseUmrechnen(zips, tage, BUSO, log) {
  const tageSet = new Set(tage.map(ymd)), erledigt = new Set(), BI = new Map(), BL = [], ZEILEN = new Map();
  const stats = { fahrten: 0, laeufe: 0, verworfen: 0 };
  for (const file of zips) {
    const zip = zipEintraege(file);
    let fStart = "00000000", fEnde = "99999999";
    await lesen(file, zip, "feed_info.txt", (f, k) => { fStart = f[k.feed_start_date] || fStart; fEnde = f[k.feed_end_date] || fEnde; });
    const meine = [...tageSet].filter(d => d >= fStart && d <= fEnde && !erledigt.has(d)); if (!meine.length) continue;
    meine.forEach(d => erledigt.add(d)); const meineSet = new Set(meine);
    const linien = new Map();
    await lesen(file, zip, "routes.txt", (f, k) => { const kat = busArt(+f[k.route_type], f[k.route_desc]); if (!kat) return;
      const kurz = (f[k.route_short_name] || "").trim().replace(/[,|;\r\n]/g, " ").slice(0, 10);
      linien.set(f[k.route_id], { kat, linie: kurz, ag: f[k.agency_id] }); });
    const dienst = new Map(), wdSp = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const wdVon = d => new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8))).getUTCDay();
    await lesen(file, zip, "calendar.txt", (f, k) => { for (const d of meine) if (d >= f[k.start_date] && d <= f[k.end_date] && f[k[wdSp[wdVon(d)]]] === "1") { let s = dienst.get(f[k.service_id]); if (!s) dienst.set(f[k.service_id], s = new Set()); s.add(d); } });
    await lesen(file, zip, "calendar_dates.txt", (line, k) => { const f = csv(line), d = f[k.date]; if (!meineSet.has(d)) return; let s = dienst.get(f[k.service_id]);
      if (f[k.exception_type] === "1") { if (!s) dienst.set(f[k.service_id], s = new Set()); s.add(d); } else if (s) s.delete(d); }, true);
    const fahrten = new Map();
    await lesen(file, zip, "trips.txt", (line, k) => { const f = csv(line), L = linien.get(f[k.route_id]); if (!L) return; const s = dienst.get(f[k.service_id]); if (!s || !s.size) return;
      fahrten.set(f[k.trip_id], { L, ziel: (f[k.trip_headsign] || "").replace(/\s*[|\r\n]+\s*/g, " / ").trim(), tage: [...s], halte: [] }); }, true);
    dienst.clear();
    const halt = new Map(), HL = [];   // stop_id → [Schlüssel, Name, x, y, genutzt]
    await lesen(file, zip, "stops.txt", (f, k) => { const lat = +f[k.stop_lat], lon = +f[k.stop_lon]; if (!lat || !lon) return; const [x, y] = lv95(lat, lon);
      const id = f[k.stop_id]; let u = f[k.didok] || ""; if (!u) { const m = id.match(/sloid:(\d+)/i); u = m ? "85" + m[1].padStart(5, "0") : (id.match(/^(\d{7})/) || [])[1] || (f[k.parent_station] || "").trim() || id; }
      halt.set(id, HL.length); HL.push([u, (f[k.stop_name] || "").trim(), x, y, false]); });
    const takt = new Map();
    await lesen(file, zip, "frequencies.txt", (f, k) => { if (!fahrten.has(f[k.trip_id])) return; const z = s => { const [h, m, x] = s.split(":").map(Number); return h * 3600 + m * 60 + (x || 0); };
      (takt.get(f[k.trip_id]) || takt.set(f[k.trip_id], []).get(f[k.trip_id])).push([z(f[k.start_time]), z(f[k.end_time]), +f[k.headway_secs]]); });
    const min = s => { if (!s) return null; const [h, m] = s.split(":"); return +h * 60 + +m; };
    await lesen(file, zip, "stop_times.txt", (line, k) => {
      const tid = line.charCodeAt(0) === 34 ? line.slice(1, line.indexOf('"', 1)) : line.slice(0, line.indexOf(","));
      const F = fahrten.get(tid); if (!F) return; const f = csv(line), h = halt.get(f[k.stop_id]);
      F.halte.push(+f[k.stop_sequence], min(f[k.arrival_time]) ?? -1, min(f[k.departure_time]) ?? -1, h === undefined ? -1 : h);
    }, true);
    const busHalt = h => { const H = HL[h], key = H[0]; let i = BI.get(key);
      if (i === undefined) { i = BL.length; BI.set(key, i); BL.push([H[1], 0, 0, 0, false]); }
      if (!H[4]) { H[4] = true; const b = BL[i]; b[1] += H[2]; b[2] += H[3]; b[3]++; }   // Lage = Mittel der Kanten
      return i; };
    for (const [tid, F] of fahrten) {
      if (!F.halte.length) continue; stats.fahrten++;
      const H = F.halte, ord = []; for (let q = 0; q < H.length; q += 4) if (H[q + 3] >= 0) ord.push(q); ord.sort((p, q) => H[p] - H[q]);
      const seq = ord.map(q => { let A = H[q + 1], D = H[q + 2]; if (A < 0) A = D; if (D < 0) D = A; const h = H[q + 3]; return { h, i: busHalt(h), x: HL[h][2], y: HL[h][3], a: A, d: D }; }).filter(s => s.a >= 0);
      F.halte = null;
      for (let q = 1; q < seq.length; q++) {   // Halte in derselben Minute gleichmässig verteilen
        const t0 = seq[q - 1].d; if (seq[q].a > t0) continue;
        let j = q; while (j < seq.length && seq[j].a <= t0) j++;
        const t1 = j < seq.length ? seq[j].a : t0 + 0.5 * (j - q + 1), n = j - q + 1;
        for (let m = q; m < j; m++) { const v = Math.round((t0 + (t1 - t0) * (m - q + 1) / n) * 100) / 100; if (seq[m].a === seq[m].d) seq[m].a = seq[m].d = v; else seq[m].a = Math.min(v, seq[m].d); }
      }
      const runs = []; let cur = null, last = null;
      for (const s of seq) {
        if (last && last.i === s.i) { last.d = s.d; if (cur) cur[cur.length - 1][2] = s.d; continue; }
        if (last) {
          const km = Math.hypot(s.x - last.x, s.y - last.y) / 10, dt = s.a - last.d;
          if (dt > 0 && km < 40 && km / (dt / 60) < 110) { if (!cur) cur = [[last.i, last.a, last.d, last.x, last.y]]; cur.push([s.i, s.a, s.d, s.x, s.y]); }
          else { stats.verworfen++; if (cur && cur.length > 1) runs.push(cur); cur = null; }
        }
        last = { i: s.i, a: s.a, d: s.d, x: s.x, y: s.y };
      }
      if (cur && cur.length > 1) runs.push(cur);
      const versaetze = [0], tk = takt.get(tid);
      if (tk && seq.length) { versaetze.length = 0; const t0 = seq[0].d * 60; for (const [von, bis, hw] of tk) if (hw > 0) for (let t = von; t < bis; t += hw) versaetze.push(Math.round((t - t0) / 60)); }
      for (const s of runs) {
        const stuecke = [[]];   // Standzeit > 20 Min. → teilen
        s.forEach((h, k) => { if (stuecke[stuecke.length - 1].length && k > 0 && k < s.length - 1 && h[2] - h[1] > 20) { stuecke[stuecke.length - 1].push([h[0], h[1], h[1], h[3], h[4]]); stuecke.push([[h[0], h[2], h[2], h[3], h[4]]]); } else stuecke[stuecke.length - 1].push(h); });
        for (let pc of stuecke) {
          if (pc.length < 2) continue;
          const n = pc.length; pc = pc.map((h, k) => k === 0 ? [h[0], h[2], h[2], h[3], h[4]] : k === n - 1 ? [h[0], h[1], h[1], h[3], h[4]] : h);
          const kacheln = [...new Set(pc.map(h => busKachel(h[3], h[4])))];
          for (const v of versaetze) {
            const body = pc.map(([i, a, d]) => a === d ? `${(BUSO + i).toString(16)},${a + v}` : `${(BUSO + i).toString(16)},${a + v},${d + v}`).join(";");
            const key = F.L.kat + "," + F.L.linie + "|" + body + "|" + F.ziel; let Z = ZEILEN.get(key);
            if (!Z) ZEILEN.set(key, Z = { kopf: F.L.kat + "," + F.L.linie, ag: F.L.ag, body, ziel: F.ziel, t0: pc[0][2] + v, t1: pc[n - 1][1] + v, k: kacheln, tage: new Set() });
            for (const d of F.tage) if (tageSet.has(d)) Z.tage.add(d);
            stats.laeufe++;
          }
        }
      }
    }
    fahrten.clear(); halt.clear(); HL.length = 0;
  }
  // je Tag, Zeitfenster und Kachel: «Ziele|…\nZeile\nZeile» (Ziele je Kachel nummeriert)
  const aus = {};
  for (const d of tage) { aus[d] = []; for (let f = 0; f < 16; f++) aus[d].push(new Map()); }
  for (const Z of ZEILEN.values()) for (const dd of Z.tage) { const d = isoAus(dd), A = aus[d]; if (!A) continue;
    for (let f = Math.max(0, Math.floor(Z.t0 / 180)); f <= Math.min(15, Math.floor((Z.t1 + 90) / 180)); f++) for (const k of Z.k) { let T = A[f].get(k); if (!T) A[f].set(k, T = { ziele: new Map(), z: [] });
      let zi = T.ziele.get(Z.ziel); if (zi === undefined) T.ziele.set(Z.ziel, zi = T.ziele.size); T.z.push(`${Z.kopf},${zi},,${Z.ag}|${Z.body}`); } }
  const halte = BL.map(([n, sx, sy, c]) => c ? [n, Math.round(sx / c * 100 + 2480000), Math.round(1300000 - sy / c * 100)] : ["", 0, 0]);
  stats.halte = BL.length; stats.zeilen = ZEILEN.size; ZEILEN.clear();
  return { aus, halte, stats };
}

// ---------- Dateien / Laden ----------
function verzeichnisse(DATA_DIR) { const d = { gtfs: path.join(DATA_DIR, "gtfs"), fp: path.join(DATA_DIR, "fahrplan") }; for (const x of Object.values(d)) fs.mkdirSync(x, { recursive: true }); return d; }
const UA = { "User-Agent": "ZugKarte (privat; Fahrplan 2x pro Woche)" };
async function neuesteAusgabe(jahr) {
  const r = await fetch(`https://data.opentransportdata.swiss/dataset/timetable-${jahr}-gtfs2020`, { headers: UA, signal: AbortSignal.timeout(60000) });
  if (r.status === 404) return null; if (!r.ok) throw new Error("Datensatzseite " + jahr + ": HTTP " + r.status);
  const m = (await r.text()).match(/download\/(gtfs_fp\d{4}_[\d-]+\.zip)/i); return m ? m[1].toLowerCase() : null;
}
async function herunterladen(jahr, ziel) {
  const r = await fetch(`https://data.opentransportdata.swiss/dataset/timetable-${jahr}-gtfs2020/permalink`, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(30 * 60000) });
  if (!r.ok || !r.body) throw new Error("Download " + jahr + ": HTTP " + r.status);
  const tmp = ziel + ".tmp", ws = fs.createWriteStream(tmp);
  const { Readable } = require("stream"), { pipeline } = require("stream/promises");
  await pipeline(Readable.fromWeb(r.body), ws);
  const z = zipEintraege(tmp); if (!z.has("stop_times.txt") || !z.has("trips.txt")) throw new Error("Download " + jahr + ": unvollständige GTFS-Datei");
  fs.renameSync(tmp, ziel);
}

// Busse umrechnen und schreiben: busse.json (Halte) und bus/JJJJ-MM-TT/FF.json.gz (Fahrten je Fenster und Kachel)
async function busseErzeugen(zips, heute, bb, bbv, B, V, log) {
  const tb = []; for (let i = -1; i <= 2; i++) tb.push(plusTage(heute, i));
  const R = await busseUmrechnen(zips, tb, bb.offset + bb.halte.length, log);
  const busv = require("crypto").createHash("sha1").update(bbv + JSON.stringify(R.halte)).digest("hex").slice(0, 10), BD = path.join(V.fp, "bus");
  fs.writeFileSync(path.join(V.fp, "busse.json.tmp"), JSON.stringify({ v: busv, basis: B.v, bbv, offset: bb.offset + bb.halte.length, halte: R.halte })); fs.renameSync(path.join(V.fp, "busse.json.tmp"), path.join(V.fp, "busse.json"));
  for (const [d, F] of Object.entries(R.aus)) {
    const dir = path.join(BD, d), tmp = dir + ".tmp"; fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
    F.forEach((M, f) => { const k = {}; for (const [kk, T] of M) k[kk] = [...T.ziele.keys()].join("|") + "\n" + T.z.join("\n");
      fs.writeFileSync(path.join(tmp, String(f).padStart(2, "0") + ".json.gz"), zlib.gzipSync(JSON.stringify({ v: busv, bbv, datum: d, f, k }))); });
    fs.rmSync(dir, { recursive: true, force: true }); fs.renameSync(tmp, dir);
  }
  for (const d of fs.readdirSync(BD)) if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d < plusTage(heute, -2)) fs.rmSync(path.join(BD, d), { recursive: true, force: true });
  return R.stats;
}

// Läuft als eigener Prozess: node fahrplan.js --erzeugen <DATA_DIR>
async function erzeugenProzess(DATA_DIR) {
  const log = (...a) => console.log(new Date().toISOString(), ...a);
  const B = JSON.parse(fs.readFileSync(path.join(__dirname, "fahrplan_basis.json"), "utf8"));
  const V = verzeichnisse(DATA_DIR), st = lesStatus(DATA_DIR);
  const heute = heuteZH().datum, tage = []; for (let i = -1; i <= 8; i++) tage.push(plusTage(heute, i));
  // neueste Ausgabe zuerst (Fahrplanjahr absteigend), damit pro Datum der passende Feed gilt
  const zips = Object.keys(st.feeds || {}).sort().reverse().map(j => path.join(V.gtfs, `fp${j}.zip`)).filter(f => fs.existsSync(f));
  if (!zips.length) throw new Error("keine GTFS-Datei vorhanden");
  const t0 = Date.now(); const { tage: erg, stats, bb, gleise } = await umrechnen(B, zips, tage, log);
  fs.writeFileSync(path.join(V.fp, "gleise.json.tmp"), JSON.stringify({ basis: B.v, gleise })); fs.renameSync(path.join(V.fp, "gleise.json.tmp"), path.join(V.fp, "gleise.json"));
  const bbv = require("crypto").createHash("sha1").update(JSON.stringify(bb)).digest("hex").slice(0, 10);
  fs.writeFileSync(path.join(V.fp, "bergbahnen.json.tmp"), JSON.stringify({ v: bbv, basis: B.v, ...bb })); fs.renameSync(path.join(V.fp, "bergbahnen.json.tmp"), path.join(V.fp, "bergbahnen.json"));
  for (const [d, x] of Object.entries(erg)) {
    const buf = zlib.gzipSync(JSON.stringify({ v: B.v, bbv, datum: d, feed: x.feed, tt: x.tt }));
    fs.writeFileSync(path.join(V.fp, d + ".json.gz.tmp"), buf); fs.renameSync(path.join(V.fp, d + ".json.gz.tmp"), path.join(V.fp, d + ".json.gz"));
  }
  for (const f of fs.readdirSync(V.fp)) { const m = f.match(/^(\d{4}-\d{2}-\d{2})\.json\.gz$/); if (m && m[1] < plusTage(heute, -2)) fs.unlinkSync(path.join(V.fp, f)); }
  const tageZahl = Object.fromEntries(Object.entries(erg).map(([d, x]) => [d, x.zuege]));
  for (const d in erg) delete erg[d];   // Speicher frei für die Busse
  // Busse: zweiter Durchgang (gestern … übermorgen), Fehler hier lassen den Bahnfahrplan stehen
  let busStats = null;
  try { busStats = await busseErzeugen(zips, heute, bb, bbv, B, V, log); }
  catch (e) { log("Fahrplan: Busse fehlgeschlagen:", e.stack || e.message); busStats = { fehler: e.message }; }
  const s2 = lesStatus(DATA_DIR);
  s2.erzeugt = { zeit: Date.now(), v: B.v, u: UMRECHNUNG, bis: tage[tage.length - 1], tage: tageZahl, stats, busse: busStats, dauer: Math.round((Date.now() - t0) / 1000) };
  schreibStatus(DATA_DIR, s2);
  log("Fahrplan: erzeugt", Object.keys(tageZahl).length, "Tage in", s2.erzeugt.dauer, "s |", JSON.stringify(stats), "| Busse", JSON.stringify(busStats));
}
function lesStatus(DATA_DIR) { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, "fahrplan", "status.json"), "utf8")); } catch { return { feeds: {} }; } }
function schreibStatus(DATA_DIR, s) { const f = path.join(DATA_DIR, "fahrplan", "status.json"); fs.writeFileSync(f + ".tmp", JSON.stringify(s)); fs.renameSync(f + ".tmp", f); }

// ---------- im Server ----------
function start({ DATA_DIR, log }) {
  let B = null; try { B = JSON.parse(fs.readFileSync(path.join(__dirname, "fahrplan_basis.json"), "utf8")); } catch (e) { log("fahrplan_basis.json fehlt:", e.message); return { get: () => null, status: () => ({ aus: true }) }; }
  let V; try { V = verzeichnisse(DATA_DIR); } catch (e) { log("Fahrplan: Datenordner nicht beschreibbar:", e.message); return { get: () => null, status: () => ({ aus: true }) }; }
  const LOCK = path.join(V.fp, "lauf.lock");
  let laeuft = false, fehler = null, letztePruefung = null;
  const gesperrt = () => { try { const [pid, t] = fs.readFileSync(LOCK, "utf8").split(" ").map(Number); if (Date.now() - t > 3 * 3600e3) return false; process.kill(pid, 0); return true; } catch { return false; } };

  async function lauf(grund) {
    if (laeuft || gesperrt()) return; laeuft = true;
    try {
      fs.writeFileSync(LOCK, process.pid + " " + Date.now());
      const st = lesStatus(DATA_DIR); st.feeds = st.feeds || {};
      const { datum: heute } = heuteZH();
      // benötigte Fahrplanjahre: gestern bis in 8 Tagen
      const jahre = [...new Set([-1, 8].map(i => fpJahr(plusTage(heute, i))))];
      let neu = false;
      for (const j of jahre) {
        const ziel = path.join(V.gtfs, `fp${j}.zip`);
        let name = null; try { name = await neuesteAusgabe(j); } catch (e) { log("Fahrplan:", e.message); }
        if (!name) { if (!fs.existsSync(ziel)) log("Fahrplan: keine Ausgabe für", j, "gefunden"); continue; }
        if (st.feeds[j] && st.feeds[j].name === name && fs.existsSync(ziel)) continue;
        log("Fahrplan: lade", name, "…"); const t0 = Date.now();
        await herunterladen(j, ziel);
        st.feeds[j] = { name, geladen: Date.now(), groesse: fs.statSync(ziel).size }; schreibStatus(DATA_DIR, st); neu = true;
        log("Fahrplan:", name, "geladen,", Math.round(st.feeds[j].groesse / 1e6), "MB in", Math.round((Date.now() - t0) / 1000), "s");
      }
      for (const j of Object.keys(st.feeds)) if (!jahre.includes(+j) && +j < Math.min(...jahre)) { try { fs.unlinkSync(path.join(V.gtfs, `fp${j}.zip`)); } catch {} delete st.feeds[j]; schreibStatus(DATA_DIR, st); }
      letztePruefung = Date.now();
      const e = st.erzeugt;
      const noetig = neu || !e || e.v !== B.v || e.u !== UMRECHNUNG || !e.bis || e.bis < plusTage(heute, 5) || !fs.existsSync(path.join(V.fp, heute + ".json.gz")) || !fs.existsSync(path.join(V.fp, "bus", plusTage(heute, 1)));
      if (!noetig) { log("Fahrplan: aktuell (" + grund + ")"); return; }
      log("Fahrplan: erzeuge (" + grund + (neu ? ", neue Ausgabe" : "") + ") …");
      await new Promise((res, rej) => {
        const c = spawn(process.execPath, ["--max-old-space-size=1536", __filename, "--erzeugen", DATA_DIR], { cwd: __dirname, stdio: ["ignore", "inherit", "inherit"] });
        c.on("exit", code => code === 0 ? res() : rej(new Error("Umrechnung beendet mit Code " + code))); c.on("error", rej);
      });
      fehler = null; cache.clear();
    } catch (e) { fehler = e.message; log("Fahrplan: Fehler", e.message); }
    finally { laeuft = false; try { fs.unlinkSync(LOCK); } catch {} }
  }
  // einmal pro Tag ab 03:00 (vor der Sperrungsprüfung um 03:30), beim Start nach 1 Minute
  let tagGeprueft = null;
  function tick() { const { datum, min } = heuteZH(); if (tagGeprueft !== datum && min >= 180) { tagGeprueft = datum; lauf("täglich"); } }
  setTimeout(() => { const { datum, min } = heuteZH(); if (min >= 180) tagGeprueft = datum; lauf("Start"); }, 60000).unref();
  setInterval(tick, 10 * 60000).unref();

  const cache = new Map();
  return {
    get(datum) {   // gzip-JSON {v, datum, feed, tt} oder null
      if (!/^\d{4}-\d{2}-\d{2}$/.test(datum)) return null;
      if (cache.has(datum)) return cache.get(datum);
      let buf = null; try { buf = fs.readFileSync(path.join(V.fp, datum + ".json.gz")); } catch {}
      if (cache.size > 20) cache.clear(); if (buf) cache.set(datum, buf); return buf;
    },
    status() { const st = lesStatus(DATA_DIR); return { feeds: st.feeds, erzeugt: st.erzeugt, laeuft, fehler, letztePruefung, basis: B.v }; },
  };
}

module.exports = { start, umrechnen, busseUmrechnen, busseErzeugen, verzeichnisse, zipEintraege, fpJahr, plusTage, BB_KAT, BUS_KAT };
if (require.main === module && process.argv[2] === "--erzeugen") {
  erzeugenProzess(process.argv[3] || process.env.ZK_DATA || "/data").catch(e => { console.error(new Date().toISOString(), "Fahrplan: Umrechnung fehlgeschlagen:", e.stack || e.message); process.exit(1); });
}
