import express from 'express';
import { config } from '../config.js';
import { db, migrate } from '../db/index.js';
import { getEvent, insertTask, pendingReviewItems, resolveReviewQueue } from '../db/queries.js';
import { computeSla } from '../events/sla.js';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderQueue(items) {
  const rows = items.map(it => {
    const candidates = JSON.parse(it.candidates || '[]');
    const candidateOptions = candidates.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)} (${c.score?.toFixed?.(2)})</option>`).join('');
    return `
      <tr>
        <td>${escapeHtml(it.kind)}</td>
        <td>${escapeHtml(it.obligation)}</td>
        <td>${escapeHtml(it.due_date || '—')}</td>
        <td>${escapeHtml(it.account_name_raw || '—')}</td>
        <td>${it.confidence.toFixed(2)}</td>
        <td>${escapeHtml(it.reason)}</td>
        <td><code>${escapeHtml((it.raw_span || '').slice(0, 200))}</code></td>
        <td>
          <form method="post" action="/queue/${encodeURIComponent(it.event_key)}/resolve" style="display:inline">
            <select name="account_id"><option value="">(unchanged: ${escapeHtml(it.account_id || 'none')})</option>${candidateOptions}</select>
            <button name="action" value="accept">Accept</button>
            <button name="action" value="dismiss">Dismiss</button>
          </form>
        </td>
      </tr>`;
  }).join('\n');

  return `<!doctype html><html><head><title>Ops Event Extractor — Review Queue</title>
  <style>body{font-family:system-ui,sans-serif;margin:2rem} table{border-collapse:collapse;width:100%} td,th{border:1px solid #ccc;padding:6px;font-size:13px;vertical-align:top} code{font-size:11px}</style>
  </head><body>
  <h1>Review Queue (${items.length})</h1>
  <p>Every action below is written to <code>review_queue.resolution</code> as a JSON patch (§5.5) — those patches become new labeled examples.</p>
  <table><thead><tr><th>Kind</th><th>Obligation</th><th>Due</th><th>Account (raw)</th><th>Conf.</th><th>Reason</th><th>Raw span</th><th>Action</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="8">Nothing pending.</td></tr>'}</tbody></table>
  </body></html>`;
}

export function createReviewApp(database = db()) {
  migrate(database);
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  app.get('/', (req, res) => res.send(renderQueue(pendingReviewItems(database))));

  app.get('/queue', (req, res) => res.json(pendingReviewItems(database)));

  app.post('/queue/:eventKey/resolve', (req, res) => {
    const { eventKey } = req.params;
    const { action, account_id } = req.body;
    const ev = getEvent(database, eventKey);
    if (!ev) return res.status(404).json({ error: 'unknown event_key' });

    const patch = { action, account_id: account_id || undefined, resolved_by: 'human', resolved_at: new Date().toISOString() };
    resolveReviewQueue(database, { event_key: eventKey, resolution: patch });

    if (action === 'accept') {
      const finalAccountId = account_id || ev.account_id;
      database.prepare("UPDATE events SET status = 'auto', account_id = ? WHERE event_key = ?").run(finalAccountId || null, eventKey);
      const sla = computeSla({ kind: ev.kind, due_date: ev.due_date, extracted_at_date: new Date(ev.extracted_at).toISOString().slice(0, 10) });
      insertTask(database, {
        event_key: eventKey, title: ev.obligation, due_date: ev.due_date,
        sla_first_action: sla.firstAction, sla_escalate: sla.escalate, sla_critical: sla.critical,
        owner: null, state: 'open', qq_note_id: null, created_at: Date.now()
      });
    } else if (action === 'dismiss') {
      database.prepare("UPDATE events SET status = 'dismissed' WHERE event_key = ?").run(eventKey);
    }

    if (req.accepts('html')) return res.redirect('/');
    res.json({ ok: true });
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`.replace(/\\/g, '/') || process.argv[1]?.endsWith('server.js')) {
  const app = createReviewApp();
  app.listen(config.review.port, () => {
    // eslint-disable-next-line no-console
    console.log(`Review queue listening on http://localhost:${config.review.port}`);
  });
}
