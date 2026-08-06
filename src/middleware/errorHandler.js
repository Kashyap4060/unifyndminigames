'use strict';

const { AppError } = require('../errors');

/**
 * Central Express error handler. Must be registered LAST (after routes).
 *
 * - Known AppErrors are translated into a consistent envelope with their
 *   status/code/message (and validation details when present).
 * - Everything else is logged in full server-side and returned to the client
 *   as a generic 500 — no stack traces, SQL, or driver errnos leak out.
 */
// eslint-disable-next-line no-unused-vars -- Express requires the 4-arg shape.
function errorHandler(err, _req, res, _next) {
  if (err instanceof AppError && err.expose) {
    const body = {
      success: false,
      error: { code: err.code, message: err.message },
    };
    if (err.details !== undefined) body.error.details = err.details;
    return res.status(err.status).json(body);
  }

  // Unexpected / 5xx: log detail internally, return an opaque message.
  // eslint-disable-next-line no-console
  console.error('Unhandled error:', err);
  return res.status(500).json({
    success: false,
    error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
  });
}

module.exports = errorHandler;
