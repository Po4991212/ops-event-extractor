import { google } from 'googleapis';
import pLimit from 'p-limit';
import { config } from '../config.js';
import { getSyncState, insertMessage, messageExists, setSyncState } from '../db/queries.js';
import { toRecord } from './fetch.js';

const QUERY = '-in:chats';
const limit = pLimit(5); // §8: rate limits on bulk backfill — cap concurrent message fetches.

async function fetchAndStore(gmail, database, id) {
  const { data: full } = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
  insertMessage(database, toRecord(full));
}

/** §3.2: mandatory first sync. includeSpamTrash is not optional — see the note in docs/SPEC.md §3.2. */
export async function fullSync(auth, database, { since = config.gmail.syncSince } = {}) {
  const gmail = google.gmail({ version: 'v1', auth });
  let pageToken;
  let n = 0;
  do {
    const { data } = await gmail.users.messages.list({
      userId: 'me',
      q: `${QUERY} after:${since}`,
      includeSpamTrash: true,
      maxResults: 500,
      pageToken
    });
    const toFetch = (data.messages ?? []).filter(m => !messageExists(database, m.id));
    await Promise.all(toFetch.map(m => limit(() => fetchAndStore(gmail, database, m.id))));
    n += toFetch.length;
    pageToken = data.nextPageToken;
  } while (pageToken);

  const { data: prof } = await gmail.users.getProfile({ userId: 'me' });
  setSyncState(database, 'historyId', String(prof.historyId));
  return n;
}

/** §3.2/§8: falls back to fullSync on a 404 (expired historyId — Gmail retains history ~1 week). */
export async function incrementalSync(auth, database) {
  const gmail = google.gmail({ version: 'v1', auth });
  const start = getSyncState(database, 'historyId');
  if (!start) return fullSync(auth, database);

  let pageToken;
  let latest = start;
  const ids = new Set();
  do {
    let data;
    try {
      ({ data } = await gmail.users.history.list({
        userId: 'me', startHistoryId: start, historyTypes: ['messageAdded'], pageToken
      }));
    } catch (e) {
      if (e.code === 404) return fullSync(auth, database);
      throw e;
    }
    for (const h of data.history ?? []) {
      latest = h.id;
      for (const m of h.messagesAdded ?? []) ids.add(m.message.id);
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  const toFetch = [...ids].filter(id => !messageExists(database, id));
  await Promise.all(toFetch.map(id => limit(() => fetchAndStore(gmail, database, id))));
  setSyncState(database, 'historyId', String(latest));
  return toFetch.length;
}
