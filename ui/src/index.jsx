import { useState } from 'react';
import { CloudUpload, Download, LogIn, PlugZap, KeyRound, Copy, ShieldCheck, ArrowRight, Trash2, CheckCircle2, Circle, RefreshCw } from 'lucide-react';
import { get, post, del, useApi, waitJob } from '@hostwerk/api';
import { Btn, Seg, Field, Loading, Callout, InfoTip, toast, confirmDialog } from '@hostwerk/ui';
import './style.css';

/*
 * Cloud backup in four steps: program → target → recovery key → use it for the external backup.
 * Texts are English; German comes from locales/de.json (also inside JSX).
 */
const LABELS = { endpoint: 'Endpoint (empty = AWS)', region: 'Region', bucket: 'Bucket', accessKey: 'Access key', secretKey: 'Secret key', url: 'WebDAV address', user: 'User', pass: 'Password', host: 'Server', port: 'Port', folder: 'Folder at the target' };
const HINTS = { endpoint: 'e.g. https://ACCOUNT.r2.cloudflarestorage.com or https://s3.eu-central-003.backblazeb2.com', url: 'Nextcloud: https://cloud.example.org/remote.php/dav/files/USER/', folder: 'Hostwerk creates it if needed.' };
const SECRET = new Set(['pass', 'secretKey']);

function Step({ n, done, title, children }) {
  return (
    <div className={`card cb-step ${done ? 'done' : ''}`}>
      <div className="card-head">{done ? <CheckCircle2 size={18} className="c-ok" aria-label="done" /> : <Circle size={18} className="muted" aria-label="open" />}<h3>{n}. {title}</h3></div>
      <div className="card-body stack" style={{ gap: 10 }}>{children}</div>
    </div>
  );
}

