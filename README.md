# Gaming Economy Engine

Transactional core for the modular in-app gaming ecosystem (see `microgames.md`). Node.js/Express
on MySQL 8.x (InnoDB), using strict transactions and row-level locking so points can never be
overdrawn, double-charged, or manipulated. Exposes `initiate` / `process` / `settle` over an
extensible **Game Router** (`BaseGameEngine` + registry) so new games drop in without core edits;
`russian_roulette` is the reference engine.

> **Schema note:** `microgames.md` names the five tables but ships no DDL. `db/schema.sql`
> contains a designed, fintech-grade schema for them. Adapt it if you have existing tables.

## Layout

```
db/schema.sql                     DDL for users, games_directory, game_sessions,
                                  points_ledger, coupons
src/config.js                     Env loading + fail-fast validation
src/db/pool.js                    mysql2/promise pool (BIGINT-safe)
src/db/withTransaction.js         Transaction wrapper + deadlock/lock-timeout retry
src/errors.js                     Typed HTTP errors
src/middleware/auth.js            JWT verification (algorithm-pinned) -> req.auth.userId
src/middleware/rateLimit.js       Per-user throttle for the bet endpoint
src/middleware/errorHandler.js    Consistent API envelope, no internal leakage
src/validators/*.js               Request body validation (initiate / settle / process)
src/services/gameSessionService.js     Transactional bet logic (initiate)
src/services/gameProcessService.js     Transactional step logic (process, auto-settle)
src/services/gameSettlementService.js  Transactional payout core (settle; shared)
src/db/sessionMetadata.js         game_metadata JSON parse/serialize helpers
src/engines/BaseGameEngine.js     Abstract engine contract (initiate/processStep/settle)
src/engines/registry.js           The Game Router: game_key -> engine (fail-closed)
src/engines/russianRoulette.js    Concrete engine (chamber layout, multiplier, payout)
src/games/index.js                Where game engines are registered at boot
src/routes/gameRoutes.js          POST /api/game/{initiate,process,settle}
src/app.js / src/server.js        App assembly + startup/graceful shutdown
```

## Adding a game (the extension point)

The engine registry is the single place to extend. To add any of the other 29 games — no core
files change:

1. Create `src/engines/<yourGame>.js` extending `BaseGameEngine` and implement three pure hooks:
   - `initiate(ctx)` → the initial `game_metadata` to persist (server-side state).
   - `processStep(ctx)` → `{ metadata, status: 'CONTINUE'|'WIN'|'LOSE', result }` (client-safe `result`).
   - `settle(ctx)` → authoritative integer payout, derived from stored metadata (never client input).
2. Register it in `src/games/index.js`: `registerEngine(new YourEngine())`.

A game with no registered engine **fails closed** (409) rather than guessing. `russian_roulette`
is the reference implementation.

## Setup

```bash
npm install

# 1. Create the database and load the schema
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS gaming"
mysql -u root -p gaming < db/schema.sql

# 2. Seed a user and a game to test against
mysql -u root -p gaming <<'SQL'
INSERT INTO users (external_uid, points_balance) VALUES (UUID(), 100);
INSERT INTO games_directory (game_key, display_name, game_type, max_bet)
VALUES ('spin-wheel', 'Spin Wheel', 'LUCK', 50);
SQL

# 3. Configure and run
cp .env.example .env      # fill in DB creds + a strong JWT_SECRET
npm start
```

## The endpoint

`POST /api/game/initiate`

| Part | Value |
|------|-------|
| Auth | `Authorization: Bearer <jwt>` — the app-injected WebView token. The acting `user_id` is read from the token's `sub` claim (configurable), **never** from the body. |
| Body | `{ "game_id": number, "points_bet": number, "idempotency_key"?: string }` |
| 201  | `{ success: true, data: { session_id, game_id, points_bet, balance_after } }` |
| 200  | Same shape — returned when an `idempotency_key` replays an existing session. |
| 4xx/5xx | `{ success: false, error: { code, message, details? } }` |

Error codes: `VALIDATION_ERROR` (400), `UNAUTHENTICATED` (401), `FORBIDDEN` (403),
`NOT_FOUND` (404), `CONFLICT` (409), `INSUFFICIENT_FUNDS` (422), `INTERNAL_ERROR` (500).

