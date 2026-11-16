import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Folder, FolderPlus, Loader2, ShieldCheck, Trash2, X } from 'lucide-react';
import { codeService } from '../../services/api';

// Saved "always" approvals of a project, with Revoke.
const SavedApprovals = ({ project, onClose }) => {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    codeService.getSavedApprovals(project).then(setItems).catch((e) => setError(e.message));
  }, [project]);

  const revoke = async (id) => {
    try {
      await codeService.revokeSavedApproval(project, id);
      setItems((list) => list.filter((a) => a.id !== id));
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4" onClick={onClose}>
      <div role="dialog" aria-label="Saved approvals" onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-xl border border-gray-700 bg-[#26272e] p-4 shadow-2xl">
        <div className="mb-3 flex items-center gap-2">
          <ShieldCheck size={17} className="text-gray-300" />
          <h2 className="text-base font-semibold text-gray-100">Always allowed in {project}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="ml-auto rounded p-1 text-gray-400 hover:bg-white/5">
            <X size={16} />
          </button>
        </div>
        {error && <p className="mb-2 text-sm text-red-300">{error}</p>}
        {items === null && !error && <Loader2 size={18} className="animate-spin text-gray-400" />}
        {items?.length === 0 && <p className="text-sm text-gray-400">Nothing yet. The agent asks before each action.</p>}
        <ul className="space-y-1.5">
          {items?.map((a) => (
            <li key={a.id} className="flex items-center gap-2 rounded-md bg-black/20 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 text-gray-200">{a.allows}</span>
              <button type="button" onClick={() => revoke(a.id)} title="Revoke"
                className="flex items-center gap-1 rounded px-2 py-1 text-xs text-red-300 hover:bg-red-500/10">
                <Trash2 size={13} /> Revoke
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};

// Pick the project the agent works in, or create one.
const ProjectPicker = ({ projects, value, onChange, onCreated, disabled }) => {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState(null);
  const [showSaved, setShowSaved] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const create = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setError(null);
    try {
      const project = await codeService.createProject(name.trim());
      setName('');
      setCreating(false);
      setOpen(false);
      onCreated(project.name);
    } catch (err) {
      setError(err.message || 'Could not create the project.');
    }
  };

  return (
    <div ref={ref} className="relative">
      <button type="button" disabled={disabled} onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}
        className="flex max-w-[14rem] items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-gray-300 hover:bg-gray-700/70 hover:text-white disabled:opacity-60">
        <Folder size={15} className="shrink-0" />
        <span className="truncate">{value || 'Choose a project'}</span>
        <ChevronDown size={14} className="shrink-0" />
      </button>

      {open && (
        <div role="menu" className="absolute left-0 top-full z-40 mt-1 w-64 rounded-xl border border-gray-700/80 bg-[#2a2b32] p-1 shadow-2xl shadow-black/40">
          <div className="thin-scroll max-h-64 overflow-y-auto">
            {projects.length === 0 && <p className="px-3 py-2 text-xs text-gray-500">No projects yet</p>}
            {projects.map((p) => (
              <button key={p.name} type="button" role="menuitem"
                onClick={() => { onChange(p.name); setOpen(false); }}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-gray-200 hover:bg-gray-700">
                <Folder size={14} className="shrink-0 text-gray-400" />
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                {p.name === value && <Check size={14} className="text-gray-300" />}
              </button>
            ))}
          </div>
          <div className="mt-1 border-t border-gray-700/80 pt-1">
            {creating ? (
              <form onSubmit={create} className="p-2">
                <input autoFocus value={name} maxLength={64} onChange={(e) => setName(e.target.value)}
                  placeholder="Project name" aria-label="New project name"
                  className="w-full rounded-md border border-gray-600 bg-[#1a1b1e] px-2.5 py-1.5 text-sm text-gray-100 outline-none focus:border-gray-400" />
                {error && <p className="mt-1.5 text-xs text-red-300">{error}</p>}
                <div className="mt-2 flex justify-end gap-2">
                  <button type="button" onClick={() => { setCreating(false); setError(null); }}
                    className="rounded-md px-2.5 py-1 text-xs text-gray-300 hover:bg-white/5">Cancel</button>
                  <button type="submit" className="rounded-md bg-blue-600 px-2.5 py-1 text-xs text-white hover:bg-blue-500">Create</button>
                </div>
              </form>
            ) : (
              <button type="button" role="menuitem" onClick={() => setCreating(true)}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-gray-200 hover:bg-gray-700">
                <FolderPlus size={14} className="text-gray-400" /> New project
              </button>
            )}
            {value && !creating && (
              <button type="button" role="menuitem" onClick={() => { setShowSaved(true); setOpen(false); }}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-gray-200 hover:bg-gray-700">
                <ShieldCheck size={14} className="text-gray-400" /> Always-allowed actions
              </button>
            )}
          </div>
        </div>
      )}
      {showSaved && value && <SavedApprovals project={value} onClose={() => setShowSaved(false)} />}
    </div>
  );
};

export default ProjectPicker;
