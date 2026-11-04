const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');
const { knownHostKey } = require('../benchmarks/k6/ssh-hosts.cjs');

test('benchmark pins exact, alternate-port and hashed OpenSSH host entries', () => {
  const key = Buffer.from('benchmark-host-key');
  const value = key.toString('base64');
  assert.deepEqual(knownHostKey(`server,alias ssh-ed25519 ${value}\n`, 'alias'), key);
  assert.deepEqual(knownHostKey(`[server]:2222 ssh-ed25519 ${value}\n`, 'server', 2222), key);
  const salt = Buffer.from('benchmark-salt');
  const digest = crypto.createHmac('sha1', salt).update('[server]:2222').digest('base64');
  const hashed = `|1|${salt.toString('base64')}|${digest} ssh-ed25519 ${value}\n`;
  assert.deepEqual(knownHostKey(hashed, 'server', 2222), key);
  assert.equal(knownHostKey(hashed, 'other', 2222), null);
  assert.equal(knownHostKey(`other ssh-ed25519 ${value}\n`, 'server'), null);
});
