'use strict';

const pool = require('./pool');

// MySQL error codes we can safely retry: the transaction was rolled back by
// InnoDB and re-running it from a fresh snapshot is the correct recovery.
const RETRYABLE_ERRNOS = new Set([
  1213, // ER_LOCK_DEADLOCK      — deadlock found; transaction rolled back
  1205, // ER_LOCK_WAIT_TIMEOUT  — lock wait timeout exceeded
]);

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 20;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(err) {
  return err && typeof err.errno === 'number' && RETRYABLE_ERRNOS.has(err.errno);
}

/**
 * Runs `work(connection)` inside a single database transaction.
 *
 * - Acquires a pooled connection, BEGIN, runs the callback, COMMIT.
 * - On any error: ROLLBACK, release the connection, then either retry (for
 *   deadlock / lock-wait-timeout, up to MAX_ATTEMPTS with linear backoff) or
 *   rethrow.
 * - The callback must perform ALL its queries on the passed `connection` so
 *   they participate in the transaction (never on the pool directly).
 *
 * @template T
 * @param {(connection: import('mysql2/promise').PoolConnection) => Promise<T>} work
 * @returns {Promise<T>}
 */
async function withTransaction(work) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const connection = await pool.getConnection();
    // If rollback fails the server-side transaction state is unknown; the
    // connection is destroyed rather than returned to the pool, so a later
    // borrower can never have a stale open transaction implicitly committed.
    let destroyed = false;
    try {
      await connection.beginTransaction();
      const result = await work(connection);
      await connection.commit();
      return result;
    } catch (err) {
      lastError = err;
      try {
        await connection.rollback();
      } catch (_rollbackErr) {
        connection.destroy();
        destroyed = true;
      }

      if (isRetryable(err) && attempt < MAX_ATTEMPTS) {
        await sleep(BASE_BACKOFF_MS * attempt);
        continue;
      }
      throw err;
    } finally {
      // `finally` runs on return, throw, AND continue. Only release a
      // connection we did not destroy.
      if (!destroyed) connection.release();
    }
  }

  // Unreachable in practice (loop either returns or throws), but keeps the
  // contract explicit.
  throw lastError;
}

module.exports = { withTransaction, RETRYABLE_ERRNOS };
