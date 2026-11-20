// Phone access security: pairing, keys, revocation, rate limits, binding. Skipped without a LAN address.
const test = require('node:test');
const assert = require('node:assert');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const phone = require('../lib/phone');

// The server uses a self-signed certificate, so this test client skips certificate checks (test only).
const req = (url, opts = {}) => new Promise((resolve) => {
  const r = https.request(url, { method: opts.method || 'GET', rejectUnauthorized: false, headers: opts.cookie ? { Cookie: opts.cookie } : {} }, (res) => {
    let body = ''; res.on('data', (d) => (body += d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
  });
  r.on('error', (e) => resolve({ status: 'ERR ' + e.code })); r.end();
});

test('phone access only serves paired devices', { skip: phone.lanAddresses().length ? false : 'no private LAN address on this machine' }, async () => {
  const svc = phone.create({ mediaDir: path.join(__dirname, '..', 'media'), state: () => ({ sessions: [], secret: 'live data' }), history: async () => [], session: async () => null, onChange: () => {} });
  const st = await svc.start(17843, 0.05);
  assert.ok(st.on, st.error);
  const base = st.urls[0];
  try {
    assert.strictEqual((await req(base + '/')).status, 401);
    const r0 = await req(base + '/api/state');
    assert.strictEqual(r0.status, 401); assert.ok(!r0.body.includes('live data'));
    assert.strictEqual((await req(base + '/pair?c=wrong')).status, 403);

    const p = svc.newPairing();
    assert.strictEqual((await req(p.url)).status, 200, 'confirm page');
    assert.strictEqual((await req(p.url)).status, 200, 'opening twice does not use the code');
    const pr = await req(p.url.replace('/pair?', '/pair/ok?'));
    assert.strictEqual(pr.status, 303);
    const setCookie = pr.headers['set-cookie'][0];
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict']) assert.ok(setCookie.includes(flag), flag);
    const cookie = setCookie.split(';')[0];

    const reused = await req(p.url.replace('/pair?', '/pair/ok?'));
    assert.strictEqual(reused.status, 303); assert.strictEqual(reused.headers.location, '/');
    const ok = await req(base + '/api/state', { cookie });
    assert.strictEqual(ok.status, 200); assert.ok(ok.body.includes('live data'));
    assert.match(ok.headers['content-security-policy'], /default-src 'none'/);
    assert.strictEqual((await req(base + '/api/state', { method: 'POST', cookie })).status, 405);
    assert.strictEqual((await req(base + '/api/state', { cookie: cookie.slice(0, -3) + (cookie.endsWith('AAA') ? 'BBB' : 'AAA') })).status, 401);

    const local = await new Promise((resolve) => { const s = net.connect(17843, '127.0.0.1'); s.on('connect', () => { s.destroy(); resolve('open'); }); s.on('error', () => resolve('refused')); });
    assert.strictEqual(local, 'refused', 'not bound to localhost');

    svc.revoke(svc.devices().at(-1).id);
    assert.strictEqual((await req(base + '/api/state', { cookie })).status, 401);
    let last = 0; for (let i = 0; i < 12; i++) last = (await req(base + '/api/state')).status;
    assert.strictEqual(last, 429);
  } finally {
    await svc.stop(false);
  }
});
