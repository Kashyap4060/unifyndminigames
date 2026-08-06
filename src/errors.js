'use strict';

/**
 * Typed application errors. Each carries an HTTP `status` and a stable machine
 * `code` so the central error handler can translate them into a consistent API
 * envelope without leaking internals to the client.
 */

class AppError extends Error {
  constructor(message, { status, code, details } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.status = status || 500;
    this.code = code || 'INTERNAL_ERROR';
    if (details !== undefined) this.details = details;
    // Marks errors that are safe to surface to clients verbatim.
    this.expose = this.status < 500;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

class ValidationError extends AppError {
  constructor(message, details) {
    super(message, { status: 400, code: 'VALIDATION_ERROR', details });
  }
}

class AuthError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, { status: 401, code: 'UNAUTHENTICATED' });
  }
}

class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, { status: 403, code: 'FORBIDDEN' });
  }
}

class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, { status: 404, code: 'NOT_FOUND' });
  }
}

class ConflictError extends AppError {
  constructor(message = 'Conflict') {
    super(message, { status: 409, code: 'CONFLICT' });
  }
}

class InsufficientFundsError extends AppError {
  constructor(message = 'Insufficient points balance', details) {
    super(message, { status: 422, code: 'INSUFFICIENT_FUNDS', details });
  }
}

module.exports = {
  AppError,
  ValidationError,
  AuthError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  InsufficientFundsError,
};
