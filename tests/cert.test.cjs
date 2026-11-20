// The phone certificate is built in pure Node: it must parse, verify, match its key and load into TLS.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const tls = require('node:tls');
const { selfSigned } = require('../lib/cert');

test('self-signed certificate is valid and usable for TLS', () => {
  const { keyPem, certPem } = selfSigned(['192.168.1.20', '10.0.0.7']);
  const cert = new crypto.X509Certificate(certPem);
  assert.match(cert.subjectAltName, /IP Address:192\.168\.1\.20/);
  assert.match(cert.subjectAltName, /IP Address:10\.0\.0\.7/);
  assert.ok(cert.verify(cert.publicKey), 'self-signature verifies');
  assert.ok(cert.checkPrivateKey(crypto.createPrivateKey(keyPem)), 'key matches');
  assert.ok(new Date(cert.validTo) - Date.now() < 398 * 86_400_000, 'validity under 398 days');
  assert.doesNotThrow(() => tls.createSecureContext({ key: keyPem, cert: certPem }));
});
