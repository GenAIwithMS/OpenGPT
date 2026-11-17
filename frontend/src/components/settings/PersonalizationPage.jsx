import React, { useEffect, useRef, useState } from 'react';
import { Check, FileText, Loader2, Trash2, Upload } from 'lucide-react';
import { PageHeader } from './controls';
import { settingsService } from '../../services/api';

const LIMITS = { nickname: 50, occupation: 100, about: 2000, instructions: 4000 };
const inputClass =
  'w-full rounded-lg border border-gray-600 bg-[#26272e] px-3 py-2 text-sm text-gray-100 placeholder-gray-500 outline-none transition-colors focus:border-gray-400';

const Field = ({ id, label, children, count, limit }) => (
  <div>
    <div className="mb-1.5 flex items-baseline justify-between">
      <label htmlFor={id} className="text-sm text-gray-200">{label}</label>
      {limit && count > limit * 0.8 && <span className="text-xs text-gray-500">{count}/{limit}</span>}
    </div>
    {children}
  </div>
);

// Profile: who you are and how the assistant should answer (chat + coding agent).
const ProfileTab = ({ settings, save }) => {
  const saved = settings?.profile || { nickname: '', occupation: '', about: '', instructions: '' };
  const [form, setForm] = useState(saved);
  const [status, setStatus] = useState(null); // 'saving' | 'saved' | error text

  useEffect(() => { setForm(settings?.profile || saved); }, [settings?.profile]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = Object.keys(LIMITS).some((k) => (form[k] || '') !== (saved[k] || ''));
  const set = (key) => (e) => { setForm((f) => ({ ...f, [key]: e.target.value })); setStatus(null); };

  const submit = async (e) => {
    e.preventDefault();
    setStatus('saving');
    try {
      await save({ profile: form });
      setStatus('saved');
    } catch (err) {
      setStatus(err.message || 'Could not save.');
    }
  };

  return (
    <form onSubmit={submit} className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="nickname" label="Nickname" count={form.nickname.length} limit={LIMITS.nickname}>
          <input id="nickname" value={form.nickname} onChange={set('nickname')} maxLength={LIMITS.nickname}
            placeholder="Muhammad" className={inputClass} />
        </Field>
        <Field id="occupation" label="Occupation" count={form.occupation.length} limit={LIMITS.occupation}>
          <input id="occupation" value={form.occupation} onChange={set('occupation')} maxLength={LIMITS.occupation}
            placeholder="Software engineer" className={inputClass} />
        </Field>
      </div>

      <Field id="about" label="More about you" count={form.about.length} limit={LIMITS.about}>
        <textarea id="about" rows={4} value={form.about} onChange={set('about')} maxLength={LIMITS.about}
          placeholder="I'm based in Lahore and work mostly with Python and React."
          className={`${inputClass} thin-scroll resize-y`} />
      </Field>

      <Field id="instructions" label="Custom instructions" count={form.instructions.length} limit={LIMITS.instructions}>
        <textarea id="instructions" rows={5} value={form.instructions} onChange={set('instructions')}
          maxLength={LIMITS.instructions}
          placeholder="Be concise. Use bullet points for steps. Default to Python unless I say otherwise."
          className={`${inputClass} thin-scroll resize-y`} />
      </Field>

      <p className="text-xs text-gray-500">
        Your nickname is shown in the sidebar. The chat and the coding agent use all of this to tailor their answers.
      </p>

      <div className="flex items-center gap-3 border-t border-gray-700/60 pt-4">
        <button type="submit" disabled={!dirty || status === 'saving'}
          className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50">
          {status === 'saving' && <Loader2 size={14} className="animate-spin" />}
          Save
        </button>
        {dirty && status !== 'saving' && (
          <button type="button" onClick={() => { setForm(saved); setStatus(null); }}
            className="rounded-lg px-3 py-1.5 text-sm text-gray-300 hover:bg-white/5">Discard</button>
        )}
        {status === 'saved' && !dirty && (
          <span className="flex items-center gap-1 text-xs text-green-300"><Check size={13} /> Saved</span>
        )}
        {status && !['saving', 'saved'].includes(status) && <span role="alert" className="text-xs text-red-300">{status}</span>}
      </div>
    </form>
  );
};

// Knowledge: documents every chat can search.
const KnowledgeTab = () => {
  const [data, setData] = useState(null);
  const [uploading, setUploading] = useState(null); // file name
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  const load = () => settingsService.listKnowledge().then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const upload = async (files) => {
    setError(null);
    for (const file of files) {
      setUploading(file.name);
      try {
        await settingsService.addKnowledge(file);
      } catch (e) {
        setError(`${file.name}: ${e.message || 'could not be added'}`);
        break;
      }
    }
    setUploading(null);
    load();
  };

  const remove = async (id) => {
    setError(null);
    try {
      await settingsService.removeKnowledge(id);
      setData((d) => ({ ...d, files: d.files.filter((f) => f.id !== id) }));
    } catch (e) {
      setError(e.message);
    }
  };

  const full = data && data.files.length >= data.max_files;

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-400">
        Add documents you want the assistant to know about, like notes, guides or policies. Every chat can search
        them, and answers say which document they came from.
      </p>

      <button
        type="button"
        disabled={Boolean(uploading) || full}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); if (!uploading && !full) upload([...e.dataTransfer.files]); }}
        className={`flex w-full flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-6 text-center transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
          dragging ? 'border-blue-400 bg-blue-500/10' : 'border-gray-600 hover:border-gray-400 hover:bg-white/[0.02]'
        }`}
      >
        {uploading ? <Loader2 size={20} className="animate-spin text-gray-300" /> : <Upload size={20} className="text-gray-300" />}
        <span className="text-sm text-gray-200">
          {uploading ? `Adding ${uploading}…` : full ? 'The knowledge base is full' : 'Drop files here or click to upload'}
        </span>
        <span className="text-xs text-gray-500">
          PDF, Markdown or text · up to {data?.max_mb ?? 20} MB each · {data?.files.length ?? 0}/{data?.max_files ?? 50} files
        </span>
      </button>
      <input ref={inputRef} type="file" accept=".pdf,.md,.txt" multiple className="hidden"
        onChange={(e) => { const files = [...e.target.files]; e.target.value = ''; if (files.length) upload(files); }} />

      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}

      {data === null && !error ? (
        <Loader2 size={18} className="animate-spin text-gray-400" />
      ) : data?.files.length ? (
        <ul className="overflow-hidden rounded-xl border border-gray-700/60">
          {data.files.map((f, i) => (
            <li key={f.id} className={`flex items-center gap-3 px-3.5 py-2.5 ${i ? 'border-t border-gray-700/40' : ''}`}>
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gray-700/50 text-gray-300">
                <FileText size={15} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-gray-100">{f.filename}</span>
                <span className="block text-xs text-gray-500">
                  {f.pages ? `${f.pages} page${f.pages === 1 ? '' : 's'} · ` : ''}{f.chunks} passages
                </span>
              </span>
              <button type="button" onClick={() => remove(f.id)} aria-label={`Remove ${f.filename}`} title="Remove"
                className="rounded-lg p-1.5 text-gray-400 hover:bg-red-500/10 hover:text-red-300">
                <Trash2 size={15} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-gray-500">No documents yet.</p>
      )}
    </div>
  );
};

const PersonalizationPage = ({ settings, save }) => {
  const [tab, setTab] = useState('profile');
  const tabs = [{ id: 'profile', label: 'Profile' }, { id: 'knowledge', label: 'Knowledge' }];

  return (
    <div>
      <PageHeader title="Personalization" description="Tell the assistant about you and what it should know." />
      <div role="tablist" className="mb-6 flex gap-5 border-b border-gray-700/60">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 pb-2 text-sm transition-colors ${
              tab === t.id ? 'border-gray-100 text-gray-100' : 'border-transparent text-gray-400 hover:text-gray-200'
            }`}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'profile' ? <ProfileTab settings={settings} save={save} /> : <KnowledgeTab />}
    </div>
  );
};

export default PersonalizationPage;
