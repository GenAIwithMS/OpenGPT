import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, ChevronRight, Search } from 'lucide-react';
import { providersService } from '../services/api';
import { AUTO, useModelChoice } from '../lib/modelChoice';

// The menu next to the send button: Auto (a model per message, picked by the
// backend) or one model from the active provider. `page` is 'chat' or 'code'.
// Layout: featured choices with a short description, then "More models" with
// the full list in a side panel.

export const OPEN_SETTINGS_EVENT = 'opengpt:open-settings';

let menuData = null; // shared by both pages; loaded once per page load
const loadMenu = () => {
  if (!menuData) menuData = providersService.models().catch((e) => { menuData = null; throw e; });
  return menuData;
};

// "provider/model-name" -> "model-name"; the full id is in the tooltip.
const shortName = (name) => (name || '').split('/').pop();

const GAP = 6;
const MARGIN = 8;

// Featured models: the jobs' models from Settings > Developer, each once.
function featuredModels(data, page) {
  if (!data) return [];
  const auto = data.auto?.[page] || {};
  const roles = page === 'code'
    ? [[auto.strong, 'For complex work'], [auto.normal, 'For everyday coding']]
    : [[auto.strong, 'For complex work'], [auto.normal, 'For everyday tasks'], [auto.light, 'Fastest for quick answers']];
  const seen = new Map();
  roles.forEach(([name, text]) => {
    if (!name) return;
    if (seen.has(name)) return;
    seen.set(name, text);
  });
  if (seen.size === 1) return [{ name: [...seen.keys()][0], text: 'Used for every task' }];
  return [...seen.entries()].map(([name, text]) => ({ name, text }));
}

const Row = ({ title, text, selected, onClick, onMouseEnter }) => (
  <button type="button" role="menuitemradio" aria-checked={selected} data-item onClick={onClick} onMouseEnter={onMouseEnter}
    className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left outline-none hover:bg-white/[0.06] focus-visible:bg-white/[0.08]">
    <span className="min-w-0 flex-1">
      <span className="block truncate text-sm text-gray-100" title={title}>{title}</span>
      {text && <span className="mt-0.5 block truncate text-xs text-gray-500">{text}</span>}
    </span>
    {selected && <Check size={16} className="shrink-0 text-blue-400" />}
  </button>
);

// Move focus between items with the arrow keys.
const moveFocus = (container, step) => {
  const items = [...(container?.querySelectorAll('[data-item]') || [])];
  if (!items.length) return;
  const i = items.indexOf(document.activeElement);
  items[(i + step + items.length) % items.length].focus();
};

