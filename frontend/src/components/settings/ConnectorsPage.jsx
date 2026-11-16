import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Braces, Check, ChevronDown, Globe, Info, Loader2, Plus, Search, TerminalSquare, Trash2, X,
} from 'lucide-react';
import { PageHeader, Toggle } from './controls';
import ConnectorLogo from './ConnectorLogo';
import { connectorsService } from '../../services/api';

// Sign in on the provider's own page, in a small window. The window is opened
// right away (on the click) so browsers don't block it, then sent to the
// provider. Resolves true/false when it reports back, or null if closed.
async function signInWindow(target) {
  const popup = window.open('', 'opengpt-signin', 'width=620,height=760');
  let url;
  try {
    url = await connectorsService.startSignIn(target);
  } catch (e) {
    popup?.close();
    throw e;
  }
  if (!popup) {
    window.location.assign(url); // popups blocked: sign in in this tab
    return null;
  }
  popup.location.href = url;
  return new Promise((resolve) => {
    const done = (value) => {
      window.removeEventListener('message', onMessage);
      clearInterval(timer);
      resolve(value);
    };
    const onMessage = (e) => {
      if (e.data && e.data.type === 'opengpt-connector') done(Boolean(e.data.ok));
    };
    const timer = setInterval(() => { if (popup.closed) done(null); }, 700);
    window.addEventListener('message', onMessage);
  });
}

const inputClass =
  'w-full rounded-lg border border-gray-600 bg-[#26272e] px-3 py-2 text-sm text-gray-100 placeholder-gray-500 outline-none focus:border-gray-400';

const Modal = ({ title, onClose, children, wide = false }) => {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}
        className={`flex w-full flex-col rounded-2xl border border-gray-700 bg-[#26272e] shadow-2xl ${
          wide ? 'h-[85vh] max-w-3xl' : 'max-h-[85vh] max-w-lg'
        }`}>
        <div className="flex items-center border-b border-gray-700/70 px-5 py-3.5">
          <h2 className="text-base font-semibold text-gray-100">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="ml-auto rounded-lg p-1 text-gray-400 hover:bg-white/5">
            <X size={17} />
          </button>
        </div>
        <div className="thin-scroll min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
};

// "KEY=value" lines <-> object
const parsePairs = (text, sep) => Object.fromEntries(
  text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const i = l.indexOf(sep);
    return i === -1 ? [l, ''] : [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  }),
);

// ----- Create: custom local / by URL / import JSON -----

const CreateForm = ({ mode, onDone, onCancel }) => {
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [url, setUrl] = useState('');
  const [pairs, setPairs] = useState('');
  const [json, setJson] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'json') await connectorsService.importJson(json);
      else if (mode === 'local') await connectorsService.create({ name, kind: 'local', command, env: parsePairs(pairs, '=') });
      else if (!pairs.trim()) {
        // No token given: sign in if the server supports it, else add as is.
        try {
          const ok = await signInWindow({ name, url });
          if (ok === false) throw new Error('Sign-in was not completed.');
        } catch (err) {
          if (!/doesn't offer sign-in/.test(err.message || '')) throw err;
          await connectorsService.create({ name, kind: 'remote', url });
        }
      } else await connectorsService.create({ name, kind: 'remote', url, headers: parsePairs(pairs, ':') });
      onDone();
    } catch (err) {
      setError(err.message || 'Could not add the connector.');
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      {mode === 'json' ? (
        <div>
          <label htmlFor="mcp-json" className="mb-1.5 block text-sm text-gray-200">MCP configuration</label>
          <textarea id="mcp-json" rows={10} value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false}
            placeholder={'{\n  "mcpServers": {\n    "my-server": { "command": "npx", "args": ["-y", "my-mcp"] },\n    "remote": { "url": "https://example.com/mcp" }\n  }\n}'}
            className={`${inputClass} thin-scroll font-mono text-xs`} />
          <p className="mt-1.5 text-xs text-gray-500">The same format other MCP apps use (mcpServers with command/args/env or url/headers).</p>
        </div>
      ) : (
        <>
          <div>
            <label htmlFor="mcp-name" className="mb-1.5 block text-sm text-gray-200">Name</label>
            <input id="mcp-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={48} required
              placeholder="my-server" className={inputClass} />
          </div>
          {mode === 'local' ? (
            <div>
              <label htmlFor="mcp-command" className="mb-1.5 block text-sm text-gray-200">Command</label>
              <input id="mcp-command" value={command} onChange={(e) => setCommand(e.target.value)} required spellCheck={false}
                placeholder="npx -y @scope/my-mcp-server" className={`${inputClass} font-mono text-xs`} />
              <p className="mt-1.5 text-xs text-gray-500">Runs on this computer when the coding agent starts.</p>
            </div>
          ) : (
            <div>
              <label htmlFor="mcp-url" className="mb-1.5 block text-sm text-gray-200">Server URL</label>
              <input id="mcp-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} required
                placeholder="https://example.com/mcp" className={inputClass} />
            </div>
          )}
          <div>
            <label htmlFor="mcp-pairs" className="mb-1.5 block text-sm text-gray-200">
              {mode === 'local' ? 'Environment variables (optional)' : 'Headers (optional)'}
            </label>
            <textarea id="mcp-pairs" rows={3} value={pairs} onChange={(e) => setPairs(e.target.value)} spellCheck={false}
              placeholder={mode === 'local' ? 'API_KEY=your-key' : 'Authorization: Bearer your-token'}
              className={`${inputClass} font-mono text-xs`} />
            <p className="mt-1.5 text-xs text-gray-500">
              One per line. Stored encrypted and never shown again.
              {mode === 'remote' && ' Leave empty to sign in with the service, if it supports it.'}
            </p>
          </div>
        </>
      )}
      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-lg px-3 py-1.5 text-sm text-gray-300 hover:bg-white/5">Cancel</button>
        <button type="submit" disabled={busy}
          className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-60">
          {busy && <Loader2 size={14} className="animate-spin" />}
          {mode === 'json' ? 'Import' : 'Add'}
        </button>
      </div>
    </form>
  );
};

