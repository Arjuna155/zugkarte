// Baustellen auf Autobahnen und Hauptstrassen: Verkehrsmeldungen des ASTRA («Traffic Situations», DATEX II über SOAP,
// gleicher Schlüssel wie Züge/Verkehrszähler – im API-Manager muss «Traffic Situations» freigeschaltet sein).
// Die Meldungen nennen den Ort als TMC-Codes (AlertC: Anfangs- und Endpunkt, Richtung). Die Codetabelle mit Koordinaten
// (RDS-TMC Location Table des ASTRA, ZIP ~1.3 MB, ohne Schlüssel) lädt der Server einmal pro Monat selbst.
// Daraus wird je Baustelle eine Linie (Punkte entlang der TMC-Kette vom Ende zum Kopf, also in Fahrtrichtung).
// /api/baustellen liefert die JETZT gültigen (Gesamtzeitraum und ggf. Teilzeiträume, z. B. nur nachts).
"use strict";
const fs = require("fs"), path = require("path"), zlib = require("zlib");

const URL_SIT = process.env.OTD_SITUATION_URL || "https://api.opentransportdata.swiss/TDP/Soap_Datex2/TrafficSituations/Pull";
const AKTION = "http://opentransportdata.swiss/TDP/Soap_Datex2/Pull/v1/pullTrafficMessages";
const CKAN = process.env.ZK_TMC_CKAN || "https://data.opentransportdata.swiss/api/3/action/package_show?id=rds-tmc";
const TMC_RUECKFALL = "https://data.opentransportdata.swiss/de/dataset/70c603be-92c8-4581-bab7-d97ab06bb490/resource/b1fb7993-6e2b-4825-b386-4e32d79405c1/download/tmc_location_codes_v7-5.zip";
const KOERPER = () => `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>`
  + `<d2LogicalModel xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" modelBaseVersion="2" xmlns="http://datex2.eu/schema/2/2_0">`
  + `<exchange><supplierIdentification><country>ch</country><nationalIdentifier>FEDRO</nationalIdentifier></supplierIdentification><subscription><operatingMode>operatingMode1</operatingMode>`
  + `<subscriptionStartTime>${new Date().toISOString()}</subscriptionStartTime><subscriptionState>active</subscriptionState><updateMethod>singleElementUpdate</updateMethod>`
  + `<target><address></address><protocol>http</protocol></target></subscription></exchange></d2LogicalModel></soap:Body></soap:Envelope>`;

