import React from 'react';
import {
  CornerDownLeft, Keyboard, MessageSquareDashed, PanelLeft, Search, Send, Settings, SquarePen, Code2, TextCursorInput,
} from 'lucide-react';
import { PageHeader } from './controls';
import { SHORTCUTS, keyLabel } from '../../lib/shortcuts';

// Key badges: "Ctrl" "Shift" "O", each a small raised key.
export const Keys = ({ keys }) => (
  <span className="flex shrink-0 items-center gap-1" aria-label={keys.map(keyLabel).join(' + ')}>
    {keys.map((k) => (
      <kbd
        key={k}
        className="inline-flex h-6 min-w-[1.5rem] items-center justify-center rounded-md border border-gray-600/80 border-b-[2px] bg-gradient-to-b from-[#3a3b44] to-[#2c2d34] px-1.5 font-sans text-[11px] font-medium text-gray-100"
      >
        {keyLabel(k)}
      </kbd>
    ))}
  </span>
);

const byId = Object.fromEntries(SHORTCUTS.map((s) => [s.id, s]));

// What each shortcut is shown with, grouped.
const GROUPS = [
  {
    title: 'Chat',
    items: [
      { label: 'Send message', hint: 'In chat and on the Code page', icon: Send, keys: ['Enter'] },
      { label: 'New line', hint: 'Without sending', icon: CornerDownLeft, keys: ['Shift', 'Enter'] },
      { ...byId.newChat, icon: SquarePen },
      { ...byId.temporaryChat, icon: MessageSquareDashed, hint: 'Not saved to your history' },
      { ...byId.focusInput, icon: TextCursorInput },
    ],
  },
  {
    title: 'Navigation',
    items: [
      { ...byId.searchChats, icon: Search },
      { ...byId.openCode, icon: Code2 },
      { ...byId.toggleSidebar, icon: PanelLeft },
    ],
  },
  {
    title: 'App',
    items: [
      { ...byId.openSettings, icon: Settings },
      { ...byId.showShortcuts, icon: Keyboard },
    ],
  },
];

/**
 * Settings > Shortcuts: every keyboard shortcut, grouped. The list comes from
 * `lib/shortcuts.js`, which also makes them work.
 */
const ShortcutsPage = () => (
  <div>
    <PageHeader title="Shortcuts" description="Work faster with the keyboard. These work anywhere in OpenGPT." />

    <div className="space-y-6">
      {GROUPS.map((group) => (
        <section key={group.title} aria-label={group.title}>
          <h3 className="mb-2 px-1 text-xs font-medium uppercase tracking-wide text-gray-500">{group.title}</h3>
          <div className="overflow-hidden rounded-xl border border-gray-700/60 bg-black/10">
            {group.items.map(({ label, hint, icon: Icon, keys }, i) => (
              <div
                key={label}
                className={`flex items-center gap-3 px-3.5 py-2.5 transition-colors hover:bg-white/[0.03] ${
                  i > 0 ? 'border-t border-gray-700/40' : ''
                }`}
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gray-700/50 text-gray-300">
                  <Icon size={15} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-gray-100">{label}</span>
                  {hint && <span className="block truncate text-xs text-gray-500">{hint}</span>}
                </span>
                <Keys keys={keys} />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  </div>
);

export default ShortcutsPage;
