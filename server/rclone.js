'use strict';
/*
 * rclone for the cloud backup: install (official download with SHA-256 check), connect a target, encrypt everything
 * with an rclone "crypt" layer (key only on this PC + as recovery key for the user), upload, list, fetch, prune.
 * Pure helpers are exported for the tests; run() is injectable.
 *
 * Secrets never land in rclone.conf or on a command line (the process list shows those): S3 keys, passwords and the
 * encryption password reach rclone as environment variables (RCLONE_CONFIG_<REMOTE>_<OPTION>), obscured where rclone wants
 * it, and are kept sealed by Hostwerk. Only OneDrive/Google Drive keep their sign-in token in rclone.conf – rclone has to
 * write refreshed tokens back there. Own app registration (client ID + secret) for Google/Microsoft: the ID goes into
 * rclone.conf, the secret only as environment variable.
 *
 * "rclone config create … --non-interactive" stops at the first question it has (OneDrive: "Token already configured –
 * replace it?", which left drive_id/drive_type unset; Google Drive: "keep using the shared client ID?"). configure()
 * answers every question with "--continue" until the setup is complete.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE = 'https://downloads.rclone.org';
const KINDS = {
  onedrive: { label: 'OneDrive', oauth: 'onedrive' },
  drive: { label: 'Google Drive', oauth: 'drive' },
  s3: { label: 'S3-compatible (AWS, Cloudflare R2, Backblaze, Wasabi …)', fields: ['endpoint', 'region', 'bucket', 'accessKey', 'secretKey'] },
  webdav: { label: 'WebDAV (Nextcloud, ownCloud …)', fields: ['url', 'user', 'pass'] },
  sftp: { label: 'SFTP server', fields: ['host', 'port', 'user', 'pass'] },
};

/** "rclone v1.68.2" → "1.68.2" */
const parseVersion = (txt) => { const m = /rclone v(\d+\.\d+\.\d+)/.exec(String(txt || '')); return m ? m[1] : null; };
/** Line of SHA256SUMS for a file name → hash */
const pickSum = (sums, file) => { const l = String(sums || '').split(/\r?\n/).find((x) => x.trim().endsWith(` ${file}`) || x.trim().endsWith(`*${file}`)); return l ? l.trim().split(/\s+/)[0] : null; };
/** Archive name for this system */
function archiveName(version, platform = process.platform, arch = process.arch) {
  const os = { win32: 'windows', linux: 'linux', darwin: 'osx' }[platform] || 'linux';
  const cpu = { x64: 'amd64', arm64: 'arm64', ia32: '386' }[arch] || 'amd64';
  return `rclone-v${version}-${os}-${cpu}.zip`;
}

/** Required fields per target – named in the error. */
function checkForm(kind, f) {
  const need = (ok, text) => { if (!ok) throw Object.assign(new Error(text), { status: 400 }); };
  if (kind === 's3') need(f.bucket && f.accessKey && f.secretKey, 'Bucket, access key and secret key are needed.');
  else if (kind === 'webdav') need(f.url, 'The WebDAV address is needed.');
  else if (kind === 'sftp') need(f.host && f.user, 'Server and user are needed.');
  else if (kind === 'onedrive' || kind === 'drive') need(f.token, 'Please sign in first.');
  else need(false, 'Unknown target');
  if (kind === 'onedrive' && f.site) need(/^https:\/\/[\w.-]+\.sharepoint\.com\/(sites|teams)\/\S+$/i.test(f.site), 'The SharePoint address looks like https://company.sharepoint.com/sites/name.');
}

/**
 * "rclone config create" for OneDrive and Google Drive (rclone has to look up the drive itself). OneDrive: personal and
 * Business are found automatically (config_type=onedrive asks Microsoft which drive belongs to the account); SharePoint
 * with the address of the site.
 */
function createArgs(kind, f) {
  checkForm(kind, f);
  const own = f.clientId ? [`client_id=${String(f.clientId).trim()}`] : [];
  if (kind === 'drive') return ['config', 'create', 'hw', 'drive', `token=${f.token}`, 'scope=drive.file', ...own, '--non-interactive'];
  if (kind === 'onedrive') return ['config', 'create', 'hw', 'onedrive', `token=${f.token}`, ...own, ...(f.site ? ['config_type=url', `config_site_url=${f.site}`] : ['config_type=onedrive']), '--non-interactive'];
  throw Object.assign(new Error('Unknown target'), { status: 400 });
}

