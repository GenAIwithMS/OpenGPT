import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search, Sparkles } from 'lucide-react';
import { providersService } from '../services/api';
import { AUTO, useModelChoice } from '../lib/modelChoice';

// The menu next to the send button: Auto (a model per message, picked by the
// backend) or one model from the active provider. `page` is 'chat' or 'code'.

let menuData = null; // shared by both pages; loaded once per page load
const loadMenu = () => {
  if (!menuData) menuData = providersService.models().catch((e) => { menuData = null; throw e; });
  return menuData;
};

// "provider/model-name" -> "model-name" for the button; the full name is in the list.
const shortName = (name) => (name || '').split('/').pop();

const ModelPicker = ({ page, disabled = false }) => {
  const [choice, setChoice] = useModelChoice(page);
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const ref = useRef(null);
  const search = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    loadMenu().then(setData).catch((e) => setError(e.message));
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => search.current?.focus(), 0);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const models = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.models || []).filter((m) => !q || m.toLowerCase().includes(q));
  }, [data, query]);

  const auto = data?.auto?.[page];
  const autoHint = auto
    ? [...new Set([auto.light, auto.normal, auto.strong])].length === 1
      ? `Uses ${shortName(auto.normal)}`
      : `${shortName(auto.light)} · ${shortName(auto.normal)} · ${shortName(auto.strong)}`
    : 'Picks a model for each message';
  const pick = (model) => { setChoice(model); setOpen(false); setQuery(''); };
  const isAuto = !choice || choice === AUTO;

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} disabled={disabled}
        aria-haspopup="listbox" aria-expanded={open} aria-label={`Model: ${isAuto ? 'Auto' : choice}`}
        title={isAuto ? 'Auto: picks a model for each message' : choice}
        className="flex h-8 max-w-[11rem] items-center gap-1 rounded-full px-2.5 text-xs text-gray-300 transition-colors hover:bg-white/10 hover:text-gray-100 disabled:opacity-50">
        {isAuto && <Sparkles size={13} className="shrink-0 text-gray-400" />}
        <span className="truncate">{isAuto ? 'Auto' : shortName(choice)}</span>
        <ChevronDown size={13} className="shrink-0 text-gray-400" />
      </button>

      {open && (
        <div role="listbox" aria-label="Choose a model"
          className="animate-menu-in origin-bottom-right absolute bottom-full right-0 z-50 mb-2 flex max-h-80 w-72 flex-col rounded-xl border border-gray-700/80 bg-[#2a2b32] p-1 shadow-2xl shadow-black/40">
          <button type="button" role="option" aria-selected={isAuto} onClick={() => pick(AUTO)}
            className="flex w-full items-start gap-2.5 rounded-lg px-3 py-2 text-left hover:bg-white/5">
            <Sparkles size={15} className="mt-0.5 shrink-0 text-gray-400" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm text-gray-100">Auto</span>
              <span className="block truncate text-[11px] text-gray-500" title={autoHint}>{autoHint}</span>
            </span>
            {isAuto && <Check size={14} className="mt-0.5 shrink-0 text-gray-200" />}
          </button>
          <div className="my-1 border-t border-gray-700/70" />
          {(data?.models?.length || 0) > 8 && (
            <div className="relative px-1 pb-1">
              <Search size={13} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-500" />
              <input ref={search} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search models"
                aria-label="Search models"
                className="w-full rounded-lg border border-gray-600 bg-[#26272e] py-1.5 pl-7 pr-2 text-xs text-gray-100 placeholder-gray-500 outline-none focus:border-gray-400" />
            </div>
          )}
          <div className="thin-scroll min-h-0 flex-1 overflow-y-auto">
            {error && <p className="px-3 py-2 text-xs text-red-300">{error}</p>}
            {!data && !error && <p className="px-3 py-2 text-xs text-gray-500">Loading models…</p>}
            {data && models.length === 0 && <p className="px-3 py-2 text-xs text-gray-500">No models match.</p>}
            {models.map((m) => (
              <button key={m} type="button" role="option" aria-selected={choice === m} onClick={() => pick(m)}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left hover:bg-white/5">
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-gray-200" title={m}>{m}</span>
                {m === (page === 'code' ? data.code_default : data.chat_default) && (
                  <span className="shrink-0 text-[10px] text-gray-500">default</span>
                )}
                {choice === m && <Check size={14} className="shrink-0 text-gray-200" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default ModelPicker;
