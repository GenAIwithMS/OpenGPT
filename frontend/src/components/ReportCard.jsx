import React from 'react';
import { FileText } from 'lucide-react';
import DownloadMenu from './DownloadMenu';
import { reportTitle } from '../lib/research';

// The research report as a card in the chat: titled after its topic, with a
// download button. Clicking the card opens the report in the side panel.
const ReportCard = ({ content, writing, active, onOpen }) => {
  const words = content.trim().split(/\s+/).length;
  const minutes = Math.max(1, Math.round(words / 220));

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onOpen();
        }
      }}
      className={`not-prose flex w-full max-w-md cursor-pointer items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-colors hover:bg-[#2a2b32] ${
        active ? 'border-gray-500 bg-[#2a2b32]' : 'border-gray-700 bg-[#2a2b32]/60 hover:border-gray-600'
      }`}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/5 text-gray-300">
        <FileText size={18} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-gray-100">
          {reportTitle(content, writing ? 'Writing report' : 'Research report')}
        </span>
        <span className={`block truncate text-xs ${writing ? 'thinking-shimmer' : 'text-gray-400'}`}>
          {writing ? 'Writing the report...' : `Report · ${minutes} min read`}
        </span>
      </span>
      {!writing && <DownloadMenu content={content} />}
    </div>
  );
};

export default ReportCard;
