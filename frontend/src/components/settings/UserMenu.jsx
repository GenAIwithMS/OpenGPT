import React, { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, BookOpen, ChevronsUpDown, Home, LifeBuoy, Settings, User } from 'lucide-react';
import { Avatar } from './controls';

const LINKS = [
  { label: 'Homepage', icon: Home, href: 'https://github.com/GenAIwithMS/OpenGPT' },
  { label: 'Get help', icon: LifeBuoy, href: 'https://github.com/GenAIwithMS/OpenGPT/issues' },
  { label: 'Docs', icon: BookOpen, href: 'https://github.com/GenAIwithMS/OpenGPT#readme' },
];

// Sidebar footer: avatar + name; the menu opens Account or Settings and links out.
const UserMenu = ({ displayName, onOpenSettings, collapsed = false }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const choose = (section) => { setOpen(false); onOpenSettings(section); };
  const item = 'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-gray-200 hover:bg-gray-700';

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}
        title={collapsed ? displayName : undefined}
        className={collapsed
          ? 'flex h-10 w-10 items-center justify-center rounded-xl hover:bg-gray-700'
          : 'flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left hover:bg-gray-700/70'}>
        <Avatar name={displayName} />
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1 truncate text-sm text-gray-100">{displayName}</span>
            <ChevronsUpDown size={15} className="shrink-0 text-gray-400" />
          </>
        )}
      </button>

      {open && (
        <div role="menu"
          className={`absolute z-50 w-60 rounded-xl border border-gray-700/80 bg-[#2a2b32] p-1 shadow-2xl shadow-black/40 ${
            collapsed ? 'bottom-0 left-full ml-2' : 'bottom-full left-0 mb-2'
          }`}>
          <div className="flex items-center gap-2.5 px-3 py-2">
            <Avatar name={displayName} />
            <div className="min-w-0">
              <p className="truncate text-sm text-gray-100">{displayName}</p>
              <p className="text-xs text-gray-500">Local</p>
            </div>
          </div>
          <div className="my-1 border-t border-gray-700/70" />
          <button type="button" role="menuitem" onClick={() => choose('account')} className={item}>
            <User size={15} className="text-gray-400" /> Account
          </button>
          <button type="button" role="menuitem" onClick={() => choose('general')} className={item}>
            <Settings size={15} className="text-gray-400" /> Settings
          </button>
          <div className="my-1 border-t border-gray-700/70" />
          {LINKS.map(({ label, icon: Icon, href }) => (
            <a key={label} role="menuitem" href={href} target="_blank" rel="noopener noreferrer" className={item}
              onClick={() => setOpen(false)}>
              <Icon size={15} className="text-gray-400" />
              <span className="flex-1">{label}</span>
              <ArrowUpRight size={14} className="text-gray-500" />
            </a>
          ))}
        </div>
      )}
    </div>
  );
};

export default UserMenu;
