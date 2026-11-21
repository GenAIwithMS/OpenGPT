import React, { useEffect, useState } from 'react';
import { Check, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react';
import { Row, Toggle, inputClass } from './controls';
import { settingsService } from '../../services/api';

// One saved memory: its text, with edit and delete.
const MemoryItem = ({ item, maxChars, onSaved, onDeleted }) => {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(item.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSaved(await settingsService.updateMemory(item.id, text));
      setEditing(false);
    } catch (err) { setError(err.message); }
    setBusy(false);
  };

  const remove = async () => {
    setBusy(true);
    try { await settingsService.removeMemory(item.id); onDeleted(item.id); } catch (err) { setError(err.message); setBusy(false); }
  };

  if (editing) {
    return (
      <li className="py-2.5">
        <form onSubmit={save} className="flex items-start gap-2">
          <label htmlFor={`mem-${item.id}`} className="sr-only">Memory</label>
          <textarea id={`mem-${item.id}`} value={text} onChange={(e) => setText(e.target.value)} maxLength={maxChars}
            rows={2} autoFocus className={`${inputClass} thin-scroll resize-y`} />
          <button type="submit" disabled={busy || !text.trim()} aria-label="Save memory"
            className="rounded-lg p-2 text-gray-300 hover:bg-white/5 hover:text-white disabled:opacity-50">
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
          </button>
          <button type="button" onClick={() => { setEditing(false); setText(item.text); setError(null); }} aria-label="Cancel"
            className="rounded-lg p-2 text-gray-400 hover:bg-white/5 hover:text-white"><X size={15} /></button>
        </form>
        {error && <p role="alert" className="mt-1 text-xs text-red-300">{error}</p>}
      </li>
    );
  }
  return (
    <li className="group flex items-start gap-2 py-2.5">
      <p className="min-w-0 flex-1 break-words text-sm text-gray-200">{item.text}</p>
      <button type="button" onClick={() => setEditing(true)} aria-label={`Edit memory: ${item.text}`}
        className="rounded-lg p-1.5 text-gray-400 hover:bg-white/5 hover:text-white"><Pencil size={14} /></button>
      <button type="button" onClick={remove} disabled={busy} aria-label={`Delete memory: ${item.text}`}
        className="rounded-lg p-1.5 text-gray-400 hover:bg-white/5 hover:text-red-300 disabled:opacity-50"><Trash2 size={14} /></button>
      {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
    </li>
  );
};

/**
 * Settings > Personalization > Memory: the two switches (saved memories,
 * chat history) and the list of saved memories (add, edit, delete, delete all).
 *
 * @param {object} props
 * @param {object} props.settings  All settings from `useSettings` (uses `settings.memory`).
 * @param {(changes: object) => Promise} props.save  Save a partial update, e.g. `{memory: {enabled: false}}`.
 */
const MemoryTab = ({ settings, save }) => {
  const switches = settings?.memory || { enabled: true, chat_history: true };
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(false);
  const [newText, setNewText] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);

  const load = () => settingsService.listMemories().then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const toggle = (key) => async (value) => {
    setError(null);
    try { await save({ memory: { [key]: value } }); } catch (e) { setError(e.message || 'Could not save.'); }
  };

  const add = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      const item = await settingsService.addMemory(newText);
      setData((d) => ({ ...d, memories: [item, ...d.memories.filter((m) => m.id !== item.id)] }));
      setNewText('');
      setAdding(false);
    } catch (err) { setError(err.message); }
  };

  const clearAll = async () => {
    setConfirmClear(false);
    setError(null);
    try { await settingsService.clearMemories(); setData((d) => ({ ...d, memories: [] })); } catch (e) { setError(e.message); }
  };

  const memories = data?.memories || [];
  return (
    <div>
      <div className="divide-y divide-gray-700/50">
        <Row label="Saved memories"
          description="The assistant saves short facts you share, like your work or preferences, and uses them in every chat.">
          <Toggle checked={switches.enabled} onChange={toggle('enabled')} label="Saved memories" />
        </Row>
        <Row label="Reference chat history"
          description="The assistant can search your other chats, and the files attached to them, when you refer to them.">
          <Toggle checked={switches.chat_history} onChange={toggle('chat_history')} label="Reference chat history" />
        </Row>
      </div>

      <div className="mt-6 flex items-center gap-3">
        <h4 className="flex-1 text-sm font-medium text-gray-200">
          Saved memories{data ? <span className="font-normal text-gray-500"> · {memories.length} of {data.max}</span> : null}
        </h4>
        <button type="button" onClick={() => setAdding(true)}
          className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-gray-300 hover:bg-white/5 hover:text-white">
          <Plus size={13} /> Add
        </button>
        {memories.length > 0 && (confirmClear ? (
          <span className="flex items-center gap-2 text-xs">
            <span className="text-gray-400">Delete all?</span>
            <button type="button" onClick={clearAll} className="text-red-300 hover:text-red-200">Delete all</button>
            <button type="button" onClick={() => setConfirmClear(false)} className="text-gray-400 hover:text-gray-200">Cancel</button>
          </span>
        ) : (
          <button type="button" onClick={() => setConfirmClear(true)}
            className="rounded-lg px-2 py-1 text-xs text-gray-400 hover:bg-white/5 hover:text-red-300">Delete all</button>
        ))}
      </div>

      {adding && (
        <form onSubmit={add} className="mt-3 flex items-start gap-2">
          <label htmlFor="new-memory" className="sr-only">New memory</label>
          <textarea id="new-memory" value={newText} onChange={(e) => setNewText(e.target.value)} rows={2} autoFocus
            maxLength={data?.max_chars || 300} placeholder="Prefers short answers with code examples"
            className={`${inputClass} thin-scroll resize-y`} />
          <button type="submit" disabled={!newText.trim()}
            className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50">Save</button>
          <button type="button" onClick={() => { setAdding(false); setNewText(''); }} aria-label="Cancel"
            className="rounded-lg p-2 text-gray-400 hover:bg-white/5 hover:text-white"><X size={15} /></button>
        </form>
      )}

      {error && <p role="alert" className="mt-3 text-sm text-red-300">{error}</p>}
      {!data && !error && <Loader2 className="mt-4 animate-spin text-gray-400" size={18} />}
      {data && memories.length === 0 && !adding && (
        <p className="mt-3 rounded-xl border border-gray-700/70 p-4 text-sm text-gray-400">
          No saved memories yet. Tell the assistant about yourself, or say "remember that…", and it saves it here.
        </p>
      )}
      {memories.length > 0 && (
        <ul className="mt-2 divide-y divide-gray-700/50">
          {memories.map((m) => (
            <MemoryItem key={m.id} item={m} maxChars={data.max_chars}
              onSaved={(saved) => setData((d) => ({ ...d, memories: d.memories.map((x) => (x.id === saved.id ? saved : x)) }))}
              onDeleted={(id) => setData((d) => ({ ...d, memories: d.memories.filter((x) => x.id !== id) }))} />
          ))}
        </ul>
      )}

      <p className="mt-4 text-xs leading-relaxed text-gray-500">
        Temporary chats never use or change memory. Deleting a chat doesn't delete the memories saved in it.
        Turning saved memories off keeps the list; the assistant just stops using and adding to it.
      </p>
    </div>
  );
};

export default MemoryTab;
