import React, { useEffect, useMemo, useState } from 'react';
import { Check, ExternalLink, FileCog, Info, Loader2, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { Modal, PageHeader, Section, inputClass } from './controls';
import LocalModels from './LocalModels';
import ProviderLogo from './ProviderLogo';
import { providersService } from '../../services/api';

const ROLES = [
  { id: 'model', label: 'Chat', hint: 'Answers in chat' },
  { id: 'small_model', label: 'Titles and summaries', hint: 'Chat titles, short summaries' },
  { id: 'research_model', label: 'Deep research', hint: 'Research reports' },
  { id: 'blog_model', label: 'Blog writer', hint: 'Blog posts' },
  { id: 'coding_model', label: 'Coding agent', hint: 'The Code page' },
];

const API_NAMES = { openai: 'OpenAI-compatible API', anthropic: 'Anthropic-compatible API' };

// The model list a provider offers, for suggestions in model fields.
const ModelList = ({ id, models }) => (
  <datalist id={id}>{(models || []).map((m) => <option key={m} value={m} />)}</datalist>
);

const TestButton = ({ onTest, state }) => (
  <button type="button" onClick={onTest} disabled={state?.busy}
    className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-200 disabled:opacity-60">
    {state?.busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Test
  </button>
);

const TestResult = ({ state }) => {
  if (!state || state.busy) return null;
  return state.error
    ? <p className="mt-2 text-xs text-red-300">{state.error}</p>
    : <p className="mt-2 flex items-center gap-1 text-xs text-green-300"><Check size={12} /> Connected · {state.models.length} models</p>;
};

// ----- add / edit -----

const ProviderForm = ({ presets, existing, onDone }) => {
  const [preset, setPreset] = useState(existing?.preset || null);
  const spec = presets.find((p) => p.id === preset);
  const [name, setName] = useState(existing?.name || '');
  const [kind, setKind] = useState(existing?.kind || 'openai');
  const [baseUrl, setBaseUrl] = useState(existing?.base_url || '');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(existing?.model || '');
  const [models, setModels] = useState([]);
  const [testing, setTesting] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const choose = (p) => { setPreset(p.id); setName(p.id === 'custom' ? '' : p.name); setBaseUrl(p.base_url); setKind(p.kind); };

  const test = async () => {
    setTesting({ busy: true });
    try {
      const list = existing && !apiKey && baseUrl === existing.base_url
        ? await providersService.test({ provider_id: existing.id })
        : await providersService.test({ preset, kind, base_url: baseUrl, api_key: apiKey });
      setModels(list);
      setTesting({ models: list });
      if (!model && list.length) setModel(list[0]);
    } catch (e) { setTesting({ error: e.message }); }
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (existing) await providersService.update(existing.id, { name, base_url: baseUrl, model, api_key: apiKey || undefined });
      else await providersService.create({ preset, name, kind, base_url: baseUrl, api_key: apiKey, model });
      onDone();
    } catch (err) { setError(err.message); setBusy(false); }
  };

  if (!preset) {
    return (
      <div className="grid gap-2 sm:grid-cols-3">
        {presets.map((p) => (
          <button key={p.id} type="button" onClick={() => choose(p)}
            className="flex items-center gap-2.5 rounded-xl border border-gray-700/70 p-3 text-left hover:border-gray-500 hover:bg-white/[0.03]">
            <ProviderLogo preset={p.id} name={p.name} size="h-8 w-8" />
            <span className="min-w-0">
              <span className="block text-sm leading-tight text-gray-100">{p.name}</span>
              <span className="block text-xs text-gray-500">{p.local ? 'On this computer' : p.id === 'custom' ? 'Any endpoint' : 'Cloud'}</span>
            </span>
          </button>
        ))}
      </div>
    );
  }

  const needsKey = !spec?.local && preset !== 'custom';
  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="flex items-center gap-3">
        <ProviderLogo preset={preset} name={spec?.name} />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-gray-100">{spec?.name}</p>
          <p className="text-xs text-gray-500">{API_NAMES[kind]}</p>
        </div>
        {!existing && (
          <button type="button" onClick={() => setPreset(null)} className="text-xs text-gray-400 hover:text-gray-200">Change</button>
        )}
      </div>
      <div>
        <label htmlFor="p-name" className="mb-1.5 block text-sm text-gray-200">Name</label>
        <input id="p-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)}
          placeholder={spec?.name} className={inputClass} />
      </div>
      {preset === 'custom' && !existing && (
        <div>
          <label htmlFor="p-kind" className="mb-1.5 block text-sm text-gray-200">API type</label>
          <select id="p-kind" value={kind} onChange={(e) => setKind(e.target.value)} className={inputClass}>
            <option value="openai">OpenAI-compatible (Chat Completions)</option>
            <option value="anthropic">Anthropic-compatible (Messages)</option>
          </select>
        </div>
      )}
      <div>
        <label htmlFor="p-url" className="mb-1.5 block text-sm text-gray-200">Base URL</label>
        <input id="p-url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} required
          placeholder="https://api.example.com/v1" className={`${inputClass} font-mono text-xs`} />
        {spec?.local && (
          <p className="mt-1.5 text-xs leading-relaxed text-gray-500">
            The server must be running on this computer. Pick a model that supports tool calling.
          </p>
        )}
      </div>
      <div>
        <div className="mb-1.5 flex items-center">
          <label htmlFor="p-key" className="text-sm text-gray-200">API key{!needsKey && <span className="text-gray-500"> (optional)</span>}</label>
          {spec?.keys_url && (
            <a href={spec.keys_url} target="_blank" rel="noreferrer" className="ml-auto flex items-center gap-1 text-xs text-gray-400 hover:text-gray-200">
              Get a key <ExternalLink size={11} />
            </a>
          )}
        </div>
        <input id="p-key" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off"
          required={needsKey && !existing} placeholder={existing?.has_key ? 'Saved. Leave empty to keep it' : ''}
          className={`${inputClass} font-mono text-xs`} />
        <p className="mt-1.5 text-xs text-gray-500">Stored encrypted on this computer and never shown again.</p>
      </div>
      <div>
        <div className="mb-1.5 flex items-center gap-3">
          <label htmlFor="p-model" className="text-sm text-gray-200">Default model</label>
          <span className="ml-auto"><TestButton onTest={test} state={testing} /></span>
        </div>
        <input id="p-model" value={model} onChange={(e) => setModel(e.target.value)} list="p-models" maxLength={200}
          placeholder="Test to load the list, or type a model name" className={`${inputClass} font-mono text-xs`} />
        <ModelList id="p-models" models={models} />
        <TestResult state={testing} />
      </div>
      {error && <p className="text-sm text-red-300">{error}</p>}
      <div className="flex justify-end">
        <button type="submit" disabled={busy}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-60">
          {busy ? 'Saving…' : existing ? 'Save' : 'Add provider'}
        </button>
      </div>
    </form>
  );
};

