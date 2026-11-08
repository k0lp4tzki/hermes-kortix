# Hermes – Homelab Monitoring

Hermes is an agentless monitoring platform for homelabs: inventory and discovery of hosts,
Docker containers and services, real checks with a threshold-based state engine, dependency
analysis with root-cause suppression, alerting via webhooks, long-term history in TimescaleDB
and a dark NOC-style "Command Center" UI.

> Work in progress: see `docs/` and the change requests per milestone. Full documentation
> follows with milestone 5.

## Quick start

```bash
cp .env.example .env      # change every value marked CHANGE ME
docker compose up -d --build
# open http://localhost:8080 and log in with HERMES_ADMIN_USER / HERMES_ADMIN_PASSWORD
```

## Kortix project files

This repository is also a Kortix project: `kortix.yaml`, `agents/`, `skills/` and `memory/`
configure the Kortix agents working on it and are not part of the Hermes product.