### Example

```bash
# Mint a quick test token (matches JWT_USER_ID_CLAIM=sub and the seeded user_id=1)
TOKEN=$(node -e "console.log(require('jsonwebtoken').sign({sub:1}, process.env.JWT_SECRET, {expiresIn:'1h'}))")

curl -sX POST http://localhost:3000/api/game/initiate \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"game_id":1,"points_bet":10}'
```

## `POST /api/game/settle`

Settles a session started by `/initiate`: computes the payout **server-side**, credits it, and
moves the session `ACTIVE → SETTLED`.

| Part | Value |
|------|-------|
| Auth | `Authorization: Bearer <jwt>` — must be the session's owner (else `404`, existence not revealed). |
| Body | `{ "session_id": uuid, "result"?: object }` — `result` is an **opaque, untrusted** payload passed to the resolver; it is never used as the payout. |
| 200  | `{ success: true, data: { session_id, status: "SETTLED", payout, balance_after } }` |

**The payout is authoritative and server-computed** by the game's engine (`engine.settle`),
derived from the session's stored `game_metadata` — never from client input. With no engine
registered, settlement **fails closed** (`409`).

Settlement is **idempotent**: re-settling a `SETTLED` session returns the stored payout with no
second credit, and concurrent double-settles collapse to a single credit (session-row `FOR UPDATE`
lock + guarded `status='ACTIVE'` update).

A misbehaving resolver is bounded on two axes before any credit: an absolute ceiling
(`MAX_PAYOUT`, mirrored by a DB `CHECK` on `game_sessions.payout`) and a generous per-stake
ceiling (`MAX_PAYOUT_MULTIPLIER`) that still allows large jackpots but rejects absurd returns.

```bash
curl -sX POST http://localhost:3000/api/game/settle \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"session_id":"<uuid-from-initiate>","result":{}}'
```

## `POST /api/game/process`

Advances one game step for an active session (an engine-specific `action`, e.g. a trigger pull).

| Part | Value |
|------|-------|
| Auth | `Authorization: Bearer <jwt>` — must be the session owner (else `404`). |
| Body | `{ "session_id": uuid, "action": string, "payload"?: object }` — `payload` is opaque/untrusted. |
| 200  | `{ success: true, data: { session_id, status, step, settlement } }` |

`status` is `CONTINUE` \| `WIN` \| `LOSE`. On a terminal step the session is **auto-settled in the
same transaction** (`settlement` carries `payout` + `balance_after`); on `CONTINUE`, `settlement`
is `null`. The response contains only the engine's client-safe `step` result — **never** the raw
`game_metadata` (e.g. the roulette chamber layout stays server-side).

**Russian Roulette flow:** `/initiate` stores a `crypto`-shuffled chamber layout in
`game_metadata`. Each `{"action":"pull"}` either survives (multiplier grows, session stays
`ACTIVE`) or hits the bullet (`LOSE`, auto-settled at payout 0). `{"action":"cashout"}` ends the
game as a `WIN`, auto-settled at the stored multiplier (with house edge).

```bash
curl -sX POST http://localhost:3000/api/game/process \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"session_id":"<uuid>","action":"pull"}'
```

## How concurrency & integrity are guaranteed

- **Atomicity** — the balance debit, `game_sessions` insert, and `points_ledger` insert run in
  one `START TRANSACTION ... COMMIT`. Any failure rolls back all three.
- **Race safety** — `SELECT ... FOR UPDATE` on the user's row serializes concurrent bets for
  that user, so two simultaneous requests cannot both read the pre-debit balance.
- **Deadlock resilience** — `withTransaction` retries automatically (up to 3x) on MySQL errno
  1213 (deadlock) and 1205 (lock wait timeout), the only safely-retryable transaction failures.
- **Double-submit safety** — an optional `idempotency_key`, unique **per user**
  (`UNIQUE (user_id, idempotency_key)`), collapses retried client requests to a single session
  and a single charge. Scoping to the user prevents one account replaying another's session.
  A concurrent duplicate resolves to the winner's session (200), never a double charge.
