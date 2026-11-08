# Hermes – Homelab-Monitoring mit Command Center

Hermes ist eine agentenlose Monitoring-Plattform für Homelabs, die ohne Neuentwicklung auf
größere Umgebungen wachsen kann. Sie erkennt Hosts, Docker-Container, Compose-Projekte und
Dienste, prüft sie mit echten Checks, bewertet Zustände über eine Schwellwert- und
Hysterese-Engine, ermittelt über ein Abhängigkeitsmodell die Ursache von Ausfällen, alarmiert per
Webhook und speichert alle Messwerte langfristig in TimescaleDB. Die Oberfläche ist ein dunkles
NOC-/Command-Center mit interaktiver Infrastrukturkarte.

Alle Werte in der Oberfläche stammen aus echten Prüfungen. Was ohne Berechtigung, API oder
Datenquelle nicht messbar ist (z. B. SMART, Temperatursensoren, Speicherlimits), wird als
**„nicht verfügbar“** mit Grund angezeigt, nie geschätzt.

## Schnellstart

Voraussetzungen: Docker Engine ≥ 24 mit Compose v2, Linux-Host (für Host-Metriken).

```bash
git clone <dieses Repository> hermes && cd hermes
cp .env.example .env
# .env bearbeiten: POSTGRES_PASSWORD, HERMES_SECRET_KEY (openssl rand -base64 32),
#                  HERMES_ADMIN_USER, HERMES_ADMIN_PASSWORD (mind. 8 Zeichen)
docker compose up -d --build
```

Dann `http://<host>:8080` öffnen und mit `HERMES_ADMIN_USER` / `HERMES_ADMIN_PASSWORD` anmelden.
Der erste Start baut das Image (2–4 Minuten). Nach etwa einer Minute zeigt das Command Center
den Host, die Hermes-eigenen Container und die Selbstüberwachung mit echten Messwerten.

Stoppen: `docker compose down` (Daten bleiben im Volume `hermes-db`).
Alles löschen: `docker compose down -v`.

## Erste Schritte in der Oberfläche

1. **Discovery → Inbox**: Hermes zeigt alle gefundenen Container (und optional Netzwerk-Endpunkte).
   Nichts davon wird automatisch überwacht. Auswählen, „Übernehmen“ (mit/ohne Überwachung) oder
   „Ignorieren“ (optional dauerhaft per Regel). Unter **Regeln** lassen sich automatische
   Übernahme/Ignorieren nach Name, Image, Compose-Projekt, Label, Netzbereich oder Port festlegen,
   mit Vorschau der Treffer.
2. **Inventar**: alle Ressourcen mit Suche, Filtern (Host, Typ, Compose-Projekt, Umgebung, Status,
   Kritikalität, Verantwortlich, Tags, Erkennung, Überwachung, Discovery-Status), Sortierung und
   Gruppierung; Massenbearbeitung; Ansichten „Fehlend/verwaist“ und „Duplikate“ (zusammenführen).
3. **Ressource → Checks**: Standard-Checks sind angelegt (Container-Zustand, Logs, Host-Metriken).
   Weitere Checks hinzufügen: HTTP(S) mit Statuscode/Body/JSON-Prüfungen, TCP, Ping, DNS, TLS,
   SSH-Banner, PostgreSQL, MySQL/MariaDB, Redis, systemd, Backup-Aktualität, Job-Heartbeat,
   Ablauf von Zugangsdaten. Zugangsdaten vorher unter **Einstellungen → Zugangsdaten** speichern.
4. **Command Center → „+ Infrastruktur“**: Router, Firewall, Switch, WAN, NAS usw. anlegen und mit
   Hosts verbinden (VLAN/Subnetz als Kantenattribut). Mit Adresse/URL bekommen sie Ping/HTTP/TLS-Checks.
5. **Abhängigkeiten**: Kanten im Graph ziehen oder per Dialog anlegen (Anwendung → Datenbank,
   Proxy → Backend, Dienst → DNS, Backup → Quelle/Storage, Anwendung → externe API …).
   Container → Host und `docker compose depends_on` werden automatisch erkannt.
6. **Benachrichtigungen**: Webhook-Kanal anlegen (Test senden), Routing-Regel anlegen. Ohne
   Routing-Regel wird nichts versendet.
