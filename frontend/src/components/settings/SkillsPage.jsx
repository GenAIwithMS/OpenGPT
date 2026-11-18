import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown, Compass, ExternalLink, FileText, Github, Info, Loader2, PencilLine, Plus, Search, ShieldCheck,
  Sparkles, Trash2, Upload,
} from 'lucide-react';
import { Modal, PageHeader, Toggle, inputClass } from './controls';
import { skillsService } from '../../services/api';

const TABS = [
  { id: 'all', label: 'All' },
  { id: 'builtin', label: 'Built-in' },
  { id: 'personal', label: 'Yours' },
  { id: 'local', label: 'On this computer' },
];

const ORIGIN = {
  opengpt: 'OpenGPT',
  created: 'Created by you',
  uploaded: 'Uploaded',
  github: 'From GitHub',
  catalog: 'From Explore',
  local: 'On this computer',
};

const titleOf = (name) => name.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
const dateOf = (seconds) => (seconds
  ? new Date(seconds * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  : null);

// ----- one skill -----

const SkillCard = ({ skill, onToggle, onOpen }) => (
  <div className={`flex flex-col rounded-xl border p-3.5 transition-colors hover:border-gray-500/80 ${
    skill.enabled ? 'border-gray-700/70' : 'border-gray-700/40'}`}>
    <div className="flex items-start gap-3">
      <button type="button" onClick={() => onOpen(skill)} className="min-w-0 flex-1 text-left">
        <p className="truncate text-sm text-gray-100">{titleOf(skill.name)}</p>
        <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-gray-400">{skill.description}</p>
      </button>
      <Toggle label={`${skill.name} on or off`} checked={skill.enabled} onChange={(v) => onToggle(skill, v)} />
    </div>
    <p className="mt-auto flex items-center gap-1.5 pt-3 text-xs text-gray-500">
      <ShieldCheck size={12} />
      {ORIGIN[skill.origin] || skill.origin}
      {skill.updated_at && <span>· Updated {dateOf(skill.updated_at)}</span>}
    </p>
  </div>
);

const SkillDetail = ({ id, onClose, onChanged }) => {
  const [skill, setSkill] = useState(null);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    skillsService.get(id).then((s) => { setSkill(s); setText(s.skill_md); }).catch((e) => setError(e.message));
  }, [id]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await skillsService.saveContent(id, text);
      setSkill(await skillsService.get(id));
      setEditing(false);
      onChanged();
    } catch (e) { setError(e.message); }
    setBusy(false);
  };
  const remove = async () => {
    setBusy(true);
    try { await skillsService.remove(id); onChanged(); onClose(); } catch (e) { setError(e.message); setBusy(false); }
  };

  return (
    <Modal title={skill ? titleOf(skill.name) : 'Skill'} onClose={onClose} wide>
      {!skill ? (error ? <p className="text-sm text-red-300">{error}</p> : <Loader2 className="animate-spin text-gray-400" size={18} />) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
            <span className="rounded-md bg-white/5 px-2 py-0.5 font-mono text-gray-300">{skill.name}</span>
            <span>{ORIGIN[skill.origin] || skill.origin}</span>
            {skill.license && <span>· {skill.license}</span>}
            {skill.url && (
              <a href={skill.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-gray-300 hover:text-white">
                · Source <ExternalLink size={11} />
              </a>
            )}
          </div>
          {skill.location && <p className="break-all font-mono text-xs text-gray-500">{skill.location}</p>}

          {editing ? (
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={18} spellCheck={false}
              aria-label="SKILL.md" className={`${inputClass} thin-scroll font-mono text-xs leading-relaxed`} />
          ) : (
            <pre className="thin-scroll max-h-[45vh] overflow-auto whitespace-pre-wrap rounded-xl border border-gray-700/60 bg-black/20 p-3.5 font-mono text-xs leading-relaxed text-gray-200">
              {skill.skill_md}
            </pre>
          )}

          {skill.files.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs font-medium text-gray-300">Files ({skill.files.length})</p>
              <div className="thin-scroll flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
                {skill.files.map((f) => (
                  <span key={f} className="flex items-center gap-1 rounded-md bg-white/5 px-2 py-0.5 font-mono text-xs text-gray-400">
                    <FileText size={11} /> {f}
                  </span>
                ))}
              </div>
            </div>
          )}

          {error && <p className="text-sm text-red-300">{error}</p>}

          <div className="flex flex-wrap items-center gap-2 border-t border-gray-700/60 pt-3">
            {skill.editable && !editing && (
              <button type="button" onClick={() => setEditing(true)}
                className="flex items-center gap-1.5 rounded-lg border border-gray-600 px-3 py-1.5 text-sm text-gray-200 hover:bg-white/5">
                <PencilLine size={14} /> Edit
              </button>
            )}
            {editing && (
              <>
                <button type="button" onClick={save} disabled={busy}
                  className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-60">
                  {busy ? 'Saving…' : 'Save'}
                </button>
                <button type="button" onClick={() => { setEditing(false); setText(skill.skill_md); }}
                  className="rounded-lg px-3 py-1.5 text-sm text-gray-300 hover:bg-white/5">Cancel</button>
              </>
            )}
            {skill.editable && !editing && (
              <span className="ml-auto">
                {confirming ? (
                  <span className="flex items-center gap-2 text-sm">
                    <span className="text-gray-400">Remove this skill?</span>
                    <button type="button" onClick={remove} disabled={busy} className="text-red-300 hover:text-red-200">Remove</button>
                    <button type="button" onClick={() => setConfirming(false)} className="text-gray-400 hover:text-gray-200">Cancel</button>
                  </span>
                ) : (
                  <button type="button" onClick={() => setConfirming(true)}
                    className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-red-300">
                    <Trash2 size={14} /> Remove
                  </button>
                )}
              </span>
            )}
            {!skill.editable && (
              <p className="text-xs text-gray-500">
                {skill.source === 'local'
                  ? 'This skill lives in a folder on your computer; edit it there.'
                  : 'Built-in skills can be turned off but not edited.'}
              </p>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
};

// ----- adding skills -----

const CreateForm = ({ onDone }) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try { await skillsService.create({ name, description, instructions }); onDone(); } catch (err) { setError(err.message); setBusy(false); }
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label htmlFor="skill-name" className="mb-1.5 block text-sm text-gray-200">Name</label>
        <input id="skill-name" value={name} maxLength={64} required placeholder="weekly-report"
          onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
          className={`${inputClass} font-mono`} />
        <p className="mt-1.5 text-xs text-gray-500">Lowercase letters, digits and hyphens.</p>
      </div>
      <div>
        <label htmlFor="skill-desc" className="mb-1.5 block text-sm text-gray-200">When to use it</label>
        <textarea id="skill-desc" value={description} maxLength={1024} required rows={2}
          placeholder="Write the weekly status report. Use when the user asks for a weekly update."
          onChange={(e) => setDescription(e.target.value)} className={inputClass} />
        <p className="mt-1.5 text-xs text-gray-500">The assistant reads this to decide when to load the skill.</p>
      </div>
      <div>
        <label htmlFor="skill-body" className="mb-1.5 block text-sm text-gray-200">Instructions</label>
        <textarea id="skill-body" value={instructions} required rows={10} spellCheck={false}
          placeholder={'# Weekly report\n\n1. Start with a three-line summary.\n2. ...'}
          onChange={(e) => setInstructions(e.target.value)} className={`${inputClass} thin-scroll font-mono text-xs leading-relaxed`} />
      </div>
      {error && <p className="text-sm text-red-300">{error}</p>}
      <div className="flex justify-end">
        <button type="submit" disabled={busy}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-60">
          {busy ? 'Creating…' : 'Create skill'}
        </button>
      </div>
    </form>
  );
};

// Upload or GitHub import; a name clash offers to replace.
const InstallForm = ({ mode, onDone }) => {
  const [file, setFile] = useState(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [clash, setClash] = useState(false);
  const [dragging, setDragging] = useState(false);
  const input = useRef(null);

  const run = async (replace = false) => {
    setBusy(true);
    setError(null);
    setClash(false);
    try {
      if (mode === 'upload') await skillsService.upload(file, replace);
      else await skillsService.importGithub(url.trim(), replace);
      onDone();
    } catch (e) {
      setError(e.message);
      setClash(/already exists/.test(e.message || ''));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); run(); }} className="space-y-4">
      {mode === 'upload' ? (
        <button type="button" onClick={() => input.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]); }}
          className={`flex w-full flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-8 text-sm ${
            dragging ? 'border-blue-400 bg-blue-500/5' : 'border-gray-600 hover:border-gray-400'}`}>
          <Upload size={20} className="text-gray-400" />
          <span className="text-gray-200">{file ? file.name : 'Choose or drop a file'}</span>
          <span className="text-xs text-gray-500">A SKILL.md file, or a .zip of a skill folder (several skills are fine)</span>
          <input ref={input} type="file" accept=".md,.zip" className="hidden"
            onChange={(e) => setFile(e.target.files[0] || null)} />
        </button>
      ) : (
        <div>
          <label htmlFor="skill-url" className="mb-1.5 block text-sm text-gray-200">GitHub link</label>
          <input id="skill-url" value={url} onChange={(e) => setUrl(e.target.value)} required
            placeholder="https://github.com/owner/repo/tree/main/skills/my-skill" className={inputClass} />
          <p className="mt-1.5 text-xs leading-relaxed text-gray-500">
            A public repository, or a folder in it. Every folder with a SKILL.md inside is imported. Check a skill
            before turning it on: its instructions and scripts come from whoever wrote it.
          </p>
        </div>
      )}
      {error && <p className="text-sm text-red-300">{error}</p>}
      <div className="flex justify-end gap-2">
        {clash && (
          <button type="button" onClick={() => run(true)} disabled={busy}
            className="rounded-lg border border-gray-600 px-4 py-2 text-sm text-gray-200 hover:bg-white/5 disabled:opacity-60">
            Replace existing
          </button>
        )}
        <button type="submit" disabled={busy || (mode === 'upload' ? !file : !url.trim())}
          className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-60">
          {busy && <Loader2 size={14} className="animate-spin" />}
          {mode === 'upload' ? 'Upload' : 'Import'}
        </button>
      </div>
    </form>
  );
};

