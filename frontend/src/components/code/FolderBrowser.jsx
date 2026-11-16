import React, { useCallback, useEffect, useState } from 'react';
import { ArrowUp, ChevronRight, Folder, FolderOpen, Home, Loader2, X } from 'lucide-react';
import { codeService } from '../../services/api';

// Browse this computer's folders (served by the backend, limited to the
// allowed folders) and open one as a project.
const FolderBrowser = ({ onOpen, onClose }) => {
  const [listing, setListing] = useState(null);
  const [pathInput, setPathInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState(null);

  const go = useCallback(async (path) => {
    setLoading(true);
    setError(null);
    try {
      const next = await codeService.browseFolders(path);
      setListing(next);
      setPathInput(next.path);
    } catch (e) {
      setError(e.message || 'Could not open that folder.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { go(); }, [go]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const open = async (path) => {
    setOpening(true);
    setError(null);
    try {
      onOpen(await codeService.openProject(path));
    } catch (e) {
      setError(e.message || 'Could not open that folder.');
      setOpening(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Open a folder"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-xl border border-gray-700 bg-[#26272e] shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-gray-700/80 px-4 py-3">
          <FolderOpen size={17} className="text-gray-300" />
          <h2 className="text-base font-semibold text-gray-100">Open a folder</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="ml-auto rounded p-1 text-gray-400 hover:bg-white/5">
            <X size={16} />
          </button>
        </div>

        {/* Path box: paste a path or see where you are */}
        <form
          className="flex gap-2 px-4 pt-3"
          onSubmit={(e) => { e.preventDefault(); if (pathInput.trim()) go(pathInput.trim()); }}
        >
          <button type="button" onClick={() => listing?.parent && go(listing.parent)} disabled={!listing?.parent || loading}
            title="Up one folder" aria-label="Up one folder"
            className="rounded-md border border-gray-600 px-2 text-gray-300 hover:bg-white/5 disabled:opacity-40">
            <ArrowUp size={15} />
          </button>
          <input
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            spellCheck={false}
            aria-label="Folder path"
            placeholder="~/projects/my-app"
            className="min-w-0 flex-1 rounded-md border border-gray-600 bg-[#1a1b1e] px-2.5 py-1.5 font-mono text-xs text-gray-100 outline-none focus:border-gray-400"
          />
          <button type="submit" className="rounded-md border border-gray-600 px-2.5 text-xs text-gray-200 hover:bg-white/5">Go</button>
        </form>

        {listing?.roots?.length > 1 && (
          <div className="flex flex-wrap gap-1.5 px-4 pt-2">
            {listing.roots.map((root) => (
              <button key={root} type="button" onClick={() => go(root)}
                className="flex items-center gap-1 rounded-md bg-black/20 px-2 py-1 text-xs text-gray-300 hover:bg-black/30">
                <Home size={12} /> {root.split(/[\\/]/).filter(Boolean).pop() || root}
              </button>
            ))}
          </div>
        )}

        <div className="thin-scroll mt-2 min-h-[12rem] flex-1 overflow-y-auto px-2">
          {loading ? (
            <div className="flex justify-center py-8"><Loader2 className="animate-spin text-gray-400" size={18} /></div>
          ) : listing?.entries?.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-gray-500">No folders here</p>
          ) : (
            <ul>
              {listing?.entries?.map((entry) => (
                <li key={entry.path}>
                  <button type="button" onClick={() => go(entry.path)} onDoubleClick={() => open(entry.path)}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-gray-200 hover:bg-gray-700/70">
                    <Folder size={15} className="shrink-0 text-gray-400" />
                    <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                    <ChevronRight size={14} className="shrink-0 text-gray-500" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {error && <p role="alert" className="px-4 pt-2 text-sm text-red-300">{error}</p>}

        <div className="flex items-center gap-2 border-t border-gray-700/80 px-4 py-3">
          <span className="min-w-0 flex-1 truncate text-xs text-gray-400" title={listing?.path}>
            {listing && !listing.can_open ? 'Open a folder inside this one' : listing?.path}
          </span>
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-gray-300 hover:bg-white/5">
            Cancel
          </button>
          <button type="button" onClick={() => listing && open(listing.path)} disabled={!listing?.can_open || opening || loading}
            className="flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50">
            {opening && <Loader2 size={14} className="animate-spin" />}
            Open this folder
          </button>
        </div>
      </div>
    </div>
  );
};

export default FolderBrowser;