// ----- the page -----

/**
 * Settings > Developer: the active provider and the model for each job, and
 * the providers list (add from presets, test, edit, remove). The provider
 * from the server's settings shows as "Default".
 */
const DeveloperPage = () => {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
  const [tests, setTests] = useState({});
  const [active, setActive] = useState('env');
  const [roles, setRoles] = useState({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [confirming, setConfirming] = useState(null);
  const [findingLocal, setFindingLocal] = useState(false);
  const [notice, setNotice] = useState(null);

  const load = () => providersService.overview().then((d) => {
    setData(d);
    setActive(d.active);
    setRoles(d.roles);
  }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const test = async (id) => {
    setTests((t) => ({ ...t, [id]: { busy: true } }));
    try {
      const models = await providersService.test({ provider_id: id });
      setTests((t) => ({ ...t, [id]: { models } }));
    } catch (e) { setTests((t) => ({ ...t, [id]: { error: e.message } })); }
  };

  // Load the chosen provider's models for the suggestions.
  useEffect(() => { if (data && !tests[active]) test(active); }, [active, data]); // eslint-disable-line react-hooks/exhaustive-deps

  const choice = useMemo(() => (data ? (active === 'env'
    ? { name: 'Default', defaults: data.env.roles || {} }
    : (() => {
      const p = data.providers.find((x) => x.id === active);
      const d = p?.model || '';
      return { name: p?.name, defaults: Object.fromEntries(ROLES.map((r) => [r.id, d])) };
    })()) : null), [data, active]);

  const dirty = data && (active !== data.active || ROLES.some((r) => (roles[r.id] || '') !== (data.roles[r.id] || '')));

  const saveChoice = async () => {
    setSaving(true);
    setError(null);
    try {
      const d = await providersService.setActive(active, roles);
      setData(d);
      setRoles(d.roles);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) { setError(e.message); }
    setSaving(false);
  };

  const remove = async (id) => {
    setConfirming(null);
    try { await providersService.remove(id); await load(); } catch (e) { setError(e.message); }
  };

  if (!data) {
    return (
      <div>
        <PageHeader title="Developer" description="Model providers, and which model does each job." />
        {error ? <p className="text-sm text-red-300">{error}</p> : <Loader2 className="animate-spin text-gray-400" size={18} />}
      </div>
    );
  }

  const options = [
    ...(data.env.configured ? [{ id: 'env', name: 'Default' }] : []),
    ...data.providers.map((p) => ({ id: p.id, name: p.name })),
  ];

  return (
    <div>
      <PageHeader title="Developer" description="Model providers, and which model does each job." />

      <Section title="Models in use">
        <div className="space-y-4 rounded-xl border border-gray-700/70 p-4">
          <div>
            <label htmlFor="active-provider" className="mb-1.5 block text-sm text-gray-200">Provider</label>
            <select id="active-provider" value={active} onChange={(e) => { setActive(e.target.value); setRoles({}); }}
              className={inputClass}>
              {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {ROLES.map((r) => (
              <div key={r.id}>
                <label htmlFor={`role-${r.id}`} className="mb-1 block text-xs text-gray-300">
                  {r.label} <span className="text-gray-500">· {r.hint}</span>
                </label>
                <input id={`role-${r.id}`} value={roles[r.id] || ''} list="active-models" maxLength={200}
                  onChange={(e) => setRoles((x) => ({ ...x, [r.id]: e.target.value }))}
                  placeholder={choice?.defaults?.[r.id] ? `Default: ${choice.defaults[r.id]}` : 'Model name'}
                  className={`${inputClass} font-mono text-xs`} />
              </div>
            ))}
          </div>
          <ModelList id="active-models" models={tests[active]?.models} />
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={saveChoice} disabled={!dirty || saving}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50">
              {saving ? 'Saving…' : 'Save'}
            </button>
            {notice && !saved && <span className="flex items-center gap-1 text-xs text-green-300"><Check size={13} /> {notice}</span>}
            {saved && <span className="flex items-center gap-1 text-xs text-green-300"><Check size={13} /> Saved. Chat uses it now; the coding agent restarts.</span>}
            {!saved && !notice && <span className="text-xs text-gray-500">Empty fields use the provider's default model.</span>}
          </div>
          {error && <p className="text-sm text-red-300">{error}</p>}
        </div>
      </Section>

      <Section title="Providers">
        <div className="mb-3 flex flex-wrap justify-end gap-2">
          <button type="button" onClick={() => setFindingLocal(true)}
            className="flex items-center gap-1.5 rounded-lg border border-gray-600 px-3 py-2 text-sm text-gray-200 hover:bg-white/5">
            <Search size={14} /> Find local models
          </button>
          <button type="button" onClick={() => setAdding(true)}
            className="flex items-center gap-1.5 rounded-lg border border-gray-600 px-3 py-2 text-sm text-gray-200 hover:bg-white/5">
            <Plus size={14} /> Add provider
          </button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-gray-700/70 p-3.5">
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/[0.06] text-gray-300 ring-1 ring-white/5">
                <FileCog size={16} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 text-sm text-gray-100">
                  Default {data.active === 'env' && <span className="rounded-md bg-blue-500/15 px-1.5 py-0.5 text-[11px] text-blue-300">In use</span>}
                </p>
                {data.env.configured ? (
                  <>
                    <p className="mt-0.5 text-xs text-gray-500">{API_NAMES[data.env.kind]}</p>
                    <p className="truncate font-mono text-xs text-gray-500">{data.env.model}</p>
                  </>
                ) : <p className="mt-0.5 text-xs text-gray-500">Not set up</p>}
              </div>
            </div>
            {data.env.configured && (
              <div className="mt-3 flex items-center gap-3 border-t border-gray-700/50 pt-2.5">
                <TestButton onTest={() => test('env')} state={tests.env} />
                <span className="text-xs text-gray-500">Set by the server</span>
              </div>
            )}
            <TestResult state={tests.env} />
          </div>

          {data.providers.map((p) => (
            <div key={p.id} className="rounded-xl border border-gray-700/70 p-3.5">
              <div className="flex items-start gap-3">
                <ProviderLogo preset={p.preset} name={p.name} />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 text-sm text-gray-100">
                    <span className="truncate">{p.name}</span>
                    {data.active === p.id && <span className="rounded-md bg-blue-500/15 px-1.5 py-0.5 text-[11px] text-blue-300">In use</span>}
                  </p>
                  <p className="mt-0.5 text-xs text-gray-500">{API_NAMES[p.kind]}{p.has_key ? ' · key saved' : ''}</p>
                  <p className="truncate font-mono text-xs text-gray-500" title={p.base_url}>{p.base_url}{p.model ? ` · ${p.model}` : ''}</p>
                </div>
              </div>
              <div className="mt-3 flex items-center gap-3 border-t border-gray-700/50 pt-2.5 text-xs">
                <TestButton onTest={() => test(p.id)} state={tests[p.id]} />
                <button type="button" onClick={() => setEditing(p)} className="text-gray-400 hover:text-gray-200">Edit</button>
                <span className="ml-auto">
                  {confirming === p.id ? (
                    <span className="flex items-center gap-2">
                      <span className="text-gray-400">Remove?</span>
                      <button type="button" onClick={() => remove(p.id)} className="text-red-300 hover:text-red-200">Remove</button>
                      <button type="button" onClick={() => setConfirming(null)} className="text-gray-400 hover:text-gray-200">Cancel</button>
                    </span>
                  ) : (
                    <button type="button" onClick={() => setConfirming(p.id)} aria-label={`Remove ${p.name}`}
                      className="flex items-center gap-1 text-gray-400 hover:text-red-300">
                      <Trash2 size={13} /> Remove
                    </button>
                  )}
                </span>
              </div>
              <TestResult state={tests[p.id]} />
            </div>
          ))}
        </div>
        <p className="mt-3 flex items-start gap-2 text-xs leading-relaxed text-gray-500">
          <Info size={13} className="mt-0.5 shrink-0" />
          Any service with an OpenAI- or Anthropic-compatible API works. Pick a model that supports tool calling.
        </p>
      </Section>

      {findingLocal && (
        <Modal title="Local models" onClose={() => setFindingLocal(false)}>
          <LocalModels providers={data.providers} onUsed={(message) => {
            setFindingLocal(false);
            setNotice(message);
            setTimeout(() => setNotice(null), 6000);
            load();
          }} />
        </Modal>
      )}
      {adding && (
        <Modal title="Add a provider" onClose={() => setAdding(false)}>
          <ProviderForm presets={data.presets} onDone={() => { setAdding(false); load(); }} />
        </Modal>
      )}
      {editing && (
        <Modal title={`Edit ${editing.name}`} onClose={() => setEditing(null)}>
          <ProviderForm presets={data.presets} existing={editing} onDone={() => { setEditing(null); load(); }} />
        </Modal>
      )}
    </div>
  );
};

export default DeveloperPage;
