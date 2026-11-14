// Feedback-Knopf: kleines Formular auf der Karte, schickt Text, Art und (wenn gewünscht) den Kartenausschnitt an
// /api/feedback. Keine persönlichen Angaben. Übersicht für Arjuna unter /feedback (mit Lesecode).
import { K } from "../karte/karte.js";
import { S } from "../zustand.js";
import { $ } from "../util.js";

export function feedbackStarten() {
  const dlg = $("fbDlg"), knopf = $("fbBtn"), form = $("fbForm"), text = $("fbText"), status = $("fbStatus"), senden = $("fbSenden");
  if (!dlg || !knopf || typeof dlg.showModal !== "function") { if (knopf) knopf.hidden = true; return; }
  let offenSeit = 0;
  knopf.hidden = false;
  knopf.onclick = () => { status.textContent = ""; status.className = "fbstatus"; senden.disabled = false; offenSeit = Date.now(); dlg.showModal(); text.focus(); };
  $("fbZu").onclick = () => dlg.close();
  dlg.addEventListener("click", e => { if (e.target === dlg) dlg.close(); });   // Klick neben das Formular schliesst
  form.onsubmit = async e => {
    e.preventDefault(); const t = text.value.trim(); if (t.length < 5) { status.textContent = "Bitte schreibe ein paar Worte."; status.className = "fbstatus fehler"; text.focus(); return; }
    const j = { text: t, art: (form.querySelector("input[name=fbArt]:checked") || {}).value || "sonst", website: $("fbWeb").value, dauer: Date.now() - offenSeit,
      bild: innerWidth + "×" + innerHeight, zeit: new Date().toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit" }) };
    if ($("fbOrt").checked && K.map) { const c = K.map.getCenter(); j.ort = { lng: c.lng, lat: c.lat, zoom: K.map.getZoom(), pitch: K.map.getPitch(), bearing: K.map.getBearing() };
      if (S.sel && S.sel.tr) j.auswahl = [S.sel.tr.cat, S.sel.tr.label || S.sel.tr.zn, S.sel.tr.to].filter(Boolean).join(" "); }
    senden.disabled = true; status.textContent = "Wird gesendet …"; status.className = "fbstatus";
    try {
      const r = await fetch("/api/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(j) }), a = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(a.fehler || "Senden hat nicht geklappt.");
      status.textContent = "Danke! Deine Meldung ist angekommen."; status.className = "fbstatus ok"; text.value = ""; setTimeout(() => { if (dlg.open) dlg.close(); }, 1800);
    } catch (err) { status.textContent = err.message || "Senden hat nicht geklappt."; status.className = "fbstatus fehler"; senden.disabled = false; }
  };
}
// Ausschnitt aus der Adresse (?ort=lng,lat,zoom,neigung,richtung) – Link aus der Feedback-Übersicht
export function ortAusAdresse(map) {
  try { const o = (new URLSearchParams(location.search).get("ort") || "").split(",").map(Number); if (o.length < 3 || o.slice(0, 3).some(v => !isFinite(v))) return;
    K.ortFest = true;   // die Startansicht «ganze Schweiz» (Handy) überschreibt den Ausschnitt sonst wieder
    map.jumpTo({ center: [o[0], o[1]], zoom: o[2], pitch: isFinite(o[3]) ? o[3] : 0, bearing: isFinite(o[4]) ? o[4] : 0 }); } catch (e) { }
}
