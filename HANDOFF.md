# HANDOFF — Wizdaa Take-Home: Time-Off Microservice

> Read this first in a fresh session. It is self-contained — you need no prior context.

## TL;DR
Building the Wizdaa take-home: a **Time-Off Microservice** in **NestJS + SQLite**. The design is **done and
validated** — it lives in `docs/TRD.md` (v3). Infra is scaffolded and Docker builds clean. What's left: build
the code (agentic), write the E1–E28 tests, README, coverage proof, then zip + submit.

**DEADLINE: 6:35 AM, 2026-05-28** (48h from receipt at 6:35 AM, 2026-05-26). As of this handoff (~00:30 May 27),
~30 hours remain.

## The assignment (essentials)
- Time-Off Microservice: manage the request lifecycle + maintain balance integrity, syncing with an external
  **HCM** system that is the **source of truth**, over an unreliable at-least-once network.
- Source spec PDF: `~/Downloads/Take_Home_Assignment_Backend.pdf`. Recruiter: Hafsa Iqbal (hafsa@wizdaa.com).
- Mandated stack: **NestJS + SQLite**.
- **"Go all in agentic development; do not write a single line of code."** Drive the AI to build it from the
  TRD; you supervise. The **TRD + test rigor** are what's graded (test rigor is called the primary deliverable).
- Mock HCM must be a **real server** with logic to **simulate balance changes**.
- Balances are **per-employee per-location**.
- Also graded: **security considerations + architectural decisions**.
- **Deliverables:** TRD + code in a GitHub repo + tests + coverage proof + README.
- **Submission:** ONE `.zip` under 50 MB, **no node_modules**, via the Google Form in Hafsa's email. README with
  clear setup/run instructions is required.

## Where everything is
- Repo root: `~/projects/personal/wizdaa-takehome/`
- **TRD: `docs/TRD.md` (v3)** — the spec. Read it before building.
- NestJS 11 scaffold; deps installed: TypeORM 1.0, better-sqlite3, @nestjs/config, @nestjs/axios,
  @nestjs/schedule, class-validator, class-transformer. 0 vulnerabilities.
- Docker: `Dockerfile` (multi-stage; native better-sqlite3 compile verified), `compose.yml` (app + mock-hcm
  stack), `compose.dev.yml` (hot reload). Image `timeoff-service:latest` builds clean.

## Status
- ✅ **Design** — TRD v3, validated through a 4-lens review (architecture / adversary / spec-compliance /
  humanizer) + 2 gates (seniority+spec cross-check vs email & PDF, AI-authorship). Document is submission-ready.
- ✅ **Infra** — scaffold, deps, Docker stack verified.
- ⬜ **Code** — NOT built yet (intentional; agentic build pending).
- ⬜ **Tests, README, coverage** — pending.

## Build order (next session)
1. **Config module** — env: `DATABASE_PATH`, `HCM_BASE_URL`, `RESERVATION_TTL_DAYS`, `HCM_RETRY_MAX_ATTEMPTS`,
   `HCM_RETRY_BACKOFF_MS` (already wired in compose).
2. **Entities + TypeORM** — model is TRD §6. Use `@VersionColumn` for optimistic locking (ADR-005).
   ⚠️ TypeORM is **1.0.0** (a fresh major, released after most tutorials) — verify the current API, don't
   blind-copy 0.3.x patterns.
3. **Mock HCM** — `src/mock-hcm/main.ts` → builds to `dist/mock-hcm/main.js` (compose expects this exact path,
   or `docker compose up` fails on that service). Stateful store + scenario toggles + `_control/*` endpoints
   (ADR-007).
4. **Balance + TimeOffRequest services** — the ADR logic (§7).
5. **Reconciliation + outbox dispatcher + reservation reaper** — all serialize on the per-balance-key lock
   (ADR-010). This is the central invariant; every failure mode in §13 is some actor skipping it.
6. **Test suite E1–E28** with the §9.1 harness: `:memory:` SQLite per test, mock-HCM scenario toggles,
   deterministic-concurrency seam (lock latch + `Promise.all`), injectable clock for TTL/DST cases.
7. **README** — setup/run + architecture summary + decisions rationale.
   ⚠️ **PROOFREAD the README before submit** (English bar — prior rejection at Factored cited written English).
   Run Grammarly / have the assistant check it.
8. `npm run test:cov` → commit the coverage report (proof; target ≥90% on services).
9. **Zip without node_modules**, submit via the Google Form.

## Key decisions (already settled — don't re-litigate; all in the TRD)
- Defense-in-depth validation; local is the primary guard, HCM confirms at approve, never trust HCM silence — ADR-001
- Reserve-on-submit + TTL reaper — ADR-002
- **Reconcile by `hcmAckAt`, not `committedAt`** (the key correctness fix from review) — ADR-003
- Queue-and-retry (PENDING_SYNC) + compensating REVERSE on retry-cap — ADR-004
- Idempotency keys on the HCM contract — ADR-008
- Batch `asOf` + monotonic sequence — ADR-009
- All five balance actors serialize on one per-balance-key lock — ADR-010
- Transactional outbox — ADR-011
- Duplicate/overlap: idempotency key (scoped to active states) + inclusive interval-overlap invariant + per-key
  lock — ADR-012
- **Idempotency stays in SQLite (unique constraint), NOT Redis.** Decided after research: Redis would add a
  dual-write problem, and under a single-writer topology a distributed lock is redundant (the writer already
  serializes). §11 has the reasoning + scaling fork.
- Single-writer topology under SQLite is deliberate; horizontal scale = Postgres+row-locks OR replicated-SQLite.

## Gotchas
- Don't hand-write code — drive the agent from the TRD (assignment rule).
- mock-hcm entrypoint must build to `dist/mock-hcm/main.js`.
- better-sqlite3 native module: Docker is set up for it; local `npm install` already done.
- README English is scrutinized — proofread.
