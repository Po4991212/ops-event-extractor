'use strict';
const { execFileSync } = require('node:child_process');
const { AppError } = require('./errors');

/**
 * Credential abstraction. Secrets live in the OS credential store, never in
 * .env, never in the database, never in the repository. Every lookup either
 * returns a value from the platform store or fails closed with an actionable
 * message. There is no file-based fallback.
 */
const SERVICE = 'ops-event-extractor';

function fromMacKeychain(account) {
  return execFileSync('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}
function fromSecretTool(account) {
  return execFileSync('secret-tool', ['lookup', 'service', SERVICE, 'account', account],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}
function fromWindowsCredentialManager(account) {
  const ps = `$c = Get-StoredCredential -Target '${SERVICE}:${account}'; ` +
    `[System.Net.NetworkCredential]::new('', $c.Password).Password`;
  return execFileSync('powershell', ['-NoProfile', '-Command', ps],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

const BACKENDS = [
  { name: 'macos-keychain', platforms: ['darwin'], get: fromMacKeychain },
  { name: 'libsecret', platforms: ['linux'], get: fromSecretTool },
  { name: 'windows-credential-manager', platforms: ['win32'], get: fromWindowsCredentialManager },
];

function describeStore() {
  const b = BACKENDS.find((x) => x.platforms.includes(process.platform));
  return b ? b.name : `unsupported-platform:${process.platform}`;
}

/** @returns {string} the secret, or throws. Never logs the value. */
function get(account) {
  const backend = BACKENDS.find((b) => b.platforms.includes(process.platform));
  if (!backend) {
    throw new AppError(`No supported OS credential store on ${process.platform}.`, 'CRED_NO_BACKEND');
  }
  let value = null;
  try { value = backend.get(account); } catch { value = null; }
  if (!value) {
    throw new AppError(
      `Credential "${account}" not found in ${backend.name} under service "${SERVICE}". ` +
      `Store it first (see docs/OPERATOR.md), then retry.`,
      'CRED_MISSING', { account, backend: backend.name },
    );
  }
  return value;
}

/** Non-throwing probe used by status reporting. Returns availability only. */
function isAvailable(account) {
  try { get(account); return true; } catch { return false; }
}

module.exports = { get, isAvailable, describeStore, SERVICE };
