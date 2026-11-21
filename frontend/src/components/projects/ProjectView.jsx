import React, { useEffect, useRef, useState } from 'react';
import { Check, FileText, FolderOpen, Loader2, MessageSquare, MoreVertical, Pencil, Plus, Trash2, Upload, X } from 'lucide-react';
import MessageInput from '../MessageInput';
import { Modal, inputClass } from '../settings/controls';
import { projectService } from '../../services/api';

const formatDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : `${iso}Z`);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

// Edit the project's instructions.
const InstructionsDialog = ({ project, onClose, onSaved }) => {
  const [text, setText] = useState(project.instructions || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSaved(await projectService.update(project.id, { instructions: text }));
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal title="Project instructions" onClose={onClose}>
      <form onSubmit={save} className="space-y-3">
        <p className="text-sm text-gray-400">
          How the assistant should answer in this project&apos;s chats: tone, format, what to focus on. They are
          added to your custom instructions and win where the two disagree.
        </p>
        <label htmlFor="project-instructions" className="sr-only">Instructions</label>
        <textarea id="project-instructions" value={text} onChange={(e) => setText(e.target.value)} rows={10}
          maxLength={8000} autoFocus placeholder="Answer as a senior reviewer. Keep replies short and cite the spec."
          className={`${inputClass} thin-scroll resize-y`} />
        {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose}
            className="rounded-lg px-3 py-2 text-sm text-gray-300 hover:bg-white/5">Cancel</button>
          <button type="submit" disabled={busy}
            className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50">
            {busy && <Loader2 size={14} className="animate-spin" />} Save
          </button>
        </div>
      </form>
    </Modal>
  );
};

/**
 * A project's page (`/project/<id>`): its name, a message box that starts a
 * new chat in the project, its instructions and files, and its chats.
 *
 * @param {object} props
 * @param {string} props.projectId
 * @param {(text: string, tools: string[], attachments: object[]) => Promise<boolean>} props.onSendMessage
 *   Start a chat in this project with the first message.
 * @param {(file: File) => void} props.onAddAttachment
 * @param {(id: string) => void} props.onRemoveAttachment
 * @param {object[]} props.pendingAttachments
 * @param {boolean} props.uploadingAttachment
 * @param {boolean} props.disabled
 * @param {(threadId: string) => void} props.onOpenChat
 * @param {() => void} props.onChanged  The project was renamed or changed (refresh the sidebar).
 * @param {(project: object) => void} props.onDelete  Ask to delete the project.
 * @param {number} [props.refreshKey]  Bumped when the project's chats change elsewhere.
 * @param {'newChat'} [props.action]  Put the cursor in the message box.
 * @param {string} [props.actionKey]  Changes with each request, so the same action can repeat.
 */