const CREATE_MODES = [
  { id: 'local', label: 'Custom MCP', hint: 'A command on this computer', icon: TerminalSquare },
  { id: 'remote', label: 'Add MCP by URL', hint: 'A remote MCP server', icon: Globe },
  { id: 'json', label: 'Import MCP by JSON', hint: 'Paste an mcpServers config', icon: Braces },
];

const CreateMenu = ({ onPick }) => {
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
        className="flex items-center gap-1 rounded-lg border border-gray-600 px-3 py-1.5 text-sm text-gray-200 hover:bg-white/5">
        Create <ChevronDown size={14} />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-20 mt-1 w-64 rounded-xl border border-gray-700/80 bg-[#2a2b32] p-1 shadow-2xl shadow-black/40">
          {CREATE_MODES.map(({ id, label, hint, icon: Icon }) => (
            <button key={id} type="button" role="menuitem" onClick={() => { setOpen(false); onPick(id); }}
              className="flex w-full items-start gap-2.5 rounded-lg px-3 py-2 text-left hover:bg-gray-700">
              <Icon size={15} className="mt-0.5 shrink-0 text-gray-400" />
              <span>
                <span className="block text-sm text-gray-100">{label}</span>
                <span className="block text-xs text-gray-500">{hint}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// ----- Browse the catalog -----

const CatalogItem = ({ entry, onAdded }) => {
  const fields = entry.auth === 'key' ? [...(entry.env || []), ...(entry.headers || [])] : [];
  const [asking, setAsking] = useState(false);
  const [values, setValues] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const add = async () => {
    if (fields.length && !asking) { setAsking(true); return; }
    setBusy(true);
    setError(null);
    try {
      if (entry.auth === 'oauth') {
        const ok = await signInWindow({ catalog_id: entry.id });
        if (ok === false) setError('Sign-in was not completed.');
      } else {
        await connectorsService.addFromCatalog(entry.id, values);
      }
      onAdded();
    } catch (e) {
      setError(e.message);
    }
    setBusy(false);
  };

  return (
    <div className="rounded-xl border border-gray-700/70 p-3.5">
      <div className="flex items-start gap-3">
        <ConnectorLogo id={entry.id} name={entry.name} />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-gray-100">{entry.name}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-gray-400">{entry.description}</p>
          <p className="mt-1 text-[11px] text-gray-500">
            {entry.auth === 'oauth' ? 'Sign in to connect' : entry.kind === 'remote' ? 'Remote server' : `Needs ${entry.requires || 'a local runtime'}`}
            {entry.homepage && <> · <a href={entry.homepage} target="_blank" rel="noopener noreferrer" className="hover:text-gray-300">Docs</a></>}
          </p>
        </div>
        {entry.added ? (
          <span className="flex h-7 w-7 items-center justify-center text-green-400" title="Added"><Check size={16} /></span>
        ) : (
          <button type="button" onClick={add} disabled={busy} aria-label={`Add ${entry.name}`}
            title={entry.auth === 'oauth' ? `Sign in with ${entry.name}` : `Add ${entry.name}`}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-gray-600 text-gray-200 hover:bg-white/5 disabled:opacity-60">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={15} />}
          </button>
        )}
      </div>
      {asking && !entry.added && (
        <div className="mt-3 space-y-2 border-t border-gray-700/60 pt-3">
          {entry.oauth_hint && <p className="text-[11px] leading-relaxed text-gray-500">{entry.oauth_hint} Until then, use a token:</p>}
          {fields.map((f) => (
            <input key={f.name} type="password" autoComplete="off" value={values[f.name] || ''}
              onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
              placeholder={f.label} aria-label={f.label} className={inputClass} />
          ))}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setAsking(false)} className="rounded-lg px-3 py-1 text-xs text-gray-300 hover:bg-white/5">Cancel</button>
            <button type="button" onClick={add} disabled={busy}
              className="rounded-lg bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-60">Add</button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-red-300">{error}</p>}
    </div>
  );
};

const BrowseModal = ({ onClose, onChanged }) => {
  const [items, setItems] = useState(null);
  const [category, setCategory] = useState('All');
  const [query, setQuery] = useState('');
  const load = () => connectorsService.catalog().then(setItems).catch(() => setItems([]));
  useEffect(() => { load(); }, []);

  const categories = ['All', ...new Set((items || []).map((i) => i.category))];
  const shown = (items || []).filter((i) => (category === 'All' || i.category === category)
    && `${i.name} ${i.description}`.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <Modal title="Browse connectors" onClose={onClose} wide>
      <div className="relative mb-3">
        <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search connectors" aria-label="Search connectors"
          className={`${inputClass} pl-9`} />
      </div>
      <div className="mb-4 flex flex-wrap gap-1.5">
        {categories.map((c) => (
          <button key={c} type="button" onClick={() => setCategory(c)}
            className={`rounded-lg px-3 py-1 text-sm ${category === c ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-gray-200'}`}>
            {c}
          </button>
        ))}
      </div>
      {items === null ? <Loader2 className="animate-spin text-gray-400" size={18} /> : (
        <div className="grid gap-3 sm:grid-cols-2">
          {shown.map((entry) => (
            <CatalogItem key={entry.id} entry={entry} onAdded={() => { load(); onChanged(); }} />
          ))}
          {shown.length === 0 && <p className="text-sm text-gray-500">No connectors match.</p>}
        </div>
      )}
    </Modal>
  );
};

// ----- Added connectors -----

const ConnectorCard = ({ connector, onChange, onRemove, onReload }) => {
  const [confirming, setConfirming] = useState(false);
  const [signing, setSigning] = useState(false);
  const signInAgain = async () => {
    setSigning(true);
    try { await signInWindow({ connector_id: connector.id }); } catch { /* shown on next load */ }
    setSigning(false);
    onReload();
  };
  const detail = connector.kind === 'remote' ? connector.url : (connector.command || []).join(' ');
  const secrets = [...connector.env_names, ...connector.header_names];
  return (
    <div className={`rounded-xl border p-3.5 ${connector.enabled ? 'border-gray-700/70' : 'border-gray-700/40 opacity-70'}`}>
      <div className="flex items-start gap-3">
        <ConnectorLogo id={connector.catalog_id || connector.name} name={connector.title} />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-sm text-gray-100">
            {connector.title}
            {connector.signed_in && (
              <span className="rounded-md bg-green-500/10 px-1.5 py-0.5 text-[10px] font-medium text-green-300">Signed in</span>
            )}
          </p>
          <p className="mt-0.5 truncate font-mono text-[11px] text-gray-500" title={detail}>{detail}</p>
          {secrets.length > 0 && <p className="mt-0.5 text-[11px] text-gray-500">Keys set: {secrets.join(', ')}</p>}
        </div>
        <Toggle label={`${connector.title} on or off`} checked={connector.enabled}
          onChange={(v) => onChange(connector.id, { enabled: v })} />
      </div>
      <div className="mt-3 flex items-center gap-3 border-t border-gray-700/50 pt-2.5 text-xs">
        <label className="flex items-center gap-1.5 text-gray-300">
          <input type="checkbox" checked={connector.use_in_code} disabled={!connector.enabled}
            onChange={(e) => onChange(connector.id, { use_in_code: e.target.checked })}
            className="h-3.5 w-3.5 accent-blue-500" />
          Use in Code
        </label>
        {connector.signed_in && (
          <button type="button" onClick={signInAgain} disabled={signing} className="text-gray-400 hover:text-gray-200 disabled:opacity-60">
            {signing ? 'Signing in…' : 'Sign in again'}
          </button>
        )}
        <span className="ml-auto">
          {confirming ? (
            <span className="flex items-center gap-2">
              <span className="text-gray-400">Remove?</span>
              <button type="button" onClick={() => onRemove(connector.id)} className="text-red-300 hover:text-red-200">Remove</button>
              <button type="button" onClick={() => setConfirming(false)} className="text-gray-400 hover:text-gray-200">Cancel</button>
            </span>
          ) : (
            <button type="button" onClick={() => setConfirming(true)} aria-label={`Remove ${connector.title}`}
              className="flex items-center gap-1 text-gray-400 hover:text-red-300">
              <Trash2 size={13} /> Remove
            </button>
          )}
        </span>
      </div>
    </div>
  );
};

const ConnectorsPage = () => {
  const [items, setItems] = useState(null);
  const [query, setQuery] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const [creating, setCreating] = useState(null);
  const [error, setError] = useState(null);

  const load = () => connectorsService.list().then(setItems).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const shown = useMemo(() => (items || []).filter((c) =>
    `${c.title} ${c.name}`.toLowerCase().includes(query.trim().toLowerCase())), [items, query]);

  const change = async (id, changes) => {
    setError(null);
    setItems((list) => list.map((c) => (c.id === id ? { ...c, ...changes } : c)));
    try { await connectorsService.update(id, changes); } catch (e) { setError(e.message); load(); }
  };
  const remove = async (id) => {
    setError(null);
    try { await connectorsService.remove(id); setItems((list) => list.filter((c) => c.id !== id)); } catch (e) { setError(e.message); }
  };

  return (
    <div>
      <PageHeader title="Connectors" description="Give the assistant tools from MCP servers." />

      <div className="mb-4 flex items-start gap-2 rounded-xl border border-gray-700/60 bg-black/10 px-3.5 py-2.5 text-xs leading-relaxed text-gray-400">
        <Info size={14} className="mt-0.5 shrink-0" />
        <span>
          Connectors are available to the coding agent, which asks before using any of their tools. Chat support
          is coming next. Changes restart the coding agent (about 10 seconds).
        </span>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[12rem] flex-1">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search connectors" aria-label="Search connectors"
            className={`${inputClass} py-1.5 pl-9`} />
        </div>
        <button type="button" onClick={() => setBrowsing(true)}
          className="rounded-lg border border-gray-600 px-3 py-1.5 text-sm text-gray-200 hover:bg-white/5">Browse connectors</button>
        <CreateMenu onPick={setCreating} />
      </div>

      {error && <p role="alert" className="mb-3 text-sm text-red-300">{error}</p>}

      {items === null ? <Loader2 className="animate-spin text-gray-400" size={18} /> : items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-700 px-4 py-10 text-center">
          <p className="text-sm text-gray-300">No connectors yet</p>
          <p className="mt-1 text-xs text-gray-500">Browse the catalog or add your own MCP server.</p>
        </div>
      ) : (
        <>
          <p className="mb-2 text-xs text-gray-500">Added</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {shown.map((c) => <ConnectorCard key={c.id} connector={c} onChange={change} onRemove={remove} onReload={load} />)}
          </div>
        </>
      )}

      {browsing && <BrowseModal onClose={() => setBrowsing(false)} onChanged={load} />}
      {creating && (
        <Modal title={CREATE_MODES.find((m) => m.id === creating).label} onClose={() => setCreating(null)}>
          <CreateForm mode={creating} onCancel={() => setCreating(null)} onDone={() => { setCreating(null); load(); }} />
        </Modal>
      )}
    </div>
  );
};

export default ConnectorsPage;
