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
const RAW = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8")
  .replace("<script>", "<script>window.ZK_LOCAL=" + JSON.stringify({ mode: "server", version: VERSION }) + ";</script><script>");
const PAGE = { raw: Buffer.from(RAW), gz: zlib.gzipSync(RAW, { level: 9 }), etag: '"' + crypto.createHash("sha1").update(RAW).digest("hex").slice(0, 16) + '"' };

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
  if (url.pathname === "/" || url.pathname === "/index.html") {
    if (req.headers["if-none-match"] === PAGE.etag) { res.writeHead(304, { ...SEC, ETag: PAGE.etag }); return res.end(); }
    const h = { ...SEC, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", ETag: PAGE.etag, Vary: "Accept-Encoding" };
    if (gzOk(req)) { res.writeHead(200, { ...h, "Content-Encoding": "gzip" }); return res.end(req.method === "HEAD" ? undefined : PAGE.gz); }
    res.writeHead(200, h); return res.end(req.method === "HEAD" ? undefined : PAGE.raw);
  }
  if (url.pathname === "/api/ping") return json(req, res, 200, { app: "ZugKarte", version: VERSION });
  if (url.pathname === "/api/status") return json(req, res, 200, { version: VERSION, schluessel: !!KEY && !isPlaceholder(KEY), letzteAbfrage: cache ? cache.abgerufen : null, fehler: lastErr ? lastErr.message : null });
  if (url.pathname === "/api/verspaetungen") {
    try { const d = await getData(); return json(req, res, 200, d, d === cache ? cacheGz : null); }
    catch (e) { return json(req, res, e instanceof KeyError ? 401 : 502, { fehler: e instanceof KeyError ? "Echtzeit ist auf diesem Server nicht eingerichtet." : e.message }); }
  }
  res.writeHead(404, { ...SEC, "Content-Type": "text/plain; charset=utf-8" }); res.end("Nicht gefunden.");
});
server.keepAliveTimeout = 65000;
server.listen(PORT, "0.0.0.0", () => log("ZugKarte", VERSION, "läuft auf Port", PORT, "| Konfiguration:", process.env.ZK_COMPOSE ? "Version " + process.env.ZK_COMPOSE : "alt (Version 1)", "| API-Schlüssel:", keyInfo()));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { server.close(); setTimeout(() => process.exit(0), 2000).unref(); });
