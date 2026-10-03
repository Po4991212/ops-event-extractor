'use strict';

/**
 * Server-rendered HTML. No client framework, no bundler, no remote assets.
 *
 * Design brief: a broker's morning triage queue. The decision being made is
 * "is this obligation real, and does the quoted text actually say so" - so the
 * verbatim span is the hero of the page, set in monospace because monospace is
 * how you signal "this is character-for-character what the carrier wrote"
 * rather than a paraphrase. Everything else stays quiet: ledger paper, ink,
 * hairline rules borrowed from a declarations page, and exactly one loud
 * colour reserved for urgency.
 *
 * Every interpolation of stored content goes through esc(). Source text is
 * hostile by assumption.
 */
function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const CSS = `
:root{
  --ledger:#F2F3EF; --card:#FBFBF8; --ink:#1B2A33; --ink-soft:#5C6B73;
  --rule:#C9CFC7; --stamp:#A8322D; --pass:#3F6B53; --quote:#FFFDF4;
}
*{box-sizing:border-box}
body{margin:0;background:var(--ledger);color:var(--ink);
  font:15px/1.55 "Inter","Helvetica Neue",Helvetica,Arial,sans-serif;}
a{color:inherit}
header{border-bottom:1px solid var(--rule);padding:18px 26px;display:flex;
  align-items:baseline;gap:18px;flex-wrap:wrap}
header h1{font-size:19px;font-weight:600;margin:0;letter-spacing:-.01em}
header .where{color:var(--ink-soft);font-size:13px}
main{max-width:1180px;margin:0 auto;padding:26px}
.wrap{display:grid;grid-template-columns:minmax(0,1fr);gap:26px}
@media(min-width:960px){.wrap.split{grid-template-columns:minmax(0,340px) minmax(0,1fr)}}
h2{font-size:15px;font-weight:600;margin:0 0 12px}
.queue{list-style:none;margin:0;padding:0;border-top:1px solid var(--rule)}
.queue li{border-bottom:1px solid var(--rule)}
.queue a{display:block;padding:12px 4px;text-decoration:none}
.queue a:hover,.queue a:focus{background:var(--card);outline:none}
.queue a:focus-visible{box-shadow:inset 3px 0 0 var(--ink)}
.kind{font-weight:600}
.meta{color:var(--ink-soft);font-size:13px}
.urgent .kind:after{content:"urgent";margin-left:8px;font-size:11px;font-weight:600;
  color:var(--stamp);border:1px solid var(--stamp);padding:1px 5px;border-radius:2px;vertical-align:1px}
.panel{background:var(--card);border:1px solid var(--rule);padding:22px}
.field{display:grid;grid-template-columns:150px minmax(0,1fr);gap:6px 14px;margin:0 0 18px}
.field dt{color:var(--ink-soft)}
.field dd{margin:0}
blockquote.span{margin:0 0 6px;background:var(--quote);border-left:3px solid var(--pass);
  padding:12px 14px;font-family:"SFMono-Regular",Consolas,"Liberation Mono",monospace;
  font-size:13.5px;white-space:pre-wrap;overflow-wrap:anywhere}
blockquote.span.bad{border-left-color:var(--stamp)}
.evidence{margin:0 0 22px}
.evidence .why{color:var(--ink-soft);font-size:13px;margin:0 0 16px}
.gates{list-style:none;padding:0;margin:0 0 18px;font-size:13.5px}
.gates li{padding:3px 0 3px 16px;border-left:2px solid var(--pass)}
.gates li.fail{border-left-color:var(--stamp)}
form.decide{border-top:1px solid var(--rule);padding-top:18px;display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}
label{display:block;font-size:13px;color:var(--ink-soft);margin-bottom:4px}
input[type=text],textarea,select{font:inherit;padding:7px 9px;border:1px solid var(--rule);
  background:#fff;color:var(--ink);border-radius:2px;min-width:220px}
button{font:inherit;font-weight:600;padding:8px 16px;border:1px solid var(--ink);
  background:var(--ink);color:var(--ledger);border-radius:2px;cursor:pointer}
button.secondary{background:transparent;color:var(--ink)}
button:focus-visible,a:focus-visible,input:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
.note{color:var(--ink-soft);font-size:13px;margin-top:22px;max-width:68ch}
.empty{padding:26px 0;color:var(--ink-soft);max-width:56ch}
.draft{background:var(--quote);border:1px solid var(--rule);padding:14px;white-space:pre-wrap;
  font-size:13.5px;margin:0 0 14px}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;

function layout(title, body, ctx) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title><style>${CSS}</style></head><body>
<header><h1><a href="/" style="text-decoration:none">Obligation review</a></h1>
<span class="where">${esc(ctx.mode)} data &middot; clock ${esc(ctx.now)} ${esc(ctx.tz)}</span></header>
<main>${body}</main></body></html>`;
}

