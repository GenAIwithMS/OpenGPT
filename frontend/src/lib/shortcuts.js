import { useEffect, useRef } from 'react';

// App-wide keyboard shortcuts. "Mod" is Ctrl (Windows/Linux) or Cmd (Mac).
// Combinations the browser keeps for itself (Ctrl+N/T/W, Ctrl+Shift+J, ...)
// are avoided, so these work in every major browser.

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export const SHORTCUTS = [
  { id: 'newChat', label: 'New chat', keys: ['Mod', 'Shift', 'O'] },
  { id: 'searchChats', label: 'Search', keys: ['Mod', 'K'] },
  { id: 'openCode', label: 'Open the Code page', keys: ['Mod', 'Shift', 'L'] },
  { id: 'temporaryChat', label: 'New temporary chat', keys: ['Mod', 'Shift', 'U'] },
  { id: 'toggleSidebar', label: 'Show or hide the sidebar', keys: ['Mod', 'Shift', 'S'] },
  { id: 'focusInput', label: 'Focus the message box', keys: ['Shift', 'Esc'] },
  { id: 'openSettings', label: 'Open settings', keys: ['Mod', ','] },
  { id: 'showShortcuts', label: 'Show keyboard shortcuts', keys: ['Mod', '/'] },
];

// How a key is shown to the user on this computer.
export const keyLabel = (key) => {
  if (key === 'Mod') return isMac ? '⌘' : 'Ctrl';
  if (key === 'Shift') return isMac ? '⇧' : 'Shift';
  return key;
};

const KEY_CODES = {
  O: ['KeyO'], K: ['KeyK'], L: ['KeyL'], U: ['KeyU'], S: ['KeyS'],
  ',': ['Comma', 'NumpadComma'], '/': ['Slash', 'NumpadDivide'], Esc: ['Escape'],
};

function matches(e, keys) {
  const wantMod = keys.includes('Mod');
  const wantShift = keys.includes('Shift');
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const other = isMac ? e.ctrlKey : e.metaKey;
  if (mod !== wantMod || e.shiftKey !== wantShift || e.altKey || other) return false;
  const main = keys.find((k) => k !== 'Mod' && k !== 'Shift');
  // `code` is layout-independent (Shift changes `key`, e.g. "/" -> "?");
  // `key` covers keyboards whose layout moves the character elsewhere.
  const key = (e.key || '').toLowerCase();
  return KEY_CODES[main].includes(e.code) || key === main.toLowerCase() || (main === 'Esc' && key === 'escape');
}

// Run handlers[id] when its shortcut is pressed. Handlers can change freely.
export function useShortcuts(handlers) {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.repeat || e.isComposing) return;
      const hit = SHORTCUTS.find((s) => matches(e, s.keys));
      const run = hit && ref.current[hit.id];
      if (!run) return;
      e.preventDefault();
      run();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}

