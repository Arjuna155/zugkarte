// ZugKarte – Starter mit Selbst-Update für den Docker-Container auf dem NAS.
//
// Holt die neueste Version des Ordners app/ aus dem GitHub-Repository, startet den Webserver
// und prüft alle paar Minuten, ob es auf GitHub eine neue Version gibt. Neue Versionen werden
// erst übernommen, wenn sie erfolgreich starten; sonst läuft die alte Version weiter.
// Ohne Abhängigkeiten, Node 20+.
"use strict";
const fs = require("fs"), path = require("path"), zlib = require("zlib"), crypto = require("crypto"), { spawn } = require("child_process");

const REPO = process.env.REPO || "Arjuna155/zugkarte";
const BRANCH = process.env.BRANCH || "main";
const CHECK_MIN = Math.max(2, +process.env.CHECK_MINUTES || 5);
const PORT = +process.env.PORT || 8080;
const DATA = process.env.ZK_DATA || "/data";
const BASE = path.join(DATA, "zugkarte");
const REL = path.join(BASE, "releases");
const STATE = path.join(BASE, "state.json");
const SELF = process.argv[1];
const log = (...a) => console.log(new Date().toLocaleString("de-CH", { timeZone: "Europe/Zurich" }), "[updater]", ...a);

fs.mkdirSync(REL, { recursive: true });
let state = { current: null, previous: null, bad: [] };
try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE, "utf8")) }; } catch {}
const saveState = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
const relDir = sha => path.join(REL, sha);
const hasRelease = sha => sha && fs.existsSync(path.join(relDir(sha), "app", "server.js")) && fs.existsSync(path.join(relDir(sha), "app", "public", "index.html"));

