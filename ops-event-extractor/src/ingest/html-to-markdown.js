'use strict';
const { parse } = require('node-html-parser');

/**
 * HTML -> Markdown for email bodies.
 *
 * Carrier notices put the payload in tables ("Installment 3 | 04/15/2026 |
 * $1,240.00"), so column structure has to survive. Link targets survive too,
 * because a portal URL is often the only account identifier in the message.
 * Remote resources are never fetched and links are never followed.
 */
const BLOCK = new Set(['p', 'div', 'br', 'tr', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'section', 'article']);
const DROP = new Set(['script', 'style', 'head', 'meta', 'link', 'noscript']);

function textOf(node) {
  return (node.text || '').replace(/\s+/g, ' ').trim();
}

function renderTable(tableEl) {
  const rows = tableEl.querySelectorAll('tr');
  if (!rows.length) return '';
  const grid = rows.map((tr) => tr.querySelectorAll('th,td').map((c) => textOf(c).replace(/\|/g, '\\|')));
  const width = Math.max(...grid.map((r) => r.length));
  const pad = (r) => { const c = r.slice(); while (c.length < width) c.push(''); return c; };
  const lines = [];
  const [head, ...body] = grid;
  lines.push(`| ${pad(head).join(' | ')} |`);
  lines.push(`| ${new Array(width).fill('---').join(' | ')} |`);
  for (const r of body) lines.push(`| ${pad(r).join(' | ')} |`);
  return lines.join('\n');
}

function walk(node, out, state) {
  if (!node) return;
  const tag = (node.rawTagName || '').toLowerCase();
  if (DROP.has(tag)) return;

  if (node.nodeType === 3) { // text
    const t = (node.rawText || '').replace(/\s+/g, ' ');
    if (t.trim()) out.push(t);
    return;
  }

  if (tag === 'table') {
    out.push('\n\n@@TABLE_START@@\n');
    out.push(renderTable(node));
    out.push('\n@@TABLE_END@@\n\n');
    return;
  }
  if (tag === 'br') { out.push('\n'); return; }
  if (tag === 'hr') { out.push('\n---\n'); return; }
  if (tag === 'a') {
    const href = node.getAttribute('href');
    const label = textOf(node);
    if (href && label) out.push(`[${label}](${href})`);
    else if (label) out.push(label);
    else if (href) out.push(href);
    return;
  }
  if (tag === 'img') {
    const alt = node.getAttribute('alt');
    // Deliberately not fetched; only the alt text and a marker are kept.
    if (alt) out.push(`![${alt}]`);
    return;
  }
  if (tag === 'li') out.push('\n- ');
  if (/^h[1-6]$/.test(tag)) out.push(`\n\n${'#'.repeat(Number(tag[1]))} `);

  for (const child of node.childNodes) walk(child, out, state);

  if (BLOCK.has(tag) && tag !== 'br' && tag !== 'li') out.push('\n\n');
  if (tag === 'li') out.push('');
}

function htmlToMarkdown(html) {
  const root = parse(html, { blockTextElements: { script: false, style: false } });
  const out = [];
  walk(root, out, {});
  return out.join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Splits markdown into segments, marking table regions so they become their own blocks. */
function splitTables(markdown) {
  const parts = [];
  const re = /@@TABLE_START@@\n([\s\S]*?)\n@@TABLE_END@@/g;
  let last = 0; let m;
  while ((m = re.exec(markdown)) !== null) {
    if (m.index > last) parts.push({ kind: 'text', text: markdown.slice(last, m.index).trim() });
    parts.push({ kind: 'table', text: m[1].trim() });
    last = m.index + m[0].length;
  }
  if (last < markdown.length) parts.push({ kind: 'text', text: markdown.slice(last).trim() });
  return parts.filter((p) => p.text);
}

module.exports = { htmlToMarkdown, splitTables };
