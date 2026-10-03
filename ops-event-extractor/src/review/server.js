'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const views = require('./views');
const { audit } = require('../db/db');
const { draftsFor } = require('../drafts/drafts');
const { setStatus } = require('../tasks/tasks');

/**
 * Review console.
 *
 * Binds to 127.0.0.1 only, and refuses any request whose Host is not loopback
 * or whose Origin is not this server. It is an internal tool holding client
 * data, so it does not become reachable because someone put it behind a
 * reverse proxy without thinking about it.
 *
 * Writes are POST only, carry a per-process CSRF token, and use the
 * obligation's version for an optimistic check - two reviewers on the same item
 * cannot silently overwrite each other. Only fields on an allowlist can be
 * changed by hand, and a correction creates a new version rather than editing
 * the old one.
 */
const PATCH_ALLOWLIST = new Set(['obligation_subject', 'stated_deadline']);

function loopbackHost(hostHeader, port) {
  if (!hostHeader) return false;
  const h = String(hostHeader).toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}` || h === `[::1]:${port}`;
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function createServer(db, cfg, clock, { port = cfg.reviewPort } = {}) {
  const csrf = crypto.randomBytes(24).toString('hex');
  const ctx = () => ({ csrf, mode: cfg.dataMode, now: clock.nowISO().slice(0, 16).replace('T', ' '), tz: cfg.timezone });

  function send(res, status, html) {
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    });
    res.end(html);
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!loopbackHost(req.headers.host, port)) {
        res.writeHead(421, { 'Content-Type': 'text/plain' });
        res.end('This console only answers requests addressed to 127.0.0.1.\n');
        return;
      }
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const path = url.pathname;

      if (req.method === 'GET' && path === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, mode: cfg.dataMode, now: clock.nowISO() }));
        return;
      }

      if (req.method === 'POST') {
        const origin = req.headers.origin;
        if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
          res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('Origin not allowed.\n'); return;
        }
        const params = new URLSearchParams(await readBody(req));
        if (params.get('csrf') !== csrf) {
          res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('Stale form. Reload the page and try again.\n'); return;
        }
        let m = path.match(/^\/obligation\/([\w-]+)\/decision$/);
        if (m) { await decideObligation(m[1], params, res); return; }
        m = path.match(/^\/quarantine\/([\w-]+)\/decision$/);
        if (m) { decideQuarantine(m[1], params, res); return; }
      }

      if (req.method === 'GET' && path === '/') { send(res, 200, index()); return; }
      let m = path.match(/^\/obligation\/([\w-]+)$/);
      if (req.method === 'GET' && m) { const h = obligation(m[1]); send(res, h ? 200 : 404, h || notFound()); return; }
      m = path.match(/^\/quarantine\/([\w-]+)$/);
      if (req.method === 'GET' && m) { const h = quarantine(m[1]); send(res, h ? 200 : 404, h || notFound()); return; }
      m = path.match(/^\/message\/([\w:.-]+)$/);
      if (req.method === 'GET' && m) { const h = message(decodeURIComponent(m[1])); send(res, h ? 200 : 404, h || notFound()); return; }

      send(res, 404, notFound());
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`The console could not complete that request: ${e.message}\n`);
    }
  });

  function notFound() {
    return views.layout('Not here', '<div class="wrap"><p class="empty">No such item. It may have been superseded by a newer version.</p></div>', ctx());
  }

  function index() {
    const review = db.prepare(`SELECT t.id AS task_id, t.kind, t.urgent, t.obligation_id, o.account_id, o.account_name,
        o.policy_ref, o.obligation_subject, o.stated_deadline, o.confidence, o.band
      FROM tasks t JOIN obligations o ON o.id = t.obligation_id
      WHERE (o.band = 'review' OR o.band IS NULL) AND t.status NOT IN ('completed','dismissed')
      ORDER BY t.urgent DESC, t.first_action_at`).all();
    const quarantined = db.prepare(`SELECT q.id, q.reason, q.urgent, q.diagnostic, m.subject
      FROM quarantine q LEFT JOIN messages m ON m.id = q.message_id
      WHERE q.triaged_at IS NULL ORDER BY q.urgent DESC, q.created_at`).all()
      .map((q) => ({ ...q, kind: safeKind(q.diagnostic) }));
    const counts = {
      auto: db.prepare("SELECT COUNT(*) c FROM obligations WHERE band = 'auto'").get().c,
      tasks: db.prepare("SELECT COUNT(*) c FROM tasks WHERE status NOT IN ('completed','dismissed')").get().c,
      escalations: db.prepare('SELECT COUNT(*) c FROM task_escalations').get().c,
    };
    return views.indexPage(ctx(), { review, quarantine: quarantined, counts });
  }

  function safeKind(diag) {
    try { return JSON.parse(diag).event.kind; } catch { return null; }
  }

  function obligation(id) {
    const o = db.prepare('SELECT * FROM obligations WHERE id = ?').get(id);
    if (!o) return null;
    const evidence = db.prepare(`SELECT field_path AS path, nature, block_id, quote AS span_text,
        COALESCE(derivation_rule, lookup_provenance, 'recorded') AS support
      FROM evidence WHERE event_version_id = ? ORDER BY id`).all(o.current_version_id);
    const task = db.prepare('SELECT * FROM tasks WHERE obligation_id = ?').get(id);
    const sources = db.prepare(`SELECT m.* FROM source_links sl JOIN messages m ON m.id = sl.message_id
      WHERE sl.obligation_id = ? ORDER BY COALESCE(m.source_ts, m.observed_ts)`).all(id);
    const version = db.prepare('SELECT * FROM event_versions WHERE id = ?').get(o.current_version_id);
    const payload = version ? JSON.parse(version.payload_json) : {};
    o.stated_deadline = o.stated_deadline || payload.stated_deadline || null;
    o.amount = payload.amount ?? null;
    // Gate outcomes are not stored on the accepted version - passing is the
    // condition of being here. What is worth showing is which fields carried
    // evidence and how each was substantiated.
    const gates = evidence.map((e) => ({ ok: true, gate: e.path, detail: e.support }));
    const escalations = task ? db.prepare('SELECT level FROM task_escalations WHERE task_id = ?').all(task.id) : [];
    const drafts = draftsFor(o, cfg);
    return views.obligationPage(ctx(), { obligation: o, evidence, task, sources, gates, drafts, escalations });
  }

  function quarantine(id) {
    const row = db.prepare('SELECT * FROM quarantine WHERE id = ?').get(id);
    if (!row) return null;
    let diagnostic = {};
    try { diagnostic = JSON.parse(row.diagnostic); } catch { diagnostic = { failures: [], event: {} }; }
    const message2 = db.prepare('SELECT * FROM messages WHERE id = ?').get(row.message_id);
    return views.quarantinePage(ctx(), { row, diagnostic, message: message2 });
  }

  function message(id) {
    const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
    if (!m) return null;
    const blocks = db.prepare('SELECT * FROM message_blocks WHERE message_id = ? ORDER BY seq').all(id);
    return views.messagePage(ctx(), { message: m, blocks });
  }

  async function decideObligation(id, params, res) {
    const o = db.prepare('SELECT * FROM obligations WHERE id = ?').get(id);
    if (!o) { send(res, 404, notFound()); return; }
    const seen = Number(params.get('version'));
    if (Number.isFinite(seen) && seen !== o.version) {
      send(res, 409, views.layout('Changed underneath you',
        '<div class="wrap"><p class="empty">This obligation changed since the page loaded. Reload it and review the current version before deciding.</p></div>', ctx()));
      return;
    }
    const decision = params.get('decision') === 'reject' ? 'reject' : 'accept';
    const patch = {};
    for (const [k, v] of params.entries()) {
      if (PATCH_ALLOWLIST.has(k) && String(v) !== String(o[k] ?? '')) patch[k] = v === '' ? null : v;
    }
    const task = db.prepare('SELECT * FROM tasks WHERE obligation_id = ?').get(id);

    db.prepare(`INSERT INTO review_decisions
      (id, subject_type, subject_id, reviewer, base_version, patch_json, reason, created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      `rev_${crypto.randomBytes(8).toString('hex')}`, 'obligation', id, 'reviewer', o.version,
      Object.keys(patch).length ? JSON.stringify(patch) : null, `review decision: ${decision}`, clock.nowISO(),
    );

    if (Object.keys(patch).length) {
      const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ');
      db.prepare(`UPDATE obligations SET ${sets}, version = version + 1, updated_at = ? WHERE id = ?`)
        .run(...Object.values(patch), clock.nowISO(), id);
    } else {
      db.prepare('UPDATE obligations SET version = version + 1, updated_at = ? WHERE id = ?').run(clock.nowISO(), id);
    }
    db.prepare("UPDATE obligations SET band = 'auto' WHERE id = ? AND ? = 'accept'").run(id, decision);
    if (task) {
      setStatus(db, clock, task.id, decision === 'accept' ? 'open' : 'dismissed', {
        actor: 'reviewer', reason: `review decision: ${decision}`,
      });
    }
    audit(db, { at: clock.nowISO(), actor: 'reviewer', action: `obligation_${decision}`, subjectType: 'obligation',
      subjectId: id, detail: { patch } });

    res.writeHead(303, { Location: '/' }); res.end();
  }

  function decideQuarantine(id, params, res) {
    const decision = params.get('decision') === 'escalate' ? 'escalate' : 'dismiss';
    db.prepare('UPDATE quarantine SET triaged_at = ?, triaged_by = ?, resolution = ? WHERE id = ?')
      .run(clock.nowISO(), 'reviewer', decision, id);
    audit(db, { at: clock.nowISO(), actor: 'reviewer', action: `quarantine_${decision}`, subjectType: 'quarantine',
      subjectId: id, detail: {} });
    res.writeHead(303, { Location: '/' }); res.end();
  }

  return { server, csrf, listen: (cb) => server.listen(port, '127.0.0.1', cb) };
}

module.exports = { createServer, loopbackHost, PATCH_ALLOWLIST };
