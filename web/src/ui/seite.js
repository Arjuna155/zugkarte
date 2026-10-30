// Seitenleiste und Bedienung: Legenden, Details (Bahnhof, Strecke, Zug), Abfahrten, Suche, Zeitsteuerung, Echtzeit-Anzeige
import { B } from "../kern/basis.js";
import { zh, clock, clockSec, fmtDelay, DAYNAME, dayType } from "../kern/zeit.js";
import { services, tagRuns, aktivZwischen, istDatiert, fpBrauche } from "../kern/fahrplan.js";
import { trainPos } from "../kern/wege.js";
import { RT, rtFor, delayNow } from "../kern/echtzeit.js";
import { foWunsch } from "../kern/formation.js";
import { S, KLASSEN, TNAME, DNAME, TYPES } from "../zustand.js";
import { K, markSt, kartenAuswahl, fit, hinZu } from "../karte/karte.js";
import { $, X, Y, fmt, norm, an, istHandy } from "../util.js";

// ---- Legenden ----
function legende() {
  $("legend").innerHTML = "";
  Object.entries(TYPES).forEach(([t, v]) => {
    const n = B.LINES.filter(L => L.type === t).length, b = document.createElement("button"); b.setAttribute("aria-pressed", S.onT[t]);
    b.innerHTML = `<i class="sw ${t}"></i><b>${v.name}</b><span class="n">${n}</span>`;
    b.onclick = () => { S.onT[t] = !S.onT[t]; legende(); kartenAuswahl(); }; $("legend").appendChild(b);
  });
}
function zugLegende() {
  const box = $("tlegend"); box.innerHTML = "";
  if (S.colMode === "vsp") {
    ["d0", "d1", "d2", "dn"].forEach(c => { const b = document.createElement("button"); b.setAttribute("aria-pressed", "true"); b.disabled = true; b.style.cursor = "default"; b.innerHTML = `<i class="dot ${c}"></i><b>${DNAME[c]}</b><span class="n">${S.zaehlerD[c]}</span>`; box.appendChild(b); });
    return;
  }
  KLASSEN.forEach(c => { const b = document.createElement("button"); b.setAttribute("aria-pressed", S.onTr[c]); b.innerHTML = `<i class="dot ${c}"></i><b>${TNAME[c]}</b><span class="n">${S.zaehler[c]}</span>`; b.onclick = () => { S.onTr[c] = !S.onTr[c]; zugLegende(); }; box.appendChild(b); });
}
function farbModus(m) { S.colMode = m; try { localStorage.setItem("zkFarbe", m); } catch (e) { } document.querySelectorAll("#colmode button").forEach(b => b.setAttribute("aria-pressed", b.dataset.v === m)); zugLegende(); }

