'use strict';
/*
 * rclone for the cloud backup: install (official download with SHA-256 check), connect a target, encrypt everything
 * with an rclone "crypt" layer (key only on this PC + as recovery key for the user), upload, list, fetch, prune.
 * Pure helpers are exported for the tests; run() is injectable.
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

/** Arguments for "rclone config create hw <type> …" from the form (secrets already obscured by the caller). */
function createArgs(kind, f, obscured = {}) {
  if (kind === 's3') {
    if (!f.bucket || !f.accessKey || !f.secretKey) throw Object.assign(new Error('Bucket, access key and secret key are needed.'), { status: 400 });
    return ['config', 'create', 'hw', 's3', 'provider=Other', `access_key_id=${f.accessKey}`, `secret_access_key=${f.secretKey}`, ...(f.endpoint ? [`endpoint=${f.endpoint}`] : []), ...(f.region ? [`region=${f.region}`] : []), '--non-interactive'];
  }
  if (kind === 'webdav') {
    if (!f.url) throw Object.assign(new Error('The WebDAV address is needed.'), { status: 400 });
    return ['config', 'create', 'hw', 'webdav', `url=${f.url}`, `vendor=${/nextcloud/i.test(f.url) || /remote\.php\/dav/.test(f.url) ? 'nextcloud' : 'other'}`, ...(f.user ? [`user=${f.user}`] : []), ...(obscured.pass ? [`pass=${obscured.pass}`] : []), '--non-interactive'];
  }
  if (kind === 'sftp') {
    if (!f.host || !f.user) throw Object.assign(new Error('Server and user are needed.'), { status: 400 });
    return ['config', 'create', 'hw', 'sftp', `host=${f.host}`, `port=${Number(f.port) || 22}`, `user=${f.user}`, ...(obscured.pass ? [`pass=${obscured.pass}`] : []), '--non-interactive'];
  }
  if (kind === 'onedrive' || kind === 'drive') {
    if (!f.token) throw Object.assign(new Error('Please sign in first.'), { status: 400 });
    return ['config', 'create', 'hw', kind, `token=${f.token}`, ...(kind === 'drive' ? ['scope=drive.file'] : ['drive_type=personal']), '--non-interactive'];
  }
  throw Object.assign(new Error('Unknown target'), { status: 400 });
}

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
  constructor({ dir, bin, run, download, extract, fetchText }) {
    Object.assign(this, { dir, bin, run, download, extract, fetchText });
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
    const r = await this.run(e.file, [...args, '--config', this.conf], { timeout: opts.timeout || 600000, ...opts });
    if (r.code !== 0 && !opts.allowFail) throw new Error((r.stderr || r.stdout || `rclone ${args[0]} failed`).split(/\r?\n/).filter(Boolean).slice(-2).join(' – ').slice(0, 400));
    return r;
  }
  async obscure(text) { return (await this.rc(['obscure', String(text)])).stdout.trim(); }
  /** Connect the target (remote "hw") and put the encryption layer "hwc" on top. key = crypt password (plain). */
  async connect(kind, form, key) {
    fs.rmSync(this.conf, { force: true });
    const obscured = form.pass ? { pass: await this.obscure(form.pass) } : {};
    await this.rc(createArgs(kind, form, obscured));
    await this.rc(['config', 'create', 'hwc', 'crypt', `remote=hw:${baseFolder(kind, form)}`, `password=${await this.obscure(key)}`, 'filename_encryption=standard', 'directory_name_encryption=true', '--non-interactive']);
  }
  connected() { try { return /\[hwc\]/.test(fs.readFileSync(this.conf, 'utf8')); } catch { return false; } }
  async test() {
    const probe = `hostwerk-test-${Date.now()}.txt`;
    const tmp = path.join(this.dir, probe); fs.writeFileSync(tmp, `test ${crypto.randomBytes(8).toString('hex')}`);
    try {
      await this.rc(['mkdir', 'hwc:'], { timeout: 60000 });
      await this.rc(['copyto', tmp, `hwc:${probe}`], { timeout: 120000 });
      const back = path.join(this.dir, `${probe}.back`);
      await this.rc(['copyto', `hwc:${probe}`, back], { timeout: 120000 });
      const same = fs.readFileSync(back, 'utf8') === fs.readFileSync(tmp, 'utf8'); fs.rmSync(back, { force: true });
      await this.rc(['deletefile', `hwc:${probe}`], { timeout: 60000, allowFail: true });
      const about = await this.rc(['about', 'hw:', '--json'], { timeout: 60000, allowFail: true });
      let free = null; try { free = JSON.parse(about.stdout).free || null; } catch { /* not every target says */ }
      if (!same) return { ok: false, text: 'Written and read back, but the content differs.' };
      return { ok: true, text: 'Target reachable, written, read back and decrypted.', free };
    } finally { fs.rmSync(tmp, { force: true }); }
  }
  async upload({ files, name, keep, log = () => {} }) {
    for (const f of files) { log(`→ ${path.basename(f)}`); await this.rc(['copyto', f, `hwc:${name}/${path.basename(f)}`, '--retries', '3']); }
    const dirs = (await this.rc(['lsf', 'hwc:', '--dirs-only'], { timeout: 120000 })).stdout.split(/\r?\n/).filter(Boolean);
    for (const old of toPrune(dirs, keep)) { log(`✕ ${old}`); await this.rc(['purge', `hwc:${old}`], { allowFail: true }); }
  }
  async stat(name, file) {
    const r = await this.rc(['lsjson', `hwc:${name}/${file}`], { timeout: 120000, allowFail: true });
    try { const j = JSON.parse(r.stdout); return j[0] ? { size: j[0].Size } : null; } catch { return null; }
  }
  async fetch(name, file, dest) { await this.rc(['copyto', `hwc:${name}/${file}`, dest]); }
  async list() {
    const r = await this.rc(['lsf', 'hwc:', '--dirs-only'], { timeout: 120000, allowFail: true });
    return r.stdout.split(/\r?\n/).filter(Boolean).map((d) => d.replace(/\/$/, '')).filter((d) => /^hostwerk-/.test(d)).sort().reverse();
  }
}

module.exports = { Rclone, KINDS, parseVersion, pickSum, archiveName, createArgs, baseFolder, tokenFrom, toPrune };
