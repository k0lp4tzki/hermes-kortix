# Hermes – Architektur

## Komponenten

| Komponente | Rolle |
| --- | --- |
| `db` (TimescaleDB 2.17 / PostgreSQL 16) | Inventar, Konfiguration, Ereignisse, Störungen; Hypertables `metrics` und `check_results` mit Kompression, Continuous Aggregates `metrics_5m` und `metrics_1h` (Echtzeit), Aufbewahrungsrichtlinien |
| `api` | Fastify-Server: REST-API unter `/api`, Server-Sent Events unter `/api/live`, statische Auslieferung der Oberfläche, Login/Sessions, Migrationen beim Start |
| `worker` | Hintergrundschleifen: Scheduler (500 ms), Bewertung (bei neuen Ergebnissen, spätestens alle 15 s), Discovery (2 s Takt, je Quelle eigenes Intervall), Bereinigung (stündlich); schreibt Heartbeats |
| `web` (im api-Image) | React-SPA |

Beide Node-Rollen nutzen dasselbe Image und dieselbe Codebasis (`server/`). Live-Updates laufen
über `pg_notify('hermes_live', …)` → eine LISTEN-Verbindung der API → SSE an alle Browser; die
Oberfläche invalidiert daraufhin gezielt ihre Abfragen (TanStack Query).

## Datenfluss

```
Discovery-Quelle ─▶ Adapter.discover() ─▶ core/reconcile (rein) ─▶ Plan ─▶ DB
                                              │
                         Regeln (core/rules) ─┘  auto_accept ▸ Ressource + Standard-Checks
                                                 ignore      ▸ Kandidat "ignoriert"
                                                 (Standard)  ▸ Kandidat "Inbox"

Scheduler ─▶ CheckExecutor.run() ─▶ Schwellwerte (core/state) ─▶ Zustandsmaschine ─▶ check_results, metrics, events
                                                                                         │
Bewertung ◀──────────────────────────────────────────────────────────────────────────────┘
  1. Ressourcenstatus = schlechtester bestätigter Check-Zustand
  2. core/deps: Ursachen, Folgefehler, betroffene nachgelagerte Komponenten
  3. Wartungsfenster
  4. Störungen je Ursache ─▶ core/alerting (Dedup, Flapping, Wartung, Erinnerung) ─▶ Webhook
```

## Datenmodell (Auszug)

- `resources`: stabile UUID, `identity_key` (logische Identität aus der Discovery, z. B.
  `docker:<engine>/compose/<projekt>/<service>`), Typ, Name/Anzeigename, `parent_id` (Host),
  Umgebung, Gruppe, Kritikalität, Verantwortlich, Tags, Metadaten, `discovered` (von der Discovery
  verwaltet), `connection`, Herkunft (auto/manuell), Quelle, Discovery-Status
  (active/missing/orphaned/detached), erste/letzte Sichtung, letzter OK-Check, Überwachung an/aus,
  Status + Zeitpunkt, `locked_fields` (von Personen geänderte Felder), Analyseergebnis
  (`root_cause_ids`, `impacted_by`, `in_maintenance`).
- `resource_aliases`: Identitäten zusammengeführter Ressourcen → Überlebende.
- `discovery_sources`, `discovery_candidates` (Inbox), `discovery_rules`.
- `checks`: Typ, Konfiguration, Secret, Intervall, Timeout, Schwellwerte, `fail_after`,
  `recover_after`, `hold_s`, Zustandsmaschine (hart/weich, Serie, Flap-Historie), letzte Messwerte.
- `check_results`, `metrics` (Hypertables), `metric_series` (Katalog je Ressource).
- `dependencies`: `from` hängt von `to` ab, Typ, hart/weich, Herkunft, `suppressed`, Attribute
  (Netzwerk, Subnetz, VLAN, Port).
- `incidents`, `notification_channels`, `routing_rules`, `notifications`, `maintenance_windows`.
- `events`: Zeitstrahl aller Zustands-, Konfigurations-, Discovery- und Alarmereignisse.
- `users`, `user_sessions`, `secrets` (AES-256-GCM), `audit_log`, `platform_heartbeats`, `settings`.

## Discovery-Regeln

- Entdeckt ≠ überwacht. Ohne passende Regel landet jeder Fund in der Inbox.
- Standardregeln beim ersten Start: Label `hermes.ignore=true` ignorieren; Hermes-eigene
  Compose-Services automatisch übernehmen und überwachen (Selbstüberwachung); den lokalen Host
  übernehmen. Der Netzwerk-Scan ist angelegt, aber deaktiviert und ohne Bereiche.
