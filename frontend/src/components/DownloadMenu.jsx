import React, { useEffect, useRef, useState } from 'react';
import { Download, FileCode, FileText, FileType, Loader2 } from 'lucide-react';
import { downloadReport } from '../lib/exportReport';

const FORMATS = [
  { key: 'pdf', label: 'PDF', icon: FileType },
  { key: 'md', label: 'Markdown', icon: FileCode },
  { key: 'txt', label: 'Plain text', icon: FileText },
];

// Download icon with a small menu to save a report as PDF, Markdown or text.
// `placement` says whether the menu opens above ("up") or below ("down").
const DownloadMenu = ({ content, placement = 'up', buttonClassName = '' }) => {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(null);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e) => {
      if (!rootRef.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const handleDownload = async (format) => {
    setBusy(format);
    try {
      await downloadReport(content, format);
      setOpen(false);
    } catch (err) {
      console.error('Download failed:', err);
      alert('Could not create the file. Please try again.');
    } finally {
      setBusy(null);
    }
  };

  return (
    // Clicks stay inside so a surrounding clickable card is not triggered
    <div ref={rootRef} className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Download report"
        title="Download"
        className={`flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-white/10 hover:text-gray-100 ${open ? 'bg-white/10 text-gray-100' : ''} ${buttonClassName}`}
      >
        <Download size={16} />
      </button>

      {open && (
        <div
          role="menu"
          className={`absolute right-0 z-50 w-40 rounded-xl border border-gray-700/80 bg-[#2a2b32] p-1 shadow-2xl shadow-black/40 ${
            placement === 'down' ? 'top-full mt-2' : 'bottom-full mb-2'
          }`}
        >
          {FORMATS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              role="menuitem"
              disabled={busy !== null}
              onClick={() => handleDownload(key)}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm text-gray-100 transition-colors hover:bg-gray-700/70 disabled:opacity-60"
            >
              {busy === key ? (
                <Loader2 size={16} className="shrink-0 animate-spin text-gray-400" />
              ) : (
                <Icon size={16} className="shrink-0 text-gray-400" />
              )}
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default DownloadMenu;