- **No negative balance** — three independent guards: `BIGINT UNSIGNED` column, a
  `CHECK (points_balance >= 0)` constraint, and a guarded `UPDATE ... WHERE points_balance >= ?`.
- **Precision** — points are whole `BIGINT` values compared with `BigInt` in JS (never floats,
  no 2^53 truncation). The driver returns big numbers as strings.
- **Trust boundary** — `user_id` comes only from the verified JWT (with a pinned algorithm
  allow-list); every query is parameterized; the error handler never leaks SQL/stack traces to
  clients; required secrets are validated at startup.
- **Abuse / hardening** — per-user rate limiting on `/initiate` (in-memory; back with Redis for
  multi-instance), Helmet security headers, and a transaction wrapper that destroys (never
  reuses) a connection whose rollback failed, so a stale open transaction can't leak into a
  later request.

## Verifying the concurrency guarantee

With a user at `points_balance = 100` and a game allowing `points_bet = 10`, fire ~20 bets in
parallel. Exactly 10 should return 201, the rest `422 INSUFFICIENT_FUNDS`, the final balance
should be 0, and `SELECT -SUM(amount) FROM points_ledger WHERE user_id = ?` should equal 100 —
no overdraft. This is automated in the test suite below.

## Automated tests

Integration tests live in `test/` and run against a **real MySQL 8** — row locks and
transactions cannot be mocked. They use Node's built-in test runner (no extra test deps) and a
throwaway Docker container that is started, schema-loaded, and torn down automatically.

```bash
npm test          # requires Docker running
```

`test/helpers/docker-mysql.js` spins up a `mysql:8` container (host port `3307`, override with
`TEST_DB_PORT`), and `test/integration.test.js` covers:

- **Concurrency:** 20 parallel bets against a balance of 100 → exactly 10 succeed, the rest fail
  with `INSUFFICIENT_FUNDS`, final balance is `0`, and the ledger reconciles — the overdraft
  proof, automated. Plus: a rejected bet leaves no partial state.
- **Idempotency:** sequential retry with the same key replays one session (charged once);
  concurrent duplicates collapse to one session/one charge; and the same key across two users
  stays isolated (no cross-account replay — the C1 fix).
- **Validation/game rules:** bet outside the game's min/max, and bets on inactive games.
- **Settlement:** credits a win (2× bet) and marks `SETTLED`; records a loss with no credit;
  idempotent re-settle (no double credit); concurrent double-settle collapses to one credit;
  refuses to settle another user's session; rejects unknown sessions.
- **Russian Roulette engine (`/process`):** stores a chamber layout at initiate without leaking
  it; a safe pull grows the multiplier and stays `ACTIVE`; a fatal pull auto-settles as a loss;
  cash-out auto-settles the win at the stored multiplier; rejects processing a settled session
  or another user's session.

> No Docker? Point the tests at any MySQL 8 by exporting `DB_*` env vars and adapting
> `test/helpers/docker-mysql.js` to skip container management (see the `startMysql` comments).

## Leaderboards (Redis Sorted Sets + MySQL fallback)

Live leaderboards use Redis Sorted Sets as a hot cache in front of MySQL (the durable source
of truth in `leaderboard_scores`). Module: `src/leaderboard/`.

```
src/leaderboard/keys.js                 Pure key/period helpers (UTC), ZREVRANGE parser
src/leaderboard/leaderboardRepository.js MySQL ops incl. the top-N fallback query
src/leaderboard/leaderboardService.js    The module: ZADD/ZINCRBY/ZREVRANGE + fallback + rebuild
src/leaderboard/index.js                 Production wiring (pool + ioredis client), graceful close
src/redis/client.js                      Resilient ioredis client (fail-fast → fallback)
```

**Keys** (all UTC): `leaderboard:global`, `leaderboard:daily:2026-08-05`,
`leaderboard:weekly:2026-08-03` (Monday of the week). Daily/weekly keys carry TTLs
(`LEADERBOARD_DAILY_TTL` / `LEADERBOARD_WEEKLY_TTL`) so memory stays bounded.

