'use strict';
/*
 * Cloud backup – server part (SDK 2.7 native extension). Adds the target "cloud" to Hostwerk's external backup
 * (Live → Backups): schedule, retention, alerts and the restore probe stay in Hostwerk – this extension brings rclone,
 * the connection and the encryption.
 *   GET  /api/cloud-backup              → state (program, target, encryption, selected in Hostwerk?)
 *   POST /api/cloud-backup/install      → job: download rclone (official, SHA-256 checked)
 *   POST /api/cloud-backup/signin       → { kind: onedrive|drive } – sign-in in the browser on this PC
 *   POST /api/cloud-backup/connect      → { kind, form } – set up target + encryption, then test
 *   POST /api/cloud-backup/test         → write, read back, decrypt
 *   GET  /api/cloud-backup/key          → recovery key (needed to read the backups anywhere else)
 *   POST /api/cloud-backup/use          → choose "cloud" as target of the external backup
 *   GET  /api/cloud-backup/list         → backups at the target
 *   DELETE /api/cloud-backup            → disconnect (backups at the target stay)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Rclone, KINDS, tokenFrom } = require('./rclone');

let state = null;

function activate(host) {
  const { ctx } = host;
  const { runJob } = host.core('jobs');
  const { exec } = host.core('util');
  const dl = host.core('download');
  const secrets = host.core('secrets');
  const dir = path.join(ctx.paths.data, 'cloud-backup');
  const rc = new Rclone({ dir, bin: path.join(ctx.paths.bin, 'rclone'), run: (f, a, o) => exec(f, a, o), download: dl.downloadFile, extract: dl.extractZip, fetchText: (u) => dl.fetchText(u) });
  const cfgFile = path.join(dir, 'settings.json');
  const cfg = () => { try { return JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch { return {}; } };
  const save = (c) => { fs.writeFileSync(`${cfgFile}.tmp`, JSON.stringify(c, null, 1)); fs.renameSync(`${cfgFile}.tmp`, cfgFile); };
  const pending = new Map(); // kind → token after browser sign-in
  state = { rc, pending, ctx };

  const view = () => {
    const c = cfg(); const e = rc.exe(); const o = ctx.monitor ? ctx.monitor.offsite : {};
    const form = { ...(c.form || {}) }; for (const k of ['pass', 'secretKey', 'token']) if (form[k]) form[k] = '••••••';
    return { installed: e ? e.version : null, kinds: Object.entries(KINDS).map(([id, k]) => ({ id, label: k.label, oauth: !!k.oauth, fields: k.fields || [] })), kind: c.kind || null, form, connected: rc.connected(), hasKey: !!c.key, keySeen: !!c.keySeen, lastTest: c.lastTest || null, selected: o.type === 'cloud', offsiteEnabled: !!o.enabled, lastRun: o.type === 'cloud' ? o.lastRun || null : null, lastError: o.type === 'cloud' ? o.lastError || null : null, signedIn: [...pending.keys()], desktop: host.core('platform').HAS_DESKTOP !== false };
  };

  // Target for Hostwerk's external backup
  if (ctx.offsiteTargets) ctx.offsiteTargets.set('cloud', {
    label: () => host.t('Cloud (encrypted)'),
    test: async () => { const r = await rc.test(); return { ok: r.ok, text: host.t(r.text) }; },
    upload: ({ files, name, job, keep }) => rc.upload({ files, name, keep, log: (l) => job.log(l) }),
    stat: (name, file) => rc.stat(name, file),
    fetch: (name, file, dest) => rc.fetch(name, file, dest),
  });

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
  host.router.post('/cloud-backup/connect', async (req, res) => {
    const b = req.body || {}; const kind = String(b.kind || '');
    if (!KINDS[kind]) throw host.error(400, 'Unknown target');
    const c = cfg();
    const form = { ...(b.form || {}) };
    // unchanged secrets come back as ••••••
    for (const k of ['pass', 'secretKey']) if (form[k] === '••••••') form[k] = c.form && c.form[k] ? secrets.open(c.form[k]) : '';
    if (KINDS[kind].oauth) form.token = pending.get(kind) || (c.kind === kind && c.form && c.form.token ? secrets.open(c.form.token) : '');
    const key = c.key ? secrets.open(c.key) : crypto.randomBytes(24).toString('base64url');
    await rc.connect(kind, form, key);
    const t = await rc.test();
    const sealed = { ...form }; for (const k of ['pass', 'secretKey', 'token']) if (sealed[k]) sealed[k] = secrets.seal(sealed[k]);
    save({ ...c, kind, form: sealed, key: secrets.seal(key), lastTest: { t: Date.now(), ok: t.ok, text: t.text } });
    pending.delete(kind);
    if (!t.ok) throw host.error(400, t.text);
    res.json(view());
  });
  host.router.post('/cloud-backup/test', async (req, res) => {
    const t = await rc.test(); const c = cfg(); save({ ...c, lastTest: { t: Date.now(), ok: t.ok, text: t.text } });
    res.json({ ...t, text: host.t(t.text) });
  });
  host.router.get('/cloud-backup/key', (req, res) => { const c = cfg(); if (!c.key) throw host.error(404, 'No key yet – connect a target first.'); save({ ...c, keySeen: true }); res.json({ key: secrets.open(c.key) }); });
  host.router.post('/cloud-backup/use', (req, res) => {
    if (!rc.connected()) throw host.error(409, 'Connect a target first.');
    const o = ctx.monitor.offsite; o.type = 'cloud'; o.enabled = true; if (!o.include) o.include = { db: true, mc: true, web: true };
    ctx.settings.save(); res.json(view());
  });
  host.router.get('/cloud-backup/list', async (req, res) => res.json(await rc.list()));
  host.router.delete('/cloud-backup', (req, res) => {
    const o = ctx.monitor ? ctx.monitor.offsite : null;
    if (o && o.type === 'cloud') { o.type = 'folder'; o.enabled = false; ctx.settings.save(); }
    fs.rmSync(rc.conf, { force: true }); const c = cfg(); delete c.form; delete c.kind; save(c); // key stays: older backups can still be read
    res.json(view());
  });
}

function deactivate() { if (state && state.ctx.offsiteTargets) state.ctx.offsiteTargets.delete('cloud'); state = null; }

module.exports = { activate, deactivate };
