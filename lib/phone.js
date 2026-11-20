// Phone access: a read-only HTTPS page on this computer's private Wi-Fi/Ethernet address, for paired devices only.
//
// Security model
// - Off by default; the user turns it on, and it turns itself off after a set time.
// - Listens only on private IPv4 addresses of en*/eth* interfaces, never on a VPN tunnel or 0.0.0.0.
// - HTTPS with a self-signed certificate made in Node by lib/cert.js (the phone warns once).
// - Pairing: a QR code carries a one-time code that expires after 2 minutes and works once. Redeeming it gives
//   that device its own random 256-bit key in an HttpOnly, Secure, SameSite=Strict cookie. Only a SHA-256 hash of
//   the key is stored; every request is checked in constant time. Devices can be revoked.
// - Failed pair/auth attempts are rate-limited per IP. Responses carry a strict CSP and no-store.
// - Read-only: the API has no write endpoints.
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const qrcode = require('qrcode-generator');

const DIR = path.join(os.homedir(), '.claude', 'claude-viz', 'phone');
const DEVICES = path.join(DIR, 'devices.json');
const KEY = path.join(DIR, 'key.pem'), CERT = path.join(DIR, 'cert.pem'), CERT_IPS = path.join(DIR, 'cert-ips.json');

const isPrivate = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
// Virtual, VPN and container adapters on macOS, Linux and Windows: never listened on.
const VIRTUAL = /^(lo|utun|tun|tap|ppp|ipsec|gif|stf|awdl|llw|bridge|br-|docker|veth|virbr|vmnet|vboxnet|zt|wg|tailscale|ham|anpi|ap\d)|vethernet|loopback|virtual|vpn|hyper-v|wsl|bluetooth|tailscale|zerotier|vmware|virtualbox|hamachi|npcap/i;
/** Private IPv4 addresses on real Wi-Fi/Ethernet adapters; virtual, VPN and container adapters are excluded. */
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL.test(name)) continue;
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal && isPrivate(a.address)) out.push({ name, ip: a.address });
  }
  return out;
}

const { selfSigned } = require('./cert');

/** A self-signed certificate for these IPs, made in Node; remade when the addresses change or the files are unusable. */
async function ensureCert(ips) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  let prev = [], ok = false;
  try { prev = JSON.parse(fs.readFileSync(CERT_IPS, 'utf8')); } catch { /* none */ }
  try {
    const k = crypto.createPrivateKey(fs.readFileSync(KEY)), c = new crypto.X509Certificate(fs.readFileSync(CERT));
    ok = k.asymmetricKeyType === 'rsa' && c.checkPrivateKey(k) && new Date(c.validTo).getTime() > Date.now() + 7 * 86_400_000 && ips.every((ip) => prev.includes(ip));
  } catch { ok = false; }
  if (!ok) {
    const { keyPem, certPem } = selfSigned(ips);
    fs.writeFileSync(KEY, keyPem, { mode: 0o600 });
    try { fs.chmodSync(KEY, 0o600); } catch { /* not supported on Windows; the folder is in the user profile */ }
    fs.writeFileSync(CERT, certPem);
    fs.writeFileSync(CERT_IPS, JSON.stringify(ips));
  }
  const cert = fs.readFileSync(CERT);
  return { key: fs.readFileSync(KEY), cert, fingerprint: new crypto.X509Certificate(cert).fingerprint256 };
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const loadDevices = () => { try { return JSON.parse(fs.readFileSync(DEVICES, 'utf8')); } catch { return []; } };
const saveDevices = (list) => { fs.mkdirSync(DIR, { recursive: true, mode: 0o700 }); fs.writeFileSync(DEVICES, JSON.stringify(list, null, 2), { mode: 0o600 }); };

function deviceName(ua = '') {
  const os2 = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'Device';
  const br = /CriOS|Chrome/.test(ua) ? 'Chrome' : /FxiOS|Firefox/.test(ua) ? 'Firefox' : /Safari/.test(ua) ? 'Safari' : 'browser';
  return `${os2} · ${br}`;
}

const HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
  'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

/**
 * @param {object} o
 * @param {string} o.mediaDir  folder with phone/index.html, app.js, app.css
 * @param {() => object} o.state  live state for /api/state
 * @param {() => Promise<object[]>} o.history  session list for /api/history
 * @param {(id: string) => Promise<object|null>} o.session  one session's insight for /api/session
 * @param {() => void} o.onChange  called when status, devices or pairing change
 */
