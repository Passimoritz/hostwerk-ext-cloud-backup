'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const R = require('../server/rclone');
const de = require('../locales/de.json');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cb-'));

test('version, checksum line and archive name', () => {
  assert.strictEqual(R.parseVersion('rclone v1.68.2\n'), '1.68.2');
  assert.strictEqual(R.pickSum('abc  rclone-v1.68.2-linux-amd64.zip\ndef  rclone-v1.68.2-windows-amd64.zip', 'rclone-v1.68.2-windows-amd64.zip'), 'def');
  assert.strictEqual(R.archiveName('1.68.2', 'win32', 'x64'), 'rclone-v1.68.2-windows-amd64.zip');
  assert.strictEqual(R.archiveName('1.68.2', 'linux', 'arm64'), 'rclone-v1.68.2-linux-arm64.zip');
});

test('config per target without secrets; missing fields are named', () => {
  const s3 = R.confText('s3', { bucket: 'b', accessKey: 'AKEY', secretKey: 'SECRET', endpoint: 'https://r2' });
  assert.match(s3, /^\[hw\]\ntype = s3\n/);
  assert.match(s3, /endpoint = https:\/\/r2/);
  assert.ok(!/AKEY|SECRET/.test(s3), 'S3 keys never in rclone.conf');
  assert.throws(() => R.confText('s3', { bucket: 'b' }), /access key/);
  assert.match(R.confText('webdav', { url: 'https://c/remote.php/dav/files/u/', user: 'u', pass: 'pw' }), /vendor = nextcloud/);
  assert.ok(!R.confText('sftp', { host: 'h', user: 'u', pass: 'pw' }).includes('pw'));
  assert.deepStrictEqual(R.secretEnv('s3', { accessKey: 'A', secretKey: 'S' }, { key: 'K' }), { RCLONE_CONFIG_HWC_PASSWORD: 'K', RCLONE_CONFIG_HW_ACCESS_KEY_ID: 'A', RCLONE_CONFIG_HW_SECRET_ACCESS_KEY: 'S' });
  assert.deepStrictEqual(R.secretEnv('webdav', {}, { key: 'K', pass: 'P' }), { RCLONE_CONFIG_HWC_PASSWORD: 'K', RCLONE_CONFIG_HW_PASS: 'P' });
  assert.ok(!R.cryptText('hostwerk').includes('password'), 'encryption password only as environment variable');
  assert.throws(() => R.createArgs('onedrive', {}), /sign in/);
  assert.ok(R.createArgs('drive', { token: '{"a":1}' }).includes('scope=drive.file'));
  // OneDrive: personal and Business found automatically, SharePoint by address
  assert.ok(R.createArgs('onedrive', { token: '{}' }).includes('config_type=onedrive'));
  assert.ok(!R.createArgs('onedrive', { token: '{}' }).some((a) => /drive_type=personal/.test(a)), 'no longer forced to personal');
  assert.ok(R.createArgs('onedrive', { token: '{}', site: 'https://firma.sharepoint.com/sites/it' }).includes('config_site_url=https://firma.sharepoint.com/sites/it'));
  assert.throws(() => R.createArgs('onedrive', { token: '{}', site: 'https://evil.example/x' }), /SharePoint/);
  assert.strictEqual(R.baseFolder('s3', { bucket: 'b', folder: '/x/' }), 'b/x');
  assert.strictEqual(R.baseFolder('webdav', {}), 'hostwerk');
});

test('token from rclone authorize output', () => {
  const out = 'Paste the following into your remote machine --->\n{"access_token":"x","token_type":"Bearer","expiry":"2026"}\n<---End paste';
  assert.strictEqual(JSON.parse(R.tokenFrom(out)).access_token, 'x');
  assert.strictEqual(R.tokenFrom('nothing'), null);
});

test('bandwidth timetable, backup names, recovery key', () => {
  assert.deepStrictEqual(R.bwArg({ limit: 0 }), []);
  assert.deepStrictEqual(R.bwArg({ limit: 4 }), ['--bwlimit', '4M']);
  assert.deepStrictEqual(R.bwArg({ limit: 2.5, from: '08:00', to: '22:00' }), ['--bwlimit', '08:00,2.5M 22:00,off']);
  assert.deepStrictEqual(R.bwArg({ limit: 1, from: '25:00', to: '22:00' }), ['--bwlimit', '1M'], 'broken window → always');
  assert.strictEqual(new Date(R.backupTime('hostwerk-2026-10-21-03-04-05')).toISOString(), '2026-10-21T03:04:05.000Z');
  assert.strictEqual(R.backupTime('other'), null);
  assert.ok(R.validKey('abcdefghijklmnop'));
  assert.ok(!R.validKey('short'));
  assert.ok(!R.validKey('with spaces in the key here'));
});

test('retention: oldest backup folders beyond "keep" are deleted', () => {
  const dirs = ['hostwerk-2026-10-01/', 'hostwerk-2026-10-03/', 'other/', 'hostwerk-2026-10-02/'];
  assert.deepStrictEqual(R.toPrune(dirs, 2), ['hostwerk-2026-10-01']);
  assert.deepStrictEqual(R.toPrune(dirs, 5), []);
});