**API** (`leaderboardService`):
| Method | Redis | Fallback |
|--------|-------|----------|
| `addScore(userId, score)` | `ZADD` (all periods) | MySQL upsert (durable, written first) |
| `incrementScore(userId, delta)` | `ZINCRBY` | MySQL upsert-add |
| `getTopPlayers(period, {limit=100})` | `ZREVRANGE … WITHSCORES` | `SELECT … ORDER BY score DESC LIMIT n` |
| `getPlayerRank(userId, period)` | `ZREVRANK` (+1) | count-of-higher query |
| `getPlayerScore(userId, period)` | `ZSCORE` | `SELECT score` |
| `rebuildFromDatabase(period)` | rehydrate via temp key + atomic `RENAME` | reads `leaderboard_scores` |
| `reconcileFromLedger(period)` | refreshes Redis after repair | rebuilds `leaderboard_scores` by summing `points_ledger` `GAME_PAYOUT` credits |

`period` ∈ `global` | `daily` | `weekly`. `getTopPlayers` returns `{ source: 'redis'|'mysql', entries: [{userId, score, rank}] }`.

**Resilience — functional under any scenario:**
- Writes persist to **MySQL first**; the Redis update is best-effort and never fails the call.
- Reads serve from Redis when it's ready and warm, and **fall back to MySQL** on any Redis error,
  when Redis is down/connecting, or when the key is cold/empty.
- The ioredis client uses `enableOfflineQueue:false` + a short `commandTimeout`, so a dead/slow
  Redis **fails fast** to the fallback instead of hanging. It reconnects in the background and
  self-heals; call `rebuildFromDatabase()` after an outage to re-warm from MySQL.
- Set `REDIS_ENABLED=false` to run MySQL-only (still fully functional).
- **Durability/repair**: the per-settlement increment is best-effort, so `leaderboard_scores`
  could drift if an increment is lost. `reconcileFromLedger(period)` repairs it from the money
  source of truth — summing `points_ledger` `GAME_PAYOUT` credits per user over the period's UTC
  window — then refreshes Redis.
- **Automatic reconciliation**: `server.js` starts an in-process UTC cron (`node-cron`) that runs
  `reconcileFromLedger` on a schedule — daily/weekly hourly, global nightly by default — so drift
  self-repairs with no manual step. Each job has an overlap guard and isolates errors. Configure
  or disable via `LEADERBOARD_RECONCILE_*` env vars (an empty expression disables that period);
  jobs start only in `server.js`, never during tests/app-assembly.

### `GET /api/leaderboard`

Read-only, JWT-authenticated. Query: `period=global|daily|weekly` (default global), `limit` (1–1000,
default 100). Returns the top players plus the caller's own standing:

```bash
curl -s "http://localhost:3000/api/leaderboard?period=daily&limit=100" \
  -H "Authorization: Bearer $TOKEN"
# { success:true, data:{ period, source:'redis'|'mysql',
#   entries:[{ rank, score, alias, isYou }...],
#   me:{ alias, rank, score } } }
```

`source` tells you whether the response came from Redis or the MySQL fallback.

**Privacy:** the public list never exposes raw `user_id`. Each entry carries a stable **opaque
alias** (`p_…`, an HMAC of the user id under `LEADERBOARD_ALIAS_SECRET`) — non-reversible and
non-enumerable — plus an `isYou` flag so the caller can find their own row.

### Auto-populated from settlement

Winnings feed the boards automatically: after `/api/game/settle` or a terminal `/api/game/process`
credits a payout, the route layer calls `leaderboardService.incrementScore(userId, payout)` across
global/daily/weekly. It's best-effort (never fails the settle response) and guarded against
idempotent-replay double-counting, so a retried settle can't inflate the board. A total loss
(payout 0) is a no-op. The board's score is therefore "points won".

**Tests:** `node --test "test/leaderboard/**/*.test.js"` — pure unit tests (no Redis/DB needed):
key/period/UTC math and the full Redis→MySQL fallback logic via injected stubs.

## Suggested next steps

- Add the remaining games as engines in `src/engines/` + one `registerEngine()` line each.
- Tune the roulette multiplier curve / house edge, or move them to per-game config.
- Move rate limiting to a shared Redis store for multi-instance deployments.
- Swap the hand-rolled validator for `zod` schemas.
- Add unit + integration tests (including the concurrency proof above) against a test database.
