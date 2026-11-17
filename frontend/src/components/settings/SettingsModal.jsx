import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Code2, Keyboard, Plug, Search, SlidersHorizontal, Sparkles, User, UserCog, X,
} from 'lucide-react';
import { Avatar } from './controls';
import AccountPage from './AccountPage';
import GeneralPage from './GeneralPage';
import ShortcutsPage from './ShortcutsPage';
import PersonalizationPage from './PersonalizationPage';
import ConnectorsPage from './ConnectorsPage';
import SkillsPage from './SkillsPage';
import DeveloperPage from './DeveloperPage';

// Settings popup: navigation on the left, the chosen page on the right.
export const SECTIONS = [
  { group: 'Account', items: [
    { id: 'account', label: 'Account', icon: User, keywords: 'name profile local' },
  ] },
  { group: 'Settings', items: [
    { id: 'general', label: 'General', icon: SlidersHorizontal, keywords: 'temporary notifications sound' },
    { id: 'shortcuts', label: 'Shortcuts', icon: Keyboard, keywords: 'keyboard keys send enter hotkeys new line' },
  ] },
  { group: 'Capabilities', items: [
    { id: 'personalization', label: 'Personalization', icon: UserCog, keywords: 'nickname instructions knowledge memory' },
    { id: 'connectors', label: 'Connectors', icon: Plug, keywords: 'mcp tools integrations' },
    { id: 'skills', label: 'Skills', icon: Sparkles, keywords: 'skill instructions explore upload github' },
  ] },
  { group: 'Developer', items: [
    { id: 'developer', label: 'Developer', icon: Code2, keywords: 'provider providers api key model models endpoint openai anthropic ollama' },
  ] },
];

const SettingsModal = ({ section, onSectionChange, onClose, settings, save, displayName, error }) => {
  const [query, setQuery] = useState('');
  const panelRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    panelRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SECTIONS;
    return SECTIONS
      .map((g) => ({ ...g, items: g.items.filter((i) => `${i.label} ${i.keywords}`.toLowerCase().includes(q)) }))
      .filter((g) => g.items.length);
  }, [query]);

  const current = SECTIONS.flatMap((g) => g.items).find((i) => i.id === section) || SECTIONS[0].items[0];

  let page;
  if (current.id === 'account') {
    page = <AccountPage displayName={displayName} onOpenPersonalization={() => onSectionChange('personalization')} />;
  } else if (current.id === 'general') {
    page = <GeneralPage settings={settings} save={save} />;
  } else if (current.id === 'shortcuts') {
    page = <ShortcutsPage />;
  } else if (current.id === 'personalization') {
    page = <PersonalizationPage settings={settings} save={save} />;
  } else if (current.id === 'connectors') {
    page = <ConnectorsPage />;
  } else if (current.id === 'skills') {
    page = <SkillsPage />;
  } else {
    page = <DeveloperPage />;
  }

  return (
    <div className="animate-backdrop-in fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-0 sm:p-6" onClick={onClose}>
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
        className="animate-dialog-in relative flex h-full w-full max-w-5xl flex-col overflow-hidden border border-gray-700/80 bg-[#2a2b32] shadow-2xl outline-none sm:h-[85vh] sm:rounded-2xl md:flex-row"
      >
        <button type="button" onClick={onClose} aria-label="Close settings"
          className="absolute right-3 top-3 z-10 rounded-lg p-1.5 text-gray-400 hover:bg-white/5 hover:text-gray-200">
          <X size={18} />
        </button>

        {/* Navigation */}
        <nav className="shrink-0 border-b border-gray-700/70 bg-[#202123] p-3 md:w-60 md:border-b-0 md:border-r md:overflow-y-auto thin-scroll" aria-label="Settings sections">
          <div className="mb-3 flex items-center gap-2.5 px-1 pr-10 md:pr-1">
            <Avatar name={displayName} />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-gray-100">{displayName}</p>
              <p className="text-xs text-gray-500">Local</p>
            </div>
          </div>
          <div className="relative mb-3">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" aria-label="Search settings"
              className="w-full rounded-lg border border-gray-700 bg-transparent py-1.5 pl-8 pr-2 text-sm text-gray-100 placeholder-gray-500 outline-none focus:border-gray-500" />
          </div>
          <div className="flex gap-1 overflow-x-auto md:block md:space-y-3">
            {groups.map((g) => (
              <div key={g.group} className="flex shrink-0 gap-1 md:block">
                <p className="hidden px-2 pb-1 text-xs text-gray-500 md:block">{g.group}</p>
                {g.items.map((item) => {
                  const Icon = item.icon;
                  const active = item.id === current.id;
                  return (
                    <button key={item.id} type="button" onClick={() => onSectionChange(item.id)}
                      aria-current={active ? 'page' : undefined}
                      className={`flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-sm md:w-full ${
                        active ? 'bg-gray-700/80 text-white' : 'text-gray-300 hover:bg-gray-700/50 hover:text-gray-100'
                      }`}>
                      <Icon size={15} className="shrink-0" />
                      {item.label}
                    </button>
                  );
                })}
              </div>
            ))}
            {groups.length === 0 && <p className="px-2 text-xs text-gray-500">No settings match</p>}
          </div>
        </nav>

        {/* Page */}
        <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-5 py-6 sm:px-10 sm:py-8">
          <div className="mx-auto max-w-2xl">
            {error && <p role="alert" className="mb-4 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>}
            {!settings && !error ? <p className="text-sm text-gray-400">Loading…</p> : page}
          </div>
        </div>
      </div>
    </div>
  );
};

export default SettingsModal;