/** A tiny rclone stand-in: "hwc:" is a folder on disk – enough to run connect, test, upload, list, stat, fetch. */
function fakeRclone(root) {
  const remote = path.join(root, 'remote'); fs.mkdirSync(remote, { recursive: true });
  const p = (x) => path.join(remote, x.replace(/^hwc:/, ''));
  const calls = [];
  const envs = [];
  const run = async (exe, args, opts = {}) => {
    calls.push(args[0]);
    envs.push(opts.env || {});
    const [cmd, a, b] = args;
    if (cmd === 'obscure') return { code: 0, stdout: `obs-${a}` };
    if (cmd === 'config') { fs.appendFileSync(args[args.indexOf('--config') + 1], `[${args[2]}]\n`); return { code: 0, stdout: '' }; }
    if (cmd === 'mkdir') { fs.mkdirSync(p(a), { recursive: true }); return { code: 0 }; }
    if (cmd === 'copyto') { const src = a.startsWith('hwc:') ? p(a) : a; const dst = b.startsWith('hwc:') ? p(b) : b; fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); return { code: 0 }; }
    if (cmd === 'deletefile') { fs.rmSync(p(a), { force: true }); return { code: 0 }; }
    if (cmd === 'purge') { fs.rmSync(p(a), { recursive: true, force: true }); return { code: 0 }; }
    if (cmd === 'about') return { code: 0, stdout: '{"free": 5000000000}' };
    if (cmd === 'lsf') return { code: 0, stdout: fs.readdirSync(p(a)).filter((d) => fs.statSync(path.join(p(a), d)).isDirectory()).map((d) => `${d}/`).join('\n') };
    if (cmd === 'lsjson') { const f = p(a); return { code: 0, stdout: fs.existsSync(f) ? JSON.stringify([{ Size: fs.statSync(f).size }]) : '[]' }; }
    return { code: 1, stderr: `unknown ${cmd}` };
  };
  return { run, calls, remote, envs };
}

test('connect, test, upload with retention, list, stat, fetch (with a stand-in for rclone)', async () => {
  const root = tmp(); const bin = path.join(root, 'bin', '1.68.2'); fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, process.platform === 'win32' ? 'rclone.exe' : 'rclone'), '');
  const fake = fakeRclone(root);
  let limits = {};
  const env = { now: {} };
  const rc = new R.Rclone({ dir: path.join(root, 'data'), bin: path.join(root, 'bin'), run: fake.run, obscureRun: async (file, text) => `obs-${text}`, env: () => env.now, limits: () => limits });
  assert.strictEqual(rc.exe().version, '1.68.2');
  env.now = await rc.connect('webdav', { url: 'https://c/dav', user: 'u', pass: 'pw' }, 'key123');
  assert.ok(rc.connected());
  assert.deepStrictEqual(env.now, { RCLONE_CONFIG_HWC_PASSWORD: 'obs-key123', RCLONE_CONFIG_HW_PASS: 'obs-pw' });
  const conf = fs.readFileSync(rc.conf, 'utf8');
  assert.ok(!/pw|key123/.test(conf), 'no password or key in rclone.conf');
  assert.ok(!fake.calls.includes('obscure'), 'obscure never with the secret as argument');
  const t = await rc.test();
  assert.ok(t.ok && t.free === 5000000000, JSON.stringify(t));
  const files = ['a.zip', 'b.zip'].map((n) => { const f = path.join(root, n); fs.writeFileSync(f, `content ${n}`); return f; });
  for (const name of ['hostwerk-2026-10-01', 'hostwerk-2026-10-02', 'hostwerk-2026-10-03']) await rc.upload({ files, name, keep: 2 });
  assert.strictEqual(fake.envs[fake.envs.length - 1].RCLONE_CONFIG_HWC_PASSWORD, 'obs-key123', 'secrets reach rclone as environment');
  limits = { limit: 3 };
  const seen = [];
  const orig = rc.run; rc.run = async (exe, args, o) => { seen.push(args); return orig(exe, args, o); };
  await rc.upload({ files: files.slice(0, 1), name: 'hostwerk-2026-10-04', keep: 9 });
  rc.run = orig;
  assert.ok(seen[0].includes('--bwlimit') && seen[0].includes('3M'), 'bandwidth limit on uploads');
  assert.deepStrictEqual(await rc.list(), ['hostwerk-2026-10-04', 'hostwerk-2026-10-03', 'hostwerk-2026-10-02']);
  assert.deepStrictEqual(await rc.stat('hostwerk-2026-10-03', 'a.zip'), { size: 'content a.zip'.length });
  assert.strictEqual(await rc.stat('hostwerk-2026-10-03', 'nope.zip'), null);
  const back = path.join(root, 'back.zip'); await rc.fetch('hostwerk-2026-10-02', 'b.zip', back);
  assert.strictEqual(fs.readFileSync(back, 'utf8'), 'content b.zip');
});

test('messages have German', () => {
  for (const s of ['Target reachable, written, read back and decrypted.', 'Bucket, access key and secret key are needed.', 'rclone is not installed yet.', 'No checksum for this system – download stopped.']) assert.ok(de[s], s);
});
