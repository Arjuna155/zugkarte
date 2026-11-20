// Zustand der Datenquellen (Server /api/zustand) in der Seitenleiste: grün = läuft, orange = Problem/lädt, rot = aus.
// Texte immer als Text (textContent), nie als HTML.
export function quellenStarten() {
  const box = document.getElementById("quellen"), sum = document.getElementById("quellenSum"); if (!box) return;
  const laden = async () => {
    let j; try { const r = await fetch("/api/zustand"); if (!r.ok) throw 0; j = await r.json(); } catch { sum.textContent = "(nicht erreichbar)"; return; }
    const z = { ok: 0, warn: 0, aus: 0 }; box.replaceChildren(...j.quellen.map(q => {
      z[q.s] = (z[q.s] || 0) + 1; const li = document.createElement("li"), i = document.createElement("i"), d = document.createElement("div"), b = document.createElement("b"), t = document.createElement("small");
      i.className = q.s; i.title = q.s === "ok" ? "läuft" : q.s === "warn" ? "Problem oder lädt" : "aus"; b.textContent = q.n; t.textContent = q.t; d.append(b, t); li.append(i, d); return li; }));
    sum.textContent = z.aus || z.warn ? "(" + [z.aus && z.aus + " aus", z.warn && z.warn + " mit Problem"].filter(Boolean).join(", ") + ")" : "(alles läuft)";
  };
  laden(); setInterval(laden, 120000);
}
