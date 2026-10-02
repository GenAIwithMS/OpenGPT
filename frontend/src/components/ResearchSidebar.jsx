import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  Check,
  ClipboardList,
  FileText,
  Globe,
  Lightbulb,
  Link2,
  Loader2,
  Telescope,
  X,
} from 'lucide-react';
import { countSources } from '../lib/research';

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

// Long text is clamped to a few lines with a "Show more" toggle
const Expandable = ({ text, lines = 4, className = '' }) => {
  const [open, setOpen] = useState(false);
  const long = text.length > lines * 55 || text.split('\n').length > lines;
  return (
    <div>
      <p
        className={`whitespace-pre-wrap break-words ${className}`}
        style={
          open || !long
            ? undefined
            : { display: '-webkit-box', WebkitLineClamp: lines, WebkitBoxOrient: 'vertical', overflow: 'hidden' }
        }
      >
        {text}
      </p>
      {long && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="mt-1 text-xs text-gray-500 hover:text-gray-300"
        >
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
};

const Row = ({ icon: Icon, label, iconClass = 'text-gray-500', children }) => (
  <div className="flex gap-2.5">
    <Icon size={14} className={`mt-0.5 shrink-0 ${iconClass}`} />
    <div className="min-w-0 flex-1">
      {label && <div className="mb-1 text-xs font-medium text-gray-300">{label}</div>}
      {children}
    </div>
  </div>
);

const Sources = ({ sources }) => {
  const [open, setOpen] = useState(false);
  const shown = open ? sources : sources.slice(0, 4);
  return (
    <Row icon={Link2} label={`Read ${sources.length} source${sources.length === 1 ? '' : 's'}`}>
      <ul className="space-y-1">
        {shown.map((s, i) => (
          <li key={i} className="truncate text-xs">
            <a
              href={s.url}
              target="_blank"
              rel="noopener noreferrer"
              title={s.title}
              className="text-gray-400 hover:text-blue-300"
            >
              <span className="text-gray-300">{hostOf(s.url)}</span>
              {s.title && <span className="text-gray-500"> · {s.title}</span>}
            </a>
          </li>
        ))}
      </ul>
      {sources.length > 4 && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="mt-1 text-xs text-gray-500 hover:text-gray-300"
        >
          {open ? 'Show less' : `+${sources.length - 4} more`}
        </button>
      )}
    </Row>
  );
};

const ActivityItem = ({ event }) => {
  switch (event.kind) {
    case 'plan':
      return (
        <Row icon={ClipboardList} label={event.title || 'Research brief'}>
          <Expandable text={event.text} lines={5} className="text-xs leading-relaxed text-gray-400" />
        </Row>
      );
    case 'thinking':
      return (
        <Row icon={Lightbulb}>
          <Expandable text={event.text} lines={4} className="text-xs leading-relaxed text-gray-400" />
        </Row>
      );
    case 'delegate':
      return (
        <Row icon={Telescope} label="Investigating" iconClass="text-blue-400">
          <Expandable text={event.text} lines={3} className="text-xs leading-relaxed text-gray-400" />
        </Row>
      );
    case 'search':
      return (
        <Row icon={Globe} label="Searching the web">
          <div className="flex flex-wrap gap-1.5">
            {event.queries.map((q, i) => (
              <span
                key={i}
                className="max-w-full truncate rounded-full border border-gray-700 bg-white/5 px-2 py-0.5 text-xs text-gray-300"
                title={q}
              >
                {q}
              </span>
            ))}
          </div>
        </Row>
      );
    case 'sources':
      return <Sources sources={event.sources} />;
    case 'findings':
      return (
        <Row icon={FileText} label="Findings">
          <Expandable text={event.text} lines={4} className="text-xs leading-relaxed text-gray-400" />
        </Row>
      );
    case 'status':
      return <div className="pl-6 text-xs text-gray-500">{event.text}</div>;
    case 'error':
      return (
        <Row icon={AlertTriangle} iconClass="text-red-400">
          <Expandable text={event.text} lines={3} className="text-xs leading-relaxed text-red-300" />
        </Row>
      );
    default:
      return null;
  }
};

// Side panel with the live (or saved) activity of a deep research run:
// each phase is a section listing what the agent thought, searched and found.
const ResearchSidebar = ({ events = [], running, onClose }) => {
  const scrollRef = useRef(null);
  const pinnedRef = useRef(true);

  // Split the flat event list into phases, one per "step" event
  const sections = useMemo(() => {
    const out = [];
    for (const event of events) {
      if (event.kind === 'step') {
        out.push({ title: event.title, items: [] });
      } else if (event.kind !== 'done') {
        if (!out.length) out.push({ title: 'Starting', items: [] });
        out[out.length - 1].items.push(event);
      }
    }
    return out;
  }, [events]);

  const sourceCount = useMemo(() => countSources(events), [events]);

  // Follow new activity unless the user has scrolled up to read
  useEffect(() => {
    const el = scrollRef.current;
    if (el && running && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [events, running]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (el) pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  return (
    <aside className="fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l border-gray-700 bg-sidebar-bg lg:static lg:z-auto lg:w-[380px] lg:max-w-none lg:shrink-0">
      <div className="flex items-center justify-between gap-3 border-b border-gray-700 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <BookOpen size={17} className="shrink-0 text-gray-300" />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-gray-100">Deep Research</h3>
            <p className="truncate text-xs text-gray-500">
              {running ? 'In progress' : 'Completed'}
              {sourceCount > 0 && ` · ${sourceCount} source${sourceCount === 1 ? '' : 's'}`}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close research activity"
          className="rounded-md p-1.5 text-gray-400 transition-colors hover:bg-gray-700 hover:text-gray-100"
        >
          <X size={16} />
        </button>
      </div>

      <div ref={scrollRef} onScroll={handleScroll} className="thin-scroll flex-1 overflow-y-auto px-4 py-4">
        {sections.length === 0 && (
          <div className="flex items-center gap-2 text-sm text-gray-400">
            <Loader2 size={14} className="animate-spin" /> Starting research...
          </div>
        )}

        <div className="space-y-5">
          {sections.map((section, i) => {
            const active = running && i === sections.length - 1;
            return (
              <section key={i}>
                <div className="mb-2.5 flex items-center gap-2">
                  {active ? (
                    <Loader2 size={14} className="shrink-0 animate-spin text-blue-400" />
                  ) : (
                    <Check size={14} className="shrink-0 text-emerald-400" />
                  )}
                  <h4 className={`text-sm font-medium ${active ? 'text-gray-100' : 'text-gray-300'}`}>
                    {section.title}
                  </h4>
                </div>
                {section.items.length > 0 && (
                  <div className="ml-[6px] space-y-3 border-l border-gray-700 pl-4">
                    {section.items.map((event) => (
                      <ActivityItem key={event.id} event={event} />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </div>
    </aside>
  );
};

export default ResearchSidebar;
