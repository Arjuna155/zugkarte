"""Erzeugt src/template3d.html (3D-Karte mit MapLibre) aus src/template.html (2D-Karte).

Die ganze Logik (Fahrplan, Echtzeit, Sperrungen, Abfahrten, Suche, Seitenleiste) wird aus der 2D-Vorlage übernommen,
nur die Kartendarstellung (SVG + Canvas) wird durch MapLibre GL ersetzt. So bleiben beide Karten auf dem gleichen Stand:
nach Änderungen an src/template.html einfach  python3 tools/mach_3d.py && python3 tools/build.py  laufen lassen.
"""
import pathlib, re

ROOT = pathlib.Path(__file__).resolve().parent.parent
src = (ROOT / "src" / "template.html").read_text(encoding="utf-8")
neu = (ROOT / "src" / "karte3d.js").read_text(encoding="utf-8")


def ersetze(s, alt, neu_, n=1):
    assert s.count(alt) == n, (s.count(alt), alt[:80])
    return s.replace(alt, neu_)


def zwischen(s, start, ende, neu_):
    """Ersetzt den Text ab `start` bis vor `ende`."""
    a = s.index(start); b = s.index(ende, a)
    return s[:a] + neu_ + s[b:]


s = src
# ---- HTML/CSS ----
s = ersetze(s, "<style>", '<link rel="stylesheet" href="lib/maplibre-gl.css">\n<style>')
s = ersetze(s, ".mapwrap{position:relative;min-width:0;min-height:0;overflow:hidden;touch-action:none;cursor:grab}",
            ".mapwrap{position:relative;min-width:0;min-height:0;overflow:hidden}\n#map{position:absolute;inset:0}\n"
            ".ctrl{z-index:3}.ctrl button[aria-pressed=\"true\"]{background:var(--ink);color:var(--panel)}\n"
            ".maplibregl-ctrl-attrib{font-size:11px}.maplibregl-ctrl-bottom-left{left:env(safe-area-inset-left,0px)}")
s = ersetze(s, '<h1>Bahnnetz Schweiz <small>Hauptnetz</small></h1>', '<h1>ÖV Schweiz <small>3D-Karte</small></h1>')
s = zwischen(s, '<svg id="map"', '<div class="ctrl">', '<div id="map"></div>\n    ')
s = ersetze(s, '<button id="zde" aria-label="Ganz Deutschland anzeigen" style="font-size:13px">DE</button>',
            '<button id="z3d" aria-label="3D-Gelände ein/aus" aria-pressed="true" style="font-size:12px">3D</button>\n'
            '      <a href="/2d" id="z2d" aria-label="Zur flachen 2D-Karte" title="Zur 2D-Karte" style="font:600 12px var(--f-ui);width:36px;height:36px;border-radius:6px;border:1px solid var(--line);background:var(--panel);color:var(--ink);display:grid;place-items:center;text-decoration:none">2D</a>')
s = zwischen(s, '<div class="readout">', '<div class="tip"', '')
# Handy: Seitenleiste unten, zuklappbar
s = ersetze(s, '<aside id="side">', '<aside id="side"><button class="sidetoggle" id="sideToggle" aria-expanded="true">Details ausblenden</button>')
s = ersetze(s, "@media (max-width:760px){", ".sidetoggle{display:none;font:600 12px var(--f-ui);border:1px solid var(--line);background:var(--ground);color:var(--ink);border-radius:999px;padding:5px 12px;align-self:center;cursor:pointer;flex:none}\n@media (max-width:760px){")
s = ersetze(s, "  .note{display:none}\n}", "  .note{display:none}\n  .app{grid-template-columns:minmax(0,1fr)}header>*{min-width:0;max-width:100%}.rtpill span{min-width:0}\n  main{grid-template-columns:minmax(0,1fr)}.clock{max-width:100%;min-width:0}.rtpill{min-width:0}\n  header{gap:6px 10px;padding-block:6px}h1{font-size:16px}h1 small{display:none}.clock{gap:6px}.clock time{font-size:16px;min-width:5.6ch}\n"
            "  .seg button{padding:5px 7px}.rtpill{max-width:100%;padding:3px 8px;font-size:11px}.search input{padding:6px 10px}\n  aside{max-height:42vh;transition:max-height .2s}\n  aside.zu{max-height:44px;overflow:hidden}\n  .sidetoggle{display:block}\n}")
s = re.sub(r'<span id="deNote">.*?</span> ', '', s, flags=re.S)
s = ersetze(s, 'Reliefschattierung © swisstopo (DHM25).', 'Grundkarte © swisstopo, Gelände © Mapterhorn (offene Höhendaten, u. a. swisstopo), dargestellt mit MapLibre GL.')
s = ersetze(s, '<script>\nconst TT=', '<script src="lib/maplibre-gl-csp.js"></script>\n<script>\nconst TT=')

