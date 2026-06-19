# Time-Off Microservice

A backend microservice that owns the **lifecycle of a time-off request** and keeps **per-employee,
per-location balances** in sync with an HCM (Human Capital Management) system that is the source of
truth.

Built with **NestJS (TypeScript)** and **SQLite (TypeORM)**.

> **Design & rationale:** see [**TRD.md**](./TRD.md) — the full Technical Requirements Document
> (challenges, solution, architecture, alternatives, security, testing).

---

## Why this design (60-second tour)

- An employee requests time off → the service **holds** the balance locally
  (`available = balanceDays − pendingDays`) and answers **instantly**, without waiting on the HCM.
- A manager approves → the authoritative debit is filed with the HCM **reliably and asynchronously**
  via a **transactional outbox** (retries, dead-letter, idempotency).
- The HCM can change balances on its own (anniversary bonus, yearly refresh) → a **reconciliation**
  engine makes the HCM figure win for `balanceDays` while preserving local holds, with a
  **ledger-based timing-window adjustment** so a stale snapshot never refunds consumed days.
- We are **defensive**: an over-draw is rejected locally **before** the HCM is ever called — we never
  rely on the HCM to catch it.

---

## Requirements

- **Node.js ≥ 20** (developed and tested on Node 24)
- npm

No native build toolchain is required — `better-sqlite3` ships prebuilt binaries.

## Install

```bash
npm install
```

## Configure

Copy the example env file (all values have sensible defaults, so this is optional):

```bash
cp .env.example .env
```

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | HTTP port |
| `DATABASE_PATH` | `./data/time-off.sqlite` | SQLite file (`:memory:` for ephemeral) |
| `HCM_BASE_URL` | `http://localhost:4000` | HCM (or mock HCM) base URL |
| `HCM_TIMEOUT_MS` | `5000` | Per-call HCM timeout |
| `HCM_MAX_RETRIES` | `5` | Outbox max delivery attempts before dead-letter |
| `OUTBOX_POLL_INTERVAL_MS` | `2000` | Outbox processor cadence |
| `RECONCILE_CRON` | `*/5 * * * *` | Reconciliation pull schedule |
| `DISABLE_SCHEDULERS` | `false` | Disable background jobs (used by tests) |

---

## Run

Open two terminals:

```bash
# 1) Start the mock HCM (source of truth) on :4000
npm run mock:hcm

# 2) Start the microservice on :3000
npm run start:dev
```

Then exercise it (seed a balance at the HCM, request, approve, watch it file automatically):

```bash
# Seed the HCM with 10 days for emp-1 @ loc-1
curl -X POST http://localhost:4000/admin/seed \
  -H 'content-type: application/json' \
  -d '{"entries":[{"employeeId":"emp-1","locationId":"loc-1","balanceDays":10}]}'

# Employee requests 3 days  -> 201, balance held (available 7)
curl -X POST http://localhost:3000/v1/time-off-requests \
  -H 'content-type: application/json' \
  -d '{"employeeId":"emp-1","locationId":"loc-1","startDate":"2026-07-01","endDate":"2026-07-03"}'

# Check the balance (balanceDays 10, pendingDays 3, availableDays 7)
curl http://localhost:3000/v1/balances/emp-1/loc-1

# Manager approves  (use the id returned by create)
curl -X POST http://localhost:3000/v1/time-off-requests/<ID>/approve \
  -H 'content-type: application/json' -d '{"approverId":"mgr-1"}'

# The scheduler files the debit with the HCM within ~2s; then:
curl http://localhost:3000/v1/balances/emp-1/loc-1     # balanceDays 7, pending 0
```

To drive the outbox/reconcile immediately instead of waiting for the scheduler:

```bash
curl -X POST 'http://localhost:3000/v1/hcm/outbox/process?force=true'   # file pending HCM calls now
curl -X POST  http://localhost:3000/v1/hcm/sync                          # pull batch & reconcile now
```

### Production-style run

```bash
npm run build
npm run start:prod
```

---

## Test

```bash
npm test            # all tests (unit + e2e), serialized
npm run test:cov    # all tests with a coverage report (coverage/)
npm run test:unit   # unit/integration specs only
npm run test:e2e    # end-to-end specs only
```

Latest run: **67 tests passing** · coverage **~92% statements / ~72% branches / ~94% functions/lines**.

The e2e suite boots the **full Nest app** and runs it against a **real, running mock HCM server**
(started on an ephemeral port per test), covering the lifecycle, defensive validation, reconciliation
(anniversary / yearly refresh / stale snapshot / timing window / over-commit / webhook), HCM failure
modes (transient retry, dead-letter, business refusal), and concurrency/idempotency.

---

## API at a glance

| Method & path | Purpose |
|---------------|---------|
| `POST /v1/time-off-requests` | Create a request (supports `Idempotency-Key` header) |
| `GET /v1/time-off-requests/:id` | Get a request |
| `GET /v1/time-off-requests` | List/filter (`employeeId`, `locationId`, `status`, `leaveType`) |
| `POST /v1/time-off-requests/:id/approve` | Manager approves |
| `POST /v1/time-off-requests/:id/reject` | Manager rejects |
| `POST /v1/time-off-requests/:id/cancel` | Cancel (refunds if already filed) |
| `GET /v1/balances/:employeeId/:locationId` | Get a balance (`?refresh=true` pulls from HCM) |
| `GET /v1/balances` | List/filter balances |
| `POST /v1/hcm/sync` | Pull the HCM batch corpus and reconcile |
| `POST /v1/hcm/webhook/balances` | Ingest an HCM balance push |
| `POST /v1/hcm/outbox/process` | Drive the outbox processor (`?force=true`) |
| `GET /v1/hcm/outbox` | Inspect outbox items (`?status=`) |
| `GET /health` | Liveness |

Errors share one envelope: `{ errorCode, message, details?, path, timestamp }` with stable codes
(`INSUFFICIENT_BALANCE`, `INVALID_DIMENSION`, `INVALID_STATE_TRANSITION`, `VALIDATION_ERROR`, …).

---

## Project layout

```
src/
  balances/        balance accounting (hold/release/debit/credit/reconcile) + read API
  time-off/        request lifecycle (create/approve/reject/cancel) + API
  hcm/             HCM client, transactional outbox + processor, reconciliation, sync API, scheduler
  ledger/          append-only balance ledger (audit)
  database/        TypeORM/SQLite wiring, entities, serialized transaction runner
  common/          enums, exceptions, validation, date/day utilities
test/
  mock-hcm/        runnable mock HCM server (real NestJS app simulating HCM behaviour)
  e2e/             end-to-end specs (full app vs real mock HCM)
  helpers/         test app + HTTP client + mock-HCM bootstrap
TRD.md             Technical Requirements Document
```
