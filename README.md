# ZugKarte

Interaktive Karte des Schweizer Bahn-Hauptnetzes: echter Gleisverlauf, alle Züge nach dem aktuellen Tagesfahrplan und Verspätungen in Echtzeit.

## So läuft die Website

```
GitHub (dieses Repo)  ──►  NAS: Container «zugkarte»  ──►  Tailscale Funnel  ──►  https://zugkarte.<tailnet>.ts.net
                            │  holt alle 5 Min. neue Versionen
                            └─ holt Echtzeit von opentransportdata.swiss (nur wenn jemand die Karte offen hat, max. 1×/Min.)
```

- **Updates:** Alles, was auf `main` landet, übernimmt das NAS automatisch innerhalb von etwa 5 Minuten. Startet eine neue Version nicht, läuft die alte weiter.
- **Zurücknehmen:** Einen Commit auf GitHub rückgängig machen (Revert) – das NAS holt die Korrektur genauso automatisch.
- **Geheimnisse:** Der API-Schlüssel steht in `data/schluessel.txt` im Projektordner auf dem NAS (oder in `OTD_API_KEY`), der Tailscale-Key in der Docker-Konfiguration – nie in diesem Repo.

## Aufbau

| Pfad | Inhalt |
|---|---|
| `src/template.html` | Quelltext der Karte (HTML, CSS, JavaScript) mit Platzhaltern für die Daten |
| `data/` | Netz (Strecken, Bahnhöfe, Gleisgeometrie), Fahrpläne Mo–Fr / Sa / So, Bahnhofsnummern |
| `tools/build.py` | Baut `app/public/index.html` aus Vorlage und Daten |
| `app/server.js` | Webserver für das NAS: liefert die Karte, verarbeitet den Echtzeitfeed SIRI-ET |
| `app/public/index.html` | Fertig gebaute Karte (wird mitcommittet, das NAS liefert genau diese Datei aus) |
| `deploy/launcher.js` | Starter mit Selbst-Update im Container |
| `deploy/docker-compose.yml` | Konfiguration für UGOS Pro → Docker → Projekt |

## Änderungen machen

1. `src/template.html` oder `data/` anpassen
2. `python3 tools/build.py`
3. Lokal testen: `PORT=8080 node app/server.js` → http://127.0.0.1:8080 (mit `OTD_API_KEY=...` auch Echtzeit)
4. Committen und auf `main` pushen – das NAS aktualisiert sich selbst.

## Datenquellen

- Gleisverlauf: Schienennetz des BAV über geo.admin.ch
- Fahrplan: transport.opendata.ch (gültig bis Fahrplanwechsel 13.12.2026)
- Echtzeit: SIRI-ET von opentransportdata.swiss (eigener API-Schlüssel nötig)
