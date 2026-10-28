# Hinweise für Claude

Projekt von Arjuna (spricht Deutsch, Schweiz). Antworten und Texte in der Karte auf Deutsch (Schweizer Schreibweise: «ss» statt «ß»).

## Architektur
- Statische Einzelseite `app/public/index.html`, gebaut von `tools/build.py` aus `src/template.html` + `data/`. Nach jeder Änderung an Vorlage oder Daten **immer** `python3 tools/build.py` laufen lassen und das Ergebnis mitcommitten.
- `app/server.js` (Node 22, keine Abhängigkeiten) liefert die Seite aus, injiziert `window.ZK_LOCAL={mode:"server"}` und stellt `/api/verspaetungen` bereit (SIRI-ET, gecacht 60 s, nur auf Anfrage).
- Auf dem NAS (UGREEN, UGOS Pro, Docker) läuft `deploy/launcher.js` im Container `node:22-alpine`. Er prüft alle 5 Min. `main` auf GitHub, lädt `app/` als Tarball, startet die neue Version und prüft `/api/ping`. Schlägt das fehl, bleibt die alte Version aktiv.
- Öffentlich erreichbar über Tailscale Funnel (Container `zugkarte-tailscale`, https://zugkarte.numbat-pike.ts.net). Funnel braucht im Tailnet-ACL `nodeAttrs` mit `"attr": ["funnel"]`. Ab Compose v4 teilt Tailscale das Netzwerk mit `zugkarte` (`network_mode: service:zugkarte`) und leitet auf `127.0.0.1:8080` – über den Containernamen gab es im Userspace-Modus 502.
- Schlüssel liegen als Dateien in `data/` auf dem NAS (`schluessel.txt`, `tailscale-key.txt`). Umgebungsvariablen in UGOS Pro kamen bei Arjuna nicht im Container an – deshalb Dateien. `ZK_COMPOSE` in der Compose-Datei zeigt im Protokoll, welche Konfigurationsversion läuft.

## Fahrplan nach Datum (GTFS, seit 25.10.2026)
- `app/fahrplan.js`: Server lädt den offiziellen GTFS-Fahrplan (data.opentransportdata.swiss, Datensatz `timetable-JJJJ-gtfs2020`, `/permalink` = neueste Ausgabe, ohne Schlüssel, 100–300 MB, ZIP64). Täglich ab 03:00 prüft er die Datensatzseite auf eine neue Ausgabe (ca. 2× pro Woche) und lädt nur dann. Fahrplanjahr ab dem zweiten Sonntag im Dezember → um den Fahrplanwechsel werden beide Jahre geladen.
- Umrechnung im eigenen Prozess (`node fahrplan.js --erzeugen <DATA_DIR>`, Test mit `ZK_FP_HEUTE=JJJJ-MM-TT`) für gestern … +8 Tage nach `DATA_DIR/fahrplan/JJJJ-MM-TT.json.gz` ({v, feed, tt} im Kartenformat). Nur Bahn (route_type 100–199) + Waldenburgerbahn (Tram BLT 19) und Forchbahn (FB 18). Label = Linie aus route_short_name («S 5», «IR 13»), sonst Zugnummer. Halte über `didok` → UIC → Kartenbahnhof, sonst naher Halt mit passendem Namen (Locarno FART, Arth-Goldau RB …). Gleiche Prüfungen wie netz_ausbau.py (8–240 km/h, Zwischenhalte ≤ 1,5 km vom Weg, Standzeit > 20 Min. teilt).
- `app/fahrplan_basis.json` (von build.py, `tools/fahrplan_basis.py`): Kartenbahnhöfe, UIC, Streckenverlauf; Kennung `v` steht auch in der Seite (`FPV`). Die Seite nimmt nur Fahrpläne mit gleicher Kennung; nach Netzänderungen rechnet der Server neu.
- Seite (nur Website): `/api/fahrplan?d=…` für gestern/heute/morgen, sonst eingebauter Wochentagsfahrplan. `/api/fahrplan/status` zeigt Stand.
- Sperrungen kommen jetzt bevorzugt aus dem GTFS-Tagesfahrplan (keine transport.opendata-Abfragen mehr); `direkt` in sperren.json zählt parallele Streckenteile mit gleichen Endbahnhöfen als befahren.

## Trams, Metro, Schiffe (Etappe 1 «ganzer ÖV», 26.10.2026)
- `tools/oev_netz.py` → `data/oev_netz.json`: Halte (didok) und Kanten mit Verlauf aus `data/quellen/gtfs_oev.json.gz` (GTFS-Auszug: Haltefolgen route_type 900/400/401/1000) und `data/quellen/osm_oev.json.gz` (OSM railway=tram|light_rail|subway, route=ferry; Overpass aus dem Browser). Ausgeschlossen: Forchbahn, Waldenburgerbahn (Bahnnetz), Riffelalp, Alpintrans.
- build.py (`MIT_OEV`): Halte als Zusatzhalte in `STX` (Namenskonflikt → «(Schiff)»/«(Tram)»), Verlauf in `KANTEN`, Liste in `OEV` {t,s}. fahrplan_basis: `oev` {didok: Index}, `nbahn`.
- fahrplan.js: Tram → Kategorie «Tram», Metro «M», Schiffe route_desc (BAT/FAE); Halte über `oev`; gleiche Minute → Zeiten verteilt (Bruchteile von Minuten). Klassen auf der Karte `tr`/`sch`, Trams erst ab Zoom 1.6, nur Website.
- Netz neu bauen: GTFS-Auszug + OSM im Browser holen (siehe oben), dann `python3 tools/oev_netz.py && python3 tools/build.py`.

## 3D-Karte (Etappe 2, Hauptseite seit 26.10.2026)
- `src/template3d.html` → `app/public/3d.html` (build.py, gleiche Platzhalter), Server liefert sie seit 28.10. nur noch unter `/3d` aus (Hauptseite ist die neue Website aus `web/`); die 2D-Karte unter `/2d`. MapLibre GL 5.6.0 (CSP-Build) liegt selbst ausgeliefert in `app/public/lib/` (`/lib/…`).
- Grundkarte: swisstopo-Vektorkacheln (`vectortiles.geo.admin.ch/styles/ch.swisstopo.lightbasemap.vt/style.json`), Gelände: Mapterhorn (`tiles.mapterhorn.com/{z}/{x}/{y}.webp`, terrarium, 512 px), beide ohne Schlüssel.
- `src/template3d.html` wird von `tools/mach_3d.py` aus `src/template.html` ERZEUGT (nicht von Hand ändern): ganze Logik der 2D-Karte (Fahrplan, Echtzeit, Sperrungen, Abfahrten, Suche, Seitenleiste) bleibt, die Darstellung (SVG/Canvas) wird durch `src/karte3d.js` (MapLibre, Ebenen, Klicks) und `src/karte3d_frame.js` (Fahrzeuge als GeoJSON ~15×/s) ersetzt. Nach Änderungen an der 2D-Vorlage: `python3 tools/mach_3d.py && python3 tools/build.py`.
- Kartenkoordinaten → WGS84 per swisstopo-Näherung; Linien mit Chaikin geglättet. `/2d` = alte Karte.
- Schriften der swisstopo-Grundkarte nur bis U+00FF: Zeichen wie «–» oder «′» in Symbol-Ebenen lassen die ganze Quelle ausfallen (Labels werden bereinigt).

## Neue Website aus Modulen (Umbau 28.10.2026, Hauptseite `/`, auch `/v2`)
- Quelle `web/`: `web/index.html` (Hülle + CSS) und `web/src/` als ES-Module, gebaut mit esbuild: `npm install` (einmalig, nur esbuild), dann `python3 tools/build.py && node tools/web_bauen.mjs` (oder `npm run bauen`). Ergebnis: `app/public/karte.html` + `app/public/js/app.<hash>.js` (committen). `ZK_LESBAR=1` baut ohne Verkleinern (zum Messen).
- Aufbau: `kern/` (basis: Grunddaten + Netzgraph; zeit; fahrplan: Zeitfenster + Zeitindex; wege: Laufwege, trainPos, Sperrungen; echtzeit; formation), `karte/` (karte: MapLibre + Grundebenen; fahrzeuge: eigene WebGL-Punkte-Ebene; zuege3d + modelle: 3D-Züge), `ui/seite.js` (Seitenleiste, Details, Abfahrten, Suche), `main.js` (Bildschleife). Gemeinsamer Zustand in `zustand.js`, Ereignisse über `an`/`melde` (util.js).
- Daten: build.py schreibt `app/public/daten/basis.<hash>.json` (Netz, Bahnhöfe, Kanten, UIC) und `ersatz.<hash>.json` (Wochentagsfahrplan, nur geladen, wenn der Server keinen Tagesfahrplan hat); Namen stehen als `window.ZK_DATEN` in der Seite. Server liefert `/js/*` und `/daten/*` mit `immutable`.
- Leistungsregeln: Fahrplan in Zeitfenstern zu 3 h (`/api/fahrplan?d=…&f=0…15`); Zeitindex in 10-Min.-Fenstern (nur fahrende Züge prüfen); Fahrzeuge als WebGL-Punkte statt GeoJSON; Neuberechnung nur, wenn sich ein Zug um ≥ ½ Pixel bewegt haben kann (herausgezoomt ~1×/s); voller Durchgang 2×/s, dazwischen nur Züge nahe am Bildausschnitt; Beschriftungen 4×/s nur ab Zoom 12.5.
- Messung (4× gedrosselte CPU, Playwright): alt → neu: Laden 3.9 MB → 0.6 MB, Speicher 209 → 52 MB, Skriptzeit Schweiz 404 → ~30 ms/s, Zürich mit 3D-Zügen 132 → ~100 ms/s.
- Die alte 3D-Seite (`src/template3d.html` über `mach_3d.py`) liegt noch unter `/3d` (eingefroren, nicht mehr weiterentwickeln), die 2D-Karte unter `/2d`; `web/src/karte/modelle.js` wird von beiden benutzt (mach_3d.py entfernt die `export`-Zeile).

## 3D-Welt, erste Fassung (28.10.2026) und Ebenen-Schalter
- `web/src/karte/welt3d.js`: Gebäude als `fill-extrusion` aus der Grundkarten-Quelle (source-layer `building`, `render_height`/`render_min_height`, ab Zoom 14). Brücken (Fahrbahn, Brüstungen, Pfeiler) und Tunnelportale per three.js aus `transportation` mit `brunnel` bridge/tunnel (Klassen rail, transit, motorway … minor), nach jedem Verschieben neu für den Ausschnitt (ab Zoom 14, nur mit Gelände). Brückenhöhe: «Wasserstand» zwischen den Talseiten (Stück ± 150 m), an echten Enden (gleichartige Strecke ohne Brücke schliesst an) Geländehöhe. Portale nur an echten Enden.
- Quelle und Ebenennamen werden aus dem Stil gesucht (ändern mit der Stilversion). Nur Daten, die die Grundkarte ohnehin lädt.
- `web/src/karte/drei.js`: three.js gemeinsam und erst bei Bedarf laden.
- `web/src/ui/ebenen.js`: Ebenen melden sich mit `ebene({id, name, an, setze})` an, Schalter in der Seitenleiste («Ebenen»), Wahl in localStorage `zk_ebenen`. Zurzeit: gebaeude, bauwerke, zuege3d (3D-Züge jetzt für alle an, abschaltbar; `?zuege3d=aus` schaltet ab).
- Test ohne Netz: `/tmp`-Testwelt mit synthetischem Gelände (Terrarium-PNG) und Vektorkacheln (geojson-vt + vt-pbf) über Playwright-Routen.

## Tunnel und Brücken auf den Bahnstrecken (28.10.2026)
- `app/tunnel.js`: Server lädt einmal (Kacheln 60 Tage zwischengespeichert in `DATA_DIR/kacheln/13/`) die swisstopo-Kacheln ch.swisstopo.base.vt Zoom 13 entlang aller Strecken (~1400 Kacheln), liest sie mit eigenem MVT-Leser (ohne Pakete) und bestimmt je Teilstück die Bereiche mit `class=rail|transit`, `brunnel=tunnel|bridge` (Abstand < 15 m, alle 10 m geprüft). Eigener Prozess (`node tunnel.js --erzeugen DATA_DIR`), Start 90 s nach Serverstart, wenn `DATA_DIR/bauwerke.json` fehlt, zu alt ist oder nicht zur Basisdatei passt. `/api/bauwerke` ({tunnel, bruecke}: je Strecke/Teilstück [[von,bis],…] als Anteil der Länge), `/api/bauwerke/status`. Test: `ZK_TILEJSON` auf einen Mock.
- Achtung: Die Gleise in `data/quellen/swisstopo_gleise.txt.gz` enthalten Tunnel (ohne Kennzeichnung); die OSM-Exporte haben keine Tunnelangabe (Feld 4 = Zahnrad).
- Seite: `kern/bauwerke.js` lädt die Daten; Strecken je Linie als zwei Merkmale (offen id=i, Tunnel id=100000+i, Eigenschaft `tun`), Ebene `bahn-tunnel` gestrichelt und blass; Fahrzeugpunkte im Tunnel mit Gelände halb durchsichtig (`p.tunnel` aus trainPos).

## 3D-Züge auf den Gleisen der Karte (28.10.2026)
- `web/src/karte/gleise.js`: Gleise der Grundkarte (transportation class=rail/transit) im Ausschnitt ab Zoom 13 in ein 25-m-Raster; `einrasten()` setzt Vorder- und Hinterende jedes 3D-Wagens auf das nächste Gleis (≤ 7 m), linke Gleise in Fahrtrichtung bevorzugt (Linksverkehr auf Doppelspur). Ohne Gleise in der Nähe bleibt der Wagen auf unserer Streckenlinie.
- Ebene «strecken» (Streckenlinien) in karte.js: blendet `bahn` und `bahn-tunnel` aus (Hervorhebung einer gewählten Strecke bleibt).

## Trams in 3D (28.10.2026)
- Trams und Metro fahren ab Zoom 13.2 als 3D-Modelle (Ebene «zuege3d»). Tagesfahrplan-Zeilen der Trams/Metro/Schiffe tragen jetzt «Kat,Linie,Ziel,,agency_id» (UMRECHNUNG 5).
- `web/src/karte/modelle.js`: Tram-Baureihen (`TRAM(...)`: Niederflur, Gelenkwagen aus kurzen Modulen, Meterspur) je Unternehmen über `TRAM_AG` (3849/849 VBZ, 773 VBG, 823 BVB, 37 BLT, 827 Bernmobil, 41 Limmattalbahn, 881 TPG, 151 tl-Metro); Formation-Dienst gibt es für Trams nicht, immer `rueckfall`.
- `zuege3d.js`: Tram steht mit der Spitze an der Haltestelle (Zug: Mitte am Bahnsteig), Richtung je Modul über ±5 m, enge Kurven gelten nicht als Wende, Abstecher am Halt (bis 60 m) werden gekürzt. Einrasten auf Kartengleise: Trams bevorzugen das RECHTE Gleis, Einrasten nur, wenn die Richtung passt (Kreuzungen).
- `tools/oev_netz.py`: Weg im 20-m-Raster wird auf die echten OSM-Gleise zurückgelegt (auf demselben Gleis bleiben, Zacken entfernen, Halte auf den Weg projiziert). Neu `kanten1` (1 m genau) → in der Basisdatei als `kanten1`, die Seite rechnet mit `B.KF(k)` (100 statt 10). Alte Seiten /2d, /3d nutzen weiter `kanten` (10 m).

## Schiffe in 3D (28.10.2026)
- Schiffe fahren ab Zoom 13.2 als 3D-Modelle (Ebene «zuege3d»). `modelle.js`: `bauSchiff()` (Rumpf mit spitzem Bug, Reling, Deckhäuser mit Fenstern, Flagge) in vier Arten: Motorschiff, Raddampfer (Schaufelradkästen, Kamin), Autofähre (Brücke quer, Autos auf Deck), kleines Schiff. `SCHIFF_AG` je Unternehmen (Länge, Breite, Farbe, Anteil Raddampfer), `FAEHRE_AG` für FAE. Welches Schiff eine Fahrt fährt, steht nicht im Fahrplan → Raddampfer nach festem Zufall (Abfahrtszeit + erster Halt), also plausibel, nicht echt.
- `zuege3d.js`: Schiffe ohne Abschnitte (nie «Wende»), Mitte an der Station (legt längsseits an), am Startort mit dem Heck, am Ziel mit dem Bug an der Station; Höhe = tiefstes Gelände im Umkreis ±300 m (Wasserspiegel), keine Neigung, kein Einrasten.
- Test ohne GTFS: /tmp-Skript baut aus den Haltefolgen in `gtfs_oev.json.gz` einen künstlichen Schiffsfahrplan (ZIP) und rechnet ihn mit `umrechnen()` um.

## Bergbahnen (28.10.2026)
- Standseilbahnen (FUN) und Luftseilbahnen (PB Pendelbahn, GB Gondelbahn, SL Sesselbahn) kommen direkt aus dem GTFS des Servers – ohne Netz in der Basisdatei. `fahrplan.js` (`bergbahnArt`: route_desc bzw. route_type 1300–1499/1700–1799/5–7, ohne Aufzüge/Skilifte): Halte je Station (Didok bzw. parent_station) mit Index ab `offset` = Anzahl Kartenhalte (`B.st.length`), Kanten gerade, Tempo < 60 km/h. Schreibt `DATA_DIR/fahrplan/bergbahnen.json` ({v, basis, offset, halte [[Name,E,N]], kanten [[a,b,Art]]}); Tagesdateien tragen `bbv` (UMRECHNUNG 6).
- server.js: `/api/bergbahnen`; Fahrplanfenster liefern `bbv`; ganzer Tag (alte Seiten /2d, /3d) ohne Bergbahn-Zeilen (`fahrplanOhneBB`).
- Seite: `kern/bergbahnen.js` lädt das Netz vor dem ersten Fenster mit `bbv` und hängt Halte an `SN` (nur wenn `SN.length === offset`), Zeilen mit unbekannten Halten werden weggelassen. Klasse `bb` («Bergbahn», Farbe `--tbb`), Punkte ab Zoom 10, Linien `bergbahn` (gestrichelt) und `bergbahn-fun`.
- 3D (`modelle.js` `bauBergbahn`, `BB_TYP`): Standseilbahnwagen auf dem Gelände, beim Zeichnen geschert (Wände senkrecht); Kabinen/Sessel hängen am Seil. Seilprofil je Kante (`seilProfil` in zuege3d.js): 10 m über Grund, obere konvexe Hülle (spannt über Täler), Seile als Linien im Umkreis 8 km.
- Test: /tmp-Skript baut eine kleine GTFS-ZIP (Polybahn, Rigiblick, Felsenegg, Titlis, Stoos) und rechnet sie mit `umrechnen()` um.

## Deployment = push auf main
Alles auf `main` geht innerhalb von ~5 Minuten live. Vor dem Push lokal prüfen:
1. `python3 tools/build.py`
2. `node --check app/server.js deploy/launcher.js`
3. `PORT=18080 node app/server.js` starten, `curl -s 127.0.0.1:18080/api/ping`, Seite im Headless-Browser (Playwright) auf JS-Fehler prüfen.
Grössere Umbauten zuerst auf einem Branch, mit Arjuna absprechen, dann mergen.

## Seiten-Code (src/template.html)
- Karte in SVG (Netz, Seen, Bahnhöfe) + Canvas (Züge). Koordinaten = LV95 / 100 (x = (E−2480000)/100, y = (1300000−N)/100).
- Fahrplan pro Tagestyp `wd`/`sa`/`su`; Zeiten in Minuten ab Mitternacht Schweizer Zeit; Bahnhofsindex hexadezimal.
- Echtzeit-Abgleich über (Bahnhof, Sollzeit); Verspätung wird vorwärts weitergereicht.
- Drei Betriebsarten: Claude-Artifact (mcp host:ZugKarte_Echtzeit), Windows-Programm (`ZK_LOCAL.mode` ≠ server, mit Schlüsselformular), Website (`mode:"server"`, ohne Schlüsselformular).

## Deutschland (zurzeit AUS)
- Seit 25.10.2026 ausgeschaltet: Arjuna will sich zuerst ganz auf die Schweiz konzentrieren. Schalter `MIT_DEUTSCHLAND` in `tools/build.py`; Daten und Werkzeuge bleiben im Repo. Bei `False` fehlen DE-Grundkarte, -Netz, DE-Knopf und Grenzzüge (Schweizer Fahrplan wie vorher an der Grenze gekappt).
- `data/deutschland.json` (Umriss + Bundesländer, `tools/deutschland.py`) und `data/deutschland_netz.json` (Bahnnetz aus OSM + Bahnhöfe DB-Kategorie 1–3 aus npm `db-stations`, `tools/deutschland_netz.py`). Züge in Deutschland: nur grenzüberschreitende (CH↔DE) aus `data/grenze.json` (`tools/grenze.py`, Quelle gtfs.de-Auszug in `data/quellen/gtfs_de_grenze.json.gz`). build.py hängt deren Halte als `STX` an `SN` an, ersetzt die an der Grenze gekappten Schweizer Fahrplanzeilen und liefert Laufwege als `KANTEN`. GTFS (gtfs.de) hat keine Zugnummern – ohne Schweizer Gegenstück zeigt das Label die Linie (z. B. «ICE 12»).
- gtfs.de-Download nur im Browser: Seite https://download.gtfs.de/germany/ öffnen, dann gleiche Herkunft fetchen, mit fflate (jsDelivr) entpacken und filtern.
- OSM-Daten nur über den Browser (Overpass): overpass-api.de antwortet aus derselben Herkunft mit 406 → Abfrage von einer fremden Seite aus (z. B. data.deutschebahn.com), Kachelergebnisse in IndexedDB zwischenspeichern.

## Gleisverlauf genau (26.10.2026)
- `tools/gleise_fein.py` legt jeden Streckenteil auf die Gleise der swisstopo-Vektorkarte (`data/quellen/swisstopo_gleise.txt.gz`, ch.swisstopo.base.vt z13, transportation/class=rail ohne Abstellgleise; im Browser geholt). Weg nur im Korridor ±250 m (sonst ±600 m) um den alten Verlauf, Kanten nah am alten Verlauf bevorzugt, Lücken (Tunnel fehlen in den Kacheln) gerade überbrückt, Länge 0.6–1.35× alt. Läuft automatisch am Ende von `tools/netz_ausbau.py`.
- Bahnhöfe stehen auf der offiziellen Lage (`data/quellen/bahnhof_koord.json`, Mittel der Bahnsteige aus dem GTFS); gleise_fein setzt sie in `stations.json` und legt die Streckenteile zwischen diese Punkte.
- Reihenfolge der Suche: durchgehender Weg auf swisstopo-Gleisen (Korridor 2.5/6/12), dann OSM-Gleise als Ersatz (fehlende Kacheln, z. B. Bonfol), erst zuletzt Lücken gerade überbrücken. Prüfung: /tmp-Skript qual.py-Logik – kein Stück > 50 m weg von swisstopo UND OSM (Ausnahmen: Waldenburgerbahn, Forchbahn, CEVA – Tunnel/Stadtbahn, in OSM richtig).
- 3D: Ecken nur noch leicht gerundet (max. 15 m).

## 3D-Züge mit echter Zusammensetzung (seit 28.10.2026 für alle, Ebene «zuege3d»)
- `app/formation.js`: Train Formation Service (`/formation/v2/formations_vehicle_based`, gleicher Schlüssel wie SIRI-ET). Hintergrund-Lader ≤ 40 Abfragen/Min. (`ZK_FORMATION_PRO_MIN`), zuerst Züge der nächsten 3 h, dann heute, dann morgen. Speichert `DATA_DIR/formation/JJJJ-MM-TT.json` und `typisch.json` (letzte Zusammensetzung je «EVU:Zugnr» als Rückfall). Zuordnung GTFS agency_id → EVU in `EVU`. `/api/formation?d=…[&w=EVU:Nr]`, `/api/formation/status`. Bei 401/403: Schlüssel nicht für den Dienst abonniert (Pause 1 h), 429: Pause 10 Min.
- Kompaktformat je Wagen «Typ,Länge,Klasse,Einheit[,von,bis]» (Einheit = gleiche parentEvn).
- Tagesfahrplan-Zeilen tragen jetzt «Kat,Linie,Ziel,Zugnr,agency_id» (UMRECHNUNG 4).
- Seite: `src/zuege3d_modelle.js` (Baureihen als Parametersätze, Geometrie mit Farbe je Fläche, Regeln typeCodeName → Baureihe, Rückfall nach Linie/Unternehmen), `src/zuege3d.js` (three.js r158 aus `/lib/three.min.js`, Custom Layer «zuege3d», Wagen entlang des Laufwegs, Abschnitte an Kopfbahnhöfen, Gleishöhe = Gelände mit Steigungsgrenze). mach_3d.py fügt beide vor karte3d_frame.js ein. Ab Zoom 13.2; Punkte der 3D-Züge werden unsichtbar (`d3`).
- Lokaler Test ohne Kacheln: Stil per Playwright-Route durch einen leeren Stil ersetzen, Gelände aus (`setze3d(false)`), Formation-API mit `OTD_FORMATION_URL` auf einen Mock.

## Netz erweitern
- `tools/netz_neu.py` (neue Strecken als Bahnhofsketten) + `tools/netz_ausbau.py` bauen aus `data/quellen/basis/` (Hauptnetz 23.10.) Stationen, Netz, Gleisverlauf (OSM, `osm_ch_export.json.gz`) und den Fahrplan (Rohdaten `ch_raw_*` + stationboards der neuen Bahnhöfe `ch_sb_neu.json.gz`) neu. Danach `tools/build.py`.
- transport.opendata.ch stationboard: `limit` max. ~400 (500 → HTTP 400); im ersten passList-Eintrag steht eine falsche Halt-ID (wird durch die ID der Tafel ersetzt).
- Neue Bahnhöfe, die auf bestehenden Strecken liegen (< 200 m, gleiche Spurweite), werden automatisch als Zwischenhalt eingefügt.
- Schmalspur/Privatbahnen (25.10.): stationboards in `ch_sb_neu2.json.gz` (ohne Verkehrsmittelfilter, Busse entfernt; Forchbahn/Waldenburgerbahn laufen als «T»). Meterspur, die in OSM als light_rail/tram erfasst ist: `osm_ch_ergaenzung.json.gz`. Haltestellen «Ort, Bahnhof/Station» werden dem nahen Kartenbahnhof zugeordnet.
- Ohne Daten bei transport.opendata.ch (Linie nur gezeichnet): zb Engelberg, MGB Visp–Zermatt, WAB Grindelwald Grund, BVB, Salvan, CJ Tavannes.

## Vision (27.10.2026, ausführlich im Projekt-Dokument claude/vision-roadmap.md)
Ganze Schweiz in 3D (Gelände, Gebäude, Brücken, Tunnels). Züge fahren in Echtzeit auf ihren Gleisen und halten wie in echt. Später kommen Trams, Bergbahnen, Schiffe und Busse dazu, als Erweiterungen Wetter und Verkehr (zuerst Autobahn). Alles ist als einzeln schaltbare Ebene gebaut (Datenteil auf dem Server, Zeichenteil auf der Karte), und die Karte muss auf dem Handy flüssig bleiben.
Entscheid 28.10.: bleibt eine Website (keine Game-Engine), Leistung ist harte Anforderung (Nachladen bei Bedarf, Daten nach Gegend/Zeitfenster, Detailstufen nach Zoom, Instancing, auf dem Handy messen). Vor Etappe 2 Umbau zu Modulen (Kern + Ebenen, Bundler, mach_3d.py fällt weg).
Etappen: 1 3D-Züge fertig → 2 Züge wie in echt (Gleis/Sektor, Anfahren/Bremsen) → 3 3D-Welt (Entscheid MapLibre oder Cesium) → 4 Trams 3D → 5 Bergbahnen/Schiffe → 6 Busse → 7 Wetter/Verkehr.

## Offene Punkte
- Eingebauter Fallback-Fahrplan (data/fahrplan/*.txt) ist vom Fahrplan 2026; auf der Website ersetzt ihn der GTFS-Fahrplan. Für Artifact/Windows-Programm ggf. später aus GTFS neu erzeugen.
