// ZugKarte – echte Zugzusammensetzungen (Train Formation Service von opentransportdata.swiss).
// Pro Zug: jeder Wagen mit Fahrzeugtyp (z. B. «RABe511»), Länge und Klasse. Die API erlaubt nur wenige Abfragen
// pro Minute und eine Zugnummer pro Abfrage – deshalb lädt der Server im Hintergrund nach (zuerst die Züge, die
// bald fahren) und merkt sich pro Zugnummer die zuletzt gesehene Zusammensetzung («typisch.json»). Damit hat die
// Karte nach ein paar Tagen für fast jeden Zug eine passende Zusammensetzung, auch wenn die heutige noch fehlt.
"use strict";
const fs = require("fs"), path = require("path"), zlib = require("zlib");

const URL_FO = process.env.OTD_FORMATION_URL || "https://api.opentransportdata.swiss/formation/v2/formations_vehicle_based";
// GTFS-Verwaltung (agency_id) → EVU-Code der Formation-API
const EVU = { "11": "SBBP", "33": "BLSP", "65": "THURBO", "72": "RhB", "82": "SOB", "86": "ZB", "29": "MBC", "53": "TPF", "44": "TRN", "73": "TRN", "81____": "OeBB" };
const PRO_MIN = +process.env.ZK_FORMATION_PRO_MIN || 40;   // Abfragen pro Minute (Limit der API ~50)

