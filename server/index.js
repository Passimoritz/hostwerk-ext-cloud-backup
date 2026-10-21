'use strict';
/*
 * Cloud backup – server part (SDK 2.7 native extension). Adds the target "cloud" to Hostwerk's external backup
 * (Live → Backups): schedule, retention, alerts and the restore probe stay in Hostwerk – this extension brings rclone,
 * the connection and the encryption.
 *   GET    /api/cloud-backup              → state (program, target, encryption, selected in Hostwerk?, runs, limits)
 *   POST   /api/cloud-backup/install      → job: download rclone (official, SHA-256 checked)
 *   POST   /api/cloud-backup/signin       → { kind: onedrive|drive } – sign-in in the browser on this PC
 *   POST   /api/cloud-backup/token        → { kind, token } – sign-in token from another PC ("rclone authorize", for servers
 *                                           without a screen)
 *   POST   /api/cloud-backup/connect      → { kind, form } – set up target + encryption, then test
 *   POST   /api/cloud-backup/test         → write, read back, decrypt (and free space at the target)
 *   GET    /api/cloud-backup/key          → recovery key (needed to read the backups anywhere else)
 *   PUT    /api/cloud-backup/key          → { key } – use the recovery key of another PC (to read older backups)
 *   PUT    /api/cloud-backup/limits       → { limit (MB/s), from, to } – bandwidth limit, optionally only in a time window
 *   POST   /api/cloud-backup/use          → choose "cloud" as target of the external backup
 *   GET    /api/cloud-backup/list         → backups at the target [{ name, t }]
 *   DELETE /api/cloud-backup              → disconnect (backups at the target stay)
 * Service "cloudBackup" (other extensions, e.g. the backup calendar): history() → [{ t, ok, error, name }], status().
 * Secrets (S3 keys, passwords, encryption password) are kept sealed and reach rclone only as environment variables.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Rclone, KINDS, tokenFrom, backupTime, validKey } = require('./rclone');

const MAX_RUNS = 60;
let state = null;

function activate(host) {
  const { ctx } = host;
  const { runJob } = host.core('jobs');
  const { exec } = host.core('util');
  const dl = host.core('download');
  const secrets = host.core('secrets');
  const dir = path.join(ctx.paths.data, 'cloud-backup');
  const cfgFile = path.join(dir, 'settings.json');
  const cfg = () => { try { return JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch { return {}; } };
  const save = (c) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(`${cfgFile}.tmp`, JSON.stringify(c, null, 1)); fs.renameSync(`${cfgFile}.tmp`, cfgFile); };
  const update = (fn) => { const c = cfg(); fn(c); save(c); return c; };
  // Secrets for rclone – sealed in settings.json, opened only for the call
  const secretEnv = () => { const c = cfg(); if (!c.env) return {}; try { return JSON.parse(secrets.open(c.env)); } catch { return {}; } };
  const rc = new Rclone({ dir, bin: path.join(ctx.paths.bin, 'rclone'), run: (f, a, o) => exec(f, a, o), download: dl.downloadFile, extract: dl.extractZip, fetchText: (u) => dl.fetchText(u), env: secretEnv, limits: () => cfg().limits || {} });
  const pending = new Map(); // kind → token after sign-in
  state = { rc, pending, ctx };
  const changed = () => host.broadcast({ type: 'cloud-backup' });

  /** Run of the external backup (or a test) – kept for the page and the backup calendar, failures included. */
  const remember = (run) => update((c) => { c.runs = [...(c.runs || []), { t: Date.now(), ...run }].slice(-MAX_RUNS); });

  const view = () => {
    const c = cfg(); const e = rc.exe(); const o = ctx.monitor ? ctx.monitor.offsite : {};
    const form = { ...(c.form || {}) }; for (const k of ['pass', 'secretKey', 'token', 'accessKey']) if (form[k]) form[k] = '••••••';
    return {
      installed: e ? e.version : null, kinds: Object.entries(KINDS).map(([id, k]) => ({ id, label: k.label, oauth: !!k.oauth, fields: k.fields || [] })), kind: c.kind || null, form,
      connected: rc.connected(), hasKey: !!c.key, keySeen: !!c.keySeen, keyFromElsewhere: !!c.keyFromElsewhere, lastTest: c.lastTest || null,
      selected: o.type === 'cloud', offsiteEnabled: !!o.enabled, lastRun: o.type === 'cloud' ? o.lastRun || null : null, lastError: o.type === 'cloud' ? o.lastError || null : null,
      runs: (c.runs || []).slice(-10).reverse(), limits: c.limits || { limit: 0, from: '', to: '' }, migrated: !!c.env,
      signedIn: [...pending.keys()], desktop: host.core('platform').HAS_DESKTOP !== false,
    };
  };

  /** Set up target + encryption with the stored (sealed) values; key = plain crypt password. */
  const connectWith = async (kind, form, key) => {
    const env = await rc.connect(kind, form, key);
    const t = await rc.test();
    const sealed = { ...form }; for (const k of ['pass', 'secretKey', 'token', 'accessKey']) if (sealed[k]) sealed[k] = secrets.seal(sealed[k]);
    update((c) => { Object.assign(c, { kind, form: sealed, key: secrets.seal(key), env: secrets.seal(JSON.stringify(env)), lastTest: { t: Date.now(), ok: t.ok, text: t.text, free: t.free ?? null } }); });
    return t;
  };
  const openForm = (c) => { const f = { ...(c.form || {}) }; for (const k of ['pass', 'secretKey', 'token', 'accessKey']) if (f[k]) { try { f[k] = secrets.open(f[k]); } catch { f[k] = ''; } } return f; };

  // Target for Hostwerk's external backup
  if (ctx.offsiteTargets) ctx.offsiteTargets.set('cloud', {
    label: () => host.t('Cloud (encrypted)'),
    test: async () => { const r = await rc.test(); return { ok: r.ok, text: host.t(r.text) }; },
    upload: async ({ files, name, job, keep, prune }) => {
      try {
        await rc.upload({ files, name, keep, prune, log: (l) => job.log(l) });
        remember({ ok: true, name, files: files.length });
      } catch (e) {
        remember({ ok: false, name, error: String(e.message || e).slice(0, 300) });
        throw e;
      } finally { changed(); }
    },
    stat: (name, file) => rc.stat(name, file),
    fetch: (name, file, dest) => rc.fetch(name, file, dest),
    // „Nur Änderungen“ (Hostwerk 3.0): unveränderte Dateien kopiert rclone am Ziel, statt sie erneut hochzuladen
    list: () => rc.list(),
    copy: (fromName, file, toName) => rc.copy(fromName, file, toName),
  });

  host.provide('cloudBackup', {
    /** Runs (uploads of the external backup), newest last – failures included. */
    history: () => (cfg().runs || []).map((r) => ({ t: r.t, ok: r.ok !== false, error: r.error || null, name: host.t('Cloud backup') })),
    status: () => { const v = view(); return { connected: v.connected, kind: v.kind, selected: v.selected, lastRun: v.lastRun, lastError: v.lastError }; },
  });

  // Older versions kept S3 keys and passwords in rclone.conf: move them out once (needs the installed rclone)
  const migrate = async () => {
    const c = cfg();
    if (c.env || !c.kind || !c.form || !c.key || !rc.exe() || !rc.connected()) return;
    try { await connectWith(c.kind, openForm(c), secrets.open(c.key)); host.log('secrets moved out of rclone.conf'); } catch (e) { host.log('could not move the secrets yet:', e.message); }
  };
  if (!process.env.HW_TEST) { const t = setTimeout(() => { migrate().catch(() => {}); }, 30000); if (t.unref) t.unref(); }

  host.router.get('/cloud-backup', (req, res) => res.json(view()));
  host.router.post('/cloud-backup/install', (req, res) => {
    const job = runJob(host.t('Install rclone'), async (j) => { const v = await rc.install(dl.jobProgress ? dl.jobProgress(j, host.t('Download rclone'), 5, 90) : undefined); j.log(`rclone ${v}`); return { version: v }; }, { key: 'cloud-backup-install' });
    res.json({ job: job.id });
  });
  host.router.post('/cloud-backup/signin', async (req, res) => {
    const kind = String((req.body || {}).kind || '');
    if (!KINDS[kind] || !KINDS[kind].oauth) throw host.error(400, 'Unknown target');
    const e = rc.exe(); if (!e) throw host.error(409, 'rclone is not installed yet.');
    // rclone opens the sign-in page in the browser of this PC and waits on 127.0.0.1:53682 for the answer
    const out = await new Promise((resolve, reject) => {
      const p = spawn(e.file, ['authorize', KINDS[kind].oauth], { windowsHide: true });
      let buf = '';
      const t = setTimeout(() => { p.kill(); reject(host.error(408, 'Sign-in was not finished within 5 minutes.')); }, 5 * 60000);
      p.stdout.on('data', (d) => { buf += d; }); p.stderr.on('data', (d) => { buf += d; });
      p.on('close', () => { clearTimeout(t); resolve(buf); });
      p.on('error', (er) => { clearTimeout(t); reject(er); });
    });
    const token = tokenFrom(out);
    if (!token) throw host.error(400, 'Sign-in did not return access – please try again.');
    pending.set(kind, token);
    res.json(view());
  });
  // Server without a screen: sign in on another PC with "rclone authorize" and paste the result here
  host.router.post('/cloud-backup/token', (req, res) => {
    const b = req.body || {}; const kind = String(b.kind || '');
    if (!KINDS[kind] || !KINDS[kind].oauth) throw host.error(400, 'Unknown target');
    const token = tokenFrom(b.token) || tokenFrom(`---> ${String(b.token || '').trim()} <---`);
    if (!token || !/access_token|refresh_token/.test(token)) throw host.error(400, 'That does not look like the result of “rclone authorize” – copy everything between ---> and <---.');
    pending.set(kind, token);
    res.json(view());
  });
  host.router.post('/cloud-backup/connect', async (req, res) => {
    const b = req.body || {}; const kind = String(b.kind || '');
    if (!KINDS[kind]) throw host.error(400, 'Unknown target');
    const c = cfg();
    const old = c.kind === kind ? openForm(c) : {};
    const form = { ...(b.form || {}) };
    // unchanged secrets come back as ••••••
    for (const k of ['pass', 'secretKey', 'accessKey']) if (form[k] === '••••••') form[k] = old[k] || '';
    if (KINDS[kind].oauth) form.token = pending.get(kind) || old.token || '';
    else delete form.token;
    if (kind !== 'onedrive') delete form.site;
    const key = c.key ? secrets.open(c.key) : crypto.randomBytes(24).toString('base64url');
    const t = await connectWith(kind, form, key);
    pending.delete(kind);
    if (!t.ok) throw host.error(400, t.text);
    changed();
    res.json(view());
  });
  host.router.post('/cloud-backup/test', async (req, res) => {
    const t = await rc.test();
    update((c) => { c.lastTest = { t: Date.now(), ok: t.ok, text: t.text, free: t.free ?? null }; });
    res.json({ ...t, text: host.t(t.text) });
  });
  host.router.get('/cloud-backup/key', (req, res) => { const c = cfg(); if (!c.key) throw host.error(404, 'No key yet – connect a target first.'); save({ ...c, keySeen: true }); res.json({ key: secrets.open(c.key) }); });
  // Recovery key from the old PC: without it, older backups at the target cannot be read on this PC
  host.router.put('/cloud-backup/key', async (req, res) => {
    const key = String((req.body || {}).key || '').trim();
    if (!validKey(key)) throw host.error(400, 'The recovery key has at least 16 characters and no spaces.');
    const c = cfg();
    if (c.kind && c.form && rc.connected()) {
      const t = await connectWith(c.kind, openForm(c), key);
      if (!t.ok) throw host.error(400, t.text);
    } else update((x) => { x.key = secrets.seal(key); });
    update((x) => { x.keySeen = true; x.keyFromElsewhere = true; });
    changed();
    res.json(view());
  });
  host.router.put('/cloud-backup/limits', (req, res) => {
    const b = req.body || {};
    const hm = /^([01]\d|2[0-3]):[0-5]\d$/;
    const limit = Math.max(0, Math.min(10000, Number(b.limit) || 0));
    const from = hm.test(b.from || '') ? b.from : '';
    const to = hm.test(b.to || '') ? b.to : '';
    update((c) => { c.limits = { limit, from, to }; });
    res.json(view());
  });
  host.router.post('/cloud-backup/use', (req, res) => {
    if (!rc.connected()) throw host.error(409, 'Connect a target first.');
    const o = ctx.monitor.offsite; o.type = 'cloud'; o.enabled = true; if (!o.include) o.include = { db: true, mc: true, web: true };
    ctx.settings.save(); changed(); res.json(view());
  });
  host.router.get('/cloud-backup/list', async (req, res) => res.json((await rc.list()).map((name) => ({ name, t: backupTime(name) }))));
  host.router.delete('/cloud-backup', (req, res) => {
    const o = ctx.monitor ? ctx.monitor.offsite : null;
    if (o && o.type === 'cloud') { o.type = 'folder'; o.enabled = false; ctx.settings.save(); }
    try { fs.rmSync(rc.conf, { force: true }); } catch (e) { throw host.error(500, 'Could not remove the connection: {msg}', { msg: e.message }); }
    // key stays: older backups can still be read
    update((c) => { delete c.form; delete c.kind; delete c.env; });
    changed();
    res.json(view());
  });
}

function deactivate() { if (state && state.ctx.offsiteTargets) state.ctx.offsiteTargets.delete('cloud'); state = null; }

module.exports = { activate, deactivate };
