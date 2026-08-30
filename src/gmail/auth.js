import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { google } from 'googleapis';
import { config } from '../config.js';

// §0.9/ADR 0003: readonly only for Phase 1–3. Add these only in the phase
// that needs the exact capability, and only after explicit operator opt-in
// — never requested eagerly "just in case."
export const SCOPES = {
  readonly: 'https://www.googleapis.com/auth/gmail.readonly',
  modify: 'https://www.googleapis.com/auth/gmail.modify',
  compose: 'https://www.googleapis.com/auth/gmail.compose'
};

/**
 * Loads a refresh token from GMAIL_TOKEN_STORE_PATH (outside the repo, per
 * .env.example) and returns an authorized OAuth2 client. Throws with a
 * redacted message on failure — never logs the token or full auth error
 * body (§0.9).
 */
export function loadAuthClient({ scopes = [SCOPES.readonly] } = {}) {
  if (!config.gmail.clientId || !config.gmail.clientSecret) {
    throw new Error('Gmail OAuth client is not configured. Set GMAIL_OAUTH_CLIENT_ID/SECRET in .env (see .env.example).');
  }
  if (!config.gmail.tokenStorePath || !fs.existsSync(config.gmail.tokenStorePath)) {
    throw new Error('GMAIL_TOKEN_STORE_PATH is not set or the token file does not exist. Run the OAuth desktop flow first.');
  }
  let token;
  try {
    token = JSON.parse(fs.readFileSync(config.gmail.tokenStorePath, 'utf8'));
  } catch {
    throw new Error('Could not read/parse the Gmail token file at GMAIL_TOKEN_STORE_PATH.');
  }
  const client = new google.auth.OAuth2(config.gmail.clientId, config.gmail.clientSecret);
  client.setCredentials(token);
  client._requestedScopes = scopes;
  return client;
}

/**
 * One-time interactive setup: performs the current Google-recommended
 * loopback-redirect OAuth flow for installed/desktop apps (the old
 * copy/paste "out of band" flow is no longer supported — see
 * docs/adr/0003-gmail-readonly-and-sync-fallback.md and
 * docs/research-sources.md) and writes the resulting refresh token to
 * GMAIL_TOKEN_STORE_PATH. Everything here runs locally on the operator's
 * machine — the authorization code and token never pass through this
 * codebase's chat/agent boundary, only through the operator's own browser
 * and this local process (§0.9).
 */
export async function runOAuthSetup({ scopes = [SCOPES.readonly] } = {}) {
  if (!config.gmail.clientId || !config.gmail.clientSecret) {
    throw new Error('Set GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET in .env first (see .env.example and README "Live Gmail setup").');
  }
  if (!config.gmail.tokenStorePath) {
    throw new Error('Set GMAIL_TOKEN_STORE_PATH in .env to a file path OUTSIDE this repo before running this (see .env.example).');
  }

  const { server, redirectUri, waitForCode } = await startLoopbackListener();
  try {
    const client = new google.auth.OAuth2(config.gmail.clientId, config.gmail.clientSecret, redirectUri);
    const authUrl = client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: scopes });

    console.log('\n1. Open this URL in a browser signed in to the mailbox you want to authorize:\n');
    console.log(`   ${authUrl}\n`);
    console.log('2. Approve access. You will be redirected back to this machine automatically.\n');
    console.log(`   (Listening on ${redirectUri} — if Google reports "redirect_uri_mismatch", the`);
    console.log('   OAuth client in Google Cloud Console must be type "Desktop app", which accepts');
    console.log('   any 127.0.0.1 port without pre-registration; a "Web application" client will not work here.)\n');

    const code = await waitForCode;
    const { tokens } = await client.getToken(code);

    fs.mkdirSync(path.dirname(config.gmail.tokenStorePath), { recursive: true });
    fs.writeFileSync(config.gmail.tokenStorePath, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    console.log(`Saved refresh token to ${config.gmail.tokenStorePath} (owner-only permissions).`);
    if (!tokens.refresh_token) {
      console.warn('Warning: no refresh_token was returned (Google only issues one the first time a ' +
        'client/account pair is authorized, or when prompt=consent is forced — which this flow already ' +
        'does). If sync later fails with an auth error, revoke access at https://myaccount.google.com/permissions ' +
        'and re-run this command.');
    }
    return tokens;
  } finally {
    server.close();
  }
}

function startLoopbackListener() {
  return new Promise((resolve, reject) => {
    let resolveCode, rejectCode;
    const waitForCode = new Promise((res, rej) => { resolveCode = res; rejectCode = rej; });

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/oauth2callback') { res.writeHead(404); res.end(); return; }
      const err = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(err
        ? `<p>Authorization failed: ${err}. You can close this tab and check the terminal.</p>`
        : '<p>Authorized. You can close this tab and return to the terminal.</p>');
      if (err) rejectCode(new Error(`Google returned an OAuth error: ${err}`));
      else if (code) resolveCode(code);
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, redirectUri: `http://127.0.0.1:${port}/oauth2callback`, waitForCode });
    });
  });
}
