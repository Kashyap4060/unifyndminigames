'use strict';

/**
 * Applies one or more .sql files to the configured MySQL database using the
 * mysql2 driver (no mysql CLI or Docker exec needed). DELIMITER-aware so the
 * schema's trigger block loads correctly.
 *
 * Usage: node --env-file=.env scripts/db.js db/schema.sql [db/seed.demo.sql ...]
 * DB connection comes from DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME env vars.
 */

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

/**
 * Split a SQL script into individual statements, honoring `DELIMITER` changes.
 * Exported for testing.
 * @param {string} input
 * @returns {string[]}
 */
function splitSql(input) {
  const statements = [];
  let delimiter = ';';
  let buffer = '';

  for (const rawLine of input.split(/\r?\n/)) {
    const trimmed = rawLine.trim();

    // DELIMITER directive: change the terminator, flush nothing.
    const delimMatch = /^DELIMITER\s+(.+)$/i.exec(trimmed);
    if (delimMatch) {
      delimiter = delimMatch[1].trim();
      continue;
    }

    // Skip standalone comment / blank lines when not mid-statement.
    if (buffer === '' && (trimmed === '' || trimmed.startsWith('--'))) {
      continue;
    }

    buffer += rawLine + '\n';

    if (trimmed.endsWith(delimiter)) {
      let stmt = buffer.trimEnd();
      stmt = stmt.slice(0, stmt.length - delimiter.length).trim();
      if (stmt) statements.push(stmt);
      buffer = '';
    }
  }
  const tail = buffer.trim();
  if (tail) statements.push(tail);
  return statements;
}

async function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('Usage: node --env-file=.env scripts/db.js <file.sql> [more.sql ...]');
    process.exit(1);
  }

  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'gaming',
    multipleStatements: false,
  });

  try {
    for (const file of files) {
      const sql = fs.readFileSync(path.resolve(file), 'utf8');
      const statements = splitSql(sql);
      for (const statement of statements) {
        await connection.query(statement);
      }
      // eslint-disable-next-line no-console
      console.log(`applied ${file} (${statements.length} statements)`);
    }
  } finally {
    await connection.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`db script failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { splitSql };
