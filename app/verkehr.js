// Strassenverkehr: Verkehrszähler des ASTRA (und der Kantone) in Echtzeit über opentransportdata.swiss (DATEX II über SOAP).
// Gleicher Schlüssel wie die Echtzeit der Züge – der Schlüssel muss im API-Manager zusätzlich für «Traffic Counters»
// freigeschaltet sein (sonst 401/403, steht dann in /api/verkehr/status).
// – Messstellen (pullMeasurementSiteTable) einmal pro Tag: Kennung, Name, Lage.
// – Messwerte (pullMeasuredData) jede Minute: je Messstelle Fahrzeuge pro Stunde (alle Spuren und Klassen) und
//   mittlere Geschwindigkeit. Limit des Dienstes: 50 Abfragen/Min. pro Schlüssel.
"use strict";
const fs = require("fs"), path = require("path"), zlib = require("zlib");

const URL_ZAEHLER = process.env.OTD_VERKEHR_URL || "https://api.opentransportdata.swiss/TDP/Soap_Datex2/TrafficCounters/Pull";
const AKTION = "http://opentransportdata.swiss/TDP/Soap_Datex2/Pull/v1/";
const KOPF = `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><soapenv:Header/><soapenv:Body>`
  + `<d2LogicalModel xmlns="http://datex2.eu/schema/2/2_0" modelBaseVersion="2"><exchange><supplierIdentification><country>ch</country><nationalIdentifier>ZugKarte</nationalIdentifier></supplierIdentification></exchange>`;
const FUSS = `</d2LogicalModel></soapenv:Body></soapenv:Envelope>`;
const einfach = () => KOPF + FUSS;
// Filter auf bestimmte Messstellen (zwei Schreibweisen, je nachdem, was der Dienst annimmt)
const mitFilter = (ids, ext) => {
  const jetzt = new Date().toISOString().slice(0, 19), refs = ids.map(id => `<measurementSiteReference targetClass="MeasurementSiteRecord" id="${id}" version="0"/>`).join("");
  const f = `<measuredDataFilter><measurementSiteTableReference targetClass="MeasurementSiteTable" id="OTD:TrafficData" version="0"/>${refs}</measuredDataFilter>`;
  return KOPF + `<payloadPublication xsi:type="GenericPublication" lang="de"><publicationTime>${jetzt}</publicationTime><publicationCreator><country>ch</country><nationalIdentifier>ZugKarte</nationalIdentifier></publicationCreator>`
    + `<genericPublicationName>MeasuredDataFilter</genericPublicationName>${ext ? `<genericPublicationExtension>${f}</genericPublicationExtension>` : f}</payloadPublication>` + FUSS;
};
// kleine XML-Helfer (ohne Pakete; Namensraum-Präfixe werden übergangen)
const tag = n => new RegExp(`<(?:\\w+:)?${n}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${n}>`, "g");
const erstes = (s, n) => { const m = tag(n).exec(s); return m ? m[1] : null; };
const alle = (s, n) => { const r = tag(n), out = []; let m; while ((m = r.exec(s))) out.push(m[0]); return out; };
const attr = (s, a) => { const m = s.match(new RegExp(`\\b${a}="([^"]*)"`)); return m ? m[1] : null; };

