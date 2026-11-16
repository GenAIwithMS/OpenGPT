import { useCallback, useEffect, useState } from 'react';
import { settingsService } from '../services/api';
import { setPreferences } from '../lib/preferences';

const DEFAULT_NAME = 'Muhammad';

// App settings from the backend. Saving updates the UI at once and rolls
// back if the backend refuses.
export function useSettings() {
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    settingsService.get()
      .then((s) => { setSettings(s); setPreferences(s.general); })
      .catch((e) => setError(e.message || 'Could not load settings.'));
  }, []);

  const save = useCallback(async (changes) => {
    const before = settings;
    // Optimistic update
    setSettings((s) => (s ? Object.fromEntries(Object.entries(s).map(([k, v]) => (
      changes[k] ? [k, { ...v, ...changes[k] }] : [k, v]
    ))) : s));
    if (changes.general) setPreferences(changes.general);
    try {
      const saved = await settingsService.update(changes);
      setSettings(saved);
      setPreferences(saved.general);
      setError(null);
      return saved;
    } catch (e) {
      setSettings(before);
      if (before) setPreferences(before.general);
      setError(e.message || 'Could not save settings.');
      throw e;
    }
  }, [settings]);

  return {
    settings,
    displayName: settings?.display_name || DEFAULT_NAME,
    error,
    save,
  };
}
