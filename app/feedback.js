// Feedback der Besucher: Knopf auf der Karte → POST /api/feedback. Gespeichert wird im Datenordner (feedback.jsonl):
// Text, Art, Kartenausschnitt (damit man die Stelle wiederfindet), Gerät, Version – KEINE Adresse des Absenders.
// Lesen und Abhaken nur mit dem Lesecode aus data/feedback-code.txt (wird beim ersten Start erzeugt, wie die Schlüssel
// eine Datei auf dem NAS; im Kopf «X-Feedback-Code»). Übersicht für Arjuna: /feedback.
// Schutz vor Missbrauch: Längen begrenzt, höchstens 5 Meldungen pro Stunde je Absender und 300 pro Tag insgesamt,
// verstecktes Feld (Honigtopf) und Mindestzeit im Formular gegen Automaten, Fehlversuche beim Code begrenzt.
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");

const ARTEN = ["fehler", "idee", "sonst"], MAX_TEXT = 2000, MAX_LISTE = 5000;
const zahl = (v, a, b) => typeof v === "number" && isFinite(v) && v >= a && v <= b ? Math.round(v * 1e5) / 1e5 : null;
const kurz = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, n);

// Eingabe prüfen → sauberer Eintrag oder Fehlertext
function pruefen(j, ua) {
  if (!j || typeof j !== "object") return { fehler: "Ungültige Anfrage" };
  const text = kurz(j.text, MAX_TEXT); if (text.length < 5) return { fehler: "Bitte schreibe ein paar Worte." };
  const e = { text, art: ARTEN.includes(j.art) ? j.art : "sonst" };
  const o = j.ort; if (o && typeof o === "object") { const lng = zahl(o.lng, 2, 15), lat = zahl(o.lat, 41, 52), zoom = zahl(o.zoom, 0, 24); if (lng != null && lat != null && zoom != null) e.ort = { lng, lat, zoom, pitch: zahl(o.pitch, 0, 85) || 0, bearing: zahl(o.bearing, -360, 360) || 0 }; }
  if (j.auswahl) e.auswahl = kurz(j.auswahl, 120);
  if (j.bild) e.bild = kurz(j.bild, 20);                       // Bildschirmgrösse «390×844»
  if (j.zeit) e.uhr = kurz(j.zeit, 30);                        // Uhrzeit beim Absender (für «Zug X stand um 10:12 falsch»)
  e.geraet = /Mobi|Android|iPhone|iPad/i.test(ua || "") ? "Handy" : "Computer";
  e.browser = (/(Firefox|Edg|OPR|Chrome|Safari)\/[\d]+/.exec(ua || "") || ["?"])[0];
  return { e };
}