7. **Alarme**: offene/behobene Störungen mit Ursache, Betroffenen, Verlauf, Häufigkeit;
   Wartungsfenster planen.
8. **Plattform**: Heartbeats von API und Worker, Scheduler-Verzug, Check-Rückstau, DB-Zustand,
   Aufbewahrungs- und Downsampling-Jobs.

### Job-Heartbeats (Backups, Cronjobs)

Check „Job-Heartbeat (Push)“ an einer Ressource anlegen; die Check-Bearbeitung zeigt die URL:

```bash
# am Ende des Backup-Skripts
curl -fsS https://hermes.example/api/push/<token>?msg=ok
# im Fehlerfall
curl -fsS "https://hermes.example/api/push/<token>?status=fail&msg=rsync%20exit%2023"
```

### Webhook-Format

```json
{ "version": 1, "source": "hermes", "event": "critical|warning|recovery|reminder|test",
  "dedup_key": "hermes:incident:<id>", "timestamp": "…", "message": "[CRITICAL] …",
  "incident": { "id": "…", "status": "open", "severity": "critical", "title": "…", "opened_at": "…",
                "duration_s": 79, "occurrences_7d": 1, "flapping": false, "url": "…" },
  "resource": { "id": "…", "name": "homelab/postgres", "kind": "container", "host": "…", "tags": [] },
  "root_cause": { "id": "…", "name": "homelab/postgres" },
  "impacted": [ { "id": "…", "name": "homelab/app", "kind": "container", "status": "ok" } ],
  "suppressed_symptoms": [ … ], "checks": [ { "name": "…", "type": "postgres", "state": "critical", "message": "…" } ] }
```

Mit HMAC-Secret enthält der Header `X-Hermes-Signature: sha256=<hex(HMAC-SHA256(body))>`.

## Konfiguration (.env)

| Variable | Bedeutung | Standard |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | Passwort der internen TimescaleDB | – (Pflicht) |
| `HERMES_SECRET_KEY` | Schlüssel für die Verschlüsselung gespeicherter Zugangsdaten (AES-256-GCM) | – (Pflicht) |
| `HERMES_ADMIN_USER` / `HERMES_ADMIN_PASSWORD` | erster Admin, nur beim ersten Start | `admin` / – |
| `HERMES_PORT`, `HERMES_BIND` | Port/Adresse der Oberfläche | `8080`, `0.0.0.0` |
| `HERMES_COOKIE_SECURE` | `true` hinter HTTPS | `false` |
| `HERMES_PUBLIC_URL` | Basis-URL für Links in Webhooks, z. B. `https://hermes.lab.local` | – |
| `HERMES_HOST_NAME` | Anzeigename des Docker-Hosts | Hostname |
| `HERMES_WORKER_CONCURRENCY` | parallele Checks | `16` |
| `HERMES_RETENTION_*_DAYS` | Aufbewahrung: Rohdaten 14, Check-Ergebnisse 30, 5-min-Mittel 180, Stundenmittel 1095, Ereignisse 365 | |

### Rechte und Mounts des Workers

| Mount / Recht | wofür | ohne |
| --- | --- | --- |
| `/var/run/docker.sock:ro` | Container-Discovery, Status, Stats, Logs | Container-Funktionen „nicht verfügbar“ |
| `/proc:/host/proc:ro` | CPU, RAM, Swap, Load, Prozesse, Disk-I/O, Netz | Host-Metriken „nicht verfügbar“ |
| `/sys:/host/sys:ro` | Temperaturen, Hardware-Infos | Temperaturen „nicht verfügbar“ |
| `/:/hostfs:ro` | Dateisystem-Belegung, Inodes, os-release, systemd-Units, Backup-Dateien | entsprechende Werte „nicht verfügbar“ |
| `cap_add: NET_RAW` | ICMP-Ping | Ping-Checks „unknown“ mit Grund |

Der Docker-Socket ist auch read-only gemountet ein mächtiges Recht (lesender Zugriff auf alle
Container-Konfigurationen inkl. Umgebungsvariablen). Hermes ruft nur lesende API-Endpunkte auf.
Wer das nicht möchte, entfernt den Mount oder nutzt einen Socket-Proxy (z. B. Tecnativa
docker-socket-proxy mit `CONTAINERS=1, INFO=1`) und trägt ihn als Docker-Quelle `tcp://…` ein.

