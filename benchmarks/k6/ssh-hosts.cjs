const crypto = require('node:crypto');
const fs = require('node:fs');

// OpenSSH may hash hostnames and represents non-default ports as [host]:port.
function knownHostKey(contents, host, port = 22) {
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid SSH host or port');
  const target = port === 22 ? host : `[${host}]:${port}`;
  for (const line of contents.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3 || fields[0].startsWith('#') || fields[0].startsWith('@')) continue;
    const matches = fields[0].split(',').some(entry => {
      if (!entry.startsWith('|1|')) return entry === target;
      const pieces = entry.split('|');
      if (pieces.length !== 4) return false;
      const salt = Buffer.from(pieces[2], 'base64'), expected = Buffer.from(pieces[3], 'base64');
      const actual = crypto.createHmac('sha1', salt).update(target).digest();
      return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    });
    if (matches) {
      const key = Buffer.from(fields[2], 'base64');
      if (key.length) return key;
    }
  }
  return null;
}
function sshAuthentication(environment = process.env, readFile = fs.readFileSync) {
  const methods = [environment.SSH_PRIVATE_KEY, environment.SSH_AUTH_SOCK, environment.SSH_PASSWORD].filter(Boolean);
  if (methods.length !== 1) throw Error('Set exactly one of SSH_PRIVATE_KEY, SSH_AUTH_SOCK or SSH_PASSWORD');
  if (environment.SSH_PRIVATE_KEY) return { privateKey: readFile(environment.SSH_PRIVATE_KEY), ...(environment.SSH_PASSPHRASE ? { passphrase: environment.SSH_PASSPHRASE } : {}) };
  if (environment.SSH_AUTH_SOCK) return { agent: environment.SSH_AUTH_SOCK };
  return { password: environment.SSH_PASSWORD };
}
module.exports = { knownHostKey, sshAuthentication };
