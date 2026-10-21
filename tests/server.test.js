'use strict';
/* Server part with a simulated Hostwerk: token from another PC, recovery key, limits, runs for the backup calendar. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.HW_TEST = '1';
const { activate, deactivate } = require('../server/index');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-srv-'));
  const routes = {};
  const router = { get: (p, fn) => { routes[`GET ${p}`] = fn; }, post: (p, fn) => { routes[`POST ${p}`] = fn; }, put: (p, fn) => { routes[`PUT ${p}`] = fn; }, delete: (p, fn) => { routes[`DELETE ${p}`] = fn; } };
  const provided = {};
  const events = [];
  const ctx = { paths: { data: path.join(root, 'data'), bin: path.join(root, 'bin') }, monitor: { offsite: {} }, offsiteTargets: new Map(), settings: { save: () => {} } };
  const host = {
    ctx, router,
    t: (s, v) => (v ? String(s).replace(/\{(\w+)\}/g, (m, k) => (v[k] !== undefined ? v[k] : m)) : s),
    error: (st, m) => Object.assign(new Error(m), { status: st }),
    core: (name) => ({
      jobs: { runJob: () => ({ id: 'j' }) }, util: { exec: async () => ({ code: 0, stdout: '' }) },
      download: {}, secrets: { seal: (x) => `sealed:${x}`, open: (x) => String(x).replace(/^sealed:/, '') }, platform: { HAS_DESKTOP: false },
    }[name]),
    provide: (n, o) => { provided[n] = o; return o; },
    broadcast: (m) => events.push(m),
    log: () => {},
  };
  activate(host);
  const call = async (key, body) => { let out; await routes[key]({ body, params: {} }, { json: (x) => { out = x; } }); return out; };
  return { call, provided, ctx, events, root };
}

test('sign-in token pasted from another PC (server without a screen)', async () => {
  const { call } = setup();
  await assert.rejects(call('POST /cloud-backup/token', { kind: 'onedrive', token: 'hello' }), /rclone authorize/);
  await assert.rejects(call('POST /cloud-backup/token', { kind: 's3', token: '{}' }), /Unknown target/);
  const v = await call('POST /cloud-backup/token', { kind: 'onedrive', token: 'Paste this --->\n{"access_token":"a","refresh_token":"r"}\n<---End' });
  assert.deepStrictEqual(v.signedIn, ['onedrive']);
  assert.strictEqual(v.desktop, false);
  const v2 = await call('POST /cloud-backup/token', { kind: 'drive', token: '{"access_token":"a","token_type":"Bearer"}' });
  assert.ok(v2.signedIn.includes('drive'), 'plain JSON works too');
});

test('recovery key of another PC, bandwidth limits, nothing secret in the view', async () => {
  const { call, root } = setup();
  await assert.rejects(call('PUT /cloud-backup/key', { key: 'short' }), /16 characters/);
  const v = await call('PUT /cloud-backup/key', { key: 'old-pc-recovery-key-123' });
  assert.ok(v.hasKey && v.keyFromElsewhere && v.keySeen);
  const stored = fs.readFileSync(path.join(root, 'data', 'cloud-backup', 'settings.json'), 'utf8');
  assert.ok(stored.includes('sealed:old-pc-recovery-key-123'), 'kept sealed');
  assert.strictEqual((await call('GET /cloud-backup/key')).key, 'old-pc-recovery-key-123');
  const l = await call('PUT /cloud-backup/limits', { limit: '2.5', from: '08:00', to: 'nope' });
  assert.deepStrictEqual(l.limits, { limit: 2.5, from: '08:00', to: '' });
});

test('runs are remembered for the page and the backup calendar – failures included', async () => {
  const { ctx, provided, events } = setup();
  const target = ctx.offsiteTargets.get('cloud');
  const job = { log: () => {} };
  // rclone is not installed in the test → the upload fails and is remembered as failed
  await assert.rejects(target.upload({ files: [], name: 'hostwerk-2026-10-21-03-00-00', job, keep: 3 }), /not installed/);
  const h = provided.cloudBackup.history();
  assert.strictEqual(h.length, 1);
  assert.strictEqual(h[0].ok, false);
  assert.match(h[0].error, /not installed/);
  assert.ok(events.some((e) => e.type === 'cloud-backup'));
  deactivate();
  assert.ok(!ctx.offsiteTargets.has('cloud'));
});
