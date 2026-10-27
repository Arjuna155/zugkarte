// ZugKarte – Webserver für die öffentliche Website (läuft auf dem NAS im Docker-Container).
// Liefert die Karte aus und stellt die Echtzeitdaten (SIRI-ET von opentransportdata.swiss) bereit.
// Ohne Abhängigkeiten, Node 20+.
"use strict";
const http = require("http"), fs = require("fs"), path = require("path"), zlib = require("zlib"), crypto = require("crypto");

const VERSION = process.env.ZK_VERSION || "dev";
const PORT = +process.env.PORT || 8080;
// API-Schlüssel: aus der Datei «schluessel.txt» im Datenordner (bevorzugt, wird bei jeder Abfrage neu gelesen,
// also ohne Neustart änderbar) oder aus der Umgebungsvariable OTD_API_KEY.
// Gesäubert werden Leerzeichen, Zeilenumbrüche, Anführungszeichen und ein versehentliches «Bearer ».
const DATA_DIR = process.env.ZK_DATA || "/data";
const KEY_FILE = path.join(DATA_DIR, "schluessel.txt");
const clean = k => (k || "").trim().replace(/^["']+|["']+$/g, "").replace(/^Bearer\s+/i, "").trim();
const isPlaceholder = k => /^HIER_/i.test(k);
// Leere Schlüsseldateien anlegen und für alle beschreibbar machen, damit sie sich mit der Dateien-App des NAS
// bearbeiten lassen: schluessel.txt (opentransportdata) und tailscale-key.txt (liest der Tailscale-Container).
for (const f of [KEY_FILE, path.join(DATA_DIR, "tailscale-key.txt")]) {
  try { if (fs.existsSync(DATA_DIR) && !fs.existsSync(f)) fs.writeFileSync(f, ""); fs.chmodSync(f, 0o666); } catch {}
}
// Funnel-Einstellung für den Tailscale-Container (liest data/tailscale-serve.json und beobachtet Änderungen).
// ${TS_CERT_DOMAIN} ersetzt Tailscale selbst durch die eigene Adresse (z. B. zugkarte.<tailnet>.ts.net).
const SERVE_FILE = path.join(DATA_DIR, "tailscale-serve.json");
// Ab Konfiguration 4 teilt Tailscale das Netzwerk mit diesem Container (network_mode: service:zugkarte),
// dann ist die Karte über 127.0.0.1 erreichbar. Der Name «zugkarte» lässt sich im Userspace-Modus nicht auflösen (502).
const SERVE_TARGET = (Number(process.env.ZK_COMPOSE) >= 4 ? "http://127.0.0.1:" : "http://zugkarte:") + PORT;
const SERVE = JSON.stringify({
  TCP: { "443": { HTTPS: true } },
  Web: { "${TS_CERT_DOMAIN}:443": { Handlers: { "/": { Proxy: SERVE_TARGET } } } },
  AllowFunnel: { "${TS_CERT_DOMAIN}:443": true }
}, null, 2) + "\n";
try { if (fs.existsSync(DATA_DIR) && (!fs.existsSync(SERVE_FILE) || fs.readFileSync(SERVE_FILE, "utf8") !== SERVE)) { fs.writeFileSync(SERVE_FILE, SERVE); fs.chmodSync(SERVE_FILE, 0o644); } } catch {}
let KEY = "", KEY_RAW = "", KEY_SRC = "";
function loadKey() {
  let fileRaw = ""; try { fileRaw = fs.readFileSync(KEY_FILE, "utf8"); } catch {}
  const envRaw = process.env.OTD_API_KEY || "";
  const fromFile = clean(fileRaw.split(/\r?\n/).find(l => l.trim() && !l.trim().startsWith("#")) || "");
  if (fromFile && !isPlaceholder(fromFile)) { KEY = fromFile; KEY_RAW = fromFile; KEY_SRC = "Datei schluessel.txt"; }
  else { KEY = clean(envRaw); KEY_RAW = envRaw; KEY_SRC = "Umgebungsvariable OTD_API_KEY"; }
  return KEY;
}
loadKey();
function keyInfo() {
  if (!KEY || isPlaceholder(KEY)) return "fehlt – trage ihn in die Datei data/schluessel.txt im Projektordner ein" + (KEY ? " (in OTD_API_KEY steht noch der Platzhalter)" : "");
  const notes = [];
  if (KEY !== KEY_RAW.trim()) notes.push("Anführungszeichen entfernt");
  if (/\s/.test(KEY)) notes.push("enthält Leerzeichen in der Mitte");
  if (/^tskey-/.test(KEY)) notes.push("das ist ein Tailscale-Key, nicht der opentransportdata-Schlüssel");
  return "aus " + KEY_SRC + ", " + KEY.length + " Zeichen, endet auf …" + KEY.slice(-4) + (notes.length ? " (" + notes.join(", ") + ")" : "");
}
const URL_ET = process.env.OTD_SIRI_ET_URL || "https://api.opentransportdata.swiss/la/siri-et";
const MIN_INTERVAL_MS = 60000;               // höchstens 1 Abfrage pro Minute (Limit 2/min, 3000/Tag)
const UICS = new Set(JSON.parse(fs.readFileSync(path.join(__dirname, "uics.json"), "utf8")));
const log = (...a) => console.log(new Date().toLocaleString("de-CH", { timeZone: "Europe/Zurich" }), ...a);

// ---- Kartenseite vorbereiten (einmal beim Start, gzip vorberechnet) ----
let RELIEF = null; try { RELIEF = fs.readFileSync(path.join(__dirname, "public", "relief.jpg")); } catch {}
function seite(datei) {
  const raw = fs.readFileSync(path.join(__dirname, "public", datei), "utf8")
    .replace("<script>", "<script>window.ZK_LOCAL=" + JSON.stringify({ mode: "server", version: VERSION }) + ";</script><script>");
  return { raw: Buffer.from(raw), gz: zlib.gzipSync(raw, { level: 9 }), etag: '"' + crypto.createHash("sha1").update(raw).digest("hex").slice(0, 16) + '"' };
}
const PAGE = seite("index.html");
// CSP der 3D-Karte – gilt auch für den Web-Worker (lädt die Kacheln selbst)
const CSP3D = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob: https://*.geo.admin.ch https://tiles.mapterhorn.com; connect-src 'self' https://*.geo.admin.ch https://tiles.mapterhorn.com; worker-src 'self' blob:; child-src 'self' blob:; frame-ancestors 'self'";
let PAGE3D = null; try { PAGE3D = seite("3d.html"); } catch {}   // 3D-Karte (Prototyp, MapLibre)
// Bibliotheken der 3D-Karte (MapLibre GL, selbst ausgeliefert)
const LIB = {}; try { for (const f of fs.readdirSync(path.join(__dirname, "public", "lib"))) { const b = fs.readFileSync(path.join(__dirname, "public", "lib", f)); LIB[f] = { raw: b, gz: zlib.gzipSync(b, { level: 9 }) }; } } catch {}

// ---- Echtzeit (SIRI-ET) ----
let cache = null, cacheGz = null, inflight = null, lastErr = null, lastAttempt = 0;
function uicOf(ref) { if (!ref) return null; ref = ref.trim(); let m = ref.match(/sloid:(\d+)/i); if (m) return "85" + m[1].padStart(5, "0"); m = ref.match(/(85\d{5})/); return m ? m[1] : null; }
const tag = (s, name) => { const m = s.match(new RegExp("<(?:\\w+:)?" + name + "(?:\\s[^>]*)?>([^<]*)<")); return m ? m[1].trim() : null; };
const epochMin = iso => { const t = Date.parse(iso); return isNaN(t) ? null : t / 60000; };
function parseJourney(block, win, out, stats) {
  stats.journeys++;
  const callRe = /<(?:\w+:)?(RecordedCall|EstimatedCall)\b[^>]*>([\s\S]*?)<\/(?:\w+:)?\1>/g;
  const calls = []; let m, inWin = false;
  while ((m = callRe.exec(block))) {
    const c = m[2]; const uic = uicOf(tag(c, "StopPointRef")); if (!uic || !UICS.has(uic)) continue;
    const aA = epochMin(tag(c, "AimedArrivalTime")), aD = epochMin(tag(c, "AimedDepartureTime"));
    const eA = epochMin(tag(c, "ExpectedArrivalTime") || tag(c, "ActualArrivalTime"));
    const eD = epochMin(tag(c, "ExpectedDepartureTime") || tag(c, "ActualDepartureTime"));
    const canc = /<(?:\w+:)?Cancellation>\s*true/i.test(c) ? 1 : 0;
    const ref = aD ?? aA; if (ref != null && ref > win[0] && ref < win[1]) inWin = true;
    calls.push([uic, aA == null ? null : Math.round(aA), aA == null || eA == null ? null : Math.round((eA - aA) * 60),
      aD == null ? null : Math.round(aD), aD == null || eD == null ? null : Math.round((eD - aD) * 60), canc]);
  }
  if (!calls.length || !inWin) return;
  const head = block.replace(callRe, "");
  out.push([tag(head, "TrainNumberRef") || tag(head, "VehicleJourneyName") || "", tag(head, "PublishedLineName") || "",
    tag(head, "OperatorRef") || "", /<(?:\w+:)?Cancellation>\s*true/i.test(head) ? 1 : 0, calls]);
}
class KeyError extends Error {}
async function fetchFeed() {
  const prevKey = KEY; loadKey();
  if (KEY !== prevKey) log("API-Schlüssel geändert:", keyInfo());
  if (!KEY || isPlaceholder(KEY)) throw new KeyError("Kein API-Schlüssel: " + keyInfo() + ".");
  const t0 = Date.now(); lastAttempt = t0;
  const res = await fetch(URL_ET, { headers: { Authorization: "Bearer " + KEY, "User-Agent": "ZugKarte/" + VERSION, "Accept-Encoding": "gzip, deflate, br" }, redirect: "follow", signal: AbortSignal.timeout(120000) });
  if (res.status === 401 || res.status === 403) {
    const body = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
    throw new KeyError("Der API-Schlüssel wurde abgelehnt (HTTP " + res.status + "). Schlüssel: " + keyInfo() + ". Antwort: " + (body || "leer"));
  }
  if (res.status === 429) throw new Error("Abfragelimit von opentransportdata.swiss erreicht.");
  if (!res.ok) throw new Error("opentransportdata.swiss antwortet mit HTTP " + res.status + ".");
  const nowMin = Date.now() / 60000, win = [nowMin - 120, nowMin + 240];
  const out = [], stats = { journeys: 0, bytes: 0 }; const dec = new TextDecoder(); let buf = "";
  const endRe = /<\/(?:\w+:)?EstimatedVehicleJourney>/g, startRe = /<(?:\w+:)?EstimatedVehicleJourney\b/g;
  const flush = final => { let last = 0, m; endRe.lastIndex = 0;
    while ((m = endRe.exec(buf))) { const piece = buf.slice(last, m.index); let s = -1, k; startRe.lastIndex = 0; while ((k = startRe.exec(piece))) s = k.index;
      if (s >= 0) parseJourney(piece.slice(s), win, out, stats); last = m.index + m[0].length; }
    buf = final ? "" : buf.slice(last); };
  for await (const chunk of res.body) { stats.bytes += chunk.length; buf += dec.decode(chunk, { stream: true }); if (buf.length > 4e6) flush(false); }
  buf += dec.decode(); flush(true);
  log("Echtzeit:", out.length, "Züge im Netz,", Math.round(stats.bytes / 1e6), "MB,", Date.now() - t0, "ms");
  return { quelle: "SIRI-ET opentransportdata.swiss", abgerufen: Date.now(), mb: Math.round(stats.bytes / 1e5) / 10, fahrten: stats.journeys, z: out };
}
// Holt nur, wenn jemand die Karte offen hat (Abfrage kommt von der Seite), höchstens 1× pro Minute für alle Besucher zusammen.
async function getData() {
  if (cache && Date.now() - cache.abgerufen < MIN_INTERVAL_MS) return cache;
  if (inflight) return inflight;
  if (lastErr && Date.now() - lastAttempt < (lastErr instanceof KeyError ? 10000 : 30000)) throw lastErr;
  inflight = fetchFeed().then(r => { cache = r; cacheGz = zlib.gzipSync(JSON.stringify(r)); lastErr = null; return r; })
    .catch(e => { lastErr = e; log("Fehler Echtzeit:", e.message); throw e; }).finally(() => { inflight = null; });
  return inflight;
}


// ---- Fahrplan nach Datum (GTFS, app/fahrplan.js) ----
const FP = require("./fahrplan.js").start({ DATA_DIR, log });
// Zugzusammensetzungen (Wagen, Typen, Längen) – lädt im Hintergrund, siehe formation.js
const FO = require("./formation.js").start({ DATA_DIR, log, fahrplan: FP, key: () => { loadKey(); return KEY && !isPlaceholder(KEY) ? KEY : ""; } });

// ---- Sperrungen (Bahnersatz) ----
// Bevorzugt aus dem GTFS-Tagesfahrplan (enthält geplante Sperrungen, braucht keine Abfragen);
// gibt es den nicht, wie bisher über die Abfahrtstafeln von transport.opendata.ch.
// Einmal pro Tag (ab 03:30 Schweizer Zeit) die Abfahrten ausgewählter Bahnhöfe des Tages bei transport.opendata.ch holen
// (mit Halteliste) und daraus bestimmen, welche Streckenteile heute befahren werden. Teile, die laut Fahrplan Verkehr
// haben, heute aber von keiner Fahrt benutzt werden, gelten als gesperrt. Grundlage: sperren.json (tools/sperren_daten.py).
const SPERR_FILE = path.join(DATA_DIR, "sperrungen.json");
let SP = null; try { SP = JSON.parse(fs.readFileSync(path.join(__dirname, "sperren.json"), "utf8")); } catch (e) { log("sperren.json fehlt:", e.message); }
const ohne = new Set((SP && SP.ohne) || []);   // Abschnitte ohne Linienverkehr (Museumsbahnen)
let sperr = null; try { sperr = JSON.parse(fs.readFileSync(SPERR_FILE, "utf8")); } catch {}
let sperrLaeuft = false;
const zhParts = () => { const p = {}; new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zurich", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(new Date()).forEach(x => p[x.type] = x.value); return p; };
const BUS = /^(B|BUS|NFB|NFO|KB|EXB|BAT|FAE|GB|PB|SL|FUN|BN|NB|EV|EXT)$/;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let sperrBuf = null;
function sperrAusGtfs() {
  if (!SP) return false;
  const p = zhParts(), datum = `${p.year}-${p.month}-${p.day}`, typ = p.weekday === "Sat" ? "sa" : p.weekday === "Sun" ? "su" : "wd";
  const buf = FP.get(datum); if (!buf) return false;
  if (buf === sperrBuf && sperr && sperr.datum === datum) return true;   // schon ausgewertet
  let j; try { j = JSON.parse(zlib.gunzipSync(buf)); } catch { return false; }
  if (j.v !== FP.status().basis || !j.tt) return false;
  const gesehen = new Uint32Array(SP.teile.length), zeilen = j.tt.split("\n").slice(1);
  for (const l of zeilen) {
    const st = l.slice(l.indexOf("|") + 1).split(";").map(q => parseInt(q, 16));
    for (let i = 1; i < st.length; i++) { const a = st[i - 1], b = st[i]; const k = Math.min(a, b) + "-" + Math.max(a, b), w = SP.beine[k]; if (w) for (const t of w) gesehen[t]++;
      const dw = SP.direkt && SP.direkt[k]; if (dw) for (const t of dw) if (!w || !w.includes(t)) gesehen[t]++; }
  }
  const erw = SP.erwartet[typ], teile = [];
  SP.teile.forEach((t, i) => { const nie = !SP.erwartet.wd[i] && !SP.erwartet.sa[i] && !SP.erwartet.su[i];
    if (gesehen[i] === 0 && (erw[i] >= 3 || nie) && !ohne.has(i)) teile.push(t); });
  sperr = { datum, erstellt: Date.now(), teile, quelle: "gtfs", feed: j.feed }; sperrBuf = buf;
  try { fs.writeFileSync(SPERR_FILE, JSON.stringify(sperr)); } catch {}
  log("Sperrungen (GTFS " + j.feed + "):", teile.length, "gesperrte Streckenteile,", zeilen.length, "Zugläufe");
  return true;
}
async function sperrPruefen() {
  if (!SP || sperrLaeuft) return; sperrLaeuft = true;
  const p = zhParts(), datum = `${p.year}-${p.month}-${p.day}`, typ = p.weekday === "Sat" ? "sa" : p.weekday === "Sun" ? "su" : "wd";
  const t0 = Date.now(), gesehen = new Uint32Array(SP.teile.length); let fehler = 0, abfragen = 0;
  log("Sperrungen: prüfe", SP.abfrage.length, "Bahnhöfe für", datum);
  try {
    for (const [si, uic] of SP.abfrage) {
      let von = "00:00", seiten = 0, ok = false;
      while (seiten++ < 6) {
        let j = null;
        for (let k = 0; k < 3 && !j; k++) {
          try { abfragen++; const r = await fetch(`https://transport.opendata.ch/v1/stationboard?id=${uic}&datetime=${datum}%20${von}&limit=300`, { headers: { "User-Agent": "ZugKarte (privat, 1x taeglich)" }, signal: AbortSignal.timeout(30000) });
            if (r.ok) j = await r.json(); else await sleep(5000 * (k + 1)); } catch { await sleep(5000 * (k + 1)); }
        }
        if (!j) break; ok = true;
        const sb = j.stationboard || []; let last = null;
        for (const e of sb) {
          const dep = e.stop && e.stop.departure; if (!dep || dep.slice(0, 10) !== datum) continue; last = dep;
          if (BUS.test(e.category || "")) continue;
          const seq = [];
          (e.passList || []).forEach((q, i) => { const id = i === 0 ? uic : q.station && q.station.id; const st = SP.uic[id];
            if (st !== undefined && seq[seq.length - 1] !== st) seq.push(st); });
          if (seq[0] !== si) seq.unshift(si);
          for (let i = 1; i < seq.length; i++) { const a = seq[i - 1], b = seq[i]; const k = Math.min(a, b) + "-" + Math.max(a, b), w = SP.beine[k]; if (w) for (const t of w) gesehen[t]++;
      const dw = SP.direkt && SP.direkt[k]; if (dw) for (const t of dw) if (!w || !w.includes(t)) gesehen[t]++; }
        }
        if (sb.length < 300 || !last) break; von = last.slice(11, 16);
      }
      if (!ok) fehler++;
      await sleep(800);
    }
    if (fehler > SP.abfrage.length * 0.1) { log("Sperrungen: zu viele Fehler (" + fehler + "), Ergebnis verworfen"); return; }
    const erw = SP.erwartet[typ], teile = [];
    SP.teile.forEach((t, i) => { const nie = !SP.erwartet.wd[i] && !SP.erwartet.sa[i] && !SP.erwartet.su[i];
      if (gesehen[i] === 0 && (erw[i] >= 3 || nie) && !ohne.has(i)) teile.push(t); });   // «nie»: Strecke ohne Fahrplandaten (an den Stichtagen gesperrt)
    sperr = { datum, erstellt: Date.now(), teile, abfragen, fehler, quelle: "transport.opendata.ch" };
    fs.writeFileSync(SPERR_FILE, JSON.stringify(sperr));
    log("Sperrungen:", teile.length, "gesperrte Streckenteile,", abfragen, "Abfragen,", Math.round((Date.now() - t0) / 1000), "s");
  } catch (e) { log("Sperrungen: Fehler", e.message); }
  finally { sperrLaeuft = false; }
}
function sperrTick() { const p = zhParts(), datum = `${p.year}-${p.month}-${p.day}`, min = +p.hour * 60 + +p.minute;
  const heute = sperr && sperr.datum === datum;
  if (sperrAusGtfs()) return;                                   // GTFS-Tagesfahrplan vorhanden (auch neu erzeugt)
  if (!heute && min >= 270) sperrPruefen(); }                  // sonst ab 04:30 über die Abfahrtstafeln
setTimeout(sperrTick, 20000); setInterval(sperrTick, 5 * 60000).unref();

// ---- HTTP ----
const SEC = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "SAMEORIGIN",
  "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'" };
const gzOk = req => /\bgzip\b/.test(req.headers["accept-encoding"] || "");
function json(req, res, code, obj, gz) {
  const h = { ...SEC, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", Vary: "Accept-Encoding" };
  if (gz && gzOk(req)) { res.writeHead(code, { ...h, "Content-Encoding": "gzip" }); return res.end(gz); }
  res.writeHead(code, h); res.end(JSON.stringify(obj));
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, SEC); return res.end(); }
  if ((url.pathname === "/" && !PAGE3D) || url.pathname === "/index.html" || url.pathname === "/2d") {   // 2D-Karte (Rückfall)
    if (req.headers["if-none-match"] === PAGE.etag) { res.writeHead(304, { ...SEC, ETag: PAGE.etag }); return res.end(); }
    const h = { ...SEC, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", ETag: PAGE.etag, Vary: "Accept-Encoding" };
    if (gzOk(req)) { res.writeHead(200, { ...h, "Content-Encoding": "gzip" }); return res.end(req.method === "HEAD" ? undefined : PAGE.gz); }
    res.writeHead(200, h); return res.end(req.method === "HEAD" ? undefined : PAGE.raw);
  }
  if ((url.pathname === "/" || url.pathname === "/3d" || url.pathname === "/3d.html") && PAGE3D) {   // Hauptseite = 3D-Karte (seit 26.10.2026)
    // 3D-Karte: Kacheln von swisstopo (Grundkarte) und Mapterhorn (Gelände)
    const csp = CSP3D;
    if (req.headers["if-none-match"] === PAGE3D.etag) { res.writeHead(304, { ...SEC, "Content-Security-Policy": csp, ETag: PAGE3D.etag }); return res.end(); }
    const h = { ...SEC, "Content-Security-Policy": csp, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", ETag: PAGE3D.etag, Vary: "Accept-Encoding" };
    if (gzOk(req)) { res.writeHead(200, { ...h, "Content-Encoding": "gzip" }); return res.end(req.method === "HEAD" ? undefined : PAGE3D.gz); }
    res.writeHead(200, h); return res.end(req.method === "HEAD" ? undefined : PAGE3D.raw);
  }
  if (url.pathname.startsWith("/lib/") && LIB[url.pathname.slice(5)]) {
    const f = LIB[url.pathname.slice(5)], ct = url.pathname.endsWith(".css") ? "text/css; charset=utf-8" : url.pathname.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/plain; charset=utf-8";
    const h = { ...SEC, "Content-Security-Policy": CSP3D, "Content-Type": ct, "Cache-Control": "public, max-age=86400", Vary: "Accept-Encoding" };
    if (gzOk(req)) { res.writeHead(200, { ...h, "Content-Encoding": "gzip" }); return res.end(req.method === "HEAD" ? undefined : f.gz); }
    res.writeHead(200, h); return res.end(req.method === "HEAD" ? undefined : f.raw);
  }
  if (url.pathname === "/relief.jpg") {   // Reliefschattierung (swisstopo), lange cachebar
    if (!RELIEF) { res.writeHead(404, SEC); return res.end(); }
    res.writeHead(200, { ...SEC, "Content-Type": "image/jpeg", "Content-Length": RELIEF.length, "Cache-Control": "public, max-age=604800" }); return res.end(req.method === "HEAD" ? undefined : RELIEF);
  }
  if (url.pathname === "/api/ping") return json(req, res, 200, { app: "ZugKarte", version: VERSION });
  if (url.pathname === "/api/status") return json(req, res, 200, { version: VERSION, schluessel: !!KEY && !isPlaceholder(KEY), letzteAbfrage: cache ? cache.abgerufen : null, fehler: lastErr ? lastErr.message : null });
  if (url.pathname === "/api/sperrungen") { const p = zhParts(), d = `${p.year}-${p.month}-${p.day}`;
    return json(req, res, 200, sperr && sperr.datum === d ? { datum: sperr.datum, erstellt: sperr.erstellt, teile: sperr.teile } : { datum: null, teile: [] }); }
  if (url.pathname === "/api/fahrplan") {
    const buf = FP.get(url.searchParams.get("d") || "");
    if (!buf) return json(req, res, 404, { fehler: "Für dieses Datum gibt es keinen aufbereiteten Fahrplan." });
    const etag = '"' + crypto.createHash("sha1").update(buf).digest("hex").slice(0, 16) + '"';   // neu erzeugte Fahrpläne sofort ausliefern
    if (req.headers["if-none-match"] === etag) { res.writeHead(304, { ...SEC, ETag: etag }); return res.end(); }
    const h = { ...SEC, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache", ETag: etag, Vary: "Accept-Encoding" };
    if (gzOk(req)) { res.writeHead(200, { ...h, "Content-Encoding": "gzip" }); return res.end(req.method === "HEAD" ? undefined : buf); }
    res.writeHead(200, h); return res.end(req.method === "HEAD" ? undefined : zlib.gunzipSync(buf));
  }
  if (url.pathname === "/api/fahrplan/status") return json(req, res, 200, FP.status());
  if (url.pathname === "/api/formation") {
    const d = url.searchParams.get("d") || "", w = url.searchParams.get("w");
    if (!/^\d{4}-\d\d-\d\d$/.test(d)) return json(req, res, 400, { fehler: "Datum fehlt" });
    if (w) { const [evu, nr] = w.split(":"); FO.wunsch(d, evu, nr || ""); }
    const gz = FO.fuer(d); return json(req, res, 200, gzOk(req) ? null : JSON.parse(zlib.gunzipSync(gz)), gz);
  }
  if (url.pathname === "/api/formation/status") return json(req, res, 200, FO.status());
  if (url.pathname === "/api/verspaetungen") {
    try { const d = await getData(); return json(req, res, 200, d, d === cache ? cacheGz : null); }
    catch (e) { return json(req, res, e instanceof KeyError ? 401 : 502, { fehler: e instanceof KeyError ? "Echtzeit ist auf diesem Server nicht eingerichtet." : e.message }); }
  }
  res.writeHead(404, { ...SEC, "Content-Type": "text/plain; charset=utf-8" }); res.end("Nicht gefunden.");
});
server.keepAliveTimeout = 65000;
server.listen(PORT, "0.0.0.0", () => log("ZugKarte", VERSION, "läuft auf Port", PORT, "| Konfiguration:", process.env.ZK_COMPOSE ? "Version " + process.env.ZK_COMPOSE : "alt (Version 1)", "| API-Schlüssel:", keyInfo()));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { server.close(); setTimeout(() => process.exit(0), 2000).unref(); });
