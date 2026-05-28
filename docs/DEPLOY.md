# Deploy Guide — Time-Off Microservice on polaris2

> Pattern modelled after `cativo23/portfolio-api`.

## How it works

CI builds a `linux/amd64` Docker image and pushes it to Docker Hub as
`cativo23/wizdaa-takehome:latest` + `:<short-sha>`. The deploy job then SSHs
into polaris2 (port 52222), copies `compose.prod.yml`, pulls the new image, and
restarts the stack — the named `timeoff-data` SQLite volume survives untouched.
Traefik picks up the container via Docker labels and terminates TLS at
`https://ooo.cativo.dev`.

---

## Required GitHub Actions secrets & vars

Set these under **Settings → Secrets and variables → Actions** in this repo.

| Name | Type | Purpose | How to obtain |
|---|---|---|---|
| `DOCKERHUB_USERNAME` | Secret | Docker Hub account name | Your Docker Hub username (`cativo23`) |
| `DOCKERHUB_TOKEN` | Secret | Docker Hub push credential | Docker Hub → Account Settings → Security → New Access Token |
| `POLARIS_USER` | Secret | SSH login user on polaris2 | The Unix account that owns `~/deploy/` on the server |
| `POLARIS_SSH_KEY` | Secret | PEM private key for SSH auth | Generate with `ssh-keygen -t ed25519`; add the public key to `~/.ssh/authorized_keys` on polaris2 |
| `POLARIS_HOST` | Variable (var) | polaris2 hostname or IP | `167.235.52.161` (or a DNS name that resolves to it) |
| `POLARIS_PORT` | Variable (var) | SSH port on polaris2 | `52222` |

> `POLARIS_HOST` and `POLARIS_PORT` are non-secret configuration — store them as
> **Variables** (not Secrets) so they're visible in the workflow run UI.

---

## One-time server setup (run on polaris2 before the first deploy)

```bash
# 1. Create the deploy directory
mkdir -p ~/deploy/wizdaa-takehome

# 2. Place compose.prod.yml (CI will keep it up-to-date after the first deploy,
#    but you need it here for any manual run before CI has fired once)
scp -P 52222 compose.prod.yml cativo23@167.235.52.161:~/deploy/wizdaa-takehome/

# 3. Docker Hub login on the server (one-time; credentials cached in ~/.docker/config.json)
docker login -u cativo23

# 4. Pull and start for the first time
cd ~/deploy/wizdaa-takehome
docker compose -f compose.prod.yml pull
docker compose -f compose.prod.yml up -d

# 5. Verify
curl -s https://ooo.cativo.dev/health
# Expected: {"status":"ok"} (Let's Encrypt cert is issued on first request — may take ~30s)
```

---

## Manual / break-glass deploy

```bash
ssh -p 52222 cativo23@167.235.52.161
cd ~/deploy/wizdaa-takehome
docker compose -f compose.prod.yml pull
docker compose -f compose.prod.yml up -d --remove-orphans
curl -sf https://ooo.cativo.dev/ && echo "OK"
```

Or trigger the workflow manually from GitHub:
**Actions → Deploy → Run workflow → Run workflow**

---

## Rollback

There is no automated rollback hook (portfolio-api doesn't have one either). To
roll back to the previous image:

```bash
ssh -p 52222 cativo23@167.235.52.161
cd ~/deploy/wizdaa-takehome

# Option A — re-tag a previous SHA as latest on Docker Hub, then pull
# (do this from your local machine first):
docker pull cativo23/wizdaa-takehome:<previous-sha>
docker tag  cativo23/wizdaa-takehome:<previous-sha> cativo23/wizdaa-takehome:latest
docker push cativo23/wizdaa-takehome:latest

# Then on polaris2:
docker compose -f compose.prod.yml pull
docker compose -f compose.prod.yml up -d --remove-orphans

# Option B — run the old image directly (without touching Docker Hub)
docker compose -f compose.prod.yml stop app
docker run -d \
  --name timeoff-app-rollback \
  --network space-server_web \
  cativo23/wizdaa-takehome:<previous-sha>
# (then update compose.prod.yml image tag and bring stack back properly)
```

The `timeoff-data` named volume is never touched by a rollback — SQLite data persists.

---

## Key notes

- **SSH port**: polaris2 is on `52222`, not 22. All `appleboy/scp-action` and
  `appleboy/ssh-action` calls pass `port: ${{ vars.POLARIS_PORT }}`.
- **External network**: the stack joins `space-server_web` (managed by the
  `space-server` Traefik stack); it must exist before `compose up`.
- **Demo HCM**: `compose.prod.yml` keeps `mock-hcm` running as the HCM
  back-end for this demo deployment. Drop it and set `HCM_BASE_URL` to a real
  endpoint for a production Wizdaa integration.
- **Image cache**: buildx layers are cached in Docker Hub as
  `cativo23/wizdaa-takehome:buildcache` to speed up incremental builds.
