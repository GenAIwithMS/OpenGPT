// The model picked in the menu next to the send button, one per page
// ('chat' or 'code'). 'auto' (the default) lets the backend pick a model for
// each message (backend/app/services/model_router.py). Remembered in this
// browser only.
import { useEffect, useState } from 'react';

export const AUTO = 'auto';
const KEY = (page) => `opengpt.model.${page}`;
const listeners = new Set();

export function getModelChoice(page) {
  try {
    return localStorage.getItem(KEY(page)) || AUTO;
  } catch {
    return AUTO;
  }
}

export function setModelChoice(page, model) {
  try {
    if (!model || model === AUTO) localStorage.removeItem(KEY(page));
    else localStorage.setItem(KEY(page), model);
  } catch { /* private mode: the choice lasts until reload */ }
  listeners.forEach((fn) => fn(page));
}

export function useModelChoice(page) {
  const [value, setValue] = useState(() => getModelChoice(page));
  useEffect(() => {
    const onChange = (changed) => { if (changed === page) setValue(getModelChoice(page)); };
    listeners.add(onChange);
    return () => listeners.delete(onChange);
  }, [page]);
  return [value, (model) => setModelChoice(page, model)];
}
