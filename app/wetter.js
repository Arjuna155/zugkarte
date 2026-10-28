// Wetter: aktuelle Messwerte der MeteoSchweiz-Stationen (Open Data, ohne Schlüssel).
// SwissMetNet (ch.meteoschweiz.ogd-smn: Temperatur, Niederschlag, Wind, Sonne, Feuchte, Schnee) und die automatischen
// Niederschlagsstationen (ch.meteoschweiz.ogd-smn-precip). Je Station eine Datei «…_t_now.csv» (10-Minuten-Werte,
// gestern 12 UTC bis jetzt, alle 10 Min. neu). Alle 10 Minuten werden alle Stationen geholt (mit ETag, also meist nur
// «304 nicht geändert»), daraus entsteht DATA_DIR/wetter.json für /api/wetter.
"use strict";
const fs = require("fs"), path = require("path"), zlib = require("zlib");

const BASIS = (process.env.ZK_WETTER_URL || "https://data.geo.admin.ch").replace(/\/$/, "");
const SAMMLUNGEN = ["ch.meteoschweiz.ogd-smn", "ch.meteoschweiz.ogd-smn-precip"];
const UA = { "User-Agent": "ZugKarte (privat; Wetter alle 10 Min.)" };
const dekoder = (() => { try { return new TextDecoder("windows-1252"); } catch { return new TextDecoder("latin1"); } })();

function csvLesen(buf) {
  const zl = dekoder.decode(buf).split(/\r?\n/).filter(Boolean); if (!zl.length) return [];
  const kopf = zl[0].split(";").map(s => s.trim());
  return zl.slice(1).map(l => { const a = l.split(";"), o = {}; kopf.forEach((k, i) => o[k] = (a[i] || "").trim()); return o; });
}
const zahl = s => s === "" || s === undefined ? null : (isFinite(+s) ? +s : null);