# ---- JS: Kartendarstellung ersetzen ----
s = zwischen(s, "// Geografie\n", "// Index Bahnhof -> Strecken, Nachbarn",
             "const MIT_OEV=OEV.t.length+OEV.s.length>0;\n"
             "const decK=v=>{let x=0,y=0;return glatt(v.split(\";\").map((q,i)=>{const [a,b]=q.split(\",\").map(Number);if(i){x+=a;y+=b}else{x=a;y=b}return [x/10,y/10]}))};\n"
             "// Verlauf glätten (Chaikin): die Gleisdaten stammen aus einem 20–50-m-Raster\n"
             "function glatt(p,n=3){for(let r=0;r<n&&p.length>2;r++){const q=[p[0]];for(let i=0;i<p.length-1;i++){const a=p[i],b=p[i+1];\n"
             "  q.push([a[0]*.75+b[0]*.25,a[1]*.75+b[1]*.25],[a[0]*.25+b[0]*.75,a[1]*.25+b[1]*.75])}q.push(p[p.length-1]);p=q}return p}\n\n")
s = ersetze(s, 'LINES.forEach(L=>{L.parts=L.geo.split("/").map(p=>{let x=0,y=0;return p.split(";").map((q,k)=>{const [a,b]=q.split(",").map(Number);if(k){x+=a;y+=b}else{x=a;y=b}return [x/10-24800,13000-y/10]})});',
            'LINES.forEach(L=>{L.parts=L.geo.split("/").map(p=>{let x=0,y=0;return glatt(p.split(";").map((q,k)=>{const [a,b]=q.split(",").map(Number);if(k){x+=a;y+=b}else{x=a;y=b}return [x/10-24800,13000-y/10]}))});')
s = zwischen(s, "// Strecken zeichnen (Fernverkehr zuoberst)", "function showTip(", neu)
# Auswahl: Bahnhofsmarkierung über die Karte
s = ersetze(s, 'Object.values(stEls).forEach(c=>c.classList.remove("sel"));stEls[n].classList.add("sel");', 'markSt(n);')
s = s.replace('Object.values(stEls).forEach(c=>c.classList.remove("sel"));', 'markSt(null);')
s = zwischen(s, "function refreshLines(){", "\n// Auswahl", "function refreshLines(){kartenAuswahl()}\n")
s = ersetze(s, "if(zoom){k=Math.max(k,4.5);tx=W/2-X(s)*k;ty=H/2-Y(s)*k}", "if(zoom)hinZu(X(s),Y(s),12.5);")
s = ersetze(s, "if(center&&p){k=Math.max(k,4);tx=W/2-p.x*k;ty=H/2-p.y*k;apply()}}", "if(center&&p)hinZu(p.x,p.y,13)}")
s = ersetze(s, 'Mit Mausrad oder zwei Fingern zoomen, Karte ziehen zum Verschieben. Einen Zug, Bahnhof oder eine Strecke anklicken, um Details zu sehen. Ein Bahnhof zeigt die nächsten Abfahrten. Beim Hineinzoomen erscheinen weitere Bahnhofsnamen.',
            'Mit Mausrad oder zwei Fingern zoomen, ziehen zum Verschieben. Neigen und Drehen mit der rechten Maustaste oder zwei Fingern (auf und ab bzw. drehen). Ein Fahrzeug, einen Bahnhof oder eine Strecke anklicken, um Details zu sehen. Trams erscheinen beim Hineinzoomen in die Städte.')
# Sperrungen als Kartenebene
s = zwischen(s, "function drawSperren(){", "async function sperrLaden(){", "function drawSperren(){sperrenKarte()}\n")
# Fahrzeuge: Canvas → GeoJSON-Ebene
s = zwischen(s, "// Zeichnen\nconst cv=", "// Zug-Details:", (ROOT / "src" / "karte3d_frame.js").read_text(encoding="utf-8"))
s = ersetze(s, "legend();refreshLines();intro();apply();\nwindow.addEventListener(\"resize\",apply);",
            "legend();intro();\n"
            "map.once(\"load\",()=>{if(matchMedia(\"(max-width:760px)\").matches){const a=document.querySelector(\".maplibregl-ctrl-attrib\");if(a)a.classList.remove(\"maplibregl-compact-show\")}});\n"
            "// Handy: Seitenleiste auf- und zuklappen; bei einer Auswahl öffnen\n"
            "function seite(auf){$(\"side\").classList.toggle(\"zu\",!auf);$(\"sideToggle\").setAttribute(\"aria-expanded\",auf);$(\"sideToggle\").textContent=auf?\"Details ausblenden\":\"Details anzeigen\";setTimeout(()=>map.resize(),250)}\n"
            "$(\"sideToggle\").onclick=()=>seite($(\"side\").classList.contains(\"zu\"));\n"
            "if(matchMedia(\"(max-width:760px)\").matches)seite(false);\n"
            "let letzteKarte=null;new MutationObserver(()=>{const c=$(\"detail\").querySelector(\".card\");if(!c)return;if($(\"side\").classList.contains(\"zu\"))seite(true);\n"
            "  const h=c.querySelector(\"h2\"),t=h?h.textContent:\"\";if(t!==letzteKarte&&matchMedia(\"(max-width:760px)\").matches){const sd=$(\"side\");sd.scrollTop+=$(\"detail\").getBoundingClientRect().top-sd.getBoundingClientRect().top-8}letzteKarte=t}).observe($(\"detail\"),{childList:true});")
assert "stEls" not in s and "lineEls" not in s and "cv." not in s, "Reste der 2D-Darstellung"
(ROOT / "src" / "template3d.html").write_text(s, encoding="utf-8")
print("src/template3d.html erzeugt,", len(s), "Zeichen")
