const crypto = require('node:crypto');

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
module.exports = { knownHostKey };
