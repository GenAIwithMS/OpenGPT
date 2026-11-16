import React, { useState } from 'react';
import {
  Check,
  ChevronRight,
  FilePen,
  FileText,
  Globe,
  Loader2,
  Search,
  TerminalSquare,
  Wrench,
  X,
} from 'lucide-react';

// What a tool call is about, in one line: the command, file, pattern or URL.
export function toolSummary(name, input = {}) {
  const pick = (...keys) => keys.map((k) => input[k]).find((v) => typeof v === 'string' && v.trim());
  switch (name) {
    case 'shell':
    case 'bash':
      return { icon: TerminalSquare, label: 'Ran a command', detail: pick('command', 'cmd') };
    case 'edit':
    case 'write':
    case 'patch':
    case 'apply_patch':
      return { icon: FilePen, label: name === 'write' ? 'Wrote a file' : 'Edited a file', detail: pick('filePath', 'path', 'file') };
    case 'read':
      return { icon: FileText, label: 'Read a file', detail: pick('filePath', 'path', 'file') };
    case 'grep':
    case 'glob':
    case 'list':
      return { icon: Search, label: 'Searched the project', detail: pick('pattern', 'query', 'path') };
    case 'webfetch':
    case 'websearch':
      return { icon: Globe, label: name === 'webfetch' ? 'Opened a web page' : 'Searched the web', detail: pick('url', 'query') };
    default:
      return { icon: Wrench, label: name ? `Used ${name}` : 'Used a tool', detail: pick('command', 'path', 'query', 'url') };
  }
}

const statusIcon = {
  running: <Loader2 size={14} className="animate-spin text-blue-400" aria-label="Running" />,
  streaming: <Loader2 size={14} className="animate-spin text-blue-400" aria-label="Running" />,
  completed: <Check size={14} className="text-green-400" aria-label="Done" />,
  error: <X size={14} className="text-red-400" aria-label="Failed" />,
};

const ToolCard = ({ part }) => {
  const [open, setOpen] = useState(false);
  const { icon: Icon, label, detail } = toolSummary(part.name, part.input);
  const hasBody = Boolean(part.output?.trim() || part.error);

  return (
    <div className="not-prose my-2 rounded-lg border border-gray-700/80 bg-[#1f2026] text-sm">
      <button
        type="button"
        onClick={() => hasBody && setOpen((o) => !o)}
        aria-expanded={hasBody ? open : undefined}
        className={`flex w-full items-center gap-2 px-3 py-2 text-left ${hasBody ? 'hover:bg-white/5' : 'cursor-default'}`}
      >
        <Icon size={15} className="shrink-0 text-gray-400" />
        <span className="shrink-0 text-gray-300">{label}</span>
        {detail && (
          <code className="min-w-0 truncate rounded bg-black/30 px-1.5 py-0.5 font-mono text-xs text-gray-200">
            {detail}
          </code>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {statusIcon[part.status] || null}
          {hasBody && (
            <ChevronRight size={14} className={`text-gray-500 transition-transform ${open ? 'rotate-90' : ''}`} />
          )}
        </span>
      </button>
      {open && hasBody && (
        <div className="border-t border-gray-700/80 px-3 py-2">
          {part.error && <p className="mb-2 text-xs text-red-300">{part.error}</p>}
          {part.output?.trim() && (
            <pre className="thin-scroll max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-gray-300">
              {part.output}
            </pre>
          )}
        </div>
      )}
    </div>
  );
};

export default ToolCard;
