// Ebenen-Schalter: jede Ebene (Gebäude, Brücken, 3D-Züge, später Busse, Wetter …) meldet sich hier an und lässt sich
// in der Seitenleiste ein- und ausschalten. Die Wahl bleibt im Browser gespeichert.
import { $ } from "../util.js";
const EBENEN = [];
let gespeichert = {}; try { gespeichert = JSON.parse(localStorage.getItem("zk_ebenen") || "{}"); } catch (e) { }
// e: {id, name, an (Standard), setze(an)}
export function ebene(e) {
  const an = e.id in gespeichert ? !!gespeichert[e.id] : e.an; e.an = an; EBENEN.push(e); zeige(); e.setze(an); return e;
}
export const ebeneAn = id => { const e = EBENEN.find(x => x.id === id); return !!(e && e.an); };
function zeige() {
  const box = $("ebenen"); if (!box) return; box.innerHTML = "";
  for (const e of EBENEN) {
    const b = document.createElement("button"); b.setAttribute("aria-pressed", e.an);
    b.innerHTML = `<i class="eb ${e.id}"></i><b>${e.name}</b><span class="n">${e.an ? "an" : "aus"}</span>`;
    b.onclick = () => { e.an = !e.an; gespeichert[e.id] = e.an; try { localStorage.setItem("zk_ebenen", JSON.stringify(gespeichert)); } catch (x) { } e.setze(e.an); zeige(); };
    box.appendChild(b);
  }
}
