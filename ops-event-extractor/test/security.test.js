'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const h = require('./helpers');
const views = require('../src/review/views');
const { createServer, loopbackHost, PATCH_ALLOWLIST } = require('../src/review/server');

test('the review console refuses any request not addressed to loopback', async () => {
  for (const host of ['ops.example.com', '127.0.0.1.evil.test:8766', 'example.com:8766', '', undefined]) {
    assert.equal(loopbackHost(host, 8766), false, `${host} is refused`);
  }
  for (const host of ['127.0.0.1:8766', 'localhost:8766', '[::1]:8766']) {
    assert.equal(loopbackHost(host, 8766), true, `${host} is accepted`);
  }

  const c = await h.processedCorpus();
  const port = 8791;
  const { server, listen } = createServer(c.db, c.cfg, c.clock, { port });
  await new Promise((r) => listen(r));
  const raw = await new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write('GET / HTTP/1.1\r\nHost: ops.example.com\r\nConnection: close\r\n\r\n'));
    let buf = ''; s.on('data', (d) => { buf += d; }); s.on('end', () => resolve(buf));
  });
  assert.match(raw.split('\r\n')[0], /421/, 'a foreign Host header is refused at the wire');
  server.close();
  h.cleanup(c.dir);
});

test('hostile content in a message renders as text, never as markup', () => {
  const payload = '<script>alert(1)</script><img src=x onerror=alert(2)> "q" & \'s\'';
  const html = views.messagePage({ csrf: 'c', mode: 'synthetic', now: 'n', tz: 'tz' }, {
    message: { subject: payload, from_address: payload, source_ts: '', observed_ts: '', processing_complete: 1 },
    blocks: [{ seq: 0, kind: 'reply', canonical_text: payload }],
  });
  assert.ok(!/<script>alert/.test(html), 'no script element');
  assert.ok(!/<img src=x onerror/.test(html), 'no event handler attribute');
  assert.ok(html.includes('&lt;script&gt;'), 'it appears escaped instead');
  assert.ok(html.includes('&quot;q&quot;'), 'quotes escaped');
  assert.ok(html.includes('&amp;'), 'ampersands escaped');
});

test('review writes need CSRF, a matching version, and an allowlisted field', async () => {
  const c = await h.processedCorpus();
  const port = 8792;
  const { server, listen, csrf } = createServer(c.db, c.cfg, c.clock, { port });
  await new Promise((r) => listen(r));
  const base = `http://127.0.0.1:${port}`;
  const obl = c.db.prepare('SELECT * FROM obligations LIMIT 1').get();
  const post = (body, headers = {}) => fetch(`${base}/obligation/${obl.id}/decision`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body,
  });

  assert.equal((await post('decision=accept')).status, 403, 'no CSRF token');
  assert.equal((await post(`csrf=${csrf}&decision=accept`, { Origin: 'http://evil.test' })).status, 403, 'foreign Origin');
  assert.equal((await post(`csrf=${csrf}&decision=accept&version=999`)).status, 409, 'stale version');

  const ok = await post(`csrf=${csrf}&decision=accept&version=${obl.version}&obligation_subject=Edited&status=hacked&account_id=acct_evil`);
  assert.equal(ok.status, 303, 'a well-formed decision is accepted');
  const after = c.db.prepare('SELECT * FROM obligations WHERE id = ?').get(obl.id);
  assert.equal(after.obligation_subject, 'Edited', 'the allowlisted field changed');
  assert.equal(after.status, obl.status, 'a field outside the allowlist did not');
  assert.equal(after.account_id, obl.account_id, 'and neither did the account');
  assert.ok(after.version > obl.version, 'the version advanced');

  const decision = c.db.prepare('SELECT * FROM review_decisions WHERE subject_id = ?').get(obl.id);
  assert.ok(decision, 'the decision is recorded with who and when');
  assert.equal(decision.base_version, obl.version, 'against the version the reviewer actually saw');
  server.close();
  h.cleanup(c.dir);
});

test('the source tool refuses a message id the application did not authorize', () => {
  const tool = require('../src/extract/model/source-tool');
  const blocks = [{ seq: 0, kind: 'reply', canonical_text: 'hello' }];
  const ok = tool.handleCall({ authorizedMessageId: 'mbx:a', blocks }, JSON.stringify({ message_id: 'mbx:a' }));
  assert.equal(ok.ok, true);
  assert.match(ok.output, /untrusted source data/, 'content is labelled as data');

  const wrong = tool.handleCall({ authorizedMessageId: 'mbx:a', blocks }, JSON.stringify({ message_id: 'mbx:b' }));
  assert.equal(wrong.ok, false, 'a different id is refused');
  assert.match(wrong.output, /not authorized/);

  const junk = tool.handleCall({ authorizedMessageId: 'mbx:a', blocks }, 'not json');
  assert.equal(junk.ok, false, 'malformed arguments are refused');

  const def = tool.toolDefinition();
  assert.equal(def.name, 'get_normalized_message');
  assert.deepEqual(Object.keys(def.parameters.properties), ['message_id'],
    'the extraction step exposes exactly one read-only parameter');
});

test('the Astra request carries no sampling parameters and pins nothing it was not given', () => {
  const astra = require('../src/extract/model/astra-adapter');
  const cfg = { model: { name: 'gpt-6-astra', snapshot: '', baseUrl: 'https://api.openai.com/v1',
    effortClassify: 'low', effortExtract: 'medium' } };
  const body = astra.buildRequest(cfg, { messageId: 'mbx:a', stage: 'extract' });

  assert.equal(body.model, 'gpt-6-astra', 'no snapshot name was invented');
  assert.equal(body.reasoning.effort, 'medium');
  assert.equal(astra.buildRequest(cfg, { messageId: 'mbx:a', stage: 'classify' }).reasoning.effort, 'low');
  for (const forbidden of ['temperature', 'top_p', 'top_logprobs', 'response_format']) {
    assert.equal(forbidden in body, false, `${forbidden} is not sent`);
  }
  assert.equal(body.text.format.type, 'json_schema', 'structured output goes through text.format');
  assert.equal(body.text.format.strict, true);
  assert.equal(body.tools.length, 1, 'exactly one tool is offered');
  assert.equal(body.tools[0].name, 'get_normalized_message');

  const serialized = JSON.stringify(body);
  assert.ok(!/configuration_update/.test(serialized), 'no invented input item shape');
});

test('credentials are never read from a file on disk', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/core/credentials'), 'utf8');
  assert.ok(!/readFileSync|\.env|process\.env\[/.test(src.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '')),
    'the credential module has no file or environment fallback');
});
