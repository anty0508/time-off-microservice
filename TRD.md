# Technical Requirements Document — Time-Off Microservice

**Status:** Implemented · **Author:** Gustavo Gabry · **Stack:** NestJS (TypeScript) + SQLite (TypeORM)

---

## 1. Context & Problem Statement

**ExampleHR** provides the primary interface for employees to request time off. The **HCM**
(Human Capital Management system — Workday, SAP, etc.) remains the **source of truth** for
employment data, including time-off balances.

Keeping balances consistent across two systems is hard because:

- ExampleHR is **not** the only writer to the HCM. Balances can change independently — e.g. a
  work-anniversary bonus or a start-of-year refresh.
- The HCM exposes a **realtime API** (read/write a single balance) and a **batch endpoint** (the
  whole corpus of balances). Both must be consumed and reconciled.
- The HCM **should** reject invalid filings (insufficient balance / invalid dimension combination),
  **but this is not guaranteed** — the service must be defensive and never depend on it.

The goal of this service is to **own the lifecycle of a time-off request** and **maintain balance
integrity** against the HCM, while giving the Employee and Manager **instant, trustworthy feedback**.

### 1.1 Personas & needs

| Persona     | Need                                                                          | How the design serves it |
|-------------|-------------------------------------------------------------------------------|--------------------------|
| Employee    | See an accurate balance; get instant feedback when requesting                 | Local **holds** give a synchronous yes/no without waiting on the HCM |
| Manager     | Approve requests knowing the data is valid                                    | Approval validates against held balances; HCM filing is reliable & auditable |

### 1.2 Goals

- Manage the full request lifecycle: **create → approve/reject → file with HCM → cancel/refund**.
- Maintain **per-employee, per-location** balances (with `leaveType` as an additional dimension).
- Provide REST endpoints for requests, balances, and HCM synchronization.
- Be **defensive**: never over-draw locally, even if the HCM would allow it.
- Be **auditable**: every balance change is explained by an append-only ledger entry.
- Be **robust to failure**: HCM outages, partial failures, retries, and out-of-order data.

### 1.3 Non-goals (explicit scope cuts)

- AuthN/AuthZ, multi-tenancy, and rate-limiting are out of scope (see §13, hooks are noted).
- Working-calendar logic (excluding weekends/holidays); we count inclusive **calendar** days.
- A production migration pipeline (we use `synchronize` for the assessment; see §12.1).
- A real message broker; the transactional **outbox** is polled from the same DB (see §6.3).

---

## 2. Challenges & Chosen Solutions (summary)

| # | Challenge | Solution | Section |
|---|-----------|----------|---------|
| C1 | Instant feedback while the HCM is the source of truth | **Reserve/hold** model: `available = balanceDays − pendingDays`, checked synchronously | §4, §5 |
| C2 | The HCM changes balances independently (anniversary/yearly) | **Reconciliation**: HCM figure always wins for `balanceDays`; local holds preserved | §6.4 |
| C3 | The HCM "may not" reject invalid filings | **Local-first validation**: we never let a hold over-draw; HCM is a second line, not the first | §5.2, §8 |
| C4 | Filing with the HCM can fail (timeout, 5xx, business refusal) | **Transactional outbox** + classified retries (transient vs business) + dead-letter | §6.3 |
| C5 | Two systems drift in the window between a filing and a snapshot | **Ledger-based timing-window adjustment** during reconciliation | §6.4.2 |
| C6 | Concurrent requests racing for the same balance | **Serialized write-transactions** (SQLite is single-writer) + **optimistic version** backstop | §7 |
| C7 | Retried client requests / retried HCM calls double-apply | **Idempotency keys** on both the inbound API and the outbound HCM filing | §7.2 |
| C8 | Out-of-order batch/webhook delivery | **Staleness guard** using snapshot `asOf` vs `hcmAsOf` | §6.4.1 |

---

## 3. High-level Architecture

