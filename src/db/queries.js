// Thin prepared-statement helpers. Each function takes the db connection
// explicitly so tests can pass an in-memory/temp-file db (see db/index.js).

export function insertMessage(database, msg) {
  const stmt = database.prepare(`
    INSERT OR IGNORE INTO messages
      (id, thread_id, history_id, internal_date, from_addr, from_domain, to_addrs, cc_addrs,
       subject, label_ids, body_text, body_full, attachment_names, content_hash, source, fetched_at)
    VALUES (@id, @thread_id, @history_id, @internal_date, @from_addr, @from_domain, @to_addrs, @cc_addrs,
       @subject, @label_ids, @body_text, @body_full, @attachment_names, @content_hash, @source, @fetched_at)
  `);
  return stmt.run({
    history_id: null,
    to_addrs: '[]',
    cc_addrs: '[]',
    label_ids: '[]',
    attachment_names: '[]',
    source: 'gmail',
    ...msg
  });
}

export function messageExists(database, id) {
  return !!database.prepare('SELECT 1 FROM messages WHERE id = ?').get(id);
}

export function findMessageByContentHash(database, hash) {
  return database.prepare('SELECT * FROM messages WHERE content_hash = ?').get(hash);
}

export function getMessage(database, id) {
  return database.prepare('SELECT * FROM messages WHERE id = ?').get(id);
}

export function allMessagesOrderedByDate(database) {
  return database.prepare('SELECT * FROM messages ORDER BY internal_date ASC').all();
}

export function insertRoutingLog(database, { msg_id, handler, parser_name = null }) {
  database.prepare('INSERT INTO routing_log (msg_id, handler, parser_name, created_at) VALUES (?, ?, ?, ?)')
    .run(msg_id, handler, parser_name, Date.now());
}

/** INSERT OR IGNORE on event_key (§4.5) — reprocessing never creates a duplicate. */
export function insertEvent(database, ev) {
  const stmt = database.prepare(`
    INSERT OR IGNORE INTO events
      (event_key, source_msg_id, source_thread_id, kind, obligation, due_date, due_date_basis,
       account_name_raw, account_id, owner, carrier, policy_no, amount_cents,
       extractor, extractor_ref, confidence, confidence_parts, confidence_gate, raw_span, status,
       superseded_by, extracted_at)
    VALUES (@event_key, @source_msg_id, @source_thread_id, @kind, @obligation, @due_date, @due_date_basis,
       @account_name_raw, @account_id, @owner, @carrier, @policy_no, @amount_cents,
       @extractor, @extractor_ref, @confidence, @confidence_parts, @confidence_gate, @raw_span, @status,
       @superseded_by, @extracted_at)
  `);
  return stmt.run({ owner: null, superseded_by: null, confidence_gate: null, ...ev });
}

export function getEvent(database, eventKey) {
  return database.prepare('SELECT * FROM events WHERE event_key = ?').get(eventKey);
}

export function supersedeEvent(database, { oldKey, newKey }) {
  database.prepare("UPDATE events SET status = 'superseded', superseded_by = ? WHERE event_key = ?").run(newKey, oldKey);
}

export function insertEventSource(database, { event_key, source_msg_id }) {
  database.prepare('INSERT OR IGNORE INTO event_sources (event_key, source_msg_id, first_seen_at) VALUES (?, ?, ?)')
    .run(event_key, source_msg_id, Date.now());
}

export function eventSourceCount(database, eventKey) {
  return database.prepare('SELECT COUNT(*) AS n FROM event_sources WHERE event_key = ?').get(eventKey).n;
}

export function insertReviewQueue(database, { event_key, reason, candidates }) {
  database.prepare('INSERT OR IGNORE INTO review_queue (event_key, reason, candidates) VALUES (?, ?, ?)')
    .run(event_key, reason, JSON.stringify(candidates || []));
}

export function resolveReviewQueue(database, { event_key, resolution }) {
  database.prepare('UPDATE review_queue SET resolved_at = ?, resolution = ? WHERE event_key = ?')
    .run(Date.now(), JSON.stringify(resolution), event_key);
}

export function pendingReviewItems(database) {
  return database.prepare(`
    SELECT rq.*, e.* FROM review_queue rq JOIN events e ON e.event_key = rq.event_key
    WHERE rq.resolved_at IS NULL ORDER BY e.extracted_at ASC
  `).all();
}

export function insertTask(database, task) {
  const stmt = database.prepare(`
    INSERT OR IGNORE INTO tasks
      (event_key, title, due_date, sla_first_action, sla_escalate, sla_critical, owner, state, qq_note_id, created_at)
    VALUES (@event_key, @title, @due_date, @sla_first_action, @sla_escalate, @sla_critical, @owner, @state, @qq_note_id, @created_at)
  `);
  return stmt.run({ owner: null, state: 'open', qq_note_id: null, ...task });
}

export function openTasks(database) {
  return database.prepare(`
    SELECT t.*, e.kind, e.obligation, e.account_name_raw, e.account_id, e.carrier, e.policy_no, e.confidence
    FROM tasks t JOIN events e ON e.event_key = t.event_key
    WHERE t.state = 'open' ORDER BY t.sla_first_action ASC
  `).all();
}

export function insertGroundTruth(database, row) {
  database.prepare(`
    INSERT INTO ground_truth (source_msg_id, source_line, account_name_raw, kind, obligation, due_date, observed_on)
    VALUES (@source_msg_id, @source_line, @account_name_raw, @kind, @obligation, @due_date, @observed_on)
  `).run(row);
}

export function allGroundTruth(database) {
  return database.prepare('SELECT * FROM ground_truth ORDER BY observed_on ASC').all();
}

export function insertLlmCall(database, row) {
  database.prepare(`
    INSERT INTO llm_calls (msg_id, purpose, model, input_tokens, output_tokens, cost_cents, latency_ms, ok, error, created_at)
    VALUES (@msg_id, @purpose, @model, @input_tokens, @output_tokens, @cost_cents, @latency_ms, @ok, @error, @created_at)
  `).run({ error: null, ...row });
}

export function llmCallStats(database) {
  return database.prepare(`
    SELECT purpose, model, COUNT(*) AS calls, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
           SUM(cost_cents) AS cost_cents, AVG(latency_ms) AS avg_latency_ms
    FROM llm_calls GROUP BY purpose, model
  `).all();
}

export function getSyncState(database, key) {
  return database.prepare('SELECT value FROM sync_state WHERE key = ?').get(key)?.value ?? null;
}

export function setSyncState(database, key, value) {
  database.prepare('INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)').run(key, value);
}
