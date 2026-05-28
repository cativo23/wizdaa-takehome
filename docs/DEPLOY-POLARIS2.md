# polaris2 deployment plan — Time-Off Microservice

## Target server snapshot

| Item | Value |
|---|---|
| OS | Ubuntu 24.04.4 LTS (Noble Numbat) |
| Kernel | 6.8.0-117-generic |
| Uptime | 3 days, 11h |
| RAM | 7.6 GiB total / ~4.6 GiB available |
| Disk | 75 GiB root / 25 GiB used / 47 GiB free (35%) |
| Docker | 29.4.1 |
| Docker Compose | v5.1.3 |
| Docker daemon | active (systemd) |

## Traefik setup

- **Provider**: Dual — Docker labels (via `dockerproxy` socket proxy on tcp://dockerproxy:2375) + file-based dynamic config
- **Main config**: `/home/cativo23/space-server/traefik/traefik.yml`
- **Dynamic config dir**: `/home/cativo23/space-server/traefik/dynamic/` (contains `auth.yml`, `middlewares.yml`)
- **TLS**: `certResolver=letsencryptresolver` — Let's Encrypt TLS challenge, cert stored at `/home/cativo23/space-server/traefik/letsencrypt/acme.json`
- **HTTP→HTTPS redirect**: configured globally at the `web` entrypoint
- **Traefik image**: `traefik:v3.6.17` (healthy, up 3 days)
- **Docker network all services join**: `space-server_web` (external)
- **Available file middlewares**: `security-headers@file`, `auth@file` (basic auth), `mail-ratelimit@file`, `mail-headers@file`

## DNS

`cativo.dev` resolves to `167.235.52.161`. polaris2 public IP is `167.235.52.161`. **Match: yes.**

## Existing services + subdomains

| Container | Host | Notes |
|---|---|---|
| portfolio-prod-app-1 | `cativo.dev` | Nuxt 4 portfolio (root domain) |
| portfolio-api-deploy-api-1 | `api.cativo.dev` | NestJS portfolio API |
| nightwire-docs-app-1 | `nightwire.cativo.dev` | Design system docs |
| ghost-blog-prod-ghost-1 | `blog.cativo.dev` | Ghost blog |
| grafana | `grafana.cativo.dev` | Grafana (auth@file gated) |
| prometheus | `prometheus.cativo.dev` | Prometheus (auth@file gated) |
| alertmanager | `alertmanager.cativo.dev` | Alertmanager (auth@file gated) |
| uptime-kuma | `uptime.cativo.dev` + `status.cativo.dev` | Uptime monitor |
| webmail | `mail.cativo.dev` | Roundcube webmail |
| traefik | `traefik.cativo.dev` | Traefik dashboard (auth@file gated) |
| dozzle | `dozzle.cativo.dev` | Container log viewer (auth@file gated) |
| hello-kitty-landing-app-1 | `devi.cativo.dev` | Hello Kitty landing page |

**Taken subdomains**: `cativo.dev`, `api`, `nightwire`, `blog`, `grafana`, `prometheus`, `alertmanager`, `uptime`, `status`, `mail`, `traefik`, `dozzle`, `devi`

## Recommended subdomain

| Subdomain | Rationale |
|---|---|
| **`ooo.cativo.dev`** *(top pick)* | "Out Of Office" — the whole product's vibe in 3 letters. Short, punny, actually memorable. Carlos will smirk. |
| `pto.cativo.dev` | Industry shorthand; instantly recognizable to anyone who's worked at a tech company |
| `leave.cativo.dev` | Clean, literal, professional fallback |

## Deployment recipe

Create `/home/cativo23/deploy/timeoff-service/compose.prod.yml` on polaris2:

```yaml
services:
  app:
    image: ${DOCKER_USERNAME:-cativo23}/timeoff-service:latest
    restart: unless-stopped
    environment:
      NODE_ENV: production
      PORT: 3000
      DATABASE_PATH: /app/data/timeoff.sqlite
      HCM_BASE_URL: ${HCM_BASE_URL}          # real HCM endpoint — no mock in prod
      RESERVATION_TTL_DAYS: 14
      HCM_RETRY_MAX_ATTEMPTS: 5
      HCM_RETRY_BACKOFF_MS: 1000
    volumes:
      - timeoff-data:/app/data
    networks:
      - space-server_web
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/health"]
      interval: 30s
      timeout: 3s
      retries: 3
      start_period: 10s
    restart: unless-stopped
    labels:
      - "traefik.enable=true"
      - "traefik.docker.network=space-server_web"
      - "traefik.http.routers.timeoff.rule=Host(`ooo.cativo.dev`)"
      - "traefik.http.routers.timeoff.entrypoints=websecure"
      - "traefik.http.routers.timeoff.tls.certresolver=letsencryptresolver"
      - "traefik.http.services.timeoff.loadbalancer.server.port=3000"
      - "traefik.http.routers.timeoff.middlewares=security-headers@file"

networks:
  space-server_web:
    external: true

volumes:
  timeoff-data:
    driver: local
```

Create a `.env` alongside it:
```
DOCKER_USERNAME=cativo23
HCM_BASE_URL=https://your-real-hcm-endpoint
```

> **Note**: The `mock-hcm` service from `compose.yml` is dropped here. In production you supply a real `HCM_BASE_URL`. If you want to keep the mock running on polaris2 for demo purposes, add the `mock-hcm` service block from the local `compose.yml` (without Traefik labels, on an internal bridge network only).

## Steps to deploy

1. **Build & push image** (on this machine):
   ```bash
   docker build --target runtime -t cativo23/timeoff-service:latest .
   docker push cativo23/timeoff-service:latest
   ```
2. **Add DNS record**: create an A record `ooo.cativo.dev → 167.235.52.161` in your DNS provider.
3. **SSH into polaris2** and create the deploy dir:
   ```bash
   mkdir -p ~/deploy/timeoff-service
   ```
4. **Copy compose + env files** to `~/deploy/timeoff-service/` on polaris2 (scp or paste).
5. **Pull and start**:
   ```bash
   cd ~/deploy/timeoff-service
   docker compose -f compose.prod.yml pull
   docker compose -f compose.prod.yml up -d
   ```
6. **Verify**: `curl -s https://ooo.cativo.dev/health` should return `{"status":"ok"}`. Let's Encrypt cert is issued automatically on first request.
7. **Check Traefik picked it up**: visit `https://traefik.cativo.dev` dashboard (auth-gated) and confirm the `timeoff` router is green.

## Gotchas observed

- **SSH on non-standard port**: polaris2 listens on port `52222`, not 22. Your SSH config must already handle this (`ssh polaris2` works), but CI/CD pipelines or `scp` commands need `--port 52222` / `-P 52222` explicitly.
- **Mail server takes the standard ports** (25, 465, 587, 993) — no conflict with the app, but worth knowing the server doubles as a mail host.
- **No `sudo` without a tty**: couldn't inspect process ownership for ports; used ss output instead. No blocking issues found.
- **SQLite volume persistence**: the `timeoff-data` named volume survives container restarts and image updates — `docker compose pull && docker compose up -d` is safe.
- **`security-headers@file` middleware**: all existing non-mail apps use it. Apply it to the timeoff router (included in the recipe above) for consistency.
- **Disk is healthy**: 35% used, 47 GiB free. No warnings.