```
                  ┌────────────────────────────────────────────────────────────┐
   Employee /     │                  Time-Off Microservice                     │
   Manager UI     │                                                            │
      │  REST     │   ┌─────────────┐     ┌───────────────┐    ┌────────────┐  │
      └──────────►│   │ TimeOff     │     │ Balances      │    │ Ledger     │  │
                  │   │ Controller  ├────►│ Service       ├───►│ (append-   │  │
                  │   │ + Service   │     │ (hold/debit/  │    │  only)     │  │
                  │   └─────┬───────┘     │  credit/recon)│    └────────────┘  │
                  │         │ enqueue     └──────┬────────┘                    │
                  │         ▼                    │ reads/writes                │
                  │   ┌────────────┐       ┌─────▼────────┐                    │
                  │   │ HCM Outbox │◄──────┤  SQLite      │                    │
                  │   │ (table)    │       │  (TypeORM)   │                    │
                  │   └─────┬──────┘       └──────────────┘                    │
                  │         │ poll                                             │
                  │   ┌─────▼─────────┐   ┌──────────────────┐                 │
                  │   │ Outbox        │   │ Reconciliation   │                 │
                  │   │ Processor     │   │ Service          │                 │
                  │   └─────┬─────────┘   └─────┬────────────┘                 │
                  │         │   HcmClient (axios)│                             │
                  └─────────┼────────────────────┼─────────────────────────────┘
                            │ realtime POST/GET  │ batch GET / webhook ingest
                            ▼                    ▼
                  ┌──────────────────────────────────────────┐
                  │             HCM (source of truth)        │
                  │  /balances  /time-off  /batch/balances   │
                  │  (mock server simulates real behaviour)  │
                  └──────────────────────────────────────────┘
```

### 3.1 Module map (acyclic by design)

- **DatabaseModule** — TypeORM/SQLite wiring + `TransactionRunner` (serialized, retrying UoW).
- **LedgerModule** — append-only `BalanceLedger` writer.
- **HcmClientModule** — leaf HTTP client (no DB) so both balances & sync layers can use it.
- **BalancesModule** — `BalancesService` (all balance mutations) + read API.
- **OutboxModule** — `OutboxService` (enqueue/claim/complete).
- **TimeOffModule** — request lifecycle (`create/approve/reject/cancel`) + API.
- **HcmModule** — `OutboxProcessor`, `ReconciliationService`, HCM operational API, `SyncScheduler`.

The dependency graph is one-directional: `TimeOff → Balances/Outbox`, `Hcm → Balances/Outbox/HcmClient`.
The sync layer updates requests via the repository directly, so **TimeOff and Hcm never depend on
each other** (no `forwardRef`, no cycles).

---

## 4. Domain Model & Balance Accounting

Balances are keyed by the dimension tuple **(employeeId, locationId, leaveType)**. The assessment
specifies per-employee/per-location; `leaveType` is an extra supported dimension defaulting to
`ANNUAL`, so the base case is exactly per-employee/per-location.

Each balance bucket tracks two numbers:

| Field         | Meaning |
|---------------|---------|
| `balanceDays` | The **authoritative** balance as last known from the HCM, adjusted by **confirmed** filings. |
| `pendingDays` | Days **held** by in-flight requests (PENDING, or APPROVED-but-not-yet-confirmed). Local only — the HCM does not know about holds. |

The number shown to users and checked on every new request is the **derived**:

```
availableDays = balanceDays − pendingDays           (never allowed < 0 by a NEW hold)
```

This separation is the crux of **C1**: the employee gets an instant, correct answer from
`availableDays` without a network round-trip, while `balanceDays` stays faithful to the HCM.

### 4.1 The ledger (auditability)

Every mutation writes an **append-only** `BalanceLedger` row recording the signed `balanceDelta`
and `pendingDelta`, the post-state snapshot, the source, and a request reference. Properties:

- The current `(balanceDays, pendingDays)` is always reconstructable by replaying ledger deltas
  (proven by test).
- It is the forensic trail for disputes and the input to the reconciliation timing-window
  adjustment (§6.4.2).

Entry types: `HOLD`, `RELEASE`, `DEBIT`, `CREDIT`, `ACCRUAL`, `RECONCILE`, `DISCREPANCY`.

---

## 5. Request Lifecycle

```
                         create (employee)
                              │  reserve(N)  ── over-draw? → 422 INSUFFICIENT_BALANCE
                              ▼
                          ┌────────┐  reject ─────────────► REJECTED   (release hold)
                          │PENDING │  cancel ─────────────► CANCELLED  (release hold)
                          └───┬────┘
                       approve│ (enqueue FILE_DEBIT, keep hold)
                              ▼
                          ┌────────┐  outbox: HCM accepts ─► confirm debit (hold→debit)
                          │APPROVED│  outbox: HCM refuses  ─► FAILED (release hold + reconcile)
                          │ filing │  cancel (before send) ► CANCELLED (withdraw + release)
                          │ async  │  cancel (after debit) ► CANCELLED (+ enqueue FILE_CREDIT refund)
                          └────────┘
```