// ---- kleine XML-Helfer (Namensraum-Präfixe werden übergangen) ----
const tag = n => new RegExp(`<(?:[\\w-]+:)?${n}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${n}>`, "g");
const erstes = (s, n) => { const m = tag(n).exec(s); return m ? m[1] : null; };
const alle = (s, n) => { const r = tag(n), out = []; let m; while ((m = r.exec(s))) out.push(m[0]); return out; };
const attr = (s, a) => { const m = s.match(new RegExp(`\\b${a}="([^"]*)"`)); return m ? m[1] : null; };
const ent = s => String(s || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&").trim();

// ---- ZIP im Speicher (klein, ohne ZIP64) ----
function unzip(buf) {
  let p = -1; for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { p = i; break; }
  if (p < 0) throw new Error("ZIP: Verzeichnisende fehlt");
  const anz = buf.readUInt16LE(p + 10); let q = buf.readUInt32LE(p + 16); const out = {};
  for (let k = 0; k < anz; k++) {
    if (buf.readUInt32LE(q) !== 0x02014b50) throw new Error("ZIP: Verzeichnis beschädigt");
    const meth = buf.readUInt16LE(q + 10), cs = buf.readUInt32LE(q + 20), nl = buf.readUInt16LE(q + 28), el = buf.readUInt16LE(q + 30), kl = buf.readUInt16LE(q + 32), off = buf.readUInt32LE(q + 42);
    const name = buf.toString("utf8", q + 46, q + 46 + nl), st = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28), roh = buf.subarray(st, st + cs);
    if (!name.endsWith("/")) out[name.split("/").pop().toUpperCase()] = meth === 8 ? zlib.inflateRawSync(roh) : roh;
    q += 46 + nl + el + kl;
  }
  return out;
}
// .DAT-Dateien: «;»-getrennt, erste Zeile Kopf, UTF-8 mit BOM
function dat(b) {
  const L = b.toString("utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean), h = L[0].split(";");
  return L.slice(1).map(l => { const a = l.split(";"), o = {}; h.forEach((k, i) => o[k] = a[i]); return o; });
}
// Codetabelle → {lcd: [lon, lat, neg, pos, strasse, name]}
function tmcAufbereiten(z) {
  const P = dat(z["POINTS.DAT"]), O = z["POFFSETS.DAT"] ? dat(z["POFFSETS.DAT"]) : [], R = z["ROADS.DAT"] ? dat(z["ROADS.DAT"]) : [], S = z["SEGMENTS.DAT"] ? dat(z["SEGMENTS.DAT"]) : [], N = z["NAMES.DAT"] ? dat(z["NAMES.DAT"]) : [];
  const nm = {}, off = {}, rn = {}, sn = {}, p = {};
  for (const n of N) nm[n.NID] = n.NAME; for (const o of O) off[o.LCD] = [+o.NEG_OFF_LCD || 0, +o.POS_OFF_LCD || 0];
  for (const r of R) rn[r.LCD] = r.ROADNUMBER; for (const s of S) sn[s.LCD] = s.ROADNUMBER;
  for (const q of P) { const lon = +q.XCOORD / 1e5, lat = +q.YCOORD / 1e5; if (!(lon > 5 && lon < 11 && lat > 45 && lat < 48.5)) continue; const o = off[q.LCD] || [0, 0];
    p[q.LCD] = [Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5, o[0], o[1], sn[q.SEG_LCD] || rn[q.ROA_LCD] || "", nm[q.N1ID] || ""]; }
  return p;
}

// Linie zwischen zwei TMC-Punkten: von «sek» (Ende des Bereichs) zu «pri» (Kopf) den Offsets folgen
function kette(T, sek, pri, richtung) {
  if (!T[sek] || !T[pri]) return null; if (sek === pri) return [sek];
  // AlertC: bei Richtung «positive» liegt der Kopf in positiver Richtung vom Ende aus (Index 3 = pos, 2 = neg)
  for (const i of richtung === "negative" ? [2, 3] : [3, 2]) {
    const weg = [sek]; let c = sek;
    for (let n = 0; n < 120; n++) { const nx = T[c] && T[c][i]; if (!nx || !T[nx] || weg.includes(String(nx))) break; c = String(nx); weg.push(c); if (c === pri) return weg; }
  }
  return [sek, pri];   // nicht über die Offsets verbunden → gerade
}

function art(rec, typ, text) {
  const t = (typ || "").replace(/^\w+:/, "");
  if (/MaintenanceWorks|ConstructionWorks|Roadworks/i.test(t)) return "baustelle";
  if (/roadMaintenance|roadworks|constructionWork|maintenanceWork/i.test(rec)) return "baustelle";
  if (/Baustelle|Bauarbeiten|Belagsarbeiten|Unterhaltsarbeiten|Reinigungsarbeiten|chantier|travaux|cantiere|lavori/i.test(text)) return "baustelle";
  return null;
}
function gueltigJetzt(b, jetzt) {
  if (b.ab && jetzt < b.ab) return false; if (b.bis && jetzt > b.bis) return false;
  if (b.perioden && b.perioden.length && !b.perioden.some(([a, e]) => jetzt >= a && (!e || jetzt <= e))) return false;
  return true;
}
// Meldungen → Baustellen (alle, mit Zeiten; gefiltert wird bei der Ausgabe)
function auswerten(x, T, zaehler) {
  const liste = [];
  for (const rec of alle(x, "situationRecord")) {
    const kopf = rec.slice(0, rec.indexOf(">") + 1), typ = attr(kopf, "xsi:type") || "", id = attr(kopf, "id") || "";
    zaehler[typ.replace(/^\w+:/, "") || "?"] = (zaehler[typ.replace(/^\w+:/, "") || "?"] || 0) + 1;
    const komm = alle(rec, "generalPublicComment").find(c => /description/.test(c)) || erstes(rec, "generalPublicComment") || "";
    const werte = alle(komm, "value"), de = werte.find(v => /lang="de/.test(v)) || werte[0] || "", text = ent(de.replace(/<[^>]+>/g, ""));
    if (/<(?:\w+:)?cancel>\s*true/.test(rec) || /Aufgehoben/.test(text)) continue;
    const a = art(rec, typ, text); if (!a) continue;
    const st = erstes(rec, "validityStatus"); if (st && /suspended/.test(st)) continue;
    const zeit = s => { const t = Date.parse(s || ""); return isFinite(t) ? t : null; };
    const perioden = alle(rec, "validPeriod").map(p => [zeit(erstes(p, "startOfPeriod")), zeit(erstes(p, "endOfPeriod"))]).filter(p => p[0]);
    const b = { id, art: a, text: text.slice(0, 400), ab: zeit(erstes(rec, "overallStartTime")), bis: zeit(erstes(rec, "overallEndTime")), perioden };
    // Ort (AlertC): Kopf (primary) und Ende (secondary), Richtung
    const pri = erstes(erstes(rec, "alertCMethod4PrimaryPointLocation") || erstes(rec, "alertCMethod2PrimaryPointLocation") || erstes(rec, "alertCPoint") || "", "specificLocation");
    const sek = erstes(erstes(rec, "alertCMethod4SecondaryPointLocation") || erstes(rec, "alertCMethod2SecondaryPointLocation") || "", "specificLocation");
    const ri = (erstes(rec, "alertCDirectionCoded") || "").trim(); b.richtung = /positive|negative/.test(ri) ? ri : "both";
    const P = String((pri || "").trim()), Sk = String((sek || pri || "").trim());
    const weg = kette(T, Sk, P, b.richtung); if (!weg) { zaehler.ohneOrt = (zaehler.ohneOrt || 0) + 1; continue; }
    b.linie = weg.map(c => [T[c][0], T[c][1]]); b.strasse = T[P] ? T[P][4] : ""; b.von = T[Sk] ? T[Sk][5] : ""; b.nach = T[P] ? T[P][5] : "";
    const sp = text.match(/Anz\. Fahrstreifen\s*(\d)/); if (sp) b.spuren = +sp[1];
    liste.push(b);
  }
  return liste;
}

function start({ DATA_DIR, log, key }) {
  const DT = path.join(DATA_DIR, "tmc.json"), DB = path.join(DATA_DIR, "baustellen.json");
  const S = { tmc: null, tmcZeit: 0, tmcQuelle: null, liste: [], zeit: 0, fehler: null, tmcFehler: null, http: null, abfragen: 0, pauseBis: 0, typen: {}, laeuft: false, groesse: 0 };
  let gz = null;
  try { const j = JSON.parse(fs.readFileSync(DT, "utf8")); S.tmc = j.p; S.tmcZeit = j.zeit; S.tmcQuelle = j.quelle; } catch { }
  try { const j = JSON.parse(fs.readFileSync(DB, "utf8")); S.liste = j.liste || []; S.zeit = j.zeit || 0; } catch { }

  async function tmcLaden() {
    if (S.tmc && Date.now() - S.tmcZeit < 30 * 86400e3) return;
    try {
      let url = TMC_RUECKFALL;
      try {   // neueste Ausgabe «TMC Location Codes x.y» aus dem Katalog
        const j = await (await fetch(CKAN, { signal: AbortSignal.timeout(30e3) })).json();
        const rs = ((j.result && j.result.resources) || []).filter(r => /tmc.*location.*codes/i.test((r.name || "") + " " + (r.url || "")) && /zip/i.test((r.format || "") + r.url));
        const ver = r => { const m = ((r.name || "") + " " + r.url).match(/(\d+)[.-](\d+)/); return m ? +m[1] * 100 + +m[2] : 0; };
        rs.sort((a, b) => ver(b) - ver(a)); if (rs[0] && rs[0].url) url = rs[0].url;
      } catch (e) { log("Baustellen: Katalog nicht lesbar, nehme bekannte TMC-Ausgabe:", e.message); }
      const r = await fetch(url, { signal: AbortSignal.timeout(120e3), redirect: "follow" }); if (!r.ok) throw new Error("TMC-Tabelle HTTP " + r.status);
      const p = tmcAufbereiten(unzip(Buffer.from(await r.arrayBuffer()))); const n = Object.keys(p).length; if (n < 1000) throw new Error("TMC-Tabelle: nur " + n + " Punkte");
      S.tmc = p; S.tmcZeit = Date.now(); S.tmcQuelle = url.split("/").pop(); S.tmcFehler = null;
      fs.writeFileSync(DT + ".tmp", JSON.stringify({ zeit: S.tmcZeit, quelle: S.tmcQuelle, p })); fs.renameSync(DT + ".tmp", DT); log("Baustellen: TMC-Tabelle", n, "Punkte,", S.tmcQuelle);
    } catch (e) { S.tmcFehler = e.message; log("Baustellen:", e.message); }
  }
  function ausgabe() {
    const jetzt = Date.now(), akt = S.liste.filter(b => gueltigJetzt(b, jetzt)).map(({ perioden, ...b }) => b);
    gz = zlib.gzipSync(JSON.stringify({ zeit: S.zeit, jetzt, b: akt })); S.groesse = akt.length;
  }
  async function runde() {
    if (S.laeuft || Date.now() < S.pauseBis) return; S.laeuft = true;
    try {
      await tmcLaden(); if (!S.tmc) throw new Error("TMC-Tabelle fehlt (" + (S.tmcFehler || "noch nicht geladen") + ")");
      const k = key(); if (!k) throw new Error("kein Schlüssel");
      const r = await fetch(URL_SIT, { method: "POST", headers: { Authorization: "Bearer " + k, "Content-Type": "text/xml; charset=utf-8", SOAPAction: AKTION, "Accept-Encoding": "gzip" }, body: KOERPER(), signal: AbortSignal.timeout(90e3) });
      S.abfragen++; S.http = r.status; const t = await r.text();
      if (r.status === 401 || r.status === 403) { S.pauseBis = Date.now() + 3600e3; throw new Error(`HTTP ${r.status}: Schlüssel nicht für «Traffic Situations» freigeschaltet (api-manager.opentransportdata.swiss)`); }
      if (r.status === 429) { S.pauseBis = Date.now() + 15 * 60e3; throw new Error("HTTP 429: zu viele Abfragen"); }
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${t.slice(0, 200).replace(/\s+/g, " ")}`);
      const typen = {}; S.liste = auswerten(t, S.tmc, typen); S.typen = typen; S.zeit = Date.now(); S.fehler = null;
      fs.writeFileSync(DB + ".tmp", JSON.stringify({ zeit: S.zeit, liste: S.liste })); fs.renameSync(DB + ".tmp", DB);
    } catch (e) { if (S.fehler !== e.message) log("Baustellen:", e.message); S.fehler = e.message; }
    ausgabe(); S.laeuft = false;
  }
  ausgabe();
  setTimeout(() => { runde(); setInterval(runde, 10 * 60e3); setInterval(ausgabe, 60e3); }, +(process.env.ZK_BAUSTELLEN_START_MS || 45000));
  return {
    gz: () => gz,
    status: () => ({ baustellenJetzt: S.groesse, baustellenGesamt: S.liste.length, stand: S.zeit ? new Date(S.zeit).toISOString() : null, typen: S.typen, tmcPunkte: S.tmc ? Object.keys(S.tmc).length : 0, tmcQuelle: S.tmcQuelle, tmcFehler: S.tmcFehler, fehler: S.fehler, http: S.http, abfragen: S.abfragen, pauseBis: S.pauseBis > Date.now() ? new Date(S.pauseBis).toISOString() : null }),
  };
}
module.exports = { start, auswerten, tmcAufbereiten, unzip, kette, gueltigJetzt };
