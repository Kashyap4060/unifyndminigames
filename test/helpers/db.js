'use strict';

const mysql = require('mysql2/promise');
const { HOST, PORT, DATABASE, ROOT_PASSWORD } = require('./docker-mysql');

let gameKeyCounter = 0;

/**
 * A test-owned pool (separate from the service's pool) used for seeding data
 * and asserting final state. Matches the service's BIGINT-as-string handling.
 */
function makePool() {
  return mysql.createPool({
    host: HOST,
    port: Number(PORT),
    user: 'root',
    password: ROOT_PASSWORD,
    database: DATABASE,
    connectionLimit: 10,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
}

/**
 * Wipes all domain tables between tests. Uses TRUNCATE (which bypasses the
 * append-only BEFORE DELETE trigger on points_ledger) with FK checks disabled,
 * on a single connection so the session-scoped setting applies to every stmt.
 */
async function resetData(pool) {
  const conn = await pool.getConnection();
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    await conn.query('TRUNCATE TABLE points_ledger');
    await conn.query('TRUNCATE TABLE game_sessions');
    await conn.query('TRUNCATE TABLE users');
    await conn.query('TRUNCATE TABLE games_directory');
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  } finally {
    conn.release();
  }
}

/** @returns {Promise<number>} the new user_id */
async function seedUser(pool, pointsBalance, status = 'ACTIVE') {
  const [res] = await pool.execute(
    'INSERT INTO users (external_uid, points_balance, status) VALUES (UUID(), ?, ?)',
    [String(pointsBalance), status],
  );
  return res.insertId;
}

/** @returns {Promise<number>} the new game_id */
async function seedGame(
  pool,
  { key, minBet = 1, maxBet = 50, status = 'ACTIVE', type = 'LUCK' } = {},
) {
  gameKeyCounter += 1;
  const gameKey = key || `test-game-${gameKeyCounter}`;
  const [res] = await pool.execute(
    `INSERT INTO games_directory (game_key, display_name, game_type, status, min_bet, max_bet)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [gameKey, `Test Game ${gameKeyCounter}`, type, status, minBet, maxBet],
  );
  return res.insertId;
}

/** @returns {Promise<string>} balance as a string (BIGINT-safe) */
async function getBalance(pool, userId) {
  const [rows] = await pool.execute('SELECT points_balance FROM users WHERE user_id = ?', [userId]);
  return rows.length ? String(rows[0].points_balance) : null;
}

/** @returns {Promise<number>} total points debited via GAME_BET for the user */
async function sumBetDebits(pool, userId) {
  const [rows] = await pool.execute(
    `SELECT COALESCE(-SUM(amount), 0) AS total
       FROM points_ledger
      WHERE user_id = ? AND reason = 'GAME_BET'`,
    [userId],
  );
  return Number(rows[0].total);
}

/** @returns {Promise<number>} session row count for the user */
async function countSessions(pool, userId) {
  const [rows] = await pool.execute(
    'SELECT COUNT(*) AS c FROM game_sessions WHERE user_id = ?',
    [userId],
  );
  return Number(rows[0].c);
}

/** @returns {Promise<number>} GAME_BET ledger row count for the user */
async function countBetLedgerRows(pool, userId) {
  const [rows] = await pool.execute(
    "SELECT COUNT(*) AS c FROM points_ledger WHERE user_id = ? AND reason = 'GAME_BET'",
    [userId],
  );
  return Number(rows[0].c);
}

/** @returns {Promise<number>} GAME_PAYOUT ledger row count for the user */
async function countPayoutLedgerRows(pool, userId) {
  const [rows] = await pool.execute(
    "SELECT COUNT(*) AS c FROM points_ledger WHERE user_id = ? AND reason = 'GAME_PAYOUT'",
    [userId],
  );
  return Number(rows[0].c);
}

/** @returns {Promise<{status:string, payout:string|null}|null>} */
async function getSession(pool, sessionId) {
  const [rows] = await pool.execute(
    'SELECT status, payout FROM game_sessions WHERE session_id = ?',
    [sessionId],
  );
  if (rows.length === 0) return null;
  return {
    status: rows[0].status,
    payout: rows[0].payout == null ? null : String(rows[0].payout),
  };
}

/** @returns {Promise<object|null>} parsed game_metadata JSON */
async function getSessionMetadata(pool, sessionId) {
  const [rows] = await pool.execute(
    'SELECT game_metadata FROM game_sessions WHERE session_id = ?',
    [sessionId],
  );
  if (rows.length === 0 || rows[0].game_metadata == null) return null;
  const raw = rows[0].game_metadata;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

module.exports = {
  makePool,
  resetData,
  seedUser,
  seedGame,
  getBalance,
  sumBetDebits,
  countSessions,
  countBetLedgerRows,
  countPayoutLedgerRows,
  getSession,
  getSessionMetadata,
};
