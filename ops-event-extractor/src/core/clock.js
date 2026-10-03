'use strict';
const { DateTime } = require('luxon');

/**
 * Single clock interface. Every date decision in the application goes through
 * one of these so replay and scheduled sweeps are deterministic, and so day
 * boundaries use the configured agency timezone rather than the host machine's.
 */
class Clock {
  constructor(zone) { this.zone = zone; }
  now() { throw new Error('not implemented'); }
  nowISO() { return this.now().toUTC().toISO({ suppressMilliseconds: true }); }
  today() { return this.now().setZone(this.zone).startOf('day'); }
}

class SystemClock extends Clock {
  now() { return DateTime.utc().setZone(this.zone); }
}

/** Deterministic clock for replay, sweeps and tests. */
class FixedClock extends Clock {
  constructor(zone, isoOrDateTime) {
    super(zone);
    this.set(isoOrDateTime);
  }
  set(isoOrDateTime) {
    this._t = typeof isoOrDateTime === 'string'
      ? DateTime.fromISO(isoOrDateTime, { zone: 'utc' }).setZone(this.zone)
      : isoOrDateTime.setZone(this.zone);
    if (!this._t.isValid) throw new Error(`invalid clock time: ${isoOrDateTime}`);
    return this;
  }
  now() { return this._t; }
  advance(duration) { this._t = this._t.plus(duration); return this._t; }
  advanceToISO(iso) { return this.set(iso); }
}

function makeClock(cfg, fixedISO) {
  return fixedISO ? new FixedClock(cfg.timezone, fixedISO) : new SystemClock(cfg.timezone);
}

module.exports = { Clock, SystemClock, FixedClock, makeClock };