function start({ DATA_DIR, log, version }) {
  const DATEI = path.join(DATA_DIR, "feedback.jsonl"), CODE_DATEI = path.join(DATA_DIR, "feedback-code.txt");
  let code = "";
  const codeLesen = () => {
    let c = ""; try { c = fs.readFileSync(CODE_DATEI, "utf8").trim(); } catch { }
    if (c.length < 12) { c = crypto.randomBytes(15).toString("base64url"); try { fs.writeFileSync(CODE_DATEI, c + "\n", { mode: 0o600 }); log("Feedback: Lesecode in feedback-code.txt angelegt"); } catch (e) { log("Feedback: feedback-code.txt nicht schreibbar:", e.message); } }
    code = c; return c;
  };
  codeLesen();
  let liste = []; try { liste = fs.readFileSync(DATEI, "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { }
  const alles = () => { try { fs.writeFileSync(DATEI + ".tmp", liste.map(e => JSON.stringify(e)).join("\n") + (liste.length ? "\n" : "")); fs.renameSync(DATEI + ".tmp", DATEI); } catch (e) { log("Feedback: speichern:", e.message); } };
  // Zähler je Absender (nur im Speicher, nur als Prüfsumme – die Adresse selbst wird nirgends abgelegt)
  const zaehler = new Map(), treffer = (k, fenster, max) => { const jetzt = Date.now(), a = (zaehler.get(k) || []).filter(t => jetzt - t < fenster); if (a.length >= max) { zaehler.set(k, a); return false; } a.push(jetzt); zaehler.set(k, a); if (zaehler.size > 5000) zaehler.clear(); return true; };
  const wer = req => { const x = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?"; return crypto.createHash("sha256").update(x).digest("hex").slice(0, 16); };
  const codeOk = req => { codeLesen(); const g = Buffer.from(String(req.headers["x-feedback-code"] || "")), s = Buffer.from(code); return g.length === s.length && crypto.timingSafeEqual(g, s); };
  const koerper = req => new Promise((ok, nein) => { let n = 0; const t = []; req.on("data", d => { n += d.length; if (n > 8192) { nein(new Error("zu gross")); req.destroy(); } else t.push(d); }); req.on("end", () => { try { ok(JSON.parse(Buffer.concat(t).toString("utf8") || "{}")); } catch (e) { nein(e); } }); req.on("error", nein); });

  // gibt true zurück, wenn die Anfrage hier beantwortet wurde
  async function behandle(req, res, url, json) {
    const p = url.pathname; if (!p.startsWith("/api/feedback")) return false;
    const w = wer(req);
    if (p === "/api/feedback" && req.method === "POST") {
      let j; try { j = await koerper(req); } catch { json(req, res, 400, { fehler: "Ungültige Anfrage" }); return true; }
      // Automaten: verstecktes Feld ausgefüllt oder Formular in < 3 s abgeschickt → freundlich annehmen, aber nicht speichern
      if (j.website || !(j.dauer >= 3000)) { json(req, res, 200, { ok: true }); return true; }
      const { e, fehler } = pruefen(j, req.headers["user-agent"]); if (fehler) { json(req, res, 400, { fehler }); return true; }
      if (!treffer("f" + w, 3600e3, 5) || !treffer("alle", 86400e3, 300)) { json(req, res, 429, { fehler: "Zu viele Meldungen – bitte später nochmals versuchen." }); return true; }
      e.id = liste.reduce((m, x) => Math.max(m, x.id || 0), 0) + 1; e.zeit = new Date().toISOString(); e.version = version || "";
      liste.push(e); if (liste.length > MAX_LISTE) { liste = liste.slice(-MAX_LISTE); alles(); } else try { fs.appendFileSync(DATEI, JSON.stringify(e) + "\n"); } catch (err) { log("Feedback: speichern:", err.message); }
      log("Feedback: neue Meldung", e.id, "(" + e.art + ")");
      json(req, res, 200, { ok: true, id: e.id }); return true;
    }
    if (p === "/api/feedback/liste" || p === "/api/feedback/erledigt") {
      if (!codeOk(req)) { if (!treffer("c" + w, 3600e3, 10)) { json(req, res, 429, { fehler: "Zu viele Versuche" }); return true; } json(req, res, 403, { fehler: "Lesecode fehlt oder ist falsch (Datei data/feedback-code.txt auf dem NAS)" }); return true; }
      if (p === "/api/feedback/liste" && req.method === "GET") { json(req, res, 200, { liste, offen: liste.filter(e => !e.erledigt).length }); return true; }
      if (p === "/api/feedback/erledigt" && req.method === "POST") {
        let j; try { j = await koerper(req); } catch { json(req, res, 400, { fehler: "Ungültige Anfrage" }); return true; }
        const e = liste.find(x => x.id === j.id); if (!e) { json(req, res, 404, { fehler: "Meldung nicht gefunden" }); return true; }
        e.erledigt = j.erledigt !== false; if (j.notiz != null) e.notiz = kurz(j.notiz, 500); if (e.erledigt) e.erledigtAm = new Date().toISOString(); else delete e.erledigtAm;
        alles(); json(req, res, 200, { ok: true }); return true;
      }
    }
    json(req, res, 404, { fehler: "Unbekannt" }); return true;
  }
  return { behandle, status: () => ({ meldungen: liste.length, offen: liste.filter(e => !e.erledigt).length }) };
}
module.exports = { start, pruefen };
