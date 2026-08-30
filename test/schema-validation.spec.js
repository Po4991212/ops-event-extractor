import { describe, expect, it, vi } from 'vitest';
import { openDb, migrate } from '../src/db/index.js';
import { insertMessage } from '../src/db/queries.js';
import { processMessage } from '../src/events/store.js';

// §5.2/§9: a malformed extraction (from a parser bug or a future LLM
// response shape drift) must be discarded loudly, not silently persisted
// or allowed to crash the batch run.

vi.mock('../src/parsers/registry.js', () => ({
  parsers: [{
    name: 'broken-test-parser',
    match: () => true,
    parse: () => [{ kind: 'not_a_real_kind', obligation: 'x', due_date: null, due_date_basis: 'absent', account_name_raw: null, raw_span: 'x', extractor: 'parser', extractor_ref: 'broken-test-parser' }]
  }]
}));

describe('schema validation gate (§5.2, §9)', () => {
  it('discards a malformed extraction (invalid enum kind) instead of crashing or persisting it', async () => {
    const database = migrate(openDb(':memory:'));
    insertMessage(database, {
      id: 'm1', thread_id: 't1', internal_date: Date.now(), from_addr: 'x@y.com', from_domain: 'y.com',
      subject: 'test', body_text: 'body', body_full: 'body', content_hash: 'h1', source: 'synthetic', fetched_at: Date.now()
    });
    const msg = database.prepare('SELECT * FROM messages WHERE id = ?').get('m1');

    const result = await processMessage(database, msg);
    expect(result.events).toEqual([{ event_key: null, status: 'discarded', gate: 'schema_invalid' }]);
    expect(database.prepare('SELECT COUNT(*) n FROM events').get().n).toBe(0);
  });
});