function start({ DATA_DIR, log, key, fahrplan }) {
  const DIR = path.join(DATA_DIR, "formation");
  try { fs.mkdirSync(DIR, { recursive: true }); } catch {}
  const TYP_FILE = path.join(DIR, "typisch.json");
  let typisch = {}; try { typisch = JSON.parse(fs.readFileSync(TYP_FILE, "utf8")); } catch {}
  const tage = {};   // datum → {z: {"evu:nr": [zeit, kompakt|""]}}
  const tagDatei = d => path.join(DIR, d + ".json");
  const tag = d => tage[d] || (tage[d] = (() => { try { return JSON.parse(fs.readFileSync(tagDatei(d), "utf8")); } catch { return { z: {} }; } })());
  let schmutzig = new Set(), typSchmutzig = false;
  const st = { abfragen: 0, mitDaten: 0, ohneDaten: 0, fehler: 0, letzterFehler: null, pauseBis: 0, letzte: null, warteschlange: 0 };
  const vorne = [];   // von der Karte gewünscht (Zug ausgewählt) – kommt zuerst dran
  let plan = [], planZeit = 0;

  // Test: ZK_FP_HEUTE=JJJJ-MM-TT verschiebt «heute» (wie in fahrplan.js)
  let versatz = 0;
  const zh = ms => { ms += versatz; const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zurich", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(ms).map(x => [x.type, x.value]));
    return { d: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute }; };
  if (process.env.ZK_FP_HEUTE) versatz = Math.round((Date.parse(process.env.ZK_FP_HEUTE) - Date.parse(zh(Date.now()).d)) / 86400000) * 86400000;

  // Antwort → kompakte Zeichenkette: Wagen in Reihenfolge, je «Typ,Länge,Klasse,Einheit[,von,bis]», getrennt durch «;»
  // Klasse: 1, 2, 12, WR (Speisewagen), X (ohne Sitzplätze: Lok, Gepäck). von/bis (UIC) nur, wenn der Wagen
  // nicht den ganzen Lauf mitfährt (Flügelzüge, Verstärkung).
  function kompakt(j) {
    const fo = (j && j.formations) || []; const wagen = [];
    for (const F of fo) for (const v of F.formationVehicles || []) wagen.push(v);
    if (!wagen.length) return "";
    wagen.sort((a, b) => (a.position || 0) - (b.position || 0));
    const von = v => v.vehicleProperties && v.vehicleProperties.fromStop ? v.vehicleProperties.fromStop.uic : null;
    const bis = v => v.vehicleProperties && v.vehicleProperties.toStop ? v.vehicleProperties.toStop.uic : null;
    const zaehl = new Map(); for (const v of wagen) for (const u of [von(v), bis(v)]) if (u) zaehl.set(u, (zaehl.get(u) || 0) + 1);
    const haeufig = [...zaehl.entries()].sort((a, b) => b[1] - a[1]); const ganz = new Set(haeufig.slice(0, 2).map(x => x[0]));
    // Einheit (Triebzug, Lok, einzelner Wagen): Wagen mit gleicher parentEvn gehören zusammen → Nummer g
    let g = -1, letzte = null;
    return wagen.map(v => {
      const id = v.vehicleIdentifier || {}, p = v.vehicleProperties || {};
      const einheit = id.parentEvn || id.evn || ("?" + v.position);
      if (einheit !== letzte) { g++; letzte = einheit; }
      const typ = String(id.typeCodeName || id.typeCode || "?").replace(/[,;|]/g, " ").trim();
      const len = p.length ? Math.round(p.length * 10) / 10 : "";
      const k = p.numberRestaurantSpace > 0 && !(p.number1class || p.number2class) ? "WR" : p.number1class > 0 && p.number2class > 0 ? "12" : p.number1class > 0 ? "1" : p.number2class > 0 ? "2" : p.numberRestaurantSpace > 0 ? "WR" : "X";
      const a = von(v), b = bis(v), teil = (a && !ganz.has(a)) || (b && !ganz.has(b));
      return [typ, len, k, g].concat(teil ? [a || "", b || ""] : []).join(",");
    }).join(";");
  }

  async function abfragen(d, evu, nr) {
    const k = key(); if (!k) throw Object.assign(new Error("Kein API-Schlüssel"), { kein: true });
    const u = `${URL_FO}?evu=${encodeURIComponent(evu)}&operationDate=${d}&trainNumber=${encodeURIComponent(nr)}`;
    const r = await fetch(u, { headers: { Authorization: "Bearer " + k, "User-Agent": "ZugKarte", Accept: "application/json" }, signal: AbortSignal.timeout(30000) });
    st.abfragen++;
    if (r.status === 429) { const e = new Error("Zu viele Abfragen (429)"); e.pause = 10 * 60000; throw e; }
    if (r.status === 401 || r.status === 403) { const e = new Error("Schlüssel nicht für den Formation-Dienst freigeschaltet (" + r.status + ")"); e.pause = 60 * 60000; throw e; }
    if (r.status === 404 || r.status === 204) return "";
    if (!r.ok) { const e = new Error("HTTP " + r.status); e.pause = 60000; throw e; }
    const t = await r.text(); if (!t.trim()) return "";
    return kompakt(JSON.parse(t));
  }

  // Züge eines Tages aus dem aufbereiteten Fahrplan: [{evu, nr, ab}] (Zeilen «Kat,Linie,Ziel,Zugnr,Verwaltung|…»)
  function zuegeVon(d) {
    const buf = fahrplan.get(d); if (!buf) return [];
    let j; try { j = JSON.parse(zlib.gunzipSync(buf)); } catch { return []; }
    const m = new Map();
    for (const l of j.tt.split("\n").slice(1)) {
      const bar = l.indexOf("|"), h = l.slice(0, bar).split(","); if (h.length < 5) continue;
      const evu = EVU[h[4]]; if (!evu) continue;
      const t = l.slice(bar + 1).split(";", 1)[0].replace(/@.*/, "").split(","), ab = +t[1];
      const id = evu + ":" + h[3]; if (!m.has(id) || m.get(id).ab > ab) m.set(id, { evu, nr: h[3], ab });
    }
    return [...m.values()];
  }

  // Reihenfolge: zuerst Züge der nächsten 3 Stunden, dann der Rest von heute, dann morgen
  function planen() {
    const jetzt = zh(Date.now()), morgen = zh(Date.now() + 86400000).d, liste = [];
    for (const [d, offs] of [[jetzt.d, 0], [morgen, 1440]]) {
      const T = tag(d);
      for (const z of zuegeVon(d)) {
        const e = T.z[z.evu + ":" + z.nr];
        if (e && (e[1] || Date.now() - e[0] < 6 * 3600000)) continue;   // schon da (oder vor Kurzem ohne Daten)
        const ab = z.ab + offs - jetzt.min; if (ab < -120) continue;
        liste.push({ d, evu: z.evu, nr: z.nr, prio: ab < 180 ? ab : 10000 + ab });
      }
    }
    liste.sort((a, b) => a.prio - b.prio); plan = liste; planZeit = Date.now();
  }

  async function schritt() {
    if (Date.now() < st.pauseBis) return;
    if (!key()) return;
    if (!plan.length && !vorne.length || Date.now() - planZeit > 15 * 60000) planen();
    const job = vorne.shift() || plan.shift(); st.warteschlange = plan.length + vorne.length;
    if (!job) return;
    try {
      const f = await abfragen(job.d, job.evu, job.nr);
      tag(job.d).z[job.evu + ":" + job.nr] = [Date.now(), f]; schmutzig.add(job.d);
      if (f) { st.mitDaten++; typisch[job.evu + ":" + job.nr] = f; typSchmutzig = true; } else st.ohneDaten++;
      st.letzte = Date.now();
    } catch (e) {
      st.fehler++; st.letzterFehler = e.message; if (e.pause) { st.pauseBis = Date.now() + e.pause; log("Formation:", e.message, "– Pause", Math.round(e.pause / 60000), "Min."); }
      if (!e.kein && !e.pause) plan.push(job);
    }
  }

  function speichern() {
    for (const d of schmutzig) try { fs.writeFileSync(tagDatei(d), JSON.stringify(tage[d])); } catch {}
    schmutzig.clear();
    if (typSchmutzig) { try { fs.writeFileSync(TYP_FILE + ".tmp", JSON.stringify(typisch)); fs.renameSync(TYP_FILE + ".tmp", TYP_FILE); } catch {} typSchmutzig = false; }
    // alte Tagesdateien löschen (älter als 3 Tage)
    const grenze = zh(Date.now() - 3 * 86400000).d;
    try { for (const f of fs.readdirSync(DIR)) if (/^\d{4}-\d\d-\d\d\.json$/.test(f) && f.slice(0, 10) < grenze) { fs.unlinkSync(path.join(DIR, f)); delete tage[f.slice(0, 10)]; } } catch {}
  }

  setInterval(schritt, Math.ceil(60000 / PRO_MIN)).unref();
  setInterval(speichern, 60000).unref();

  // Für die Karte: alle Zusammensetzungen eines Tages (heutige, sonst die zuletzt gesehene für diese Zugnummer).
  // {f: [kompakt, …], z: {"Verwaltung:Zugnr": [Index, echt(1)/typisch(0)]}} – gleiche Zusammensetzungen nur einmal.
  const ausgabeCache = new Map();
  function fuer(d) {
    const c = ausgabeCache.get(d); if (c && Date.now() - c.t < 60000) return c.gz;
    const T = tag(d), f = [], idx = new Map(), z = {};
    const agVon = {}; for (const [a, e] of Object.entries(EVU)) if (!agVon[e]) agVon[e] = a;
    const neu = s => { let i = idx.get(s); if (i === undefined) { idx.set(s, i = f.length); f.push(s); } return i; };
    for (const zg of zuegeVon(d)) {
      const id = zg.evu + ":" + zg.nr, e = T.z[id], ty = typisch[id];
      if (e && e[1]) z[id] = [neu(e[1]), 1]; else if (ty) z[id] = [neu(ty), 0];
    }
    const gz = zlib.gzipSync(JSON.stringify({ d, evu: EVU, f, z }));
    ausgabeCache.set(d, { t: Date.now(), gz }); if (ausgabeCache.size > 4) ausgabeCache.delete(ausgabeCache.keys().next().value);
    return gz;
  }
  // Zug ausgewählt: vorziehen, falls heute noch nicht abgefragt
  function wunsch(d, evu, nr) {
    if (!/^\d{4}-\d\d-\d\d$/.test(d) || !/^\d{1,6}$/.test(nr) || !Object.values(EVU).includes(evu)) return;
    const e = tag(d).z[evu + ":" + nr]; if (e && (e[1] || Date.now() - e[0] < 3600000)) return;
    if (vorne.length < 50 && !vorne.some(j => j.d === d && j.evu === evu && j.nr === nr)) vorne.push({ d, evu, nr });
  }
  function status() {
    const d = zh(Date.now()).d, T = tag(d); let mit = 0, ohne = 0; for (const e of Object.values(T.z)) e[1] ? mit++ : ohne++;
    return { ...st, heute: { mitDaten: mit, ohneDaten: ohne }, typisch: Object.keys(typisch).length, proMinute: PRO_MIN };
  }
  return { fuer, wunsch, status, kompakt };
}
module.exports = { start, EVU };
