import { useSyncExternalStore } from 'react';

// The General settings, shared app-wide (notifications, new chats). Loaded
// from the backend by useSettings; components read them here.
let current = {
  temporary_by_default: false,
  notify_on_finish: false,
  sound_on_finish: false,
};
const listeners = new Set();

export const getPreferences = () => current;

export function setPreferences(changes) {
  current = { ...current, ...changes };
  listeners.forEach((listener) => listener());
}

const subscribe = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function usePreferences() {
  return useSyncExternalStore(subscribe, getPreferences);
}

// Enter sends; Shift+Enter makes a new line. Enter while an IME is composing
// confirms the text instead of sending.
export function isSendKey(e) {
  if (e.key !== 'Enter' || e.nativeEvent?.isComposing || e.keyCode === 229) return false;
  return !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey;
}

export const SEND_HINT = 'Press Enter to send, Shift+Enter for new line';
