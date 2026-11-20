// A self-signed X.509 certificate built in pure Node (no openssl binary), so phone access works the same on
// macOS, Linux and Windows. RSA-2048 + SHA-256, with the server's IP addresses in subjectAltName,
// serverAuth extended key usage and a validity under 398 days (what phones accept for TLS servers).
const crypto = require('crypto');

// ---- minimal DER encoding ----
const len = (n) => {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let x = n; x > 0; x >>= 8) bytes.unshift(x & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...items) => tlv(0x30, Buffer.concat(items));
const set = (...items) => tlv(0x31, Buffer.concat(items));
const int = (buf) => tlv(0x02, buf[0] & 0x80 ? Buffer.concat([Buffer.from([0]), buf]) : buf);
const nul = () => Buffer.from([0x05, 0x00]);
const octets = (buf) => tlv(0x04, buf);
const bits = (buf, unused = 0) => tlv(0x03, Buffer.concat([Buffer.from([unused]), buf]));
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0]));
const explicit = (n, body) => tlv(0xa0 + n, body);
function oid(s) {
  const p = s.split('.').map(Number), out = [40 * p[0] + p[1]];
  for (const v of p.slice(2)) {
    const enc = [v & 0x7f];
    for (let x = v >> 7; x > 0; x >>= 7) enc.unshift(0x80 | (x & 0x7f));
    out.push(...enc);
  }
  return tlv(0x06, Buffer.from(out));
}
/** UTCTime before 2050, GeneralizedTime after (RFC 5280). */
function time(d) {
  const iso = d.toISOString().replace(/[-:T]/g, '').slice(0, 14); // YYYYMMDDHHMMSS
  return d.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(iso.slice(2) + 'Z')) : tlv(0x18, Buffer.from(iso + 'Z'));
}
const ext = (id, critical, value) => seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));

/**
 * @param {string[]} ips IPv4 addresses the server is reached at
 * @returns {{ keyPem: string, certPem: string }}
 */
function selfSigned(ips, commonName = 'Agent Glasses phone access', days = 397) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sha256WithRSA = seq(oid('1.2.840.113549.1.1.11'), nul());
  const name = seq(set(seq(oid('2.5.4.3'), utf8(commonName))));
  const now = new Date(Date.now() - 5 * 60_000); // a little in the past, for clocks that run behind
  const until = new Date(now.getTime() + days * 86_400_000);
  const san = seq(...ips.map((ip) => tlv(0x87, Buffer.from(ip.split('.').map(Number))))); // [7] iPAddress
  const extensions = explicit(3, seq(
    ext('2.5.29.19', true, seq()), // basicConstraints: not a CA
    ext('2.5.29.15', true, bits(Buffer.from([0xa0]), 5)), // keyUsage: digitalSignature, keyEncipherment
    ext('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))), // extKeyUsage: serverAuth
    ext('2.5.29.17', false, san), // subjectAltName
  ));
  const tbs = seq(
    explicit(0, int(Buffer.from([2]))), // v3
    int(crypto.randomBytes(16)),
    sha256WithRSA,
    name,
    seq(time(now), time(until)),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    extensions,
  );
  const signature = crypto.sign('sha256', tbs, privateKey);
  const der = seq(tbs, sha256WithRSA, bits(signature));
  const pem = (label, buf) => `-----BEGIN ${label}-----\n${buf.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
  return { keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }), certPem: pem('CERTIFICATE', der) };
}

module.exports = { selfSigned };