// ---- GitHub ----
const GH = { "User-Agent": "ZugKarte-Updater", "X-GitHub-Api-Version": "2022-11-28" };
async function latestSha() {
  const r = await fetch(`https://api.github.com/repos/${REPO}/commits/${BRANCH}`, { headers: { ...GH, Accept: "application/vnd.github.sha" }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error("GitHub antwortet mit HTTP " + r.status);
  const sha = (await r.text()).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("Unerwartete Antwort von GitHub");
  return sha;
}
// Minimaler tar-Leser (ustar + pax), liefert {name, data} für normale Dateien.
function* untar(buf) {
  let off = 0, paxPath = null;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every(b => b === 0)) break;
    const str = (a, b) => h.subarray(a, b).toString("utf8").replace(/\0.*$/s, "");
    let name = str(0, 100); const prefix = str(345, 500);
    if (prefix) name = prefix + "/" + name;
    const size = parseInt(str(124, 136).trim() || "0", 8);
    const type = String.fromCharCode(h[156] || 48);
    const data = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") { const m = data.toString("utf8").match(/\d+ path=([^\n]*)\n/); paxPath = m ? m[1] : null; continue; }
    if (type === "g") continue;
    if (paxPath) { name = paxPath; paxPath = null; }
    if (type === "0" || type === "\0") yield { name, data };
  }
}
async function download(sha) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/tarball/${sha}`, { headers: GH, redirect: "follow", signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error("Download von GitHub fehlgeschlagen (HTTP " + r.status + ")");
  const tar = zlib.gunzipSync(Buffer.from(await r.arrayBuffer()));
  const tmp = relDir(sha) + ".tmp"; fs.rmSync(tmp, { recursive: true, force: true });
  let n = 0, launcher = null;
  for (const { name, data } of untar(tar)) {
    const rel = name.split("/").slice(1).join("/");          // ersten Ordner (repo-sha) entfernen
    if (rel === "deploy/launcher.js") launcher = data;
    if (!rel.startsWith("app/") || rel.includes("..")) continue;
    const dest = path.join(tmp, rel); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, data); n++;
  }
  if (!fs.existsSync(path.join(tmp, "app", "server.js"))) throw new Error("Im Download fehlt app/server.js");
  fs.rmSync(relDir(sha), { recursive: true, force: true }); fs.renameSync(tmp, relDir(sha));
  log("Version", sha.slice(0, 7), "geladen (" + n + " Dateien)");
  return launcher;
}

// ---- Webserver-Prozess ----
let child = null, childSha = null, stopping = false, crashes = [];
function startChild(sha) {
  childSha = sha; stopping = false;
  child = spawn(process.execPath, [path.join(relDir(sha), "app", "server.js")], { cwd: path.join(relDir(sha), "app"), stdio: "inherit", env: { ...process.env, PORT: String(PORT), ZK_VERSION: sha.slice(0, 7) } });
  const me = child;
  child.on("exit", code => {
    if (me !== child || stopping) return;
    log("Webserver beendet (Code " + code + "), starte neu …");
    crashes = crashes.filter(t => Date.now() - t < 120000); crashes.push(Date.now());
    if (crashes.length >= 3 && state.previous && hasRelease(state.previous) && childSha !== state.previous) {
      log("Version", sha.slice(0, 7), "stürzt wiederholt ab – zurück auf", state.previous.slice(0, 7));
      state.bad.push(sha); state.current = state.previous; saveState(); crashes = [];
      return setTimeout(() => startChild(state.current), 2000);
    }
    setTimeout(() => startChild(childSha), 5000);
  });
}
function stopChild() {
  return new Promise(res => {
    if (!child || child.exitCode !== null) return res();
    stopping = true; const c = child; c.once("exit", () => res()); c.kill("SIGTERM");
    setTimeout(() => { try { c.kill("SIGKILL"); } catch {} }, 5000);
  });
}
async function healthy() {
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try { const r = await fetch(`http://127.0.0.1:${PORT}/api/ping`, { signal: AbortSignal.timeout(3000) }); if (r.ok && (await r.json()).app === "ZugKarte") return true; } catch {}
  }
  return false;
}
async function switchTo(sha) {
  const old = state.current;
  await stopChild(); startChild(sha);
  if (await healthy()) {
    state.previous = old && old !== sha ? old : state.previous; state.current = sha; saveState();
    log("Neue Version", sha.slice(0, 7), "läuft.");
    for (const d of fs.readdirSync(REL)) if (![state.current, state.previous].includes(d)) fs.rmSync(path.join(REL, d), { recursive: true, force: true });
    return true;
  }
  log("Version", sha.slice(0, 7), "startet nicht – bleibe bei", old ? old.slice(0, 7) : "keiner");
  state.bad.push(sha); saveState();
  await stopChild(); if (old && hasRelease(old)) startChild(old);
  return false;
}

// ---- Ablauf ----
let busy = false;
async function check() {
  if (busy) return; busy = true;
  try {
    const sha = await latestSha();
    if (sha === state.current && child) return;
    if (state.bad.includes(sha)) return;
    const launcher = hasRelease(sha) ? null : await download(sha);
    if (await switchTo(sha) && launcher && SELF && fs.existsSync(SELF)) {
      const mine = fs.readFileSync(SELF);
      if (!crypto.createHash("sha1").update(mine).digest().equals(crypto.createHash("sha1").update(launcher).digest())) {
        log("Neuer Starter verfügbar – Container startet neu.");
        fs.writeFileSync(SELF + ".neu", launcher); fs.renameSync(SELF + ".neu", SELF);
        await stopChild(); process.exit(0);
      }
    }
  } catch (e) { log("Update-Prüfung fehlgeschlagen:", e.message); }
  finally { busy = false; }
}
(async () => {
  log("Starter läuft. Repository:", REPO + "@" + BRANCH, "| Prüfung alle", CHECK_MIN, "Min.");
  if (hasRelease(state.current)) startChild(state.current);   // sofort mit der letzten guten Version starten
  await check();
  if (!child) log("Noch keine Version vorhanden – neuer Versuch in", CHECK_MIN, "Min.");
  setInterval(check, CHECK_MIN * 60000);
})();
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, async () => { await stopChild(); process.exit(0); });
