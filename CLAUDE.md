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

## 3D-Karte (Etappe 2, Prototyp seit 26.10.2026)
- `src/template3d.html` → `app/public/3d.html` (build.py, gleiche Platzhalter), Server liefert sie unter `/3d` mit eigener CSP aus. MapLibre GL 5.6.0 (CSP-Build) liegt selbst ausgeliefert in `app/public/lib/` (`/lib/…`).
- Grundkarte: swisstopo-Vektorkacheln (`vectortiles.geo.admin.ch/styles/ch.swisstopo.lightbasemap.vt/style.json`), Gelände: Mapterhorn (`tiles.mapterhorn.com/{z}/{x}/{y}.webp`, terrarium, 512 px), beide ohne Schlüssel.
- `src/template3d.html` wird von `tools/mach_3d.py` aus `src/template.html` ERZEUGT (nicht von Hand ändern): ganze Logik der 2D-Karte (Fahrplan, Echtzeit, Sperrungen, Abfahrten, Suche, Seitenleiste) bleibt, die Darstellung (SVG/Canvas) wird durch `src/karte3d.js` (MapLibre, Ebenen, Klicks) und `src/karte3d_frame.js` (Fahrzeuge als GeoJSON ~15×/s) ersetzt. Nach Änderungen an der 2D-Vorlage: `python3 tools/mach_3d.py && python3 tools/build.py`.
- Kartenkoordinaten → WGS84 per swisstopo-Näherung; Linien mit Chaikin geglättet. `/2d` = alte Karte.
- Schriften der swisstopo-Grundkarte nur bis U+00FF: Zeichen wie «–» oder «′» in Symbol-Ebenen lassen die ganze Quelle ausfallen (Labels werden bereinigt).

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

## Netz erweitern
- `tools/netz_neu.py` (neue Strecken als Bahnhofsketten) + `tools/netz_ausbau.py` bauen aus `data/quellen/basis/` (Hauptnetz 23.10.) Stationen, Netz, Gleisverlauf (OSM, `osm_ch_export.json.gz`) und den Fahrplan (Rohdaten `ch_raw_*` + stationboards der neuen Bahnhöfe `ch_sb_neu.json.gz`) neu. Danach `tools/build.py`.
- transport.opendata.ch stationboard: `limit` max. ~400 (500 → HTTP 400); im ersten passList-Eintrag steht eine falsche Halt-ID (wird durch die ID der Tafel ersetzt).
- Neue Bahnhöfe, die auf bestehenden Strecken liegen (< 200 m, gleiche Spurweite), werden automatisch als Zwischenhalt eingefügt.
- Schmalspur/Privatbahnen (25.10.): stationboards in `ch_sb_neu2.json.gz` (ohne Verkehrsmittelfilter, Busse entfernt; Forchbahn/Waldenburgerbahn laufen als «T»). Meterspur, die in OSM als light_rail/tram erfasst ist: `osm_ch_ergaenzung.json.gz`. Haltestellen «Ort, Bahnhof/Station» werden dem nahen Kartenbahnhof zugeordnet.
- Ohne Daten bei transport.opendata.ch (Linie nur gezeichnet): zb Engelberg, MGB Visp–Zermatt, WAB Grindelwald Grund, BVB, Salvan, CJ Tavannes.

## Offene Punkte
- Eingebauter Fallback-Fahrplan (data/fahrplan/*.txt) ist vom Fahrplan 2026; auf der Website ersetzt ihn der GTFS-Fahrplan. Für Artifact/Windows-Programm ggf. später aus GTFS neu erzeugen.