### Weitere Docker-Hosts

Discovery → Quellen → „Quelle anlegen“, Typ Docker, Endpunkt `tcp://<host>:2375` (oder über einen
Socket-Proxy). Container-Checks laufen dann gegen diese Engine. Host-Metriken (/proc) gibt es
agentenlos nur für den Host, auf dem Hermes läuft; andere Hosts werden über Ping/TCP/HTTP/SSH
geprüft.

## Architektur

Kurzfassung (Details in [docs/architecture.md](docs/architecture.md)):

```
 Browser ── HTTP/SSE ──▶ api (Fastify)  ── SQL / LISTEN ──▶ TimescaleDB
                              ▲                                ▲
                              └──── NOTIFY (Live-Updates) ─────┤
                                                               │
 worker: Scheduler ▸ Check-Executor ▸ Zustands-Engine ▸ Bewertung (Abhängigkeiten, Wartung)
         ▸ Störungen ▸ Benachrichtigung      Discovery-Adapter ▸ Reconciliation ▸ Inbox/Regeln
```

- **server/** (TypeScript, Node 22): ein Image, zwei Rollen. `api` liefert REST, SSE und die
  Oberfläche aus; `worker` führt Discovery, Checks, Bewertung und Alarmierung aus. Mehrere
  Worker können parallel laufen (`FOR UPDATE SKIP LOCKED`).
- **server/src/core/**: reine, getestete Logik – Discovery-Regeln und Reconciliation,
  Zustandsmaschine, Abhängigkeitsanalyse, Benachrichtigungsentscheidungen.
- **server/src/discovery/**, **server/src/checks/**: Adapter- bzw. Plugin-Schnittstellen
  (`DiscoveryAdapter`, `CheckExecutor`) mit Registry – neue Quellen (Podman, SNMP, Proxmox,
  Windows) und Check-Typen werden dort ergänzt, ohne Scheduler, Engine oder UI umzubauen.
- **server/migrations/**: SQL-Migrationen, automatisch beim Start (Advisory-Lock).
- **web/** (React, Vite, TanStack Query, React Flow + dagre, uPlot): Command Center, Inventar,
  Ressourcen-Detail, Discovery, Checks, Abhängigkeiten, Alarme, Benachrichtigungen,
  Einstellungen, Plattform.

## Entwicklung

```bash
pnpm install
docker compose up -d db                       # nur die Datenbank
export DATABASE_URL=postgres://hermes:<pw>@localhost:5432/hermes HERMES_SECRET_KEY=dev-key-0123456789 HERMES_ADMIN_PASSWORD=admin1234
# (für lokale Entwicklung den Port 5432 des db-Service freigeben)
pnpm --filter @hermes/server dev:api          # API auf :8080
pnpm --filter @hermes/server dev:worker       # Worker
pnpm --filter @hermes/web dev                 # UI auf :5173 (Proxy auf :8080)
pnpm test                                     # Unit-Tests (Vitest)
pnpm typecheck
```

## Grenzen von v1

- Agentenlos: Host-Metriken nur für den Host, auf dem der Worker läuft; keine Windows-Agenten,
  kein SNMP, keine physische L2/VLAN-Erkennung (Netzwerke/VLANs als manuelle Attribute).
- Benachrichtigungskanal: generischer JSON-Webhook (ntfy, Gotify, Home Assistant, n8n,
  Matrix-/Slack-/Discord-Bridges lassen sich damit anbinden).
- SMART-Werte benötigen privilegierten Zugriff und sind nicht aktiviert.
- Podman: Adapter-Schnittstelle vorhanden; die Docker-kompatible Podman-API funktioniert als
  Docker-Quelle (`unix:///run/podman/podman.sock` mounten).
- Kein Prometheus-Export; Messwerte liegen in TimescaleDB (Rohdaten + 5-min- und Stunden-Aggregate).

## Kortix-Projektdateien

Dieses Repository ist zugleich ein Kortix-Projekt: `kortix.yaml`, `agents/`, `skills/` und
`memory/` konfigurieren die Kortix-Agenten und gehören nicht zum Produkt Hermes.
