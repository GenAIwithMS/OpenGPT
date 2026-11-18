import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Code2, CornerDownLeft, FolderOpen, MessageCircle, MessageCirclePlus, MessageCircleDashed, Settings, TerminalSquare, X,
} from 'lucide-react';
import { codeService } from '../services/api';

// Search everything: chats, coding projects and coding sessions, plus a few
// actions. Arrow keys move, Enter opens, left/right change the type.

const TABS = [
  { id: 'all', label: 'All' },
  { id: 'chat', label: 'Chats' },
  { id: 'project', label: 'Projects' },
  { id: 'session', label: 'Sessions' },
];

const ICONS = { chat: MessageCircle, project: FolderOpen, session: TerminalSquare };
const RECENT_COUNT = 8;
const MAX_PROJECTS_SCANNED = 12;

const Key = ({ children }) => (
  <kbd className="inline-flex min-w-[1.25rem] items-center justify-center rounded border border-gray-600 px-1 font-sans text-[10px] text-gray-300">
    {children}
  </kbd>
);

/**
 * The search window (sidebar "Search chats", Ctrl/Cmd+K). Loads coding
 * projects and sessions when it opens.
 *
 * @param {object} props
 * @param {{thread_id: string, title?: string}[]} props.threads  The chat list.
 * @param {() => void} props.onClose
 * @param {(threadId: string) => void} props.onOpenChat
 * @param {(projectId: string) => void} props.onOpenProject
 * @param {(projectId: string, sessionId: string) => void} props.onOpenSession
 * @param {{id: string, title: string, icon: Function, run: () => void, hint?: string}[]} props.actions
 *   Shown under Actions (new chat, temporary chat, OpenGPT Code, settings).
 */