const ModelPicker = ({ page, disabled = false }) => {
  const [choice, setChoice] = useModelChoice(page);
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [pos, setPos] = useState(null);       // main panel {top, left}
  const [subPos, setSubPos] = useState(null); // side panel {top, left}
  const button = useRef(null);
  const panel = useRef(null);
  const sub = useRef(null);
  const moreRow = useRef(null);
  const search = useRef(null);

  const isAuto = !choice || choice === AUTO;
  const close = useCallback(() => { setOpen(false); setMore(false); setQuery(''); }, []);
  const pick = (model) => { setChoice(model); close(); button.current?.focus(); };

  useEffect(() => {
    if (!open) return undefined;
    loadMenu().then(setData).catch((e) => setError(e.message));
    const onDown = (e) => {
      if (!button.current?.contains(e.target) && !panel.current?.contains(e.target) && !sub.current?.contains(e.target)) close();
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); button.current?.focus(); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, close]);

  // Below the button, right-aligned with it; above only when there is no room below.
  const place = useCallback(() => {
    const b = button.current?.getBoundingClientRect();
    const p = panel.current;
    if (!b || !p) return;
    const h = p.offsetHeight;
    const w = p.offsetWidth;
    const below = window.innerHeight - b.bottom - GAP - MARGIN;
    const top = below >= h || below >= b.top - GAP - MARGIN ? b.bottom + GAP : Math.max(MARGIN, b.top - GAP - h);
    const left = Math.min(Math.max(MARGIN, b.right - w), window.innerWidth - w - MARGIN);
    setPos({ top, left });
    const s = sub.current;
    const r = moreRow.current?.getBoundingClientRect();
    if (s && r) {
      const sw = s.offsetWidth;
      const sh = s.offsetHeight;
      // Beside the menu: to the right when it fits, else to the left.
      const sideLeft = left + w + GAP + sw <= window.innerWidth - MARGIN ? left + w + GAP : Math.max(MARGIN, left - GAP - sw);
      const sideTop = Math.min(Math.max(MARGIN, r.top - 8), window.innerHeight - sh - MARGIN);
      setSubPos({ top: sideTop, left: sideLeft });
    }
  }, []);

  useLayoutEffect(() => {
    if (!open) return undefined;
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, more, data, query, place]);

  // Focus the current choice when the menu opens, and the search when "More" opens.
  useEffect(() => {
    if (open && data) {
      const current = panel.current?.querySelector('[aria-checked="true"]') || panel.current?.querySelector('[data-item]');
      current?.focus();
    }
  }, [open, data]);
  useEffect(() => { if (more) setTimeout(() => (search.current || sub.current?.querySelector('[data-item]'))?.focus(), 0); }, [more]);

  const featured = useMemo(() => featuredModels(data, page), [data, page]);
  const featuredNames = new Set(featured.map((f) => f.name));
  const others = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.models || []).filter((m) => !featuredNames.has(m) && (!q || m.toLowerCase().includes(q)));
  }, [data, query, featured]); // eslint-disable-line react-hooks/exhaustive-deps
  const pickedOther = !isAuto && !featuredNames.has(choice);

  const openSettings = () => {
    close();
    window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: 'developer' }));
  };

  const panelKeys = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveFocus(panel.current, 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveFocus(panel.current, -1); }
  };
  const subKeys = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveFocus(sub.current, 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveFocus(sub.current, -1); }
    else if (e.key === 'ArrowLeft') {
      // In the search box, Left moves the cursor until the box is empty.
      if (e.target === search.current && query) return;
      e.preventDefault();
      setMore(false);
      moreRow.current?.focus();
    }
  };

  const menu = open && createPortal(
    <>
      <div ref={panel} role="menu" aria-label="Choose a model" onKeyDown={panelKeys}
        style={{ position: 'fixed', top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
        className="animate-menu-in z-[80] w-80 rounded-2xl border border-gray-700/80 bg-[#2a2b32] p-1.5 shadow-2xl shadow-black/50">
        <Row title="Auto" text="Picks a model for each message" selected={isAuto} onClick={() => pick(AUTO)}
          onMouseEnter={() => setMore(false)} />
        {!data && !error && <p className="px-3 py-2 text-xs text-gray-500">Loading models…</p>}
        {error && <p className="px-3 py-2 text-xs text-red-300">{error}</p>}
        {featured.map((f) => (
          <Row key={f.name} title={shortName(f.name)} text={f.text} selected={choice === f.name}
            onClick={() => pick(f.name)} onMouseEnter={() => setMore(false)} />
        ))}
        {data && (data.models || []).length > featured.length && (
          <>
            <div className="mx-2 my-1.5 border-t border-gray-700/70" />
            <button ref={moreRow} type="button" data-item aria-haspopup="menu" aria-expanded={more}
              onClick={() => setMore(true)}
              onMouseEnter={() => setMore(true)}
              onKeyDown={(e) => { if (e.key === 'ArrowRight') { e.preventDefault(); setMore(true); } }}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-gray-100 outline-none hover:bg-white/[0.06] focus-visible:bg-white/[0.08] ${more ? 'bg-white/[0.08]' : ''}`}>
              <span className="flex-1">More models</span>
              {pickedOther && <span className="max-w-[9rem] truncate text-xs text-gray-400" title={choice}>{shortName(choice)}</span>}
              <ChevronRight size={15} className="shrink-0 text-gray-400" />
            </button>
          </>
        )}
        <div className="mx-2 my-1.5 border-t border-gray-700/70" />
        <p className="px-3 pb-1.5 pt-0.5 text-xs leading-relaxed text-gray-500">
          Auto uses the models set for each job in Settings.{' '}
          <button type="button" onClick={openSettings} className="text-gray-300 underline underline-offset-2 hover:text-white">
            Change
          </button>
        </p>
      </div>

      {more && (
        <div ref={sub} role="menu" aria-label="More models" onKeyDown={subKeys}
          style={{ position: 'fixed', top: subPos?.top ?? -9999, left: subPos?.left ?? -9999 }}
          className="animate-menu-in z-[80] flex max-h-[min(24rem,70vh)] w-72 flex-col rounded-2xl border border-gray-700/80 bg-[#2a2b32] p-1.5 shadow-2xl shadow-black/50">
          {others.length + featured.length > 8 && (
            <div className="relative px-1 pb-1.5">
              <Search size={13} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-[60%] text-gray-500" />
              <input ref={search} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search models"
                aria-label="Search models"
                className="w-full rounded-lg border border-gray-600 bg-[#26272e] py-1.5 pl-7 pr-2 text-xs text-gray-100 placeholder-gray-500 outline-none focus:border-gray-400" />
            </div>
          )}
          <div className="thin-scroll min-h-0 flex-1 overflow-y-auto">
            {others.length === 0 && <p className="px-3 py-2 text-xs text-gray-500">No models match.</p>}
            {others.map((m) => (
              <Row key={m} title={m} selected={choice === m} onClick={() => pick(m)} />
            ))}
          </div>
        </div>
      )}
    </>,
    document.body,
  );

  return (
    <>
      <button ref={button} type="button" onClick={() => (open ? close() : setOpen(true))} disabled={disabled}
        aria-haspopup="menu" aria-expanded={open} aria-label={`Model: ${isAuto ? 'Auto' : choice}`}
        title={isAuto ? 'Auto: picks a model for each message' : choice}
        className={`flex h-8 max-w-[12rem] items-center gap-1 rounded-lg px-2.5 text-sm text-gray-300 transition-colors hover:bg-white/10 hover:text-gray-100 disabled:opacity-50 ${
          open ? 'bg-white/10 text-gray-100' : ''}`}>
        <span className="truncate">{isAuto ? 'Auto' : shortName(choice)}</span>
        <ChevronDown size={14} className={`shrink-0 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {menu}
    </>
  );
};

export default ModelPicker;
