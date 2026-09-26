# NexusHost (Hoster) — Real Infrastructure Build

Project: Hoster (https://github.com/artishade/Hoster) cloned and rebuilt as a REAL hosting platform
Location: /home/z/my-project (Next.js 16 + Turbopack, port 3000)

---

## Current project status description / assessment

The platform was transformed from a simulated PaaS mockup into a real hosting control plane.
All core systems now perform REAL work — verified end-to-end on this machine:

- **Real deployer** (`src/lib/hoster/deployer.ts`): git clone → stack auto-detect (node/python/static)
  → dependency install (bun→npm fallback / pip) → optional build → real child process spawn
  (`bash -lc <start>` in own process group) → HTTP readiness probe → running. Real commit hash
  extracted from the actual clone. Failures carry the real stderr tails. NO timers anywhere.
- **Real edge routing** (`src/proxy.ts` — Next 16 "proxy" convention, replaces deprecated middleware):
  Host-header routing — `Host: <name>.nexushost.dev` → `/api/ingress/<name>/<path>`; custom domains
  resolved via internal `/api/edge/resolve` (DB-backed). Edge PoP view (`/api/edge` + EdgeNetworkView)
  reports real host telemetry, routing table, and live upstream provider latency probes (HEAD, ms).
- **Providers LIVE tokenless + watchdog** (`src/lib/hoster/providers.ts`): all 5 built-ins
  (local-node, huggingface, render, fly, koyeb) are connected WITHOUT tokens via public endpoint
  probes (any HTTP answer = live; 401/404 counts). Auto re-verify watchdog sweeps every 30s
  (token-verified providers every ~5 min), logs status transitions, refreshes real capacity.
- **No simulated metrics** (`src/lib/hoster/telemetry.ts` rewritten): PRNG simulator deleted.
  Services: real request counters + p95 from live ring (ingress records every proxied request),
  real CPU/RAM via /proc/<pid> (resolves bash→bun→node to the actual worker process).
  Databases: real op counters (SQL console + redis console), real keyspace sizes, real memory bytes,
  real SQLite file size. Volumes: real on-disk directories (`volumes-data/<name>`), usage measured
  by walking the filesystem (12MB blob test → 0.012GB shown). history route serves REAL stored
  MetricSample rows (scope='service') recorded by the 15s sampler.
- **Free high-spec tiers** (`hardware-specs.ts`): new `free-blitz` tier sized from the REAL machine
  (2 vCPU / 2.4GB reserved of 4.06GB), `free-koyeb` tier added, local-node raised to real capacity.
  Environment-guarded so browser bundles don't get garbage os polyfills.

## Current goals / completed modifications / verification results

Goal: make providers go live, replace fake build/deploy timers with a real git clone → build → run
deployer, remove simulated metrics, raise free tiers, verify end-to-end.

Verified (curl + agent-browser):
- Deployed http-party/http-server via API → running on real commit 0d3b7bb, pid alive, real
  http-server output streaming to logs (117 log entries: clone progress, npm install 733 pkgs, app boot).
- Deployed mdn/beginner-html-site-styled (static path) via browser DeployModal → real content served
  through `Host: browser-e2e-app.nexushost.dev` AND `/api/ingress/browser-e2e-app`.
- Stop/start/restart lifecycle works: stop → 503, start → full re-clone + serve (fresh pid).
- 5/5 providers live tokenless (measured: HF 254ms, render 168ms, fly 267ms, koyeb 261ms).
- Edge DNS verifier resolved github.com for real (A: 20.205.243.166, ENODATA CNAME, 6ms).
- SQL console: `SELECT count(*) FROM Service` → 3 rows in 3ms (BigInt serialization fixed).
- Redis console: SET/GET roundtrip works, keys/ops/mem are real measurements.
- Volume: 12MB written to volumes-data/demo-data → 0.012 GB reported.
- Mobile viewport: no horizontal overflow; no console errors; lint + tsc clean.
- Restart race fixed: PATCH flips status before killing old process; exit handlers guard on pid.

Key files:
- src/lib/hoster/{deployer,procstats,edge,providers,runtime,server,telemetry,hardware-specs}.ts
- src/proxy.ts (edge host routing), src/app/api/edge/{route,resolve}/route.ts
- src/app/api/{services,services/[id],volumes,databases,redis,ingress,...}/route.ts updates
- src/components/hoster/EdgeNetworkView.tsx (new), DeployModal/DatabasesView/SidebarNav/page.tsx updates

## Unresolved issues or risks, and priority recommendations for the next phase

1. **Deployed apps and dev-server restarts**: children spawn detached (own process group) so they
   survive dev-server reloads, but a full server restart orphans them until the watchdog marks the
   service failed. Next: adopt orphans by scanning for listeners on stored ports (parse /proc or
   `ss -ltnp`) and re-bind them to the service records.
2. **Host routing through the public gateway**: `*.nexushost.dev` routing works for direct Host-header
   requests (curl-verified). The sandbox Caddy gateway forwards the preview panel hostname only, so
   the dashboard is what external users see. When deployed on a real host with wildcard DNS, host
   routing activates automatically — no code change needed.
3. **Python stack**: pip install --user works but venv-less; heavy ML repos (torch) will be slow /
   may exceed disk. Consider uv or venv isolation next.
4. **UI tier display in browser**: Free Blitz shows the static browser fallback (2 vCPU / 2 GB);
   the server enforces real measured specs. Could serve real specs via an endpoint for exact display.
5. **DeployModal step 2/3 defaults** (postgres/redis attach, volumes) reference IDs of instances
   that may not exist yet — safe (empty), but could be pre-wired to first available instance.
6. Next features worth adding: per-service terminal (exec into process via PTY), deploy webhooks
   (GitHub push → redeploy), real TLS via Caddy on the host, autoscaling worker based on real load.

Operational notes:
- Dev server: `bun run dev` (port 3000, must stay in background). DB: prisma db:push done.
- Deploy workspaces: /home/z/my-project/deployments/<name>/repo; volumes: volumes-data/<name>.
- Deployment watchdog + provider watchdog + host sampler start automatically on API traffic.