function CloudBackupPage() {
  const st = useApi('/cloud-backup', [], { live: false });
  const s = st.data;
  const [kind, setKind] = useState(null);
  const [form, setForm] = useState(null);
  const [key, setKey] = useState(null);
  const [busy, setBusy] = useState(null);
  if (!s) return <Loading />;
  const k = kind || s.kind || 'onedrive';
  const f = form || { folder: 'hostwerk', ...s.form };
  const info = s.kinds.find((x) => x.id === k) || s.kinds[0];
  const run = async (what, fn) => { setBusy(what); try { await fn(); } catch (e) { toast.error(e); } setBusy(null); };
  const install = () => run('install', async () => { const r = await post('/cloud-backup/install'); await waitJob(r.job); st.reload(); toast.success('rclone installed'); });
  const signin = () => run('signin', async () => { toast('Your browser opens – sign in there and allow access.'); st.setData(await post('/cloud-backup/signin', { kind: k })); toast.success('Signed in'); });
  const connect = () => run('connect', async () => { st.setData(await post('/cloud-backup/connect', { kind: k, form: f })); setForm(null); toast.success('Connected and tested'); });
  const test = () => run('test', async () => { const r = await post('/cloud-backup/test'); if (r.ok) toast.success(r.text); else toast.error(r.text); st.reload({ silent: true }); });
  const showKey = () => run('key', async () => { setKey((await get('/cloud-backup/key')).key); st.reload({ silent: true }); });
  const use = () => run('use', async () => { st.setData(await post('/cloud-backup/use')); toast.success('The external backup now goes to the cloud'); });
  const disconnect = async () => { if (await confirmDialog({ title: 'Disconnect the cloud target?', text: 'The backups at the target stay. The external backup is switched off until you choose a target again.', confirm: 'Disconnect', danger: true })) st.setData(await del('/cloud-backup')); };
  const copyKey = async () => { try { await navigator.clipboard.writeText(key); toast.success('Recovery key copied'); } catch { toast.error('Could not copy – select the key and copy it by hand.'); } };
  return (
    <div className="page fade-in">
      <div className="page-head">
        <div>
          <h1><CloudUpload /> Cloud backup</h1>
          <p>Hostwerk's external backup – encrypted to OneDrive, Google Drive, an S3 bucket, Nextcloud or an SFTP server.</p>
        </div>
        <div className="actions">
          <InfoTip title="How it works">Hostwerk keeps doing the backups (databases, Minecraft worlds, web pages) on its schedule. This extension only brings the cloud target: rclone uploads them, encrypted on this PC – the provider never sees the content.</InfoTip>
        </div>
      </div>
      <div className="stack cb">
        <Step n={1} done={!!s.installed} title="Program">
          {s.installed ? <div className="small">rclone {s.installed} is installed.</div> : (
            <>
              <div className="small muted">rclone is a widely used open-source program for cloud storage. Hostwerk downloads the official version and checks its checksum.</div>
              <div><Btn className="primary" icon={Download} busy={busy === 'install'} onClick={install}>Install rclone</Btn></div>
            </>
          )}
        </Step>
        <Step n={2} done={s.connected} title="Target">
          <Seg options={s.kinds.map((x) => ({ id: x.id, label: x.label.split(' (')[0] }))} value={k} onChange={(v) => { setKind(v); setForm({ folder: 'hostwerk' }); }} />
          <div className="small muted">{info.label}</div>
          {info.oauth ? (
            <div className="row-tight" style={{ flexWrap: 'wrap' }}>
              <Btn icon={LogIn} busy={busy === 'signin'} disabled={!s.installed || !s.desktop} onClick={signin}>{s.signedIn.includes(k) ? 'Signed in – sign in again' : `Sign in to ${info.label}`}</Btn>
              {!s.desktop && <span className="small muted">Sign-in needs a browser on this PC – on a server without a screen use S3, WebDAV or SFTP.</span>}
            </div>
          ) : (
            <div className="form-grid">
              {info.fields.map((x) => <Field key={x} label={LABELS[x]} hint={HINTS[x]}><input className={`input ${['url', 'endpoint', 'host'].includes(x) ? 'mono' : ''}`} type={SECRET.has(x) ? 'password' : 'text'} value={f[x] || ''} onChange={(e) => setForm({ ...f, [x]: e.target.value })} /></Field>)}
            </div>
          )}
          <Field label={LABELS.folder} hint={HINTS.folder}><input className="input mono" value={f.folder || ''} onChange={(e) => setForm({ ...f, folder: e.target.value })} /></Field>
          <div className="row-tight" style={{ flexWrap: 'wrap' }}>
            <Btn className="primary" icon={PlugZap} busy={busy === 'connect'} disabled={!s.installed || (info.oauth && !s.signedIn.includes(k) && !(s.connected && s.kind === k))} onClick={connect}>{s.connected ? 'Save and test again' : 'Connect and test'}</Btn>
            {s.connected && <Btn icon={RefreshCw} busy={busy === 'test'} onClick={test}>Test</Btn>}
            {s.connected && <Btn className="ghost danger" icon={Trash2} onClick={disconnect}>Disconnect</Btn>}
          </div>
          {s.lastTest && <Callout kind={s.lastTest.ok ? 'ok' : 'err'} dismissible={false}>{s.lastTest.text}</Callout>}
        </Step>
        <Step n={3} done={s.keySeen} title="Recovery key">
          <div className="small">Everything is encrypted on this PC. Without this key nobody can read the backups – not the provider, but also not you on a new PC. Keep it somewhere safe (password manager, printed).</div>
          {key ? (
            <div className="row-tight cb-key"><code className="grow">{key}</code><Btn className="sm" icon={Copy} onClick={copyKey}>Copy</Btn></div>
          ) : <div><Btn icon={KeyRound} busy={busy === 'key'} disabled={!s.hasKey} onClick={showKey}>Show recovery key</Btn></div>}
        </Step>
        <Step n={4} done={s.selected && s.offsiteEnabled} title="Use for the external backup">
          {s.selected && s.offsiteEnabled ? (
            <div className="stack" style={{ gap: 6 }}>
              <div className="small row-tight"><ShieldCheck size={15} className="c-ok" />Hostwerk's external backup goes to the cloud.</div>
              {s.lastRun && <div className="small muted">Last run: {new Date(s.lastRun).toLocaleString()}{s.lastError ? ` – ${s.lastError}` : ''}</div>}
              <div><Btn className="sm ghost" icon={ArrowRight} onClick={() => { location.hash = '/live/backups'; }}>Schedule, retention and restore probe</Btn></div>
            </div>
          ) : (
            <div className="row-tight" style={{ flexWrap: 'wrap' }}>
              <Btn className="primary" icon={CloudUpload} busy={busy === 'use'} disabled={!s.connected} onClick={use}>Use the cloud for the external backup</Btn>
              <span className="small muted">You can change what is backed up and how often under Live → Backups.</span>
            </div>
          )}
        </Step>
      </div>
    </div>
  );
}

export default {
  pages: { main: CloudBackupPage },
};