- Container-Neuerstellung: Die Identität basiert auf Compose-Projekt/Service (bzw. Name), die
  Container-ID ist nur ein Attribut. Eine neue ID erzeugt das Ereignis „neu erstellt“ und keine
  neue Ressource. Container-Checks folgen der neuen ID automatisch.
- Manuelle Änderungen sperren das Feld gegen Überschreiben (`locked_fields`, im UI mit
  Schlüssel-Symbol, wieder freigebbar). „Von Discovery lösen“ entkoppelt eine Ressource ganz.
- Nicht mehr gefundene Ressourcen werden „fehlend“, nach `orphan_after_s` „verwaist“.
- Duplikate: gleiche Container-ID, gleiche Adresse oder ähnlicher Name; Zusammenführen
  verschiebt Checks, Kanten, Ereignisse, Störungen und legt einen Alias an.

## Zustands-Engine

- Ein Check-Lauf liefert einen eigenen Befund (z. B. Verbindung fehlgeschlagen → critical) und
  Messwerte. Schwellwerte (`metric op warning/critical`, Wildcards wie `fs_used_percent:*`)
  werden darauf angewendet; der Rohzustand ist das Schlechteste aus beidem.
- Ein neuer schlechter Zustand wird erst nach `fail_after` aufeinanderfolgenden Ergebnissen
  **und** `hold_s` Sekunden hart; Recovery nach `recover_after` guten Ergebnissen.
- Flapping: gewichteter Anteil der Zustandswechsel der letzten 21 Ergebnisse; ab 50 % flatternd,
  unter 25 % wieder stabil. Flatternde Störungen werden erfasst, aber nicht gemeldet.
- Unknown = Messung nicht möglich (Konfiguration, fehlende Rechte); erzeugt keine Benachrichtigung.

## Abhängigkeiten und Ursachenanalyse

- Kante `A → B` bedeutet „A hängt von B ab“. Harte Kanten erklären Ausfälle, weiche nur Auswirkungen.
- Eine gestörte Ressource ist Folgefehler, wenn über harte Kanten ein *critical* Anbieter
  erreichbar ist (nur über gestörte Zwischenknoten). Die obersten gestörten Anbieter sind die
  Ursachen. Pro Ursache gibt es genau eine Störung; Folgefehler werden ihr zugeordnet.
- Alle nachgelagerten Komponenten einer critical-Ursache (harte und weiche Kanten) gelten als
  betroffen, auch wenn ihre eigenen Checks noch grün sind.

## Erweiterung

- **Neue Discovery-Quelle**: `DiscoveryAdapter` in `server/src/discovery/` implementieren
  (`availability`, `discover` → `DiscoveredItem[]` mit stabiler `identityKey`), in
  `registry.ts` eintragen, Typ in Migration/Validierung freischalten.
- **Neuer Check-Typ**: `CheckExecutor` in `server/src/checks/` implementieren (Felder,
  Metrik-Katalog, Standard-Schwellwerte, `run`), in `registry.ts` eintragen. Editor und
  Diagramme der Oberfläche sind generisch.
- **Skalierung**: weitere `worker`-Instanzen starten; Checks werden per `SKIP LOCKED` verteilt.
  Discovery-Quellen laufen sequentiell; bei mehreren Workern in allen außer einem
  `HERMES_DISCOVERY_ENABLED=false` setzen.

## Sicherheit

- Passwörter mit bcrypt (Kosten 12), Session-Token als zufälliger 256-bit-Wert im httpOnly-
  Cookie (SameSite=Lax), in der DB nur als SHA-256-Hash; Login-Drosselung nach 5 Fehlversuchen.
- Rollen: `viewer` (nur lesen), `operator` (konfigurieren), `admin` (zusätzlich Benutzer/Audit).
- Schreibende API-Aufrufe erwarten `application/json`; Formular-Posts anderer Seiten scheitern
  daher (CSRF-Schutz zusätzlich zu SameSite).
- Zugangsdaten: AES-256-GCM mit Schlüssel aus `HERMES_SECRET_KEY`; die API gibt Werte nie zurück.
- DB-Checks setzen `default_transaction_read_only` bzw. führen nur lesende Abfragen aus.
- SSH-Check liest nur das Banner. Der Netzwerk-Scan ist opt-in und begrenzt.
