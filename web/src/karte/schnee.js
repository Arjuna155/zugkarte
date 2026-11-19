// Schneedecke nach den Messwerten: Die MeteoSchweiz-Stationen melden die Schneehöhe (htoauts0, «hs» in /api/wetter).
// Daraus die Schneegrenze um die Bildmitte: die Höhe, die Stationen mit Schnee (≥ 3 cm) und ohne Schnee am besten
// trennt, nahe Stationen zählen mehr. Über der Grenze legt «ls-schnee» (color-relief aus dem Geländemodell, im
// Landschaftsstil) Schnee aufs Gelände, mit weichem Übergang; Wald und Felswände schimmern durch. Bäume und Dächer
// werden über der Grenze weiss (baeume.js, daecher.js lesen schneeAnteil()).
import { K } from "./karte.js";
import { WE, lv95, feldBei } from "./wetter.js";
import { ebene } from "../ui/ebenen.js";
import { beiRuhe, melde } from "../util.js";

export const SCHNEE = { linie: 99999, v: 0, an: true, lo: 0, hi: 0 };
const UEBERGANG = 260;   // m vom ersten Fleck bis geschlossene Decke
// 0 (kein Schnee) … 1 (geschlossene Decke) für eine Höhe in m ü. M.; h = fester Zufall 0–1 für Flecken im Übergang
export function schneeAnteil(m, h = .5) {
  if (!SCHNEE.an) return 0; const u = (m - SCHNEE.linie + UEBERGANG * .5) / UEBERGANG + (h - .5) * .5;
  return u <= 0 ? 0 : u >= 1 ? 1 : u;
}

export function grenzeBei(lng, lat) {
  const [E, N] = lv95(lng, lat), st = [];
  for (const s of WE.stationen) { if (s.hs == null || s.hoehe == null || (s.hs > 0 && s.hs < 3)) continue; const d2 = (s.E - E) ** 2 + (s.N - N) ** 2; st.push({ h: s.hoehe, ja: s.hs >= 3, g: 1 / (d2 + 25000 ** 2) }); }
  if (!st.length) return null;
  // Höhe mit dem kleinsten Fehlergewicht: Station mit Schnee unter der Grenze bzw. ohne Schnee darüber ist ein Fehler
  let best = Infinity, lo = 0, hi = 0;
  for (let h = 200; h <= 3800; h += 25) {
    let f = 0; for (const s of st) if (s.ja ? s.h < h : s.h > h) f += s.g;
    if (f < best * (1 - 1e-9)) { best = f; lo = hi = h; } else if (f <= best * (1 + 1e-9)) hi = h;
  }
  const mitSchnee = st.some(s => s.ja);
  // keine Station mit Schnee (Sommer): Grenze über der höchsten schneefreien Station, mindestens 300 m über der Nullgradgrenze
  const null0 = feldBei(lng, lat, "temp") / .0065;
  const linie = mitSchnee ? (lo + hi) / 2 : Math.max(lo + 200, null0 + 300);
  return { linie: Math.round(linie), lo, hi };
}

function farbe(L) {
  const s = a => `rgba(248,250,253,${a})`;
  return ["interpolate", ["linear"], ["elevation"], L - UEBERGANG * .5 - 60, s(0), L - UEBERGANG * .5, s(.18), L, s(.62), L + UEBERGANG * .5, s(.9), L + 900, s(.95)];
}

function setzen(neu) {
  const map = K.map; if (!map || !map.getLayer("ls-schnee")) return;
  const an = SCHNEE.an && neu < 4300;
  for (const id of ["ls-schnee", "ls-schnee-wald", "ls-schnee-fels"]) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", an ? "visible" : "none");
  if (an) map.setPaintProperty("ls-schnee", "color-relief-color", farbe(neu));
}

function rechnen(immer) {
  const map = K.map; if (!map || !WE.stationen.length) return;
  const c = map.getCenter(), g = grenzeBei(c.lng, c.lat); if (!g) return;
  if (!immer && Math.abs(g.linie - SCHNEE.linie) < 40) return;
  Object.assign(SCHNEE, g); SCHNEE.v++; setzen(g.linie); melde("schnee", SCHNEE);
}

export function schneeStarten() {
  const map = K.map;
  ebene({ id: "schnee", name: "Schneedecke (nach den Messstationen)", an: true, setze: an => { SCHNEE.an = an; setzen(SCHNEE.linie); SCHNEE.v++; melde("schnee", SCHNEE); map.triggerRepaint(); } });
  beiRuhe(map, () => rechnen(false));
  map.on("styledata", () => { if (map.getLayer("ls-schnee") && !SCHNEE.gesetzt) { SCHNEE.gesetzt = true; setzen(SCHNEE.linie); } });
  const warte = setInterval(() => { if (WE.stationen.length) { rechnen(true); clearInterval(warte); } }, 1000);
  setInterval(() => rechnen(false), 5 * 60000);
  window.__schnee = { SCHNEE, grenzeBei, setze: m => { SCHNEE.linie = m; SCHNEE.v++; setzen(m); melde("schnee", SCHNEE); } };
}