function queueRow(t) {
  return `<li class="${t.urgent ? 'urgent' : ''}"><a href="/obligation/${esc(t.obligation_id)}">
<span class="kind">${esc(t.kind)}</span>
<div class="meta">${esc(t.account_name || t.account_id || 'account not resolved')}${t.policy_ref ? ` &middot; ${esc(t.policy_ref)}` : ''}</div>
<div class="meta">${esc(String(t.obligation_subject).slice(0, 96))}</div>
<div class="meta">${t.stated_deadline ? `due ${esc(t.stated_deadline)}` : 'no stated deadline'} &middot; confidence ${esc(t.confidence)} (${esc(t.band)})</div>
</a></li>`;
}

function quarantineRow(q) {
  return `<li class="${q.urgent ? 'urgent' : ''}"><a href="/quarantine/${esc(q.id)}">
<span class="kind">${esc(q.kind || 'unparsed')}</span>
<div class="meta">${esc(q.subject || '')}</div>
<div class="meta">failed: ${esc(q.reason)}</div></a></li>`;
}

function indexPage(ctx, { review, quarantine, counts }) {
  const left = `<section><h2>Needs a decision (${review.length})</h2>
${review.length ? `<ul class="queue">${review.map(queueRow).join('')}</ul>`
    : '<p class="empty">Nothing is waiting on a decision. New items appear here when confidence lands in the review band.</p>'}</section>`;
  const right = `<section><h2>Held back (${quarantine.length})</h2>
${quarantine.length ? `<ul class="queue">${quarantine.map(quarantineRow).join('')}</ul>`
    : '<p class="empty">Nothing was held back. Items land here when a gate rejects the evidence, and urgent ones stay visible even while held.</p>'}
<p class="note">${esc(counts.auto)} accepted automatically, ${esc(counts.tasks)} open tasks, ${esc(counts.escalations)} escalations fired.
This console reads and annotates. It cannot send mail and it does not write to the agency management system.</p></section>`;
  return layout('Obligation review', `<div class="wrap split">${left}${right}</div>`, ctx);
}

function evidenceBlock(e) {
  const bad = e.support && /not|no |cannot/i.test(e.support);
  return `<div class="evidence">
<div class="meta">${esc(e.path)} = ${esc(e.value)}</div>
<blockquote class="span${bad ? ' bad' : ''}">${esc(e.span_text)}</blockquote>
<p class="why">${esc(e.nature)} evidence &middot; ${esc(e.support || 'recorded')}</p></div>`;
}