// ---- Auswahl und Details ----
function intro() { $("detail").innerHTML = `<p class="eyebrow">Bedienung</p><p class="hint">Mit Mausrad oder zwei Fingern zoomen, ziehen zum Verschieben. Neigen und Drehen mit der rechten Maustaste oder zwei Fingern (auf und ab bzw. drehen). Ein Fahrzeug, einen Bahnhof oder eine Strecke anklicken, um Details zu sehen. Trams erscheinen beim Hineinzoomen in die Städte.</p>`; }
export function auswahlWeg() { S.sel = null; S.selSt = null; S.selHalt = null; S.selLn = null; markSt(null); kartenAuswahl(); intro(); }
function bindDetail() {
  $("detail").querySelectorAll("[data-s]").forEach(b => b.onclick = () => bahnhof(b.dataset.s, true));
  $("detail").querySelectorAll("[data-l]").forEach(b => b.onclick = () => strecke(+b.dataset.l));
  const bk = $("back"); bk && (bk.onclick = auswahlWeg);
}
// Haltestelle ohne eigenen Bahnhof (Bus, Tram, Schiff, Bergbahn): nur Abfahrten
function halt(n, zoom) {
  S.sel = null; S.selLn = null; S.selSt = null; S.selHalt = n; markSt(null);
  const s = B.STX[n], art = { bus: "Bushaltestelle", b: "Bergbahn" }[s.a] || "Haltestelle";
  $("detail").innerHTML = `<div class="card"><p class="eyebrow">${art}</p><h2>${n.replace(/ \(Bus\)'*$/, "")}</h2>
    <p class="eyebrow">Abfahrten</p><ul class="deps" id="deps"></ul>
    <button class="link" id="back">Auswahl aufheben</button></div>`;
  bindDetail(); kartenAuswahl(); abfahrten(n);
  if (zoom) hinZu(X(s), Y(s), 15);
}
export function bahnhof(n, zoom) {
  if (!B.ST[n]) { if (B.STX[n]) halt(n, zoom); return; }
  S.selHalt = null;
  S.sel = null; S.selLn = null; S.selSt = n; markSt(n);
  const s = B.ST[n], o = B.byStation[n];
  const lines = [...o.lines].sort((a, b) => "fvrvsm".indexOf(B.LINES[a].type) - "fvrvsm".indexOf(B.LINES[b].type));
  $("detail").innerHTML = `<div class="card"><p class="eyebrow">Bahnhof</p><h2>${n}</h2>
    <p class="sub">${lines.length} ${lines.length === 1 ? "Strecke" : "Strecken"} · ${o.nb.size} Nachbarbahnhöfe im Hauptnetz</p>
    <p class="eyebrow">Abfahrten</p><ul class="deps" id="deps"></ul>
    <p class="eyebrow">Strecken</p><div class="chips">${lines.map(i => `<button class="chip" data-l="${i}"><i class="${B.LINES[i].type}"></i>${B.LINES[i].name}</button>`).join("")}</div>
    <p class="eyebrow">Nächste Bahnhöfe</p><div class="chips">${[...o.nb].sort().map(b => `<button class="chip" data-s="${b}">${b}</button>`).join("")}</div>
    <dl class="kv"><dt>LV95 E</dt><dd>${fmt(s.E)}</dd><dt>LV95 N</dt><dd>${fmt(s.N)}</dd><dt>WGS84</dt><dd>${s.lat.toFixed(4)}° N, ${s.lon.toFixed(4)}° E</dd></dl>
    <button class="link" id="back">Auswahl aufheben</button></div>`;
  bindDetail(); kartenAuswahl(); abfahrten(n);
  if (zoom) hinZu(X(s), Y(s), 12.5);
}
export function strecke(i) {
  S.sel = null; S.selSt = null; S.selHalt = null; S.selLn = i; markSt(null);
  const L = B.LINES[i], c = `var(--${L.type})`, km = L.km.reduce((a, b) => a + b, 0);
  $("detail").innerHTML = `<div class="card"><p class="eyebrow">${TYPES[L.type].short}</p><h2>${L.name}</h2>
    <p class="sub">${L.stops[0]} – ${L.stops[L.stops.length - 1]} · ${L.stops.length} Bahnhöfe · ca. ${Math.round(km)} km Strecke</p>
    <ol class="stops" style="--c:${c}">${L.stops.map((s, j) => `<li><button data-s="${s}">${s}</button>${j ? `<span class="km">+${L.km[j - 1].toFixed(1)} km</span>` : ""}</li>`).join("")}</ol>
    <button class="link" id="back">Auswahl aufheben</button></div>`;
  bindDetail(); kartenAuswahl();
  const xs = L.stops.map(s => X(B.ST[s])), ys = L.stops.map(s => Y(B.ST[s]));
  fit([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
}
// Zug-Details: Zeiten relativ zur aktuellen Betriebszeit
export function zug(tr, o, center) {
  if (!S.sel || S.sel.tr !== tr) foWunsch(tr, o);
  S.sel = { tr, o }; S.selSt = null; S.selHalt = null; S.selLn = null; markSt(null);
  const rt = rtFor(tr, o), t = zh(S.simMs).t + o, p = rt && rt.canc ? null : trainPos(tr, t, rt), at = tm => clock(S.simMs + (tm - t) * 60000);
  const items = tr.st.map((St, j) => {
    const tm = j === 0 ? St.d : St.a, dl = rt ? (j === 0 ? rt.dd[j] : rt.da[j]) : 0, etm = tm + dl / 60, cls = p && (p.next === j || p.stop === j) ? "next" : etm < t ? "done" : "", cx = rt && (rt.canc || rt.sc[j]);
    return `<li class="${cls}"><time class="${cx ? "cx" : ""}">${at(tm)}</time><span>${B.SN[St.i]}${cx ? ' <span class="cxl">fällt aus</span>' : dl >= 60 ? ` <span class="late">${fmtDelay(dl)}</span>` : ""}</span></li>`;
  }).join("");
  const dln = delayNow(rt, p);
  const where = rt && rt.canc ? "Dieser Zug fällt heute aus" : !p ? "Nicht mehr unterwegs" : (p.moving ? `Unterwegs nach ${B.SN[tr.st[p.next].i]}` : `Hält in ${B.SN[tr.st[p.stop].i]}`) + (rt ? (dln >= 60 ? ` · ${Math.round(dln / 60)} Min. verspätet` : " · pünktlich") : " · nur Fahrplan, keine Echtzeit");
  $("detail").innerHTML = `<div class="card"><p class="eyebrow">${TNAME[tr.cls]}</p><h2><span class="badge ${tr.cls}">${tr.label}</span> → ${tr.to}</h2>
    <p class="sub">${where}</p><p class="eyebrow">Halte im Hauptnetz</p><ol class="trip">${items}</ol>
    <button class="link" id="back">Auswahl aufheben</button></div>`;
  bindDetail();
  if (center && p) hinZu(p.x, p.y, 13);
}
// Abfahrten an einem Bahnhof (nächste 45 Minuten, auch über Mitternacht)
function abfahrten(n) {
  const box = $("deps"); if (!box) return; const i = B.SIDX[n], out = [];
  const z = zh(S.simMs), svs = [...services(S.simMs), { runs: tagRuns(zh(S.simMs + 86400000)), o: -1440, t: z.t - 1440 }];
  for (const sv of svs) for (const tr of aktivZwischen(sv.runs, sv.t, sv.t + 45)) {
    if (tr.t1 < sv.t || tr.t0 > sv.t + 45) continue;
    const rt = rtFor(tr, sv.o);
    tr.st.forEach((St, j) => { if (St.i !== i || j === tr.st.length - 1) return; const dm = St.d - sv.t, dl = rt ? rt.dd[j] : 0; if (dm + dl / 60 < -0.5 || dm > 45) return; out.push({ dm, tr, dl, cx: rt && (rt.canc || rt.sc[j]) }); });
  }
  out.sort((a, b) => a.dm - b.dm);
  { const u = new Set(); for (let j = out.length - 1; j >= 0; j--) { const key = out[j].tr.label + "|" + Math.round(out[j].dm); if (u.has(key)) out.splice(j, 1); else u.add(key); } }
  box.innerHTML = out.length ? out.slice(0, 12).map(o => `<li><time class="${o.cx ? "cx" : ""}">${clock(S.simMs + o.dm * 60000)}</time><span><span class="badge ${o.tr.cls}">${o.tr.label}</span></span><span class="to">${o.cx ? '<span class="cxl">fällt aus</span> ' : o.dl >= 60 ? `<span class="late">${fmtDelay(o.dl)}</span> ` : ""}${o.tr.to}</span></li>`).join("")
    : `<li><span></span><span></span><span class="to">Keine Abfahrten in den nächsten 45 Minuten</span></li>`;
}

// ---- Suche ----
function suche() {
  const q = $("q"), sg = $("sugg"); let hits = [], hi = 0;
  const zeige = () => { sg.innerHTML = ""; hits.forEach((n, j) => { const b = document.createElement("button"); b.textContent = n; if (j === hi) b.className = "on"; b.onmousedown = e => { e.preventDefault(); waehle(n); }; sg.appendChild(b); }); sg.hidden = !hits.length; };
  const waehle = n => { q.value = n; sg.hidden = true; q.blur(); bahnhof(n, true); };
  const alle = Object.keys(B.ST).map(n => [n, norm(n)]);
  q.addEventListener("input", () => { const v = norm(q.value.trim()); hi = 0; hits = v ? alle.filter(([, m]) => m.includes(v)).sort((a, b) => a[1].indexOf(v) - b[1].indexOf(v) || B.tier(a[0]) - B.tier(b[0])).slice(0, 8).map(x => x[0]) : []; zeige(); });
  q.addEventListener("keydown", e => {
    if (sg.hidden) return;
    if (e.key === "ArrowDown") { hi = Math.min(hits.length - 1, hi + 1); zeige(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { hi = Math.max(0, hi - 1); zeige(); e.preventDefault(); }
    else if (e.key === "Enter" && hits[hi]) waehle(hits[hi]); else if (e.key === "Escape") sg.hidden = true;
  });
  q.addEventListener("blur", () => setTimeout(() => sg.hidden = true, 100));
}

// ---- Echtzeit-Anzeige ----
function echtzeitAnzeige() {
  const el = $("rt"), setze = (state, msg, kurz) => { el.dataset.state = state; $("rtTxt").textContent = kurz || msg; $("rtNote").textContent = state === "on" ? "" : msg; };
  if (RT.on) { const age = (Date.now() - RT.at) / 60000, hh = clock(RT.at); if (age > 5) setze("stale", `Echtzeit veraltet (Stand ${hh})`); else setze("on", `Echtzeit · Stand ${hh}`); if (RT.fehler) $("rtNote").textContent = RT.fehler; }
  else if (RT.fehler) setze("err", RT.fehler, "Echtzeit nicht verfügbar"); else setze("wait", "Hole Echtzeitdaten …");
}

// ---- Handy: Seitenleiste auf- und zuklappen; bei einer Auswahl öffnen ----
function seitenleiste() {
  const seite = auf => { $("side").classList.toggle("zu", !auf); $("sideToggle").setAttribute("aria-expanded", auf); $("sideToggle").textContent = auf ? "Details ausblenden" : "Details anzeigen"; setTimeout(() => K.map && K.map.resize(), 250); };
  $("sideToggle").onclick = () => seite($("side").classList.contains("zu"));
  if (istHandy()) seite(false);
  let letzte = null;
  new MutationObserver(() => {
    const c = $("detail").querySelector(".card"); if (!c) return; if ($("side").classList.contains("zu")) seite(true);
    const h = c.querySelector("h2"), t = h ? h.textContent : "";
    if (t !== letzte && istHandy()) { const sd = $("side"); sd.scrollTop += $("detail").getBoundingClientRect().top - sd.getBoundingClientRect().top - 8; } letzte = t;
  }).observe($("detail"), { childList: true });
}

export function seiteStarten() {
  legende(); intro(); suche(); seitenleiste(); farbModus(S.colMode);
  document.querySelectorAll("#colmode button").forEach(b => b.onclick = () => farbModus(b.dataset.v));
  document.querySelectorAll("#speed button").forEach(b => b.onclick = () => { S.speed = +b.dataset.v; document.querySelectorAll("#speed button").forEach(x => x.setAttribute("aria-pressed", x === b)); });
  if ($("now")) $("now").onclick = () => { S.simMs = Date.now(); };
  an("bahnhof", n => bahnhof(n)); an("strecke", i => strecke(i)); an("zug", (tr, o) => zug(tr, o, false)); an("leer", auswahlWeg);
  an("echtzeit", echtzeitAnzeige); echtzeitAnzeige(); setInterval(echtzeitAnzeige, 15000);
}
// zweimal pro Sekunde: Zähler, Fahrplan-Hinweis, offene Details nachführen
export function seiteTakt() {
  const z = S.zaehler;
  $("live").textContent = `· ${z.fv + z.rv + z.s + z.tr + z.sch} unterwegs` + (RT.on ? ` · ${S.spaet} verspätet · ${S.ausfall} fallen aus` : "");
  document.querySelectorAll("#tlegend .n").forEach((n, j) => n.textContent = S.colMode === "vsp" ? S.zaehlerD[["d0", "d1", "d2", "dn"][j]] : z[KLASSEN[j]]);
  const zz = zh(S.simMs); fpBrauche(S.simMs);
  $("daytype").textContent = istDatiert(zz.date) ? `Fahrplan vom ${+zz.date.slice(8)}.${+zz.date.slice(5, 7)}.${zz.date.slice(0, 4)}` : tagRuns(zz) ? `Ersatzfahrplan ${DAYNAME[dayType(zz.wd)]}` : "Fahrplan wird geladen …";
  if (S.sel) zug(S.sel.tr, S.sel.o, false); else if ((S.selSt || S.selHalt) && $("deps")) abfahrten(S.selSt || S.selHalt);
}
export const uhr = () => { $("clk").textContent = clockSec(S.simMs); };
