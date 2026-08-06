'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');

// Throwaway MySQL 8 container used only for integration tests.
const CONTAINER = 'gaming-econ-test-mysql';
const ROOT_PASSWORD = 'test_root_pw';
const DATABASE = 'gaming_test';
const HOST = '127.0.0.1';
const PORT = process.env.TEST_DB_PORT || '3307';
const READY_TIMEOUT_MS = 150_000;
const SCHEMA_PATH = path.join(__dirname, '..', '..', 'db', 'schema.sql');

function docker(args, opts = {}) {
  return execFileSync('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], ...opts });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertDockerAvailable() {
  try {
    docker(['--version']);
  } catch (_err) {
    throw new Error(
      'Docker is required to run the integration tests. Install Docker and ensure the daemon is running.',
    );
  }
}

/**
 * Starts a fresh MySQL 8 container, waits until it accepts connections, points
 * the service's DB config at it via process.env, and loads the schema.
 *
 * MUST be called before requiring src/services (the service pool reads env at
 * require time).
 *
 * @returns {Promise<{host: string, port: string, database: string}>}
 */
async function startMysql() {
  assertDockerAvailable();

  // Remove any stale container from a previous aborted run.
  try {
    docker(['rm', '-f', CONTAINER]);
  } catch (_err) {
    /* none existed — fine */
  }

  docker([
    'run', '-d', '--name', CONTAINER,
    '-e', `MYSQL_ROOT_PASSWORD=${ROOT_PASSWORD}`,
    '-e', `MYSQL_DATABASE=${DATABASE}`,
    '-p', `${PORT}:3306`,
    'mysql:8',
  ]);

  // Point the application config at the container BEFORE the service is required.
  process.env.DB_HOST = HOST;
  process.env.DB_PORT = PORT;
  process.env.DB_USER = 'root';
  process.env.DB_PASSWORD = ROOT_PASSWORD;
  process.env.DB_NAME = DATABASE;
  process.env.DB_CONNECTION_LIMIT = '20';
  // Generous lock-wait so the 20-way concurrency test never flakes under load;
  // the deadlock-retry path is still exercised for genuine deadlocks.
  process.env.DB_LOCK_WAIT_TIMEOUT = '30';
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);

  await waitUntilReady();
  loadSchema();

  return { host: HOST, port: PORT, database: DATABASE };
}

async function waitUntilReady() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const conn = await mysql.createConnection({
        host: HOST,
        port: Number(PORT),
        user: 'root',
        password: ROOT_PASSWORD,
      });
      await conn.query('SELECT 1');
      await conn.end();
      return;
    } catch (err) {
      lastErr = err;
      await sleep(2000);
    }
  }
  throw new Error(`MySQL container did not become ready in time: ${lastErr && lastErr.message}`);
}

/**
 * Loads db/schema.sql by piping it into the container's mysql client, which (unlike
 * the mysql2 driver) understands the DELIMITER blocks used for the ledger triggers.
 */
function loadSchema() {
  const sql = fs.readFileSync(SCHEMA_PATH);
  docker(
    ['exec', '-i', CONTAINER, 'mysql', '-uroot', `-p${ROOT_PASSWORD}`, DATABASE],
    { input: sql },
  );
}

function stopMysql() {
  try {
    docker(['rm', '-f', CONTAINER]);
  } catch (_err) {
    /* already gone */
  }
}

module.exports = { startMysql, stopMysql, HOST, PORT, DATABASE, ROOT_PASSWORD };
