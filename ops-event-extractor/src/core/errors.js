'use strict';
/** Typed errors so callers can branch without string matching. */
class AppError extends Error {
  constructor(message, code, detail) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.detail = detail || null;
  }
}
class CapabilityError extends AppError {}   // blocked by the HTTP capability allowlist
class GuardError extends AppError {}        // blocked by the two-switch external write guard
class DataModeError extends AppError {}     // live data access attempted without enablement
class GateError extends AppError {}         // a hard validation gate rejected a candidate event
class ResolutionError extends AppError {}   // account could not be resolved safely
module.exports = { AppError, CapabilityError, GuardError, DataModeError, GateError, ResolutionError };
