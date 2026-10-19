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

test('config arguments per target; missing fields are named', () => {
  assert.deepStrictEqual(R.createArgs('s3', { bucket: 'b', accessKey: 'A', secretKey: 'S', endpoint: 'https://r2' }).slice(0, 4), ['config', 'create', 'hw', 's3']);
  assert.throws(() => R.createArgs('s3', { bucket: 'b' }), /access key/);
  assert.ok(R.createArgs('webdav', { url: 'https://c/remote.php/dav/files/u/', user: 'u' }, { pass: 'OBS' }).includes('vendor=nextcloud'));
  assert.ok(R.createArgs('webdav', { url: 'https://c/dav' }, { pass: 'OBS' }).includes('pass=OBS'));
  assert.throws(() => R.createArgs('onedrive', {}), /sign in/);
  assert.ok(R.createArgs('drive', { token: '{"a":1}' }).includes('scope=drive.file'));
  assert.strictEqual(R.baseFolder('s3', { bucket: 'b', folder: '/x/' }), 'b/x');
  assert.strictEqual(R.baseFolder('webdav', {}), 'hostwerk');
});

test('token from rclone authorize output', () => {
  const out = 'Paste the following into your remote machine --->\n{"access_token":"x","token_type":"Bearer","expiry":"2026"}\n<---End paste';
  assert.strictEqual(JSON.parse(R.tokenFrom(out)).access_token, 'x');
  assert.strictEqual(R.tokenFrom('nothing'), null);
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
  const run = async (exe, args) => {
    calls.push(args[0]);
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
  return { run, calls, remote };
}

test('connect, test, upload with retention, list, stat, fetch (with a stand-in for rclone)', async () => {
  const root = tmp(); const bin = path.join(root, 'bin', '1.68.2'); fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, process.platform === 'win32' ? 'rclone.exe' : 'rclone'), '');
  const fake = fakeRclone(root);
  const rc = new R.Rclone({ dir: path.join(root, 'data'), bin: path.join(root, 'bin'), run: fake.run });
  assert.strictEqual(rc.exe().version, '1.68.2');
  await rc.connect('webdav', { url: 'https://c/dav', user: 'u', pass: 'pw' }, 'key123');
  assert.ok(rc.connected());
  const t = await rc.test();
  assert.ok(t.ok && t.free === 5000000000, JSON.stringify(t));
  const files = ['a.zip', 'b.zip'].map((n) => { const f = path.join(root, n); fs.writeFileSync(f, `content ${n}`); return f; });
  for (const name of ['hostwerk-2026-10-01', 'hostwerk-2026-10-02', 'hostwerk-2026-10-03']) await rc.upload({ files, name, keep: 2 });
  assert.deepStrictEqual(await rc.list(), ['hostwerk-2026-10-03', 'hostwerk-2026-10-02']);
  assert.deepStrictEqual(await rc.stat('hostwerk-2026-10-03', 'a.zip'), { size: 'content a.zip'.length });
  assert.strictEqual(await rc.stat('hostwerk-2026-10-03', 'nope.zip'), null);
  const back = path.join(root, 'back.zip'); await rc.fetch('hostwerk-2026-10-02', 'b.zip', back);
  assert.strictEqual(fs.readFileSync(back, 'utf8'), 'content b.zip');
});

test('messages have German', () => {
  for (const s of ['Target reachable, written, read back and decrypted.', 'Bucket, access key and secret key are needed.', 'rclone is not installed yet.', 'No checksum for this system – download stopped.']) assert.ok(de[s], s);
});