function create(o) {
  let servers = [], status = { on: false, urls: [], fingerprint: '', until: 0, error: '' }, pairing = null, timer = null;
  const fails = new Map(); // ip -> { n, until }
  const usedCodes = new Map(); // sha256(code) -> time used; reopening such a link goes to the main page
  const log = (line) => { try { o.log?.(line); } catch { /* logging must never break a request */ } };
  const limited = (ip) => { const f = fails.get(ip); return f && f.until > Date.now(); };
  const fail = (ip) => { const f = fails.get(ip) || { n: 0, until: 0 }; f.n++; if (f.n >= 10) { f.until = Date.now() + 10 * 60_000; f.n = 0; } fails.set(ip, f); };

  function authed(req) {
    const m = /(?:^|;\s*)cvz=([A-Za-z0-9_-]{8,40})\.([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.headers.cookie || '');
    if (!m) return null;
    const list = loadDevices(), d = list.find((x) => x.id === m[1]);
    if (!d) return null;
    const a = Buffer.from(sha(m[2]), 'hex'), b = Buffer.from(d.hash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    if (Date.now() - (d.lastSeen || 0) > 60_000) { d.lastSeen = Date.now(); d.lastIp = req.socket.remoteAddress; saveDevices(list); o.onChange(); }
    return d;
  }

  const send = (res, code, type, body, extra = {}) => { res.writeHead(code, { ...HEADERS, 'Content-Type': type, ...extra }); res.end(body); };
  const json = (res, code, v) => send(res, code, 'application/json; charset=utf-8', JSON.stringify(v));
  const page = (res, code, title, text) => send(res, code, 'text/html; charset=utf-8', `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><link rel="stylesheet" href="/app.css"></head><body><main class="msgpage"><h1>${title}</h1><p>${text}</p></main></body></html>`);
  const STATIC = { '/app.js': 'application/javascript; charset=utf-8', '/app.css': 'text/css; charset=utf-8', '/': 'text/html; charset=utf-8' };

  async function handle(req, res) {
    const ip = req.socket.remoteAddress || '';
    if (req.method !== 'GET') return send(res, 405, 'text/plain', 'Method not allowed', { Allow: 'GET' });
    if (limited(ip)) return page(res, 429, 'Too many attempts', 'Wait ten minutes, then pair again from VS Code.');
    const url = new URL(req.url, 'https://x');
    if (url.pathname === '/app.css') return send(res, 200, STATIC['/app.css'], fs.readFileSync(path.join(o.mediaDir, 'phone', 'app.css')));
    if (url.pathname === '/pair' || url.pathname === '/pair/ok') {
      // Already paired (e.g. the link opened twice): go to the dashboard instead of failing.
      if (authed(req)) { log(`Pairing link opened again from ${ip} by an already paired device`); return send(res, 303, 'text/plain', 'Already paired', { Location: '/' }); }
      const c = url.searchParams.get('c') || '';
      // A link whose code was already used (back button, rescanning, another app opening it) goes to the main
      // page. That page itself requires a paired device, so this reveals nothing to anyone else.
      for (const [h, t] of usedCodes) if (Date.now() - t > 3_600_000) usedCodes.delete(h);
      if (c && usedCodes.has(sha(c))) { log(`Used pairing link reopened from ${ip}: sent to the main page`); return send(res, 303, 'text/plain', 'Already used', { Location: '/' }); }
      const valid = pairing && !pairing.used && pairing.expires >= Date.now() && c.length === pairing.code.length && crypto.timingSafeEqual(Buffer.from(c), Buffer.from(pairing.code));
      if (!valid) {
        const why = !pairing ? 'no pairing code is active' : pairing.used ? 'this code was already used' : pairing.expires < Date.now() ? 'the code expired' : 'the code does not match the latest one';
        fail(ip); log(`Pairing refused from ${ip}: ${why}`);
        return page(res, 403, 'Pairing code not valid', `Reason: ${why}. In VS Code, open Agent Glasses → System → Phone access, press New code, and scan it again.`);
      }
      // Step 1 only shows a confirmation; the code is used up by tapping Pair (step 2), so link previews and
      // reloads after the certificate warning cannot burn it.
      if (url.pathname === '/pair') {
        log(`Pairing page opened from ${ip}`);
        return send(res, 200, 'text/html; charset=utf-8', `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pair this phone</title><link rel="stylesheet" href="/app.css"></head><body><main class="msgpage"><h1>Pair this phone?</h1><p>It will be able to view your Claude Code sessions (read-only) while phone access is on. You can revoke it any time in VS Code.</p><p><a class="pairbtn" href="/pair/ok?c=${c}">Pair this phone</a></p></main></body></html>`);
      }
      usedCodes.set(sha(pairing.code), Date.now());
      pairing.used = true; pairing = null;
      const id = crypto.randomBytes(12).toString('base64url'), key = crypto.randomBytes(32).toString('base64url');
      const list = loadDevices(); list.push({ id, name: deviceName(req.headers['user-agent']), hash: sha(key), created: Date.now(), lastSeen: Date.now(), lastIp: ip }); saveDevices(list);
      log(`Paired ${deviceName(req.headers['user-agent'])} from ${ip}`);
      o.onChange();
      return send(res, 303, 'text/plain', 'Paired', { Location: '/', 'Set-Cookie': `cvz=${id}.${key}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000` });
    }
    const dev = authed(req);
    if (!dev) { fail(ip); return page(res, 401, 'This device is not paired', 'In VS Code, open Agent Glasses → System → Phone access → Pair a device, and scan the code with this phone.'); }
    if (url.pathname === '/' || url.pathname === '/app.js') return send(res, 200, STATIC[url.pathname], fs.readFileSync(path.join(o.mediaDir, 'phone', url.pathname === '/' ? 'index.html' : 'app.js')));
    try {
      if (url.pathname === '/api/state') return json(res, 200, { ...o.state(), device: dev.name });
      if (url.pathname === '/api/history') return json(res, 200, await o.history());
      if (url.pathname === '/api/session') { const sid = url.searchParams.get('id') || ''; if (!/^[\w-]{8,64}$/.test(sid)) return json(res, 400, { error: 'bad id' }); const d = await o.session(sid); return d ? json(res, 200, d) : json(res, 404, { error: 'not found' }); }
    } catch { return json(res, 500, { error: 'Could not read that.' }); }
    return send(res, 404, 'text/plain', 'Not found');
  }

  async function start(port, hours) {
    await stop(false);
    const addrs = lanAddresses();
    if (!addrs.length) { status = { ...status, on: false, error: 'No Wi-Fi or Ethernet address found. Connect to a network first.' }; o.onChange(); return status; }
    try {
      const { key, cert, fingerprint } = await ensureCert(addrs.map((a) => a.ip));
      for (const a of addrs) {
        const srv = https.createServer({ key, cert, minVersion: 'TLSv1.2' }, (req, res) => { handle(req, res).catch(() => { try { res.writeHead(500); res.end(); } catch { /* closed */ } }); });
        srv.headersTimeout = 10_000; srv.requestTimeout = 15_000;
        await new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(port, a.ip, resolve); });
        servers.push(srv);
      }
      const until = Date.now() + hours * 3_600_000;
      clearTimeout(timer); timer = setTimeout(() => stop(true), hours * 3_600_000);
      status = { on: true, urls: addrs.map((a) => `https://${a.ip}:${port}`), fingerprint, until, error: '' };
    } catch (e) {
      await stop(false);
      status = { ...status, on: false, error: /EADDRINUSE/.test(String(e)) ? `Port ${port} is in use. Change agentGlasses.phone.port.` : String(e.message || e).slice(0, 200) };
    }
    o.onChange();
    return status;
  }

  async function stop(notify = true) {
    clearTimeout(timer); timer = null; pairing = null;
    await Promise.all(servers.map((s) => new Promise((r) => { s.close(() => r()); s.closeAllConnections?.(); })));
    servers = [];
    status = { ...status, on: false, urls: [], until: 0 };
    if (notify) o.onChange();
  }

  /** A fresh one-time pairing code (10 minutes) and its QR matrix for the first address. */
  function newPairing() {
    if (!status.on) return null;
    pairing = { code: crypto.randomBytes(24).toString('base64url'), expires: Date.now() + 600_000, used: false };
    log('New pairing code (valid 10 minutes)');
    const url = `${status.urls[0]}/pair?c=${pairing.code}`;
    const qr = qrcode(0, 'M'); qr.addData(url); qr.make();
    const n = qr.getModuleCount(), matrix = [];
    for (let r = 0; r < n; r++) { let row = ''; for (let c = 0; c < n; c++) row += qr.isDark(r, c) ? '1' : '0'; matrix.push(row); }
    o.onChange();
    return { url, expires: pairing.expires, matrix, fingerprint: status.fingerprint };
  }

  const devices = () => loadDevices().map(({ hash, ...d }) => d);
  const revoke = (id) => { saveDevices(loadDevices().filter((d) => d.id !== id)); o.onChange(); };

  return { start, stop, status: () => status, newPairing, devices, revoke };
}

module.exports = { create, lanAddresses };