function obligationPage(ctx, { obligation, evidence, task, sources, gates, drafts, escalations }) {
  const body = `<div class="wrap split">
<section><h2>What the source says</h2>
${evidence.length ? evidence.map(evidenceBlock).join('') : '<p class="empty">No evidence rows were recorded for this obligation.</p>'}
<h2>Source messages (${sources.length})</h2><ul class="queue">${sources.map((s) => `<li><a href="/message/${esc(s.id)}">
<span class="kind">${esc(s.from_address)}</span><div class="meta">${esc(s.subject)}</div>
<div class="meta">${esc(s.source_ts || s.observed_ts)} &middot; ${esc(s.mailbox_id)}</div></a></li>`).join('')}</ul></section>

<section class="panel">
<dl class="field">
<dt>Kind</dt><dd>${esc(obligation.kind)}</dd>
<dt>Account</dt><dd>${esc(obligation.account_name || obligation.account_id || 'not resolved')}</dd>
<dt>Policy</dt><dd>${esc(obligation.policy_ref || 'none stated')}</dd>
<dt>Obligation</dt><dd>${esc(obligation.obligation_subject)}</dd>
<dt>Stated deadline</dt><dd>${esc(obligation.stated_deadline || 'none stated')}</dd>
<dt>Confidence</dt><dd>${esc(obligation.confidence)} (${esc(obligation.band)})</dd>
<dt>Task</dt><dd>${task ? `${esc(task.status)} &middot; first action ${esc(task.first_action_at)}` : 'none'}</dd>
<dt>Escalations</dt><dd>${escalations.length ? esc(escalations.map((e) => e.level).join(', ')) : 'none fired'}</dd>
</dl>
<h2>Gate results</h2>
<ul class="gates">${gates.map((g) => `<li class="${g.ok ? '' : 'fail'}">${esc(g.gate)}: ${esc(g.detail)}</li>`).join('')}</ul>
<form class="decide" method="post" action="/obligation/${esc(obligation.id)}/decision">
<input type="hidden" name="csrf" value="${esc(ctx.csrf)}">
<input type="hidden" name="version" value="${esc(obligation.version)}">
<div><label for="corr">Correction (optional)</label>
<input type="text" id="corr" name="obligation_subject" value="${esc(obligation.obligation_subject)}"></div>
<div><label for="dl">Stated deadline</label>
<input type="text" id="dl" name="stated_deadline" value="${esc(obligation.stated_deadline || '')}" placeholder="YYYY-MM-DD"></div>
<button name="decision" value="accept">Confirm obligation</button>
<button class="secondary" name="decision" value="reject">Dismiss</button>
</form>
<h2 style="margin-top:26px">Drafts</h2>
${drafts.variants.map((v) => `<div class="meta">${esc(v.label)}</div><div class="draft">${esc(v.body)}</div>`).join('')}
<p class="note">${esc(drafts.disclaimer)}</p>
</section></div>`;
  return layout(`${obligation.kind} - review`, body, ctx);
}

function quarantinePage(ctx, { row, diagnostic, message }) {
  const body = `<div class="wrap"><section class="panel">
<dl class="field">
<dt>Message</dt><dd>${esc(message ? message.subject : row.message_id)}</dd>
<dt>From</dt><dd>${esc(message ? message.from_address : '')}</dd>
<dt>Held because</dt><dd>${esc(row.reason)}</dd>
<dt>Urgent</dt><dd>${row.urgent ? 'yes - still visible despite being held' : 'no'}</dd>
</dl>
<h2>Why it was held</h2>
<ul class="gates">${(diagnostic.failures || []).map((f) => `<li class="fail">${esc(f.gate)}: ${esc(f.detail)}</li>`).join('')}</ul>
<h2>What was proposed</h2>
<div class="draft">${esc(JSON.stringify(diagnostic.event, null, 2))}</div>
<form class="decide" method="post" action="/quarantine/${esc(row.id)}/decision">
<input type="hidden" name="csrf" value="${esc(ctx.csrf)}">
<button name="decision" value="dismiss">Dismiss</button>
<button class="secondary" name="decision" value="escalate">Flag for a person</button>
</form>
<p class="note">Held items are never deleted. Dismissing records who decided and when.</p>
</section></div>`;
  return layout('Held back', body, ctx);
}

function messagePage(ctx, { message, blocks }) {
  const body = `<div class="wrap"><section class="panel">
<dl class="field"><dt>Subject</dt><dd>${esc(message.subject)}</dd>
<dt>From</dt><dd>${esc(message.from_address)}</dd>
<dt>Received</dt><dd>${esc(message.source_ts || message.observed_ts)}</dd>
<dt>Decoded</dt><dd>${message.processing_complete ? 'fully' : 'partially - some content could not be decoded'}</dd></dl>
${blocks.map((b) => `<div class="meta">block ${esc(b.seq)} &middot; ${esc(b.kind)}</div>
<blockquote class="span">${esc(b.canonical_text)}</blockquote>`).join('')}
<p class="note">Shown as stored after normalization. Nothing on this page is executed or fetched.</p>
</section></div>`;
  return layout('Message', body, ctx);
}

module.exports = { esc, layout, indexPage, obligationPage, quarantinePage, messagePage };
