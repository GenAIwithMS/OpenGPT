import React, { useEffect, useState } from 'react';
import { Check, Copy, Loader2, RefreshCw } from 'lucide-react';
import ProviderLogo from './ProviderLogo';
import { inputClass } from './controls';
import { providersService } from '../../services/api';

const formatSize = (bytes) => {
  if (!bytes) return '';
  const gb = bytes / 1e9;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
};

const Command = ({ text }) => {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* no clipboard */ }
  };
  return (
    <div className="mt-2 flex items-center gap-2 rounded-lg bg-black/30 px-3 py-2">
      <code className="min-w-0 flex-1 truncate font-mono text-xs text-gray-200" title={text}>{text}</code>
      <button type="button" onClick={copy} aria-label={copied ? 'Copied' : `Copy ${text}`}
        className="shrink-0 text-gray-400 hover:text-gray-200">
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
    </div>
  );
};

// One server: what was found, what to do, and (when running) a model to use.
const ServerCard = ({ server, providers, onUsed }) => {
  const [model, setModel] = useState(server.models[0] || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const existing = providers.find((p) => p.base_url === server.base_url);

  const use = async () => {
    setBusy(true);
    setError(null);
    try {
      const item = existing
        ? await providersService.update(existing.id, { model })
        : await providersService.create({ preset: server.preset, name: server.name, base_url: server.base_url, model });
      await providersService.setActive(item.id, {});
      onUsed(`${server.name} · ${model} is in use. Chat uses it now; the coding agent restarts.`);
    } catch (e) { setError(e.message); setBusy(false); }
  };

  const tone = server.status === 'running' ? 'text-green-300' : 'text-amber-200';
  return (
    <div className="rounded-xl border border-gray-700/70 p-3.5">
      <div className="flex items-start gap-3">
        <ProviderLogo preset={server.preset} name={server.name} />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-gray-100">{server.name}</p>
          <p className={`mt-0.5 text-xs leading-relaxed ${tone}`}>{server.message}</p>
        </div>
      </div>
      {server.command && <Command text={server.command} />}

      {server.status === 'running' && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-gray-700/50 pt-3">
          <label htmlFor={`local-${server.preset}`} className="sr-only">Model</label>
          <select id={`local-${server.preset}`} value={model} onChange={(e) => setModel(e.target.value)}
            className={`${inputClass} min-w-0 flex-1 font-mono text-xs`}>
            {server.models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <button type="button" onClick={use} disabled={busy || !model}
            className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-60">
            {busy ? 'Saving…' : 'Use this model'}
          </button>
        </div>
      )}

      {server.status !== 'running' && server.downloaded.length > 0 && (
        <details className="mt-2 text-xs text-gray-400">
          <summary className="cursor-pointer hover:text-gray-200">Downloaded models ({server.downloaded.length})</summary>
          <ul className="mt-1.5 space-y-0.5">
            {server.downloaded.map((m) => (
              <li key={m.name} className="flex gap-2 font-mono">
                <span className="min-w-0 flex-1 truncate" title={m.name}>{m.name}</span>
                <span className="shrink-0 text-gray-500">{formatSize(m.size)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {error && <p className="mt-2 text-xs text-red-300">{error}</p>}
    </div>
  );
};

/**
 * Settings > Developer > Find local models: model servers running on this
 * computer (Ollama, LM Studio, llama.cpp, Jan), models downloaded for them,
 * and what to do next. Running servers can be added and used in one step.
 *
 * @param {object} props
 * @param {object[]} props.providers  Saved providers, to update one instead of adding a copy.
 * @param {(message: string) => void} props.onUsed  Called after a model is made active.
 */
const LocalModels = ({ providers, onUsed }) => {
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(true);

  const search = async () => {
    setBusy(true);
    setError(null);
    try { setResult(await providersService.findLocal()); } catch (e) { setError(e.message); }
    setBusy(false);
  };
  useEffect(() => { search(); }, []);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <p className="flex-1 text-xs leading-relaxed text-gray-400">
          Checks the usual ports for Ollama, LM Studio, llama.cpp and Jan, and their model folders on this computer.
        </p>
        <button type="button" onClick={search} disabled={busy}
          className="flex shrink-0 items-center gap-1 text-xs text-gray-400 hover:text-gray-200 disabled:opacity-60">
          {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Search again
        </button>
      </div>

      {error && <p className="text-sm text-red-300">{error}</p>}
      {busy && !result && <Loader2 className="animate-spin text-gray-400" size={18} />}

      {result && (
        <>
          {result.servers.length === 0 && (
            <p className="rounded-xl border border-gray-700/70 p-3.5 text-sm leading-relaxed text-gray-300">
              No local model server or downloaded models found. Install one (Ollama, LM Studio, llama.cpp or Jan),
              download a model, start it, then search again. A server on another port or computer can be added with
              Add provider &gt; Custom.
            </p>
          )}
          {result.servers.map((s) => (
            <ServerCard key={s.preset} server={s} providers={providers} onUsed={onUsed} />
          ))}
          {!result.disk_checked && (
            <p className="text-xs leading-relaxed text-gray-500">
              Downloaded models weren't checked because the server is open to the network (HOST isn't local).
            </p>
          )}
          <p className="text-xs leading-relaxed text-gray-500">
            Pick a model that supports tool calling: chat tools, deep research and the blog writer need it. Ollama uses
            a short context window by default; set OLLAMA_CONTEXT_LENGTH (for example 16384) and restart it for long chats.
          </p>
        </>
      )}
    </div>
  );
};

export default LocalModels;