const SearchPalette = ({ threads, onClose, onOpenChat, onOpenProject, onOpenSession, actions }) => {
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState('all');
  const [active, setActive] = useState(0);
  const [projects, setProjects] = useState([]);
  const [sessions, setSessions] = useState([]);
  const input = useRef(null);
  const list = useRef(null);

  useEffect(() => { input.current?.focus(); }, []);

  // Coding projects and their sessions (loaded when the window opens).
  useEffect(() => {
    let stopped = false;
    codeService.getProjects().then(async (data) => {
      const found = data.projects || [];
      if (stopped) return;
      setProjects(found);
      const lists = await Promise.all(found.slice(0, MAX_PROJECTS_SCANNED).map((p) =>
        codeService.getSessions(p.id)
          .then((items) => items.map((s) => ({ ...s, project: p })))
          .catch(() => [])));
      if (!stopped) setSessions(lists.flat());
    }).catch(() => {}); // the coding agent may be off: chats still work
    return () => { stopped = true; };
  }, []);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (text) => !q || (text || '').toLowerCase().includes(q);
    const chats = threads
      .filter((t) => match(t.title || 'Untitled chat'))
      .map((t) => ({ key: `chat:${t.thread_id}`, type: 'chat', title: t.title || 'Untitled chat', open: () => onOpenChat(t.thread_id) }));
    const sessionItems = sessions
      .filter((s) => match(`${s.title} ${s.project.name}`))
      .map((s) => ({ key: `session:${s.id}`, type: 'session', title: s.title || 'Untitled session', detail: s.project.name, open: () => onOpenSession(s.project.id, s.id) }));
    const projectItems = projects
      .filter((p) => match(`${p.name} ${p.path || ''}`))
      .map((p) => ({ key: `project:${p.id}`, type: 'project', title: p.name, detail: p.path, open: () => onOpenProject(p.id) }));
    const actionItems = actions
      .filter((a) => match(a.title))
      .map((a) => ({ key: `action:${a.id}`, type: 'action', title: a.title, icon: a.icon, hint: a.hint, open: a.run }));

    if (tab === 'chat') return [{ label: q ? 'Chats' : 'Recent chats', items: chats }];
    if (tab === 'project') return [{ label: 'Projects', items: projectItems }];
    if (tab === 'session') return [{ label: 'Coding sessions', items: sessionItems }];
    if (!q) {
      return [
        { label: 'Recents', items: [...chats.slice(0, RECENT_COUNT - 2), ...sessionItems.slice(0, 2)] },
        { label: 'Actions', items: actionItems },
      ];
    }
    return [
      { label: 'Chats', items: chats.slice(0, 20) },
      { label: 'Coding sessions', items: sessionItems.slice(0, 10) },
      { label: 'Projects', items: projectItems.slice(0, 10) },
      { label: 'Actions', items: actionItems },
    ];
  }, [query, tab, threads, sessions, projects, actions, onOpenChat, onOpenProject, onOpenSession]);

  const flat = groups.flatMap((g) => g.items);
  useEffect(() => { setActive(0); }, [query, tab]);
  useEffect(() => {
    list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (item) => {
    if (!item) return;
    onClose();
    item.open();
  };

  const changeTab = (step) => {
    const i = TABS.findIndex((t) => t.id === tab);
    setTab(TABS[(i + step + TABS.length) % TABS.length].id);
  };

  const onKeyDown = (e) => {
    const el = input.current;
    const atStart = el && el.selectionStart === 0 && el.selectionEnd === 0;
    const atEnd = el && el.selectionStart === query.length;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (flat.length ? (i + 1) % flat.length : 0)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (flat.length ? (i - 1 + flat.length) % flat.length : 0)); }
    else if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); choose(flat[active]); }
    else if (e.key === 'ArrowRight' && (!query || atEnd)) { e.preventDefault(); changeTab(1); }
    else if (e.key === 'ArrowLeft' && (!query || atStart)) { e.preventDefault(); changeTab(-1); }
  };

  let index = -1;
  return (
    <div className="animate-backdrop-in fixed inset-0 z-[70] flex items-start justify-center bg-black/50 px-4 pt-[8vh]" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Search" onClick={(e) => e.stopPropagation()}
        className="animate-dialog-in flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-gray-700/80 bg-[#2a2b32] shadow-2xl shadow-black/50">
        <div className="px-5 pt-4">
          <div className="flex items-center gap-3">
            <input ref={input} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKeyDown}
              placeholder="Search" aria-label="Search" role="combobox" aria-expanded="true" aria-controls="search-results"
              className="min-w-0 flex-1 bg-transparent py-1 text-base text-gray-100 placeholder-gray-500 outline-none" />
            <button type="button" onClick={onClose} aria-label="Close search"
              className="rounded-lg p-1 text-gray-400 hover:bg-white/5 hover:text-gray-200">
              <X size={18} />
            </button>
          </div>
          <div className="mt-3 flex flex-wrap gap-1 pb-3" role="tablist" aria-label="Type">
            {TABS.map((t) => (
              <button key={t.id} type="button" role="tab" aria-selected={tab === t.id}
                onClick={() => { setTab(t.id); input.current?.focus(); }}
                className={`rounded-lg px-2.5 py-1 text-sm ${tab === t.id ? 'bg-white/10 text-gray-100' : 'text-gray-400 hover:text-gray-200'}`}>
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div ref={list} id="search-results" role="listbox" aria-label="Results"
          className="thin-scroll min-h-0 flex-1 overflow-y-auto border-t border-gray-700/70 px-2 py-2">
          {flat.length === 0 && (
            <p className="px-3 py-8 text-center text-sm text-gray-500">{query ? 'Nothing found' : 'Nothing here yet'}</p>
          )}
          {groups.map((g) => g.items.length > 0 && (
            <div key={g.label} className="mb-1">
              <p className="px-3 pb-1 pt-2 text-xs text-gray-500">{g.label}</p>
              {g.items.map((item) => {
                index += 1;
                const i = index;
                const Icon = item.icon || ICONS[item.type] || MessageCircle;
                const isActive = i === active;
                return (
                  <button key={item.key} type="button" role="option" aria-selected={isActive} data-active={isActive}
                    onMouseMove={() => setActive(i)} onClick={() => choose(item)}
                    className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm ${
                      isActive ? 'bg-white/[0.08] text-gray-50' : 'text-gray-300'}`}>
                    <Icon size={16} className="shrink-0 text-gray-400" />
                    <span className="min-w-0 flex-1 truncate">{item.title}</span>
                    {item.detail && <span className="max-w-[40%] shrink-0 truncate text-xs text-gray-500">{item.detail}</span>}
                    {item.hint && !isActive && <span className="shrink-0 text-xs text-gray-500">{item.hint}</span>}
                    {isActive && <CornerDownLeft size={14} className="shrink-0 text-gray-400" />}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-gray-700/70 px-5 py-2.5 text-xs text-gray-400">
          <span className="flex items-center gap-1.5">Close <Key>Esc</Key></span>
          <span className="flex items-center gap-1.5">Change type <Key>←</Key><Key>→</Key></span>
          <span className="flex items-center gap-1.5">Move <Key>↑</Key><Key>↓</Key></span>
          <span className="ml-auto flex items-center gap-1.5">Open <Key><CornerDownLeft size={10} /></Key></span>
        </div>
      </div>
    </div>
  );
};

export const searchActionIcons = { Code2, MessageCirclePlus, MessageCircleDashed, Settings };

export default SearchPalette;
