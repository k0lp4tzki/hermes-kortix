# Hermes (homelab monitoring product)

The repository root holds **Hermes**, a homelab monitoring product built from the brief in
session 51fe77da (German "Auftrag"). It lives next to the Kortix project files.

- Layout: `server/` (TypeScript, Fastify, pg; roles `api` and `worker` from one image),
  `web/` (React + Vite, React Flow + dagre, uPlot, TanStack Query), `server/migrations/` (SQL,
  applied on start), `docs/architecture.md`, `docker-compose.yml`, `.env.example`.
- Pure, unit-tested logic sits in `server/src/core/` (rules, reconcile, state, deps, alerting);
  run `pnpm test` (Vitest).
- Extension points: `DiscoveryAdapter` (`server/src/discovery/registry.ts`) and `CheckExecutor`
  (`server/src/checks/registry.ts`).
- Verify end to end: `cp .env.example .env`, set passwords, `docker compose up -d --build`,
  login at :8080. In a Kortix sandbox Docker must be installed first
  (`apt-get install docker.io docker-compose-v2`, start `dockerd` manually: no systemd).
- Gotchas: pnpm 11 rejects packages younger than 24 h (`minimumReleaseAge`) and needs
  `allowBuilds: esbuild` in `pnpm-workspace.yaml`; the `/:/hostfs` mount must not use `rslave`
  (fails on hosts where `/` is not a shared mount); TimescaleDB continuous aggregates need
  `materialized_only = false` for real-time rollups; continuous aggregate migrations need the
  `-- hermes:no-transaction` marker.
- The project GitHub repo named in the brief (k0lp4tzki/hermes-kortix) was not reachable from
  the sandbox; delivery went through Kortix change requests on this project's repo.
- Dependency suggestions: pure logic in `server/src/core/suggest.ts`, collector in
  `server/src/worker/suggestions.ts` (container netns via `/host/proc/<pid>/net/tcp`, routes,
  resolv.conf, VMware facts), API `server/src/api/routes/suggestions.ts`. VMware client
  `server/src/lib/vsphere.ts` (SOAP vim25); no real ESXi was available, it was verified against
  a SOAP mock only (the user has 2 standalone ESXi hosts).
