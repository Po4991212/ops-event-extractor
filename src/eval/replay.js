import { processMessage } from '../events/store.js';
import { allGroundTruth, allMessagesOrderedByDate, llmCallStats } from '../db/queries.js';
import { isoDate } from '../normalize/dates.js';
import { scoreRun } from './score.js';

/**
 * §7.3: processes every message in chronological order, using each
 * message's own internal_date as "today" (processMessage's default) so the
 * pipeline never sees information from a later message — no lookahead.
 */
export async function replay(database, { from = null, to = null, allowLlm = false } = {}) {
  let messages = allMessagesOrderedByDate(database);
  if (from) messages = messages.filter(m => isoDate(m.internal_date) >= from);
  if (to) messages = messages.filter(m => isoDate(m.internal_date) <= to);

  for (const msg of messages) {
    await processMessage(database, msg, { allowLlm });
  }

  const allEvents = database.prepare(`
    SELECT e.*, m.from_domain FROM events e JOIN messages m ON m.id = e.source_msg_id
  `).all().map(e => ({ ...e, confidence_parts: JSON.parse(e.confidence_parts || '{}') }));

  const groundTruth = allGroundTruth(database);
  const predicted = allEvents.filter(e => e.status !== 'discarded');
  const llmCalls = database.prepare('SELECT * FROM llm_calls').all();

  const metrics = scoreRun({ predicted, groundTruth, allEvents, llmCalls });
  return { messageCount: messages.length, eventCount: allEvents.length, metrics, llmCallStats: llmCallStats(database) };
}
