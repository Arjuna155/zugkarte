# Hinweise für Claude

Projekt von Arjuna (spricht Deutsch, Schweiz). Antworten und Texte in der Karte auf Deutsch (Schweizer Schreibweise: «ss» statt «ß»).

## Architektur
- Statische Einzelseite `app/public/index.html`, gebaut von `tools/build.py` aus `src/template.html` + `data/`. Nach jeder Änderung an Vorlage oder Daten **immer** `python3 tools/build.py` laufen lassen und das Ergebnis mitcommitten.
- `app/server.js` (Node 22, keine Abhängigkeiten) liefert die Seite aus, injiziert `window.ZK_LOCAL={mode:"server"}` und stellt `/api/verspaetungen` bereit (SIRI-ET, gecacht 60 s, nur auf Anfrage).
- Auf dem NAS (UGREEN, UGOS Pro, Docker) läuft `deploy/launcher.js` im Container `node:22-alpine`. Er prüft alle 5 Min. `main` auf GitHub, lädt `app/` als Tarball, startet die neue Version und prüft `/api/ping`. Schlägt das fehl, bleibt die alte Version aktiv.
- Öffentlich erreichbar über Tailscale Funnel (Container `zugkarte-tailscale`).
- Schlüssel liegen als Dateien in `data/` auf dem NAS (`schluessel.txt`, `tailscale-key.txt`). Umgebungsvariablen in UGOS Pro kamen bei Arjuna nicht im Container an – deshalb Dateien. `ZK_COMPOSE` in der Compose-Datei zeigt im Protokoll, welche Konfigurationsversion läuft.

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

## Offene Punkte
- Fahrplan vor dem Fahrplanwechsel am 13.12.2026 neu laden (Quelle: transport.opendata.ch stationboard, nur aus dem Browser erreichbar).
- Engelberg-Strecke und MGB Visp–Zermatt haben keine Fahrplandaten.
