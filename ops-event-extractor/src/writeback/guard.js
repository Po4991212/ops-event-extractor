'use strict';
const { GateError } = require('../core/errors');
const { audit } = require('../db/db');

/**
 * One chokepoint for every external mutation.
 *
 * Two independent switches, checked here and nowhere else, immediately before
 * the call that changes something outside this process:
 *   1. --live on the command that is running (an intentional act, per run)
 *   2. OPS_EXTERNAL_WRITES_APPROVED=1 in the environment (an intentional act,
 *      per machine, by whoever set the environment up)
 *
 * Either switch alone leaves the system in dry run. Dry run is not a
 * simulation of the request - the identical payload is built and persisted,
 * and only dispatch is withheld - so what you inspect is what would be sent.
 */
function writeMode(cfg, { live = false } = {}) {
  const flag = Boolean(live);
  const env = cfg.externalWritesApproved === true;
  return {
    live: flag && env,
    flagPresent: flag,
    envApproved: env,
    reason: flag && env ? 'both switches set'
      : !flag && !env ? 'neither switch set'
        : flag ? 'run flag set but OPS_EXTERNAL_WRITES_APPROVED is not 1'
          : 'OPS_EXTERNAL_WRITES_APPROVED is 1 but the run flag was not passed',
  };
}

function assertExternalWrite(db, cfg, clock, { live, operation, target }) {
  const mode = writeMode(cfg, { live });
  audit(db, {
    at: clock.nowISO(), actor: 'guard', action: mode.live ? 'external_write_permitted' : 'external_write_withheld',
    subjectType: 'outbox', subjectId: target || operation, detail: { operation, ...mode },
  });
  if (!mode.live) {
    throw new GateError(`external write withheld: ${mode.reason}`, { operation, ...mode });
  }
  return mode;
}

module.exports = { writeMode, assertExternalWrite };