const ProjectView = ({
  projectId,
  onSendMessage,
  onAddAttachment,
  onRemoveAttachment,
  pendingAttachments,
  uploadingAttachment,
  disabled,
  onOpenChat,
  onChanged,
  onDelete,
  refreshKey = 0,
  action = null,
  actionKey = null,
}) => {
  const [project, setProject] = useState(null);
  const [error, setError] = useState(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [editingInstructions, setEditingInstructions] = useState(false);
  const [uploading, setUploading] = useState(null);
  const [fileError, setFileError] = useState(null);
  const fileInputRef = useRef(null);
  const composerRef = useRef(null);
  const handledActionRef = useRef(null);

  // The sidebar's new chat button.
  useEffect(() => {
    if (!action || !project || handledActionRef.current === actionKey) return;
    handledActionRef.current = actionKey;
    if (action === 'newChat') composerRef.current?.querySelector('textarea')?.focus();
  }, [action, actionKey, project]);

  const load = () => projectService.get(projectId)
    .then((p) => { setProject(p); setError(null); })
    .catch((e) => setError(e.message));

  useEffect(() => {
    setProject(null);
    setRenaming(false);
    setFileError(null);
    load();
  }, [projectId, refreshKey]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const close = (e) => { if (!e.target.closest('[data-project-menu]')) setMenuOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  const saveName = async () => {
    const next = name.trim();
    setRenaming(false);
    if (!next || next === project.name) return;
    try {
      const saved = await projectService.update(project.id, { name: next });
      setProject((p) => ({ ...p, ...saved }));
      onChanged();
    } catch (e) {
      setError(e.message);
    }
  };

  const upload = async (files) => {
    setFileError(null);
    for (const file of files) {
      setUploading(file.name);
      try {
        await projectService.addFile(project.id, file);
      } catch (e) {
        setFileError(`${file.name}: ${e.message || 'could not be added'}`);
        break;
      }
    }
    setUploading(null);
    load();
  };

  const removeFile = async (fileId) => {
    setFileError(null);
    try {
      await projectService.removeFile(project.id, fileId);
      setProject((p) => ({ ...p, files: p.files.filter((f) => f.id !== fileId) }));
    } catch (e) {
      setFileError(e.message);
    }
  };

  if (error && !project) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center">
        <p role="alert" className="text-sm text-gray-400">{error}</p>
      </div>
    );
  }
  if (!project) {
    return <div className="flex flex-1 items-center justify-center"><Loader2 className="animate-spin text-gray-400" /></div>;
  }

  const full = project.files.length >= project.max_files;

  return (
    <div className="thin-scroll flex-1 overflow-y-auto px-4 pb-10">
      <div className="mx-auto w-full max-w-3xl pt-6 lg:pt-12">
        {/* Name and menu */}
        <div className="mb-5 flex items-center gap-3">
          <FolderOpen size={26} className="shrink-0 text-gray-300" aria-hidden="true" />
          {renaming ? (
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoFocus
              aria-label="Project name" onBlur={saveName}
              onKeyDown={(e) => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') setRenaming(false); }}
              className="min-w-0 flex-1 rounded-lg bg-gray-700 px-2 py-1 text-2xl font-semibold text-white outline-none focus:ring-2 focus:ring-blue-500" />
          ) : (
            <h1 className="min-w-0 flex-1 truncate text-2xl font-semibold text-gray-100">{project.name}</h1>
          )}
          <div className="relative" data-project-menu>
            <button type="button" onClick={() => setMenuOpen((o) => !o)} aria-label="Project options"
              className="rounded-lg p-2 text-gray-300 hover:bg-gray-700/70 hover:text-white">
              <MoreVertical size={18} />
            </button>
            {menuOpen && (
              <div className="animate-menu-in absolute right-0 top-full z-30 mt-1 w-44 origin-top-right rounded-xl border border-gray-700/70 bg-gray-800 py-1 shadow-xl shadow-black/40">
                <button type="button" onClick={() => { setMenuOpen(false); setName(project.name); setRenaming(true); }}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-gray-200 hover:bg-gray-700">
                  <Pencil size={14} /> Rename
                </button>
                <button type="button" onClick={() => { setMenuOpen(false); setEditingInstructions(true); }}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-gray-200 hover:bg-gray-700">
                  <FileText size={14} /> Edit instructions
                </button>
                <button type="button" onClick={() => { setMenuOpen(false); onDelete(project); }}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-red-400 hover:bg-gray-700">
                  <Trash2 size={14} /> Delete project
                </button>
              </div>
            )}
          </div>
        </div>
        {error && <p role="alert" className="mb-3 text-sm text-red-300">{error}</p>}

        {/* New chat in this project */}
        <div ref={composerRef}>
        <MessageInput
          onSendMessage={onSendMessage}
          onAddAttachment={onAddAttachment}
          onRemoveAttachment={onRemoveAttachment}
          onStop={() => {}}
          disabled={disabled}
          pendingAttachments={pendingAttachments}
          uploadingAttachment={uploadingAttachment}
          placeholder={`New chat in ${project.name}`}
        />
        </div>

        {/* Instructions and files */}
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <section className="rounded-xl border border-gray-700/70 p-4">
            <div className="mb-2 flex items-center">
              <h2 className="flex-1 text-sm font-medium text-gray-200">Instructions</h2>
              <button type="button" onClick={() => setEditingInstructions(true)}
                aria-label={project.instructions ? 'Edit instructions' : 'Add instructions'}
                className="rounded-lg p-1.5 text-gray-400 hover:bg-white/5 hover:text-white">
                {project.instructions ? <Pencil size={14} /> : <Plus size={15} />}
              </button>
            </div>
            {project.instructions ? (
              <p className="line-clamp-4 whitespace-pre-wrap break-words text-sm text-gray-400">{project.instructions}</p>
            ) : (
              <p className="text-sm text-gray-500">Tell the assistant how to answer in this project.</p>
            )}
          </section>

          <section className="rounded-xl border border-gray-700/70 p-4">
            <div className="mb-2 flex items-center">
              <h2 className="flex-1 text-sm font-medium text-gray-200">
                Files <span className="font-normal text-gray-500">· {project.files.length}/{project.max_files}</span>
              </h2>
              <button type="button" onClick={() => fileInputRef.current?.click()} disabled={Boolean(uploading) || full}
                aria-label="Add files" title={full ? 'The project is full' : 'Add files'}
                className="rounded-lg p-1.5 text-gray-400 hover:bg-white/5 hover:text-white disabled:opacity-50">
                {uploading ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
              </button>
              <input ref={fileInputRef} type="file" accept=".pdf,.md,.txt" multiple className="hidden"
                onChange={(e) => { const files = [...e.target.files]; e.target.value = ''; if (files.length) upload(files); }} />
            </div>
            {uploading && <p className="mb-1 truncate text-xs text-gray-400">Adding {uploading}…</p>}
            {fileError && <p role="alert" className="mb-1 text-xs text-red-300">{fileError}</p>}
            {project.files.length ? (
              <ul className="thin-scroll max-h-40 space-y-0.5 overflow-y-auto">
                {project.files.map((f) => (
                  <li key={f.id} className="group flex items-center gap-2 rounded-lg py-1 text-sm text-gray-300">
                    <FileText size={14} className="shrink-0 text-gray-500" />
                    <span className="min-w-0 flex-1 truncate">{f.filename}</span>
                    <button type="button" onClick={() => removeFile(f.id)} aria-label={`Remove ${f.filename}`}
                      className="rounded p-1 text-gray-500 opacity-0 hover:text-red-300 focus:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                      <X size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-gray-500">
                PDF, Markdown or text, up to {project.max_mb} MB each. Every chat in the project can use them.
              </p>
            )}
          </section>
        </div>

        {/* Chats */}
        <h2 className="mb-1 mt-8 text-sm font-medium text-gray-300">Chats</h2>
        {project.threads.length ? (
          <ul className="divide-y divide-gray-700/50">
            {project.threads.map((t) => (
              <li key={t.thread_id}>
                <button type="button" onClick={() => onOpenChat(t.thread_id)}
                  className="flex w-full items-center gap-3 rounded-lg px-2 py-3 text-left hover:bg-gray-700/40">
                  <MessageSquare size={15} className="shrink-0 text-gray-500" />
                  <span className="min-w-0 flex-1 truncate text-sm text-gray-100">{t.title || 'New Chat'}</span>
                  <span className="shrink-0 text-xs text-gray-500">{formatDate(t.updated_at)}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-3 text-sm text-gray-500">
            Chats you start here appear here. You can also move a chat into this project from its menu in the sidebar.
          </p>
        )}
      </div>

      {editingInstructions && (
        <InstructionsDialog project={project} onClose={() => setEditingInstructions(false)}
          onSaved={(saved) => setProject((p) => ({ ...p, ...saved }))} />
      )}
    </div>
  );
};

export default ProjectView;

/**
 * Project settings, opened from the sidebar without leaving the current page:
 * the project's instructions and files.
 *
 * @param {object} props
 * @param {string} props.projectId
 * @param {() => void} props.onClose
 * @param {() => void} props.onChanged  The instructions or files changed (refresh the sidebar and page).
 */
export const ProjectSettingsDialog = ({ projectId, onClose, onChanged }) => {
  const [project, setProject] = useState(null);
  const [text, setText] = useState('');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(null);
  const [fileError, setFileError] = useState(null);
  const fileInputRef = useRef(null);

  const load = () => projectService.get(projectId)
    .then((p) => { setProject(p); setError(null); return p; })
    .catch((e) => setError(e.message));

  useEffect(() => {
    load().then((p) => { if (p) setText(p.instructions || ''); });
  }, [projectId]);

  const saveInstructions = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const next = await projectService.update(projectId, { instructions: text });
      setProject((p) => ({ ...p, ...next }));
      setSaved(true);
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const upload = async (files) => {
    setFileError(null);
    for (const file of files) {
      setUploading(file.name);
      try {
        await projectService.addFile(projectId, file);
      } catch (e) {
        setFileError(`${file.name}: ${e.message || 'could not be added'}`);
        break;
      }
    }
    setUploading(null);
    await load();
    onChanged();
  };

  const removeFile = async (fileId) => {
    setFileError(null);
    try {
      await projectService.removeFile(projectId, fileId);
      setProject((p) => ({ ...p, files: p.files.filter((f) => f.id !== fileId) }));
      onChanged();
    } catch (e) {
      setFileError(e.message);
    }
  };

  const full = project ? project.files.length >= project.max_files : false;
  const changed = project ? text !== (project.instructions || '') : false;

  return (
    <Modal title={project ? `${project.name}: settings` : 'Project settings'} onClose={onClose}>
      {!project ? (
        error
          ? <p role="alert" className="text-sm text-red-300">{error}</p>
          : <div className="flex justify-center py-8"><Loader2 size={20} className="animate-spin text-gray-400" /></div>
      ) : (
        <div className="space-y-6">
          <form onSubmit={saveInstructions} className="space-y-2">
            <label htmlFor="project-settings-instructions" className="block text-sm font-medium text-gray-200">
              Instructions
            </label>
            <p className="text-sm text-gray-400">
              How the assistant should answer in this project&apos;s chats. They are added to your custom
              instructions and win where the two disagree.
            </p>
            <textarea id="project-settings-instructions" value={text} rows={7} maxLength={8000}
              onChange={(e) => { setText(e.target.value); setSaved(false); }}
              placeholder="Answer as a senior reviewer. Keep replies short and cite the spec."
              className={`${inputClass} thin-scroll resize-y`} />
            {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
            <div className="flex items-center justify-end gap-3">
              {saved && !changed && <span className="text-sm text-gray-400">Saved</span>}
              <button type="submit" disabled={saving || !changed}
                className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50">
                {saving && <Loader2 size={14} className="animate-spin" />} Save
              </button>
            </div>
          </form>

          <section>
            <h3 className="mb-2 text-sm font-medium text-gray-200">
              Files <span className="font-normal text-gray-500">· {project.files.length}/{project.max_files}</span>
            </h3>
            {/* The whole box adds files: click it, or drop files on it. */}
            <button type="button" onClick={() => fileInputRef.current?.click()} disabled={Boolean(uploading) || full}
              onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDragging(false);
                const files = [...e.dataTransfer.files];
                if (files.length && !uploading && !full) upload(files);
              }}
              className={`mb-2 flex w-full flex-col items-center gap-1 rounded-xl border border-dashed px-4 py-5 text-center transition-colors
                disabled:cursor-not-allowed disabled:opacity-60
                ${dragging ? 'border-blue-400 bg-blue-500/10' : 'border-gray-600 hover:border-gray-400 hover:bg-white/5'}`}>
              {uploading ? <Loader2 size={18} className="animate-spin text-gray-300" /> : <Upload size={18} className="text-gray-300" />}
              <span className="text-sm font-medium text-gray-200">
                {full ? 'The project is full' : uploading ? `Adding ${uploading}…` : 'Add files'}
              </span>
              <span className="text-xs text-gray-400">
                Click or drop files here. PDF, Markdown or text, up to {project.max_mb} MB each. Every chat in the project can use them.
              </span>
            </button>
            <input ref={fileInputRef} type="file" accept=".pdf,.md,.txt" multiple className="hidden"
              onChange={(e) => { const files = [...e.target.files]; e.target.value = ''; if (files.length) upload(files); }} />
            {fileError && <p role="alert" className="mb-1 text-xs text-red-300">{fileError}</p>}
            {project.files.length ? (
              <ul className="space-y-0.5">
                {project.files.map((f) => (
                  <li key={f.id} className="group flex items-center gap-2 rounded-lg px-1 py-1 text-sm text-gray-300 hover:bg-white/5">
                    <FileText size={14} className="shrink-0 text-gray-500" />
                    <span className="min-w-0 flex-1 truncate">{f.filename}</span>
                    <button type="button" onClick={() => removeFile(f.id)} aria-label={`Remove ${f.filename}`}
                      className="rounded p-1 text-gray-500 opacity-0 hover:text-red-300 focus:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                      <X size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-gray-500">No files yet.</p>
            )}
          </section>
        </div>
      )}
    </Modal>
  );
};

/**
 * Ask for a new project's name.
 *
 * @param {object} props
 * @param {() => void} props.onClose
 * @param {(name: string) => Promise} props.onCreate
 */
export const NewProjectDialog = ({ onClose, onCreate }) => {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onCreate(name);
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal title="New project" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <p className="text-sm text-gray-400">
          A project keeps related chats together, with instructions and files they all use.
        </p>
        <label htmlFor="new-project-name" className="block text-sm text-gray-300">Name</label>
        <input id="new-project-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100}
          autoFocus placeholder="Thesis research" className={inputClass} />
        {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose}
            className="rounded-lg px-3 py-2 text-sm text-gray-300 hover:bg-white/5">Cancel</button>
          <button type="submit" disabled={busy || !name.trim()}
            className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Create project
          </button>
        </div>
      </form>
    </Modal>
  );
};
