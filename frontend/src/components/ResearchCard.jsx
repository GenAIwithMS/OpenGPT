import React from 'react';
import { BookOpen, ChevronRight } from 'lucide-react';
import { countSources, currentActivity } from '../lib/research';

// Compact entry in the chat for a deep research run. While it runs it shows
// the current activity; afterwards a summary. Clicking opens the activity panel.
const ResearchCard = ({ events = [], running, onOpen }) => {
  const sources = countSources(events);
  const searches = events.filter((e) => e.kind === 'search').length;

  const summary = [
    sources > 0 && `${sources} source${sources === 1 ? '' : 's'}`,
    searches > 0 && `${searches} search${searches === 1 ? '' : 'es'}`,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <button
      type="button"
      onClick={onOpen}
      className="not-prose mb-3 flex w-full max-w-md items-center gap-3 rounded-xl border border-gray-700 bg-[#2a2b32]/60 px-3.5 py-2.5 text-left transition-colors hover:border-gray-600 hover:bg-[#2a2b32]"
    >
      <BookOpen size={17} className="shrink-0 text-gray-300" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-gray-100">Deep Research</span>
        <span className={`block truncate text-xs ${running ? 'thinking-shimmer' : 'text-gray-400'}`}>
          {running ? currentActivity(events) : `Completed${summary ? ` · ${summary}` : ''}`}
        </span>
      </span>
      <ChevronRight size={16} className="shrink-0 text-gray-500" />
    </button>
  );
};

export default ResearchCard;