function start({ DATA_DIR, log }) {
  const DATEI = path.join(DATA_DIR, "wetter.json");
  const S = { stationen: {}, etag: {}, href: {}, letzte: null, fehler: null, laeuft: false, metaZeit: 0, abfragen: 0, geaendert: 0 };
  let gz = null; try { gz = zlib.gzipSync(fs.readFileSync(DATEI)); } catch { }

  async function holen(url, etag) {
    const h = { ...UA }; if (etag) h["If-None-Match"] = etag;
    const r = await fetch(url, { headers: h, signal: AbortSignal.timeout(30000) }); S.abfragen++;
    if (r.status === 304) return { nichtNeu: true };
    if (!r.ok) return { status: r.status };
    return { buf: Buffer.from(await r.arrayBuffer()), etag: r.headers.get("etag") };
  }
  // Stationsliste (einmal pro Tag): Kürzel, Name, Lage (LV95), Höhe
  async function meta() {
    if (Date.now() - S.metaZeit < 24 * 3600e3 && Object.keys(S.stationen).length) return;
    const neu = {};
    for (const sm of SAMMLUNGEN) {
      const kurz = sm.split(".").pop(), r = await holen(`${BASIS}/${sm}/${kurz}_meta_stations.csv`);
      if (!r.buf) { log("Wetter: Stationsliste", kurz, "HTTP", r.status); continue; }
      for (const o of csvLesen(r.buf)) {
        const k = (o.station_abbr || "").toUpperCase(); if (!k) continue;
        const E = zahl(o.station_coordinates_lv95_east), N = zahl(o.station_coordinates_lv95_north); if (!E || !N) continue;
        if (neu[k] && sm.endsWith("precip")) continue;   // Station in beiden Netzen: SwissMetNet hat mehr Werte
        neu[k] = { k, n: o.station_name || k, E: Math.round(E), N: Math.round(N), h: zahl(o.station_height_masl), sm, nur: sm.endsWith("precip") ? "rr" : "" };
      }
    }
    if (Object.keys(neu).length) { for (const k in neu) neu[k].w = (S.stationen[k] || {}).w || null; S.stationen = neu; S.metaZeit = Date.now(); log("Wetter:", Object.keys(neu).length, "Stationen"); }
  }
  // Datei einer Station: zuerst der übliche Pfad, sonst über den STAC-Eintrag der Station suchen
  async function stationHolen(st) {
    const kl = st.k.toLowerCase(), kurz = st.sm.split(".").pop();
    let url = S.href[st.k] || `${BASIS}/${st.sm}/${kl}/${kurz}_${kl}_t_now.csv`, r = await holen(url, S.etag[st.k]);
    if (r.status === 404 && !S.href[st.k]) {
      const j = await holen(`${BASIS}/api/stac/v1/collections/${st.sm}/items/${kl}`);
      if (j.buf) { try { const a = Object.values(JSON.parse(j.buf).assets || {}).find(x => /_t_now\.csv$/.test(x.href)); if (a) { url = a.href; S.href[st.k] = url; r = await holen(url); } } catch { } }
    }
    if (r.nichtNeu || !r.buf) return;
    S.etag[st.k] = r.etag; S.geaendert++;
    const zeilen = csvLesen(r.buf); if (!zeilen.length) return;
    // letzte Zeile mit Werten; Niederschlag der letzten Stunde = Summe der letzten 6 Zehnminutenwerte
    let i = zeilen.length - 1; while (i > 0 && zahl(zeilen[i].rre150z0) === null && zahl(zeilen[i].tre200s0) === null) i--;
    const z = zeilen[i]; let rr1h = 0, n = 0; for (let q = i; q > i - 6 && q >= 0; q--) { const v = zahl(zeilen[q].rre150z0); if (v !== null) { rr1h += v; n++; } }
    const m = (z.reference_timestamp || "").match(/(\d\d)\.(\d\d)\.(\d{4}) (\d\d):(\d\d)/);
    st.w = { z: m ? Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]) : null, t: zahl(z.tre200s0), rr: zahl(z.rre150z0), rr1h: n ? Math.round(rr1h * 10) / 10 : null,
      ff: zahl(z.fu3010z0), dd: zahl(z.dkl010z0), fx: zahl(z.fu3010z1), so: zahl(z.sre000z0), rf: zahl(z.ure200s0), hs: zahl(z.htoauts0), gs: zahl(z.gre000z0) };
  }
  async function runde() {
    if (S.laeuft) return; S.laeuft = true; const t0 = Date.now(); S.geaendert = 0;
    try {
      await meta();
      const liste = Object.values(S.stationen); let p = 0;
      await Promise.all(Array.from({ length: 6 }, async () => { while (p < liste.length) { const st = liste[p++]; try { await stationHolen(st); } catch (e) { } } }));
      const aus = liste.filter(s => s.w && s.w.z && Date.now() - s.w.z < 3 * 3600e3)
        .map(s => [s.k, s.n, s.E, s.N, s.h, s.w.t, s.w.rr, s.w.rr1h, s.w.ff, s.w.dd, s.w.fx, s.w.so, s.w.rf, s.w.hs, s.w.gs, s.w.z]);
      const j = { zeit: Date.now(), felder: ["k", "name", "E", "N", "hoehe", "t", "rr", "rr1h", "ff", "dd", "fx", "so", "rf", "hs", "gs", "z"], stationen: aus };
      if (aus.length) { const raw = JSON.stringify(j); fs.writeFileSync(DATEI + ".tmp", raw); fs.renameSync(DATEI + ".tmp", DATEI); gz = zlib.gzipSync(raw); }
      S.letzte = { zeit: Date.now(), stationen: aus.length, geaendert: S.geaendert, dauer: Math.round((Date.now() - t0) / 1000) }; S.fehler = null;
    } catch (e) { S.fehler = e.message; log("Wetter: Fehler", e.message); }
    S.laeuft = false;
  }
  // alle 10 Minuten, jeweils 4 Minuten nach dem Zehnminutentakt (dann sind die neuen Werte veröffentlicht)
  const naechste = () => { const ms = 600e3, jetzt = Date.now(); return ms - ((jetzt - 240e3) % ms); };
  const plane = () => setTimeout(() => { runde().finally(plane); }, naechste());
  setTimeout(() => runde().finally(plane), +(process.env.ZK_WETTER_START_MS || 20000));
  return {
    gz: () => gz,
    status: () => ({ stationen: Object.keys(S.stationen).length, mitWerten: Object.values(S.stationen).filter(s => s.w).length, letzte: S.letzte, fehler: S.fehler, abfragen: S.abfragen, laeuft: S.laeuft }),
  };
}
module.exports = { start };
