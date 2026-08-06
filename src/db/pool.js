'use strict';

const mysql = require('mysql2/promise');
const config = require('../config');

/**
 * Shared mysql2/promise connection pool.
 *
 * BIGINT handling: `supportBigNumbers` + `bigNumberStrings` make the driver
 * return BIGINT columns (points_balance, amounts) as strings rather than JS
 * numbers. Balances can exceed Number.MAX_SAFE_INTEGER (2^53), so we compare
 * and arithmetic them with BigInt — never a lossy float.
 */
const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  connectionLimit: config.db.connectionLimit,
  waitForConnections: true,
  queueLimit: 0,
  supportBigNumbers: true,
  bigNumberStrings: true,
  // Bound how long a statement blocks on a row lock before InnoDB aborts it;
  // the aborted transaction is then retried by withTransaction().
  connectAttributes: { program_name: 'gaming-economy-engine' },
});

// Apply the lock wait timeout to every new physical connection in the pool.
pool.on('connection', (connection) => {
  connection
    .query('SET SESSION innodb_lock_wait_timeout = ?', [config.db.lockWaitTimeout])
    .catch((err) => {
      // Non-fatal: log and continue with the server default.
      // eslint-disable-next-line no-console
      console.error('Failed to set innodb_lock_wait_timeout:', err.message);
    });
});

module.exports = pool;