Two status fields are tracked **independently**:

- `status`: `PENDING | APPROVED | REJECTED | CANCELLED | FAILED`
- `hcmFilingStatus`: `NOT_FILED | PENDING | CONFIRMED | FAILED`

A request can be **APPROVED** locally (manager sees success instantly) while its HCM filing is still
**PENDING** (delivered asynchronously). This decoupling is what lets us be both responsive and
reliable.

### 5.1 Why hold-then-file (not file-synchronously)

Filing synchronously on approve would couple the user-facing latency and availability to the HCM. A
hold gives instant feedback; the authoritative debit is delivered reliably in the background.

### 5.2 Defensiveness (C3)

The over-draw check is performed **locally** against `availableDays` **before** anything is sent to
the HCM. Even if the HCM is misconfigured to accept any filing (`enforceBalance=false` in the mock),
a request that exceeds the local available balance is rejected with `422 INSUFFICIENT_BALANCE` and
**no over-draw ever reaches the HCM** (proven by test).

---

## 6. HCM Integration

### 6.1 HCM client

A thin axios client with a per-call timeout and, crucially, **error classification**:

- **Business error** (`HcmBusinessError`, e.g. 4xx `INSUFFICIENT_BALANCE` / `INVALID_DIMENSION`):
  terminal — retrying will not help.
- **Transient error** (`HcmTransientError`, 5xx / 408 / 429 / timeout / connection refused):
  retryable.

This classification drives every downstream decision.

### 6.2 Realtime API

- `GET /balances` — used for **lazy seeding**: the first time we see a dimension we read the HCM and
  cache it locally; if the HCM has no such bucket, the dimension is **invalid** and we reject.
- `POST /time-off` — files a **signed delta** (negative debit / positive credit) with an
  `Idempotency-Key` so retries don't double-apply.

### 6.3 Transactional outbox (C4)

When a request is approved/cancelled, the **local state change and the intent to call the HCM are
committed in the same DB transaction** by inserting an `HcmOutbox` row. A background processor then
delivers it:

```
approve(request)  ──┐  (one transaction)
  set APPROVED      │
  insert outbox     ├──► COMMIT
  (FILE_DEBIT, -N)  ┘

OutboxProcessor (scheduled / on-demand):
  claim due items → call HCM (OUTSIDE the txn)
    success   → (txn) markSent + confirmDebit + request CONFIRMED
    business  → (txn) markFailed + releaseHold + request FAILED   → then reconcile the bucket
    transient → (txn) scheduleRetry (exp. back-off) … until DEAD (kept for manual handling)
```

Guarantees:

- **At-least-once** delivery that survives a crash mid-call (the intent is durably stored).
- **Idempotent application**: the HCM call happens outside the transaction; the local apply
  re-checks the item is still active and uses the HCM idempotency key, so a duplicate delivery is a
  no-op.
- **Dead-letter**: after `HCM_MAX_RETRIES` the item becomes `DEAD` and the hold is intentionally
  retained, surfacing the problem for manual/automated intervention instead of silently losing it.

### 6.4 Reconciliation (C2, C5, C8)

Two ingestion paths, one engine:

