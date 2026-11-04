const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');
const { knownHostKey, sshAuthentication } = require('../benchmarks/k6/ssh-hosts.cjs');

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

test('benchmark supports private key, agent, or password without mixing credentials', () => {
  assert.deepEqual(sshAuthentication({ SSH_PRIVATE_KEY: 'key', SSH_PASSPHRASE: 'pass' }, () => Buffer.from('key-data')), { privateKey: Buffer.from('key-data'), passphrase: 'pass' });
  assert.deepEqual(sshAuthentication({ SSH_AUTH_SOCK: 'agent' }), { agent: 'agent' });
  assert.deepEqual(sshAuthentication({ SSH_PASSWORD: 'secret' }), { password: 'secret' });
  assert.throws(() => sshAuthentication({}), /exactly one/);
  assert.throws(() => sshAuthentication({ SSH_PASSWORD: 'secret', SSH_PRIVATE_KEY: 'key' }), /exactly one/);
});