/** Answers Hostwerk gives itself; every other question gets rclone's default (e.g. the drive rclone found). */
const ANSWERS = {
  config_refresh_token: 'false', // the token from the sign-in is already there – do not start a new sign-in
  config_shared_client_id: 'true', // without own app registration: keep rclone's shared one
  config_change_team_drive: 'false', // own drive, not a shared drive
};
/**
 * Pending question in the output of "rclone config create/update --non-interactive" → { state, name, answer } or null
 * (setup complete). Throws if rclone reports an error or needs an answer nobody can give here.
 */
function configQuestion(stdout) {
  const s = String(stdout || '');
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a < 0 || b < a) return null;
  let j; try { j = JSON.parse(s.slice(a, b + 1)); } catch { return null; }
  if (j.Error) throw new Error(`rclone setup: ${String(j.Error).slice(0, 300)}`);
  if (!j.State) return null;
  const o = j.Option || {};
  let answer = ANSWERS[o.Name];
  if (answer === undefined) answer = o.DefaultStr !== undefined && o.DefaultStr !== '' ? o.DefaultStr : (o.Examples && o.Examples[0] && o.Examples[0].Value) || '';
  if (answer === '' && o.Required) throw new Error(`rclone setup needs an answer: ${String(o.Help || o.Name || '').split('\n')[0].slice(0, 200)}`);
  return { state: j.State, name: o.Name || '', answer: String(answer) };
}

/**
 * Readable message for typical failures of a cloud target (the rclone line stays as detail). Texts with "Details: {}"
 * have a German pattern in locales/de.json.
 */
