import React, { useEffect, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';

// Live "Thinking" row shown while the model reasons. Collapsed, it is a single
// line: a shimmering status label plus the tail of the streaming reasoning.
// Clicking it opens a height-capped panel with the full reasoning so far.
const ThinkingIndicator = ({ label = 'Thinking...', reasoning = '' }) => {
  const [open, setOpen] = useState(false);
  const panelRef = useRef(null);
  const hasReasoning = reasoning.trim().length > 0;

  // Keep the newest reasoning in view while the panel is open
  useEffect(() => {
    if (open && panelRef.current) {
      panelRef.current.scrollTop = panelRef.current.scrollHeight;
    }
  }, [reasoning, open]);

  // Only the most recent text fits on one line; right-aligning it keeps the
  // newest words visible while older ones slide out under the fade.
  const tail = reasoning.replace(/\s+/g, ' ').slice(-200);

  return (
    <div className="not-prose mb-3 text-sm">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={!hasReasoning}
        aria-expanded={open}
        className="flex w-full max-w-full items-center gap-1.5 text-left disabled:cursor-default"
      >
        <span className="thinking-shimmer shrink-0 font-medium">{label}</span>
        {hasReasoning && (
          <ChevronRight
            size={14}
            className={`shrink-0 text-gray-500 transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
          />
        )}
        {hasReasoning && !open && (
          <span className="thinking-tail flex min-w-0 justify-end overflow-hidden whitespace-nowrap text-xs text-gray-500">
            {tail}
          </span>
        )}
      </button>

      {open && hasReasoning && (
        <div
          ref={panelRef}
          className="thin-scroll mt-2 max-h-44 overflow-y-auto whitespace-pre-wrap border-l-2 border-gray-700 pl-3 text-xs leading-relaxed text-gray-400"
        >
          {reasoning}
        </div>
      )}
    </div>
  );
};

export default ThinkingIndicator;
