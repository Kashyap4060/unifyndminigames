'use strict';

/**
 * Helpers for the game_sessions.game_metadata JSON column. mysql2 may return a
 * JSON column already parsed (object) or as a string depending on version/flags,
 * so parseMetadata tolerates both. Writes are always stringified.
 */

function parseMetadata(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch (_err) {
      return null;
    }
  }
  return raw; // already an object
}

function serializeMetadata(obj) {
  return obj == null ? null : JSON.stringify(obj);
}

module.exports = { parseMetadata, serializeMetadata };