function start({ DATA_DIR, log, key }) {
  const DATEI = path.join(DATA_DIR, "verkehr.json");
  const S = { stellen: {}, stellenZeit: 0, variante: null, letzte: null, fehler: null, http: null, pauseBis: 0, abfragen: 0, laeuft: false };
  let gz = null;
  async function soap(aktion, body) {
    const k = key(); if (!k) throw Object.assign(new Error("kein Schlüssel"), { ohneSchluessel: true });
    const r = await fetch(URL_ZAEHLER, { method: "POST", headers: { Authorization: "Bearer " + k, "Content-Type": "text/xml; charset=utf-8", SOAPAction: AKTION + aktion, "Accept-Encoding": "gzip" }, body, signal: AbortSignal.timeout(60000) });
    S.abfragen++; S.http = r.status; const t = await r.text();
    if (r.status === 401 || r.status === 403) { S.pauseBis = Date.now() + 3600e3; throw new Error(`HTTP ${r.status}: Schlüssel nicht für «Traffic Counters» freigeschaltet (api-manager.opentransportdata.swiss)`); }
    if (r.status === 429) { S.pauseBis = Date.now() + 5 * 60e3; throw new Error("HTTP 429: zu viele Abfragen"); }
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${t.slice(0, 200).replace(/\s+/g, " ")}`);
    return t;
  }
  // Messstellen: Kennung, Name, Lage (WGS84)
  async function stellen() {
    if (Date.now() - S.stellenZeit < 24 * 3600e3 && Object.keys(S.stellen).length) return;
    const x = await soap("pullMeasurementSiteTable", einfach()), neu = {};
    for (const rec of alle(x, "measurementSiteRecord")) {
      const id = attr(rec, "id"); if (!id) continue;
      const lat = parseFloat(erstes(rec, "latitude")), lon = parseFloat(erstes(rec, "longitude")); if (!isFinite(lat) || !isFinite(lon)) continue;
      const nameXml = erstes(rec, "measurementSiteName") || "", name = (erstes(nameXml, "value") || "").trim();
      const spuren = parseInt(erstes(rec, "measurementSiteNumberOfLanes")) || null;
      neu[id] = { id, lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5, name, spuren };
    }
    if (Object.keys(neu).length) { S.stellen = neu; S.stellenZeit = Date.now(); log("Verkehr:", Object.keys(neu).length, "Messstellen"); }
    else throw new Error("Messstellentabelle leer");
  }
  // Messwerte auswerten: je Messstelle Summe der Fahrzeuge/h (alle Spuren, Klassen) und mittlere Geschwindigkeit (nach Menge gewichtet)
  function werte(x, ziel) {
    let n = 0;
    for (const sm of alle(x, "siteMeasurements")) {
      const ref = sm.match(/<(?:\w+:)?measurementSiteReference\b[^>]*\bid="([^"]*)"/); if (!ref) continue;
      let fluss = 0, fz = 0, vSumme = 0, vGew = 0, schwer = 0;
      for (const mv of alle(sm, "basicData").length ? sm.split(/<(?:\w+:)?measuredValue\b[^>]*\bindex="/).slice(1) : []) {
        const idx = parseInt(mv), fl = parseFloat(erstes(mv, "vehicleFlowRate")), sp = parseFloat(erstes(mv, "speed"));
        if (isFinite(fl)) { fluss += fl; fz++; if (idx >= 11 && idx <= 19) schwer += fl; }
        if (isFinite(sp) && sp > 0) { const g = isFinite(fl) && fl > 0 ? fl : 1; vSumme += sp * g; vGew += g; }
      }
      if (!fz && !vGew) continue;
      ziel[ref[1]] = { q: Math.round(fluss), v: vGew ? Math.round(vSumme / vGew) : null, lkw: fluss ? Math.round(schwer / fluss * 100) / 100 : 0, t: erstes(sm, "measurementTimeDefault") };
      n++;
    }
    return n;
  }
  async function runde() {
    if (S.laeuft || Date.now() < S.pauseBis) return; S.laeuft = true; const t0 = Date.now();
    try {
      await stellen();
      const ids = Object.keys(S.stellen), w = {};
      // zuerst ohne Filter (liefert der Dienst dann alles?), sonst mit Filter in Paketen zu 250
      if (S.variante !== "filter" && S.variante !== "filterExt") { const x = await soap("pullMeasuredData", einfach()); if (werte(x, w) > 0) S.variante = "alles"; }
      if (!Object.keys(w).length) {
        for (const ext of S.variante === "filterExt" ? [true] : S.variante === "filter" ? [false] : [false, true]) {
          for (let i = 0; i < ids.length; i += 250) { const x = await soap("pullMeasuredData", mitFilter(ids.slice(i, i + 250), ext)); werte(x, w); if (i === 0 && !Object.keys(w).length) break; }
          if (Object.keys(w).length) { S.variante = ext ? "filterExt" : "filter"; break; }
        }
      }
      const aus = []; for (const [id, m] of Object.entries(w)) { const s = S.stellen[id]; if (s) aus.push([id, s.lat, s.lon, m.q, m.v, m.lkw, s.spuren]); }
      if (aus.length) { const raw = JSON.stringify({ zeit: Date.now(), felder: ["id", "lat", "lon", "q", "v", "lkw", "spuren"], stellen: aus }); fs.writeFileSync(DATEI + ".tmp", raw); fs.renameSync(DATEI + ".tmp", DATEI); gz = zlib.gzipSync(raw); }
      S.letzte = { zeit: Date.now(), stellen: aus.length, dauer: Math.round((Date.now() - t0) / 1000) }; S.fehler = aus.length ? null : "keine Messwerte erhalten";
    } catch (e) { if (!e.ohneSchluessel || S.fehler !== e.message) log("Verkehr:", e.message); S.fehler = e.message; }
    S.laeuft = false;
  }
  try { gz = zlib.gzipSync(fs.readFileSync(DATEI)); } catch { }
  setTimeout(() => { runde(); setInterval(runde, 60e3); }, +(process.env.ZK_VERKEHR_START_MS || 30000));
  return {
    gz: () => gz,
    status: () => ({ messstellen: Object.keys(S.stellen).length, variante: S.variante, letzte: S.letzte, fehler: S.fehler, http: S.http, abfragen: S.abfragen, pauseBis: S.pauseBis > Date.now() ? new Date(S.pauseBis).toISOString() : null }),
  };
}
module.exports = { start };