function explain(raw) {
  const s = String(raw || '');
  const d = s.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (/invalid_grant|couldn't fetch token|InvalidAuthenticationToken|authError|maybe it has expired|token (has been )?(expired|revoked)/i.test(s)) return `The sign-in at the cloud is no longer valid (expired or access withdrawn) – please sign in again under “Target”. Details: ${d}`;
  if (/storageQuotaExceeded|quotaLimitReached|Insufficient Storage|Insufficient Space|XMinioStorageFull|QuotaExceeded|\b507\b/i.test(s)) return `The target is full – free up space there or keep fewer backups. Details: ${d}`;
  if (/SignatureDoesNotMatch|InvalidAccessKeyId|InvalidClientTokenId/i.test(s)) return `The S3 target rejects the access key or secret key – please check both. Details: ${d}`;
  if (/\b401\b|Unauthorized|unable to authenticate|ssh: handshake failed/i.test(s)) return `User name or password for the target is wrong. Details: ${d}`;
  if (/connection refused|actively refused|no such host|i\/o timeout|network is unreachable|connectex/i.test(s)) return `The target cannot be reached – is the address right and the server online? Details: ${d}`;
  return d;
}

const ini = (name, o) => `[${name}]\n${Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k} = ${String(v).replace(/[\r\n]/g, '')}`).join('\n')}\n`;

/** rclone.conf section for S3, WebDAV and SFTP – without any secret (those come as environment variables). */
function confText(kind, f) {
  checkForm(kind, f);
  if (kind === 's3') return ini('hw', { type: 's3', provider: 'Other', endpoint: f.endpoint, region: f.region, env_auth: 'false' });
  if (kind === 'webdav') return ini('hw', { type: 'webdav', url: f.url, vendor: /nextcloud/i.test(f.url) || /remote\.php\/dav/.test(f.url) ? 'nextcloud' : 'other', user: f.user });
  if (kind === 'sftp') return ini('hw', { type: 'sftp', host: f.host, port: Number(f.port) || 22, user: f.user });
  throw Object.assign(new Error('Unknown target'), { status: 400 });
}

/** Encryption layer on top of the target (password only as environment variable). */
const cryptText = (folder) => ini('hwc', { type: 'crypt', remote: `hw:${folder}`, filename_encryption: 'standard', directory_name_encryption: 'true' });

/** Environment for rclone: secrets of the target and the encryption password (obscured = as rclone stores them). */
function secretEnv(kind, f, obscured) {
  const env = { RCLONE_CONFIG_HWC_PASSWORD: obscured.key };
  if (kind === 's3') Object.assign(env, { RCLONE_CONFIG_HW_ACCESS_KEY_ID: f.accessKey, RCLONE_CONFIG_HW_SECRET_ACCESS_KEY: f.secretKey });
  if ((kind === 'webdav' || kind === 'sftp') && obscured.pass) env.RCLONE_CONFIG_HW_PASS = obscured.pass;
  if ((kind === 'drive' || kind === 'onedrive') && f.clientSecret) env.RCLONE_CONFIG_HW_CLIENT_SECRET = f.clientSecret;
  return env;
}

/** Bandwidth limit as rclone timetable: 4 MB/s always ("4M") or only between 08:00 and 22:00 ("08:00,4M 22:00,off"). */
function bwArg({ limit, from, to } = {}) {
  const n = Number(limit);
  if (!n || n <= 0) return [];
  const v = `${Math.round(n * 10) / 10}M`;
  const hm = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (hm.test(from || '') && hm.test(to || '') && from !== to) return ['--bwlimit', `${from},${v} ${to},off`];
  return ['--bwlimit', v];
}

/** "hostwerk-2026-10-21-03-00-00" (UTC, as Hostwerk names them) → time (for the list of backups at the target). */
function backupTime(name) {
  const m = /^hostwerk-(\d{4})-(\d{2})-(\d{2})(?:[T_ -](\d{2})[-:]?(\d{2})(?:[-:]?(\d{2}))?)?/.exec(String(name || ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) : null; // Hostwerk names them in UTC
}

/** Recovery key from the user (other PC): at least 16 visible characters, no spaces. */
const validKey = (k) => typeof k === 'string' && /^\S{16,200}$/.test(k.trim());

/** Folder inside the target: S3 needs the bucket first. */
const baseFolder = (kind, f) => (kind === 's3' ? `${f.bucket}/${(f.folder || 'hostwerk').replace(/^\/+|\/+$/g, '')}` : (f.folder || 'hostwerk').replace(/^\/+|\/+$/g, ''));

/** Token JSON from the output of "rclone authorize" (between the paste markers, or the first {...}). */
function tokenFrom(out) {
  const s = String(out || '');
  const m = /--->\s*([\s\S]*?)\s*<---/.exec(s) || /(\{"access_token"[\s\S]*?\})\s*$/m.exec(s);
  if (!m) return null;
  const t = m[1].trim();
  try { JSON.parse(t); return t; } catch { return null; }
}

/** Backup folders (hostwerk-YYYY-…) to delete so that `keep` remain. */
const toPrune = (dirs, keep) => dirs.map((d) => d.replace(/\/$/, '')).filter((d) => /^hostwerk-/.test(d)).sort().slice(0, Math.max(0, dirs.filter((d) => /^hostwerk-/.test(d.replace(/\/$/, ''))).length - keep));

class Rclone {
  /** dir = data folder of the extension (config + key), bin = program folder, run(exe, args, opts) → { code, stdout, stderr } */
  constructor({ dir, bin, run, download, extract, fetchText, env = () => ({}), obscureRun = null, limits = () => ({}) }) {
    Object.assign(this, { dir, bin, run, download, extract, fetchText, env, obscureRun, limits });
    fs.mkdirSync(dir, { recursive: true });
    this.conf = path.join(dir, 'rclone.conf');
  }
  exe() {
    let vs = []; try { vs = fs.readdirSync(this.bin).filter((v) => /^\d/.test(v)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })); } catch { /* none */ }
    for (const v of vs.reverse()) { const f = path.join(this.bin, v, process.platform === 'win32' ? 'rclone.exe' : 'rclone'); if (fs.existsSync(f)) return { file: f, version: v }; }
    return null;
  }
  async install(progress = () => {}) {
    const version = parseVersion(await this.fetchText(`${BASE}/version.txt`));
    if (!version) throw new Error('Could not read the current rclone version.');
    const name = archiveName(version);
    const sum = pickSum(await this.fetchText(`${BASE}/v${version}/SHA256SUMS`), name);
    if (!sum) throw new Error('No checksum for this system – download stopped.');
    const zip = path.join(this.bin, `${name}.part`);
    fs.mkdirSync(this.bin, { recursive: true });
    await this.download(`${BASE}/v${version}/${name}`, zip, { sha256: sum, onProgress: progress });
    await this.extract(zip, path.join(this.bin, version));
    fs.rmSync(zip, { force: true });
    if (process.platform !== 'win32') try { fs.chmodSync(path.join(this.bin, version, 'rclone'), 0o755); } catch { /* egal */ }
    return version;
  }
  async rc(args, opts = {}) {
    const e = this.exe(); if (!e) throw Object.assign(new Error('rclone is not installed yet.'), { status: 409 });
    const r = await this.run(e.file, [...args, '--config', this.conf], { timeout: opts.timeout || 600000, ...opts, env: { ...process.env, ...this.env(), ...(opts.env || {}) } });
    if (r.code !== 0 && !opts.allowFail) {
      // Hinweise (NOTICE, z. B. „No host key validation“) verdrängen sonst die eigentliche Fehlerzeile
      const all = (r.stderr || r.stdout || '').split(/\r?\n/).filter((l) => l.trim() && !/shared Google Drive client_id/.test(l));
      const errs = all.filter((l) => !/\bNOTICE:/.test(l));
      const lines = errs.length ? errs : all;
      // Zeitlimit abgelaufen (Ziel antwortet nicht): Hostwerk hat rclone beendet, oft ohne eine einzige Fehlerzeile
      if (r.error && r.error.killed) throw new Error(explain(`i/o timeout: no answer within ${Math.round((opts.timeout || 600000) / 1000)} s ${errs.slice(-1).join(' ')}`.trim()));
      throw new Error(explain(lines.slice(-2).join(' – ') || `rclone ${args[0]} failed`));
    }
    return r;
  }
  /** Set up OneDrive/Google Drive: "config create", then answer rclone's questions until it is done. */
  async configure(kind, form, env) {
    let r = await this.rc(createArgs(kind, form), { env, timeout: 120000 });
    for (let i = 0; i < 12; i++) {
      const q = configQuestion(r.stdout);
      if (!q) return;
      r = await this.rc(['config', 'update', 'hw', '--continue', '--state', q.state, '--result', q.answer, '--non-interactive'], { env, timeout: 120000 });
    }
    throw new Error('rclone keeps asking during the setup – please try again.');
  }
  /** "rclone obscure -" with the text on stdin – never as an argument (the process list would show it). */
  async obscure(text) {
    const e = this.exe(); if (!e) throw Object.assign(new Error('rclone is not installed yet.'), { status: 409 });
    const out = this.obscureRun ? await this.obscureRun(e.file, String(text)) : await obscureStdin(e.file, String(text));
    if (!out) throw new Error('rclone could not prepare the password.');
    return out;
  }
  /**
   * Connect the target (remote "hw") and put the encryption layer "hwc" on top. key = crypt password (plain).
   * Returns the environment with the secrets (the caller keeps it sealed and hands it to every later call).
   */
  async connect(kind, form, key) {
    fs.rmSync(this.conf, { force: true });
    const obscured = { key: await this.obscure(key), ...(form.pass ? { pass: await this.obscure(form.pass) } : {}) };
    const env = secretEnv(kind, form, obscured);
    if (kind === 'onedrive' || kind === 'drive') await this.configure(kind, form, env);
    else fs.writeFileSync(this.conf, confText(kind, form));
    fs.appendFileSync(this.conf, `\n${cryptText(baseFolder(kind, form))}`);
    return env;
  }
  connected() { try { return /\[hwc\]/.test(fs.readFileSync(this.conf, 'utf8')); } catch { return false; } }
  /**
   * env: secrets of a connection that is not stored yet (right after connect()) – without them the very first test ran
   * without the encryption password ("password not set in config file") and every new connection failed.
   */
  async test(env) {
    const o = env ? { env } : {};
    const probe = `hostwerk-test-${Date.now()}.txt`;
    const tmp = path.join(this.dir, probe); fs.writeFileSync(tmp, `test ${crypto.randomBytes(8).toString('hex')}`);
    try {
      try { await this.rc(['mkdir', 'hwc:'], { timeout: 60000, ...o }); } catch (e) {
        // S3 mit falschem Schlüssel: die HEAD-Abfrage bekommt 403 ohne Text, rclone meldet „is a file not a directory“ –
        // eine Liste am Ziel liefert den eigentlichen Grund (SignatureDoesNotMatch, InvalidAccessKeyId …)
        if (!/is a file not a directory/.test(e.message)) throw e;
        const l = await this.rc(['lsf', 'hw:', '--max-depth', '1'], { timeout: 60000, allowFail: true, ...o });
        const why = explain(String(l.stderr || '').split(/\r?\n/).filter((x) => x.trim()).slice(-1)[0] || '');
        throw new Error(why && /Details:/.test(why) ? why : e.message);
      }
      await this.rc(['copyto', tmp, `hwc:${probe}`], { timeout: 120000, ...o });
      const back = path.join(this.dir, `${probe}.back`);
      await this.rc(['copyto', `hwc:${probe}`, back], { timeout: 120000, ...o });
      const same = fs.readFileSync(back, 'utf8') === fs.readFileSync(tmp, 'utf8'); fs.rmSync(back, { force: true });
      await this.rc(['deletefile', `hwc:${probe}`], { timeout: 60000, allowFail: true, ...o });
      const about = await this.rc(['about', 'hw:', '--json'], { timeout: 60000, allowFail: true, ...o });
      let free = null; try { free = JSON.parse(about.stdout).free || null; } catch { /* not every target says */ }
      if (!same) return { ok: false, text: 'Written and read back, but the content differs.' };
      return { ok: true, text: 'Target reachable, written, read back and decrypted.', free };
    } finally { fs.rmSync(tmp, { force: true }); }
  }
  /**
   * prune (optional, Hostwerk 3.0): decides which backups go – it keeps older backups that newer ones still point to
   * ("only changes"). Without it the plain "keep the newest n" applies.
   */
  async upload({ files, name, keep, prune, log = () => {} }) {
    for (const f of files) { log(`→ ${path.basename(f)}`); await this.rc(['copyto', f, `hwc:${name}/${path.basename(f)}`, '--retries', '3', ...bwArg(this.limits())]); }
    const dirs = (await this.rc(['lsf', 'hwc:', '--dirs-only'], { timeout: 120000 })).stdout.split(/\r?\n/).filter(Boolean);
    const names = dirs.map((d) => d.replace(/\/$/, '')).filter((d) => /^hostwerk-/.test(d));
    const drop = typeof prune === 'function' ? await prune(names) : toPrune(dirs, keep);
    for (const old of drop) { log(`✕ ${old}`); await this.rc(['purge', `hwc:${old}`], { allowFail: true }); }
  }
  async stat(name, file) {
    const r = await this.rc(['lsjson', `hwc:${name}/${file}`], { timeout: 120000, allowFail: true });
    try { const j = JSON.parse(r.stdout); return j[0] ? { size: j[0].Size } : null; } catch { return null; }
  }
  /** Unchanged file of an earlier backup into the new one – rclone copies on the server where the target can (no upload). */
  async copy(fromName, file, toName) { await this.rc(['copyto', `hwc:${fromName}/${file}`, `hwc:${toName}/${file}`, '--retries', '3']); }
  async fetch(name, file, dest) { await this.rc(['copyto', `hwc:${name}/${file}`, dest, ...bwArg(this.limits())]); }
  async list() {
    const r = await this.rc(['lsf', 'hwc:', '--dirs-only'], { timeout: 120000, allowFail: true });
    return r.stdout.split(/\r?\n/).filter(Boolean).map((d) => d.replace(/\/$/, '')).filter((d) => /^hostwerk-/.test(d)).sort().reverse();
  }
}

/** Default for obscure(): spawn rclone and write the text to stdin. */
function obscureStdin(file, text) {
  const { spawn } = require('child_process');
  return new Promise((resolve) => {
    let out = '';
    let p;
    try { p = spawn(file, ['obscure', '-'], { windowsHide: true }); } catch { resolve(null); return; }
    const t = setTimeout(() => { try { p.kill(); } catch { /* gone */ } resolve(null); }, 30000);
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => { clearTimeout(t); resolve(null); });
    p.on('close', (code) => { clearTimeout(t); resolve(code === 0 ? out.trim() || null : null); });
    p.stdin.end(`${text}\n`);
  });
}

module.exports = { Rclone, KINDS, parseVersion, pickSum, archiveName, createArgs, confText, cryptText, secretEnv, bwArg, backupTime, validKey, checkForm, baseFolder, tokenFrom, toPrune, configQuestion, explain };