- **Pull**: `POST /v1/hcm/sync` calls the HCM **batch** endpoint and reconciles the whole corpus.
- **Push**: `POST /v1/hcm/webhook/balances` ingests a realtime/batch push (e.g. *"1 day for
  locationId X employeeId Y"*).

For each bucket, the HCM figure **wins** for `balanceDays`; local `pendingDays` (holds) are
**preserved**. An anniversary bonus (balance ↑) or yearly refresh is simply accepted.

#### 6.4.1 Staleness guard (C8)

Each bucket stores `hcmAsOf` (the snapshot time it was last reconciled against). A snapshot whose
`asOf <= hcmAsOf` is **ignored**, so out-of-order delivery cannot regress a balance.

#### 6.4.2 Timing-window adjustment (C5)

A snapshot is generated at time `T_gen`. If we confirmed a debit/credit with the HCM **after**
`T_gen`, that change is **not yet reflected** in the snapshot. Naively overwriting `balanceDays` with
the snapshot value would transiently "refund" a balance we legitimately consumed.

We correct for this using the **ledger**:

```
adjustment = Σ (balanceDelta of HCM-confirmed DEBIT/CREDIT entries with occurredAtMs > T_gen)
target     = hcmSnapshotValue + adjustment
```

Because debits are negative and credits positive, adding the post-snapshot deltas back reconstructs
the correct current authoritative balance. (We compare against an app-controlled
millisecond timestamp `occurredAtMs`, not `createdAt`, because SQLite's `CURRENT_TIMESTAMP` is only
second-precision — a subtle but real correctness bug we explicitly avoid.) Proven by an e2e test
where a stale snapshot showing the pre-debit balance does **not** refund the consumed days.

#### 6.4.3 Over-commit detection

If, after reconciliation, `available < 0` (the HCM dropped the balance below our outstanding holds),
we **do not silently mutate holds**. We record a `DISCREPANCY` ledger entry, log a warning, and
report `overcommitted` in the sync summary — a human/policy decides how to resolve (e.g. cancel the
most recent pending request). Surfacing beats silently corrupting.

### 6.5 Synchronization process — directions, triggers & cadence

Sync is **bidirectional**, and each direction has its own trigger model. The same engine code backs
both the scheduled jobs and the on-demand HTTP endpoints, so production runs automatically while
tests drive identical logic deterministically (schedulers off via `DISABLE_SCHEDULERS=true`).

```
 OUTBOUND (we write to HCM)                 INBOUND (HCM balance → us)
 ───────────────────────────               ─────────────────────────────────────────
 outbox poll  ── every 2s ──► HCM           scheduled PULL  ── cron */5m ──► GET /batch/balances
 on-demand    POST /outbox/process          PUSH (webhook)  ── HCM-initiated ──► POST /webhook/balances
                                            event PULL (1 bucket) ── after a filing refusal
```

#### 6.5.1 Outbound cadence — how often we file with the HCM

The outbox processor is the **only** writer to the HCM. It is driven on two clocks:

| Knob | Env var | Default | Effect |
|------|---------|---------|--------|
| Poll interval | `OUTBOX_POLL_INTERVAL_MS` | **2000 ms** | how often `processBatch()` claims & delivers due items |
| Batch size | `OUTBOX_BATCH_SIZE` | **25** | max items claimed per tick (oldest-first) |
| Retry base | `OUTBOX_RETRY_BASE_MS` | **1000 ms** | back-off base for transient failures |
| Max attempts | `HCM_MAX_RETRIES` | **5** | attempts before an item is `DEAD` (set on each item at enqueue) |
| Per-call timeout | `HCM_TIMEOUT_MS` | **5000 ms** | timeout on each `POST /time-off` |

- **Steady state:** every **2 seconds** the processor delivers up to **25** newly-due filings. A
  freshly-approved request is therefore filed within ≤ ~2 s, without the approve call ever blocking
  on the HCM.
- **Transient failure back-off:** on a 5xx/timeout the item is rescheduled with
  `delay = min(retryBase × 2^(attempts−1), 60_000ms)` → **1s, 2s, 4s, 8s** across attempts, then
  `DEAD` on the 5th. `nextAttemptAt` gates re-delivery; the dispatch query is indexed on
  `(status, nextAttemptAt)`.
- **On demand:** `POST /v1/hcm/outbox/process` runs a tick immediately; `?force=true` ignores the
  back-off schedule (used by ops and the e2e suite).
- **Overlap guard:** ticks are non-reentrant (a `running` flag), so a slow tick never stacks.

#### 6.5.2 Inbound — how the HCM balance reaches us

Inbound has a **guaranteed floor cadence** plus two event-driven paths; all three converge into the
same `ReconciliationService` engine (§6.4: staleness guard, timing-window adjustment, over-commit
detection):

1. **Scheduled pull (baseline) — every 5 minutes.** `RECONCILE_CRON` (default `*/5 * * * *`) calls
   `pullAndReconcile()` → HCM **batch** corpus → reconcile every bucket. This is the safety net that
   guarantees convergence to the HCM truth **even if no webhook ever arrives**. A failed pull (HCM
   unreachable) logs a warning and simply retries next tick — it never crashes the scheduler.
2. **Push (webhook) — event-driven, see §6.5.3.** Lower-latency convergence whenever the HCM chooses
   to notify us.
3. **Event pull (single bucket) — on a filing refusal.** When the HCM returns a *business* refusal
   for a filing, that refusal proves our local view drifted, so the outbox processor immediately
   calls `reconcileDimension()` (realtime `GET /balances` for that one bucket) to repair it.

Cadence summary: **outbound ≈ every 2 s**, **inbound pull = every 5 min** (plus webhook pushes and
post-refusal repairs as they occur). All values are env-overridable.

#### 6.5.3 Inbound webhook (push) — `POST /v1/hcm/webhook/balances`

The webhook lets the HCM **push** balance changes (e.g. an anniversary bonus, a yearly refresh, or
*"+1 day for employeeId Y / locationId X"*) instead of waiting for the next 5-minute pull. Because it
is **HCM-initiated, it has no fixed frequency** — it fires whenever the HCM has something to report;
the scheduled pull (§6.5.2) remains the guaranteed floor if pushes are sparse or missed.

- **Payload** (validated by `HcmWebhookDto`): an optional ISO-8601 `generatedAt` (the snapshot time;
  defaults to *now* if omitted) and a `balances[]` array of `{ employeeId, locationId, leaveType?,
  balanceDays }`. It accepts either a **single/few realtime** updates or a **full corpus** — same
  shape, same handler.
- **Shared engine:** it calls `reconciliation.ingest(snapshots, generatedAt)` — the **identical**
  path as the batch pull, so the **staleness guard** (`asOf <= hcmAsOf` ⇒ ignored), the
  **timing-window adjustment** (no false refund of post-snapshot confirmed debits), and **over-commit
  detection** all apply to pushes exactly as to pulls. The HCM figure wins for `balanceDays`; local
  `pendingDays` holds are preserved.
- **Response:** the same `ReconcileSummary` (`applied / skipped / overcommitted / buckets`) as
  `/sync`, making the push observable.

**Scope boundary (honest):** we implement the webhook **receiver** only. There is **no subscription
handshake** (we don't register a callback URL with the HCM) and **no push-signature verification**
yet — the assessment's HCM contract defines neither. Signed/authenticated webhooks are listed as
required-for-production in §13, and a subscription/registration step would be added when integrating
a real HCM that supports it. In tests, an HCM push is simulated by POSTing to the endpoint directly.

---

## 7. Concurrency, Idempotency & Consistency

### 7.1 Concurrency (C6)

SQLite is a **single-writer** engine. Rather than fight it, the `TransactionRunner` **serializes
write-transactions** through an in-process async mutex, turning would-be "database is locked" /
nested-transaction errors into clean, ordered execution. As a **backstop** for a hypothetical
multi-process deployment, every balance row carries an **optimistic `version`**; a lost-update
results in a retry, and after exhaustion a `409 CONCURRENCY_CONFLICT`.

Result (proven by test): 10 single-day requests racing for a balance of 5 → **exactly 5 succeed, 5
are cleanly rejected**, `available` never goes negative.

### 7.2 Idempotency (C7)

- **Inbound**: `POST /v1/time-off-requests` honours an `Idempotency-Key` header; a repeated key
  returns the original request and holds the balance **once** (a unique partial index enforces it,
  even under concurrent retries).
- **Outbound**: each outbox item carries a deterministic HCM `Idempotency-Key`
  (`<requestId>:<operation>`); the HCM (and our mock) returns the original reference on replay.

---

## 8. API Reference

Base errors share one envelope: `{ errorCode, message, details?, path, timestamp }`.

### Time-off requests
| Method & path | Purpose | Notable responses |
|---------------|---------|-------------------|
| `POST /v1/time-off-requests` | Create (employee). `Idempotency-Key` header optional | `201`; `422 INSUFFICIENT_BALANCE`/`INVALID_DIMENSION`; `400 VALIDATION_ERROR` |
| `GET /v1/time-off-requests/:id` | Fetch one | `404 REQUEST_NOT_FOUND` |
| `GET /v1/time-off-requests?employeeId=&locationId=&status=&leaveType=` | List/filter | `200` |
| `POST /v1/time-off-requests/:id/approve` | Manager approves | `200`; `409 INVALID_STATE_TRANSITION` |
| `POST /v1/time-off-requests/:id/reject` | Manager rejects | `200`; `409` |
| `POST /v1/time-off-requests/:id/cancel` | Cancel (refund if already filed) | `200`; `409` |

### Balances
| Method & path | Purpose |
|---------------|---------|
| `GET /v1/balances/:employeeId/:locationId?leaveType=&refresh=true` | One balance; `refresh` pulls from HCM realtime & seeds |
| `GET /v1/balances?employeeId=&locationId=&leaveType=` | List/filter |

### HCM sync (operational; also driven by the scheduler)
| Method & path | Purpose |
|---------------|---------|
| `POST /v1/hcm/sync` | Pull the batch corpus and reconcile |
| `POST /v1/hcm/webhook/balances` | Ingest a pushed balance update (realtime or batch) |
| `POST /v1/hcm/outbox/process?force=true` | Drive the outbox processor on demand |
| `GET /v1/hcm/outbox?status=` | Inspect outbox items |
| `GET /health` | Liveness |

---

## 9. Data Model

| Table | Key columns | Notes |
|-------|-------------|-------|
| `balances` | unique (employeeId, locationId, leaveType); `balanceDays`, `pendingDays`, `hcmAsOf`, `version` | one row per bucket; `version` = optimistic lock |
| `time_off_requests` | `status`, `hcmFilingStatus`, `numberOfDays`, `idempotencyKey` (unique partial), `hcmReference`, `version` | the aggregate root |
| `balance_ledger` | `entryType`, `source`, `balanceDelta`, `pendingDelta`, `*After`, `occurredAtMs`, `requestId` | append-only audit |
| `hcm_outbox` | `operation`, `deltaDays`, `idempotencyKey`, `status`, `attempts`, `nextAttemptAt` | transactional outbox |

---

## 10. Failure Handling Matrix

| Failure | Detection | Response |
|---------|-----------|----------|
| Over-draw request | local `available` check | `422` immediately; HCM never called |
| Invalid dimension | local + HCM `GET /balances` 404 | `422 INVALID_DIMENSION` |
| HCM timeout / 5xx on filing | `HcmTransientError` | outbox retry w/ exponential back-off → `DEAD` after max |
| HCM business refusal on filing | `HcmBusinessError` | release hold, request `FAILED`, reconcile the bucket |
| HCM unreachable during reconcile | transient | log & retry next tick (no crash) |
| Out-of-order snapshot | `asOf <= hcmAsOf` | ignored |
| Snapshot predates a confirmed filing | ledger adjustment | corrected `target` (no false refund) |
| HCM balance < outstanding holds | `available < 0` after reconcile | `DISCREPANCY` entry + warning + reported, no silent mutation |
| Concurrent reservations | serialized txn + version | exactly-available succeed; rest `422`; no over-sell |
| Duplicate client submit | `Idempotency-Key` unique index | original request returned, held once |

---

## 11. Alternatives Considered

| Decision | Chosen | Alternatives & why not |
|----------|--------|------------------------|
| Feedback model | **Local holds + async filing** | (a) *File synchronously on approve* — couples UX latency/availability to the HCM, and a mid-call crash loses the side-effect. (b) *No local cache, always ask HCM* — slow, chatty, and offers no over-draw protection if the HCM is permissive. |
| HCM delivery | **Transactional outbox (DB-polled)** | (a) *Direct call in the request handler* — not crash-safe, not retryable, couples transactions to network. (b) *External broker (Kafka/SQS)* — correct at scale but heavy for this scope; the outbox pattern is broker-agnostic and upgradeable later. |
| Reconcile math | **Ledger-based delta adjustment** | (a) *Blind overwrite with HCM value* — refunds in-flight confirmed debits during the snapshot window. (b) *Trust HCM ordering only* — fails when ExampleHR and HCM clocks/snapshots interleave. |
| Concurrency | **Serialize writes + optimistic version** | (a) *Optimistic-only* — with SQLite produces "database is locked"/nested-transaction errors under load. (b) *Pessimistic `SELECT … FOR UPDATE`* — unsupported/limited in SQLite. The mutex matches SQLite's single-writer reality; the version column keeps multi-process correctness. |
| Persistence | **SQLite + TypeORM** | Per the assessment. TypeORM gives entity/transaction ergonomics; `better-sqlite3` is synchronous and ships prebuilt binaries (no native toolchain needed). A production deployment would swap the driver for Postgres with the same repository code. |
| Balance precision | **`REAL` days rounded to 4 dp** | Integer-only would reject fractional HCM accruals; unrounded floats drift (0.1+0.2). |
| Schema mgmt | **`synchronize: true`** (dev) | Migrations are the production answer (§12.1); `synchronize` removes friction for a self-contained assessment. |

---

## 12. Testing Strategy & Proof of Coverage

The value of an agentic build is in the rigor of its tests. We use two complementary layers.

### 12.1 What we test

- **Unit / integration (`*.spec.ts`)** — pure logic and service logic against an **in-memory SQLite**
  DB with a mocked HCM: date math, balance accounting (hold/release/debit/credit/reconcile),
  ledger reconstruction, outbox retry→dead-letter, HCM error classification, the serialized
  transaction runner, and the scheduler wiring.
- **End-to-end (`*.e2e-spec.ts`)** — the **full Nest app** over HTTP (supertest) against a **real,
  running mock HCM server** (a separate NestJS app started on an ephemeral port). These cover the
  lifecycle, defensive validation, reconciliation scenarios (anniversary, yearly refresh, stale
  snapshot, timing window, over-commit, webhook), HCM failure modes (transient retry, dead-letter,
  business refusal), and concurrency/idempotency.

### 12.2 The mock HCM (a real server, not a stub)

`test/mock-hcm/` is a runnable NestJS server (also `npm run mock:hcm`) that maintains its own
balances and simulates real behaviours: realtime get/file, batch corpus, **idempotent** filing,
configurable **balance/dimension enforcement** (to test our defensiveness when the HCM is
permissive), forced **transient/business** failures, and independent changes (**anniversary bonus**,
**yearly refresh**). e2e tests drive scenarios against it exactly as production would.

### 12.3 Coverage (latest run)

```
Test Suites: 11 passed   Tests: 67 passed
Statements 92.5% | Branches 72.1% | Functions 93.8% | Lines 94.7%
```

Run `npm run test:cov` to regenerate the HTML/lcov report under `coverage/`.

---

## 13. Security Considerations

- **Input validation**: a global `ValidationPipe` with `whitelist + forbidNonWhitelisted` rejects
  unknown/oversized fields; dates are strictly parsed (no silent rollovers).
- **No information leakage**: the global exception filter returns stable `errorCode`s and never
  leaks stack traces; 5xx details are logged server-side only.
- **Idempotency** prevents replay/double-submit from mutating balances twice.
- **Server-authoritative computation**: `numberOfDays` is derived server-side from the date range;
  clients cannot inject an arbitrary consumption amount.
- **Outbound idempotency keys** prevent duplicate financial effects at the HCM.
- **Out of scope but required for production** (hooks exist): authN/Z (JWT/OIDC + RBAC so only the
  owning employee/their manager can act), per-tenant isolation, rate-limiting, secrets management for
  HCM credentials, signed webhooks (verify the HCM push is authentic), and audit-log retention.

---

## 14. Operational Concerns & Future Work

- **Migrations** instead of `synchronize` for safe production schema evolution.
- **Postgres** driver swap for true concurrency (the repository/service code is unchanged;
  the optimistic-version backstop already supports multi-process writers).
- **Real broker** (SQS/Kafka) behind the same outbox abstraction for horizontal scale; today's
  poller serializes within one instance.
- **Working calendars** per location (weekends/holidays, half-days).
- **Observability**: structured logs are in place; add metrics (outbox lag, reconcile drift,
  dead-letter count) and tracing.
- **Alerting** on `DEAD` outbox items and `DISCREPANCY`/over-commit ledger entries.

---

## 15. Assumptions

1. Balances are **per-employee per-location**; `leaveType` is an extra dimension defaulting to `ANNUAL`.
2. Days are **inclusive calendar days**; weekend/holiday calendars are future work.
3. The HCM realtime `GET /balances` returns "now"; the batch endpoint provides a `generatedAt`
   snapshot time used for ordering and the timing-window adjustment.
4. Clock skew between ExampleHR and the HCM is small relative to snapshot cadence; the staleness +
   ledger-adjustment logic tolerates ordinary skew but assumes monotonic-ish snapshot times.
5. A single service instance per database in the default config (the mutex); multi-instance is
   supported correctness-wise by the optimistic version, throughput-wise by a future broker/Postgres.