const ExploreModal = ({ onClose, onChanged }) => {
  const [items, setItems] = useState(null);
  const [category, setCategory] = useState('All');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const load = () => skillsService.catalog().then(setItems).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const install = async (id) => {
    setBusy(id);
    setError(null);
    try { await skillsService.install(id); await load(); onChanged(); } catch (e) { setError(e.message); }
    setBusy(null);
  };
  const categories = ['All', ...new Set((items || []).map((i) => i.category))];
  const shown = (items || []).filter((i) => category === 'All' || i.category === category);

  return (
    <Modal title="Explore skills" onClose={onClose} wide>
      <p className="mb-3 text-xs leading-relaxed text-gray-400">
        Open-source skills, installed from GitHub at a fixed version. Ones that come with scripts can run them in the
        Code page; chat reads their instructions.
      </p>
      <div className="mb-4 flex flex-wrap gap-1">
        {categories.map((c) => (
          <button key={c} type="button" onClick={() => setCategory(c)}
            className={`rounded-lg px-3 py-1.5 text-sm ${category === c ? 'bg-white/10 text-gray-100' : 'text-gray-400 hover:text-gray-200'}`}>
            {c}
          </button>
        ))}
      </div>
      {error && <p className="mb-3 text-sm text-red-300">{error}</p>}
      {items === null ? <Loader2 className="animate-spin text-gray-400" size={18} /> : (
        <div className="grid gap-3 sm:grid-cols-2">
          {shown.map((s) => (
            <div key={s.id} className="flex items-start gap-3 rounded-xl border border-gray-700/70 p-3.5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/[0.06] text-gray-300 ring-1 ring-white/5">
                <Sparkles size={16} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-gray-100">{s.title}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-gray-400">{s.description}</p>
                <p className="mt-1.5 text-xs text-gray-500">{s.author} · {s.license}</p>
              </div>
              {s.installed ? (
                <span className="text-xs text-green-300">Added</span>
              ) : (
                <button type="button" onClick={() => install(s.id)} disabled={!!busy} aria-label={`Add ${s.title}`}
                  className="rounded-lg border border-gray-600 p-1.5 text-gray-200 hover:bg-white/5 disabled:opacity-60">
                  {busy === s.id ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
};

const ADD_MODES = [
  { id: 'explore', label: 'Explore skills', icon: Compass },
  { id: 'create', label: 'Create a skill', icon: PencilLine, divider: true },
  { id: 'upload', label: 'Upload a skill', icon: Upload },
  { id: 'github', label: 'Import from GitHub', icon: Github },
];

const AddMenu = ({ onPick }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}
        className="flex items-center gap-1.5 rounded-lg border border-gray-600 px-3 py-2 text-sm text-gray-200 hover:bg-white/5">
        <Plus size={14} /> Add <ChevronDown size={14} />
      </button>
      {open && (
        <div role="menu" className="animate-menu-in origin-top-right absolute right-0 z-20 mt-1 w-56 rounded-xl border border-gray-700/80 bg-[#2a2b32] p-1 shadow-2xl shadow-black/40">
          {ADD_MODES.map(({ id, label, icon: Icon, divider }) => (
            <React.Fragment key={id}>
              {divider && <div className="my-1 border-t border-gray-700/70" />}
              <button type="button" role="menuitem" onClick={() => { setOpen(false); onPick(id); }}
                className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-gray-200 hover:bg-white/5">
                <Icon size={15} className="text-gray-400" /> {label}
              </button>
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
};

// ----- the page -----

/**
 * Settings > Skills: every skill with an on/off switch, filtered by source,
 * a detail view (instructions, files, edit and remove for your own), Explore
 * (installable open-source skills) and Add (create, upload, import from GitHub).
 */
const SkillsPage = () => {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState('all');
  const [adding, setAdding] = useState(null);
  const [open, setOpen] = useState(null);

  const load = () => skillsService.list().then(setItems).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const shown = useMemo(() => (items || []).filter((s) => (tab === 'all' || s.source === tab)
    && `${s.name} ${s.description}`.toLowerCase().includes(query.trim().toLowerCase())), [items, tab, query]);

  const toggle = async (skill, enabled) => {
    setError(null);
    setItems((list) => list.map((s) => (s.id === skill.id ? { ...s, enabled } : s)));
    try { await skillsService.setEnabled(skill.id, enabled); } catch (e) { setError(e.message); load(); }
  };
  const added = () => { setAdding(null); load(); };
  const enabledCount = (items || []).filter((s) => s.enabled).length;

  return (
    <div>
      <PageHeader title="Skills" description="Instructions the assistant loads when a task fits them." />

      <div className="mb-4 flex items-start gap-2 rounded-xl border border-gray-700/60 bg-black/10 px-3.5 py-2.5 text-xs leading-relaxed text-gray-400">
        <Info size={14} className="mt-0.5 shrink-0" />
        <span>
          Skills that are on work in chat and in the coding agent. Each one adds a line to every request, so keep
          only the ones you use. Scripts inside skills run only in the Code page. Changes restart the coding agent.
        </span>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[12rem] flex-1">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search skills"
            aria-label="Search skills" className={`${inputClass} pl-9`} />
        </div>
        <button type="button" onClick={() => setAdding('explore')}
          className="flex items-center gap-1.5 rounded-lg border border-gray-600 px-3 py-2 text-sm text-gray-200 hover:bg-white/5">
          <Compass size={14} /> Explore skills
        </button>
        <AddMenu onPick={setAdding} />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-1">
        {TABS.map((t) => (
          <button key={t.id} type="button" onClick={() => setTab(t.id)}
            className={`rounded-lg px-3 py-1.5 text-sm ${tab === t.id ? 'bg-white/10 text-gray-100' : 'text-gray-400 hover:text-gray-200'}`}>
            {t.label}
          </button>
        ))}
        {items && <span className="ml-auto text-xs text-gray-500">{enabledCount} on</span>}
      </div>

      {error && <p className="mb-3 text-sm text-red-300">{error}</p>}
      {items === null ? <Loader2 className="animate-spin text-gray-400" size={18} /> : shown.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-700 px-4 py-10 text-center">
          <p className="text-sm text-gray-300">{tab === 'local' ? 'No skills found on this computer' : 'No skills here yet'}</p>
          <p className="mt-1 text-xs text-gray-500">
            {tab === 'local' ? 'Skills in ~/.claude/skills and ~/.agents/skills show up here.' : 'Explore skills or add your own.'}
          </p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {shown.map((s) => <SkillCard key={s.id} skill={s} onToggle={toggle} onOpen={(x) => setOpen(x.id)} />)}
        </div>
      )}

      {adding === 'explore' && <ExploreModal onClose={() => setAdding(null)} onChanged={load} />}
      {adding === 'create' && <Modal title="Create a skill" onClose={() => setAdding(null)}><CreateForm onDone={added} /></Modal>}
      {adding === 'upload' && <Modal title="Upload a skill" onClose={() => setAdding(null)}><InstallForm mode="upload" onDone={added} /></Modal>}
      {adding === 'github' && <Modal title="Import from GitHub" onClose={() => setAdding(null)}><InstallForm mode="github" onDone={added} /></Modal>}
      {open && <SkillDetail id={open} onClose={() => setOpen(null)} onChanged={load} />}
    </div>
  );
};

export default SkillsPage;
