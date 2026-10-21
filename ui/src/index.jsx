import { useState } from 'react';
import { CloudUpload, Download, LogIn, PlugZap, KeyRound, Copy, ShieldCheck, ArrowRight, Trash2, CheckCircle2, Circle, RefreshCw, RotateCw, CloudOff, FolderOpen, Gauge, ClipboardPaste } from 'lucide-react';
import { get, post, put, del, useApi, waitJob, fmtBytes } from '@hostwerk/api';
import { Btn, Seg, Field, Loading, Empty, Callout, InfoTip, toast, confirmDialog } from '@hostwerk/ui';
import { t } from '@hostwerk/i18n';
import './style.css';

/*
 * Cloud backup in four steps: program → target → recovery key → use it for the external backup.
 * Plus: backups at the target, last runs, bandwidth limit. Texts are English; German comes from locales/de.json
 * (also inside JSX). Dates follow Hostwerk's language (document language), not the system.
 */
const locale = () => (typeof document !== 'undefined' && document.documentElement.lang) || 'en';
const when = (ts) => (ts ? new Date(ts).toLocaleString(locale(), { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '–');
const LABELS = { endpoint: 'Endpoint (empty = AWS)', region: 'Region', bucket: 'Bucket', accessKey: 'Access key', secretKey: 'Secret key', url: 'WebDAV address', user: 'User', pass: 'Password', host: 'Server', port: 'Port', folder: 'Folder at the target', site: 'SharePoint site (optional)', clientId: 'Client ID', clientSecret: 'Client secret' };
const HINTS = { endpoint: 'e.g. https://ACCOUNT.r2.cloudflarestorage.com or https://s3.eu-central-003.backblazeb2.com', url: 'Nextcloud: https://cloud.example.org/remote.php/dav/files/USER/', folder: 'Hostwerk creates it if needed.', site: 'Empty = your own OneDrive (personal or Business). For a SharePoint library: https://company.sharepoint.com/sites/name' };
const SECRET = new Set(['pass', 'secretKey', 'accessKey', 'clientSecret']);

function Step({ n, done, title, children }) {
  return (
    <div className={`card cb-step ${done ? 'is-done' : ''}`}>
      <div className="card-head">{done ? <CheckCircle2 size={18} className="c-ok" aria-label="done" /> : <Circle size={18} className="muted" aria-label="open" />}<h3>{n}. {title}</h3></div>
      <div className="card-body stack cb-body">{children}</div>
    </div>
  );
}

/** Sign-in on another PC: "rclone authorize" there, paste the result here (servers without a screen). */
function TokenPaste({ kind, label, client, onDone }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  if (!open) return <button type="button" className="btn ghost sm" onClick={() => setOpen(true)}><ClipboardPaste size={14} />Sign in on another PC</button>;
  const cmd = `rclone authorize "${kind}"${client && client.clientId ? ` "${client.clientId}" "${client.clientSecret && client.clientSecret !== '••••••' ? client.clientSecret : 'CLIENT_SECRET'}"` : ''}`;
  return (
    <div className="stack cb-paste">
      <div className="small">{t('On a PC with a browser: install rclone, run {cmd}, sign in to {label} and copy everything between ---> and <---.', { cmd, label })}</div>
      <div className="row-tight"><code className="grow cb-code">{cmd}</code><Btn className="xs ghost" icon={Copy} onClick={() => navigator.clipboard.writeText(cmd).then(() => toast.success('Copied'), () => {})}>Copy</Btn></div>
      <textarea className="input mono cb-textarea" rows={4} aria-label="Result of rclone authorize" placeholder='{"access_token":"…","refresh_token":"…"}' value={text} onChange={(e) => setText(e.target.value)} />
      <div className="row-tight"><Btn className="sm" busy={busy} disabled={!text.trim()} onClick={async () => { setBusy(true); try { onDone(await post('/cloud-backup/token', { kind, token: text })); setText(''); setOpen(false); toast.success('Sign-in taken over'); } catch (e) { toast.error(e); } setBusy(false); }}>Use this sign-in</Btn>
        <Btn className="sm ghost" onClick={() => setOpen(false)}>Cancel</Btn></div>
    </div>
  );
}

/** Own app registration for Google/Microsoft – rclone's shared Google client ID is being retired during 2026. */
function OwnApp({ f, setForm }) {
  return (
    <details className="cb-own" open={!!f.clientId}>
      <summary className="small">Own app registration (optional)</summary>
      <div className="stack cb-body">
        <div className="row-tight small muted">Only needed if the sign-in with rclone's shared app no longer works.
          <InfoTip title="Own app registration">Google is retiring the app that rclone shares among all users during 2026. With your own app (Google Cloud Console → APIs → Credentials → OAuth client of type “Desktop app”, Drive API switched on; Microsoft: app registration in Entra ID) the sign-in keeps working. Enter it before signing in.</InfoTip>
        </div>
        <div className="form-grid">
          {['clientId', 'clientSecret'].map((x) => <Field key={x} label={LABELS[x]}><input className="input mono" type={SECRET.has(x) ? 'password' : 'text'} autoComplete="off" value={f[x] || ''} onChange={(e) => setForm({ ...f, [x]: e.target.value })} /></Field>)}
        </div>
      </div>
    </details>
  );
}

/** Use the recovery key of another PC – needed to read backups made there. */
function KeyFromElsewhere({ connected, onDone }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  if (!open) return <button type="button" className="btn ghost sm" onClick={() => setOpen(true)}><KeyRound size={14} />Enter the key of another PC</button>;
  const ok = /^\S{16,200}$/.test(key.trim());
  const go = async () => {
    if (connected && !(await confirmDialog({ title: 'Use this recovery key?', text: 'From now on Hostwerk encrypts with this key. Backups made here with the old key can no longer be read – note the old key first if you still need them.', confirm: 'Use key', danger: true }))) return;
    setBusy(true);
    try { onDone(await put('/cloud-backup/key', { key: key.trim() })); setKey(''); setOpen(false); toast.success('Recovery key taken over'); } catch (e) { toast.error(e); }
    setBusy(false);
  };
  return (
    <div className="stack cb-paste">
      <div className="small muted">Moved to a new PC? With the recovery key of the old one, Hostwerk reads the backups made there.</div>
      <div className="row-tight">
        <input className="input mono grow" type="password" autoComplete="off" aria-label="Recovery key" placeholder="Recovery key" value={key} onChange={(e) => setKey(e.target.value)} />
        <Btn className="sm" busy={busy} disabled={!ok} onClick={go}>Use key</Btn>
        <Btn className="sm ghost" onClick={() => setOpen(false)}>Cancel</Btn>
      </div>
    </div>
  );
}

/** Backups at the target – loaded on demand (asks the cloud). */
function TargetList() {
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = async () => { setBusy(true); try { setList(await get('/cloud-backup/list')); } catch (e) { toast.error(e); } setBusy(false); };
  return (
    <div className="stack cb-body">
      <div className="row-tight"><Btn className="sm ghost" icon={FolderOpen} busy={busy} onClick={load}>{list ? 'Look again' : 'Show backups at the target'}</Btn></div>
      {list && (list.length ? (
        <div className="cb-list">{list.map((b) => <div key={b.name} className="row-tight small"><span className="grow">{b.t ? when(b.t) : b.name}</span><span className="muted mono tiny">{b.name}</span></div>)}</div>
      ) : <div className="small muted">No backups at the target yet.</div>)}
    </div>
  );
}

/** Bandwidth limit, optionally only in a time window (e.g. during the day). */
function Limits({ s, setData }) {
  const [f, setF] = useState(null);
  const v = f || { limit: s.limits.limit || '', from: s.limits.from || '', to: s.limits.to || '' };
  const save = async () => { try { setData(await put('/cloud-backup/limits', { limit: Number(v.limit) || 0, from: v.from, to: v.to })); setF(null); toast.success('Saved'); } catch (e) { toast.error(e); } };
  return (
    <div className="card">
      <div className="card-head"><Gauge size={16} /><h3>Bandwidth</h3><InfoTip title="Bandwidth limit">Uploads and restores use at most this much – so the internet stays fast for everyone else. With a time window the limit applies only then (e.g. 08:00–22:00), at night at full speed.</InfoTip></div>
      <div className="card-body cb-limits">
        <Field label="Limit (MB/s, 0 = none)"><input className="input" type="number" min="0" step="0.5" value={v.limit} onChange={(e) => setF({ ...v, limit: e.target.value })} /></Field>
        <Field label="Only from"><input className="input" type="time" value={v.from} onChange={(e) => setF({ ...v, from: e.target.value })} /></Field>
        <Field label="until"><input className="input" type="time" value={v.to} onChange={(e) => setF({ ...v, to: e.target.value })} /></Field>
        <div className="cb-limits-save"><Btn className="sm" disabled={!f} onClick={save}>Save</Btn></div>
      </div>
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
  if (!s && st.error) return <div className="page"><Empty icon={CloudOff} title="Could not load the cloud backup" text={st.error} action={<Btn icon={RotateCw} onClick={() => st.reload()}>Try again</Btn>} /></div>;
  if (!s) return <div className="page"><Loading /></div>;
  const k = kind || s.kind || 'onedrive';
  const f = form || { folder: 'hostwerk', ...s.form };
  const info = s.kinds.find((x) => x.id === k) || s.kinds[0];
  const fields = [...(info.fields || []), ...(k === 'onedrive' ? ['site'] : [])];
  const run = async (what, fn) => { setBusy(what); try { await fn(); } catch (e) { toast.error(e); } setBusy(null); };
  const install = () => run('install', async () => { const r = await post('/cloud-backup/install'); await waitJob(r.job); st.reload(); toast.success('rclone installed'); });
  const signin = () => run('signin', async () => { toast('Your browser opens – sign in there and allow access.'); st.setData(await post('/cloud-backup/signin', { kind: k, clientId: f.clientId || '', clientSecret: f.clientSecret || '' })); toast.success('Signed in'); });
  const connect = () => run('connect', async () => { st.setData(await post('/cloud-backup/connect', { kind: k, form: f })); setForm(null); toast.success('Connected and tested'); });
  const test = () => run('test', async () => { const r = await post('/cloud-backup/test'); if (r.ok) toast.success(r.text); else toast.error(r.text); st.reload({ silent: true }); });
  const showKey = () => run('key', async () => { setKey((await get('/cloud-backup/key')).key); st.reload({ silent: true }); });
  const use = () => run('use', async () => { st.setData(await post('/cloud-backup/use')); toast.success('The external backup now goes to the cloud'); });
  const disconnect = () => run('disconnect', async () => { if (await confirmDialog({ title: 'Disconnect the cloud target?', text: 'The backups at the target stay. The external backup is switched off until you choose a target again.', confirm: 'Disconnect', danger: true })) st.setData(await del('/cloud-backup')); });
  const copyKey = async () => { try { await navigator.clipboard.writeText(key); toast.success('Recovery key copied'); } catch { toast.error('Could not copy – select the key and copy it by hand.'); } };
  const signedIn = s.signedIn.includes(k);
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
      {st.error && <Callout kind="warn" dismissible={false}>{t('Could not refresh: {error}', { error: st.error })}</Callout>}
      <div className="stack cb">
        <Step n={1} done={!!s.installed} title="Program">
          {s.installed ? <div className="small">{t('rclone {version} is installed.', { version: s.installed })}</div> : (
            <>
              <div className="small muted">rclone is a widely used open-source program for cloud storage. Hostwerk downloads the official version and checks its checksum.</div>
              <div><Btn className="primary" icon={Download} busy={busy === 'install'} onClick={install}>Install rclone</Btn></div>
            </>
          )}
        </Step>
        <Step n={2} done={s.connected} title="Target">
          <Seg options={s.kinds.map((x) => ({ id: x.id, label: x.label.split(' (')[0] }))} value={k} onChange={(v) => { setKind(v); setForm({ folder: 'hostwerk' }); }} />
          <div className="small muted">{info.label}</div>
          {info.oauth && (
            <div className="row-tight cb-wrap">
              {s.desktop && <Btn icon={LogIn} busy={busy === 'signin'} disabled={!s.installed} onClick={signin}>{signedIn ? 'Signed in – sign in again' : t('Sign in to {label}', { label: info.label })}</Btn>}
              {signedIn && !s.desktop && <span className="badge ok">Signed in</span>}
              <TokenPaste kind={k} label={info.label} client={f} onDone={st.setData} />
              {!s.desktop && <span className="small muted">This Hostwerk has no screen – sign in on another PC and paste the result here.</span>}
            </div>
          )}
          {info.oauth && <OwnApp f={f} setForm={setForm} />}
          {fields.length > 0 && (
            <div className="form-grid">
              {fields.map((x) => <Field key={x} label={LABELS[x]} hint={HINTS[x]}><input className={`input ${['url', 'endpoint', 'host', 'site'].includes(x) ? 'mono' : ''}`} type={SECRET.has(x) ? 'password' : 'text'} autoComplete="off" value={f[x] || ''} onChange={(e) => setForm({ ...f, [x]: e.target.value })} /></Field>)}
            </div>
          )}
          <Field label={LABELS.folder} hint={HINTS.folder}><input className="input mono" value={f.folder || ''} onChange={(e) => setForm({ ...f, folder: e.target.value })} /></Field>
          <div className="row-tight cb-wrap">
            <Btn className="primary" icon={PlugZap} busy={busy === 'connect'} disabled={!s.installed || (info.oauth && !signedIn && !(s.connected && s.kind === k))} onClick={connect}>{s.connected ? 'Save and test again' : 'Connect and test'}</Btn>
            {s.connected && <Btn icon={RefreshCw} busy={busy === 'test'} onClick={test}>Test</Btn>}
            {s.connected && <Btn className="ghost danger" icon={Trash2} busy={busy === 'disconnect'} onClick={disconnect}>Disconnect</Btn>}
          </div>
          {s.lastTest && <Callout kind={s.lastTest.ok ? 'ok' : 'err'} dismissible={false}>{s.lastTest.text}{s.lastTest.ok && s.lastTest.free != null ? ` ${t('Free at the target: {free}.', { free: fmtBytes(s.lastTest.free) })}` : ''}</Callout>}
          {s.connected && !s.migrated && <Callout kind="info" dismissible={false}>Older connection: passwords are still in rclone’s settings file. “Save and test again” moves them into Hostwerk’s sealed storage.</Callout>}
        </Step>
        <Step n={3} done={s.keySeen} title="Recovery key">
          <div className="small">Everything is encrypted on this PC. Without this key nobody can read the backups – not the provider, but also not you on a new PC. Keep it somewhere safe (password manager, printed).</div>
          {key ? (
            <div className="row-tight cb-key"><code className="grow">{key}</code><Btn className="sm" icon={Copy} onClick={copyKey}>Copy</Btn></div>
          ) : <div className="row-tight cb-wrap"><Btn icon={KeyRound} busy={busy === 'key'} disabled={!s.hasKey} onClick={showKey}>Show recovery key</Btn></div>}
          {s.keyFromElsewhere && <div className="small muted">This PC uses the recovery key of another PC.</div>}
          <KeyFromElsewhere connected={s.connected} onDone={(v) => { setKey(null); st.setData(v); }} />
        </Step>
        <Step n={4} done={s.selected && s.offsiteEnabled} title="Use for the external backup">
          {s.selected && s.offsiteEnabled ? (
            <div className="stack cb-body">
              <div className="small row-tight"><ShieldCheck size={15} className="c-ok" />Hostwerk's external backup goes to the cloud.</div>
              {s.lastRun && <div className="small muted">{t('Last run: {when}', { when: when(s.lastRun) })}{s.lastError ? ` – ${s.lastError}` : ''}</div>}
              <div><Btn className="sm ghost" icon={ArrowRight} onClick={() => { location.hash = '/live/backups'; }}>Schedule, retention and restore probe</Btn></div>
            </div>
          ) : (
            <div className="row-tight cb-wrap">
              <Btn className="primary" icon={CloudUpload} busy={busy === 'use'} disabled={!s.connected} onClick={use}>Use the cloud for the external backup</Btn>
              <span className="small muted">You can change what is backed up and how often under Live → Backups.</span>
            </div>
          )}
          {s.runs.length > 0 && (
            <div className="cb-list">
              {s.runs.map((r) => <div key={r.t} className="row-tight small"><span className={`badge ${r.ok ? 'ok' : 'err'}`}>{r.ok ? 'uploaded' : 'failed'}</span><span className="grow">{when(r.t)}</span>{r.error && <span className="muted ellipsis" title={r.error}>{r.error}</span>}</div>)}
            </div>
          )}
          {s.connected && <TargetList />}
        </Step>
        {s.connected && <Limits s={s} setData={st.setData} />}
      </div>
    </div>
  );
}

export default {
  pages: { main: CloudBackupPage },
};
