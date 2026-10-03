'use strict';
const { FixedClock } = require('../core/clock');
const { processMessage } = require('../extract/pipeline');
const { runSweep } = require('../tasks/sweeps');
const fulfillment = require('../tasks/fulfillment');

/**
 * Replays the corpus in the order it actually arrived, advancing the clock to
 * each message's own timestamp.
 *
 * This is the difference between "does the system get the right answer" and
 * "would it have got the right answer at the time". Processing everything at
 * once lets information from May leak backwards into a decision that had to be
 * made in March - the renewal looks obvious once you have already seen the
 * lapse notice. Replay forbids that: at each step the only rows visible are the
 * ones whose timestamps precede the current clock.
 */
async function replay(db, cfg, { modelExtractor, onStep, sweepEvery = 5 } = {}) {
  const messages = db.prepare(`SELECT * FROM messages ORDER BY COALESCE(source_ts, observed_ts), id`).all();
  const steps = [];
  let processed = 0;

  for (const message of messages) {
    const at = message.source_ts || message.observed_ts;
    const clock = new FixedClock(cfg.timezone, at);

    const future = db.prepare(`SELECT COUNT(*) c FROM obligations
      WHERE created_at > ?`).get(at).c;
    if (future > 0) {
      throw new Error(`replay integrity: ${future} obligations already exist with timestamps after ${at}`);
    }

    const outcome = await processMessage(db, cfg, clock, message.id, { modelExtractor });
    processed += 1;
    steps.push({ at, messageId: message.id, subject: message.subject, outcome: outcome.status || outcome.stage || 'processed' });
    if (onStep) onStep(steps[steps.length - 1]);

    if (processed % sweepEvery === 0) {
      fulfillment.check(db, cfg, clock);
      runSweep(db, cfg, clock, { name: 'replay' });
    }
  }

  // Final pass at the last observed moment.
  const last = messages.length ? (messages[messages.length - 1].source_ts || messages[messages.length - 1].observed_ts) : null;
  if (last) {
    const clock = new FixedClock(cfg.timezone, last);
    fulfillment.check(db, cfg, clock);
    runSweep(db, cfg, clock, { name: 'replay' });
  }

  return { steps, processed };
}

module.exports = { replay };
