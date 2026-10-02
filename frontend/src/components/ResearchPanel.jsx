import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import { Check, Copy, ExternalLink, Pencil, X } from 'lucide-react';
import DownloadMenu from './DownloadMenu';
import ResearchActivity from './ResearchActivity';
import { markdownComponents } from './MessageList';
import { countSources, reportTitle } from '../lib/research';
import { openReportInNewTab } from '../lib/openReport';

const WIDTH_KEY = 'opengpt:research-panel-width';
const MIN_WIDTH = 360;
const DEFAULT_WIDTH = 480;
// Space the panel leaves on its right edge (matches the lg:mr-3 margin)
const RIGHT_GAP = 12;

const clampWidth = (width) =>
  Math.round(Math.min(Math.max(width, MIN_WIDTH), Math.max(MIN_WIDTH, window.innerWidth * 0.62)));

const readWidth = () => {
  try {
    return clampWidth(Number(localStorage.getItem(WIDTH_KEY)) || DEFAULT_WIDTH);
  } catch {
    return DEFAULT_WIDTH;
  }
};

const iconButton =
  'flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-white/10 hover:text-gray-100 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-gray-400';

const Tab = ({ active, onClick, children }) => (
  <button
    type="button"
    role="tab"
    aria-selected={active}
    onClick={onClick}
    className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
      active ? 'bg-white/10 text-gray-100' : 'text-gray-400 hover:text-gray-200'
    }`}
  >
    {children}
  </button>
);

// Side panel for a deep research answer. "Report" shows the finished report
// for review (copy, download, edit, open in a new tab); "Activity" shows what
// the agent did to produce it. The panel's width can be dragged from its left
// edge and is remembered.
const ResearchPanel = ({ message, view, onViewChange, onClose, onSaveReport }) => {
  const [width, setWidth] = useState(readWidth);
  const [resizing, setResizing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const reportScrollRef = useRef(null);

  const events = message.research || [];
  const content = message.content || '';
  const running = !!message.streaming;
  const hasReport = content.trim().length > 0;
  const sourceCount = countSources(events);

  // Leave edit mode when the panel switches view
  useEffect(() => {
    setEditing(false);
  }, [view]);

  // While the report is being written, keep its newest text in view
  useEffect(() => {
    const el = reportScrollRef.current;
    if (el && running && view === 'report') el.scrollTop = el.scrollHeight;
  }, [content, running, view]);

  const handleResizeStart = (e) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setResizing(true);
  };

  const handleResizeMove = (e) => {
    if (resizing) setWidth(clampWidth(window.innerWidth - e.clientX - RIGHT_GAP));
  };

  const handleResizeEnd = () => {
    if (!resizing) return;
    setResizing(false);
    try {
      localStorage.setItem(WIDTH_KEY, String(width));
    } catch {
      // storage unavailable: the width just isn't remembered
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard may be unavailable; ignore
    }
  };

  const startEditing = () => {
    setDraft(content);
    setEditing(true);
  };

  const handleSave = async () => {
    if (!draft.trim() || draft === content) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onSaveReport(draft);
      setEditing(false);
    } catch (err) {
      console.error('Could not save report:', err);
      alert('Could not save your changes. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const status = running
    ? hasReport
      ? 'Writing the report'
      : 'Researching'
    : `Deep Research${sourceCount > 0 ? ` · ${sourceCount} source${sourceCount === 1 ? '' : 's'}` : ''}`;

  return (
    <aside
      style={{ '--panel-width': `${width}px` }}
      className={`fixed inset-x-2 bottom-2 top-14 z-40 flex flex-col overflow-hidden rounded-[24px] border border-gray-700 bg-sidebar-bg shadow-2xl shadow-black/40 lg:relative lg:inset-auto lg:z-auto lg:mb-3 lg:mr-3 lg:w-[var(--panel-width)] lg:shrink-0 lg:shadow-none ${
        resizing ? 'select-none' : ''
      }`}
    >
      {/* Drag handle on the left edge (desktop) */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        onPointerDown={handleResizeStart}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeEnd}
        onPointerCancel={handleResizeEnd}
        className="group absolute inset-y-0 left-0 z-10 hidden w-2.5 cursor-col-resize touch-none lg:block"
      >
        <span
          className={`absolute left-1 top-1/2 h-10 w-1 -translate-y-1/2 rounded-full transition-colors ${
            resizing ? 'bg-gray-300' : 'bg-transparent group-hover:bg-gray-500'
          }`}
        />
      </div>

      {/* Title row */}
      <div className="flex items-start justify-between gap-3 px-5 pt-4">
        <div className="min-w-0">
          <h3 className="truncate text-[15px] font-semibold leading-6 text-gray-100" title={reportTitle(content, '')}>
            {reportTitle(content, 'Deep Research')}
          </h3>
          <p className={`truncate text-xs ${running ? 'thinking-shimmer' : 'text-gray-500'}`}>{status}</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close panel" title="Close" className={`${iconButton} -mr-1.5 shrink-0`}>
          <X size={17} />
        </button>
      </div>

      {/* Tabs + report actions */}
      <div className="flex items-center justify-between gap-2 border-b border-gray-700/80 px-4 pb-2.5 pt-3">
        <div role="tablist" className="flex items-center gap-1">
          <Tab active={view === 'report'} onClick={() => onViewChange('report')}>Report</Tab>
          <Tab active={view === 'activity'} onClick={() => onViewChange('activity')}>Activity</Tab>
        </div>

        {view === 'report' && hasReport && !editing && (
          <div className="flex items-center gap-0.5">
            <button type="button" onClick={handleCopy} aria-label="Copy report" title={copied ? 'Copied' : 'Copy'} className={`${iconButton} ${copied ? 'text-green-400' : ''}`}>
              {copied ? <Check size={16} /> : <Copy size={16} />}
            </button>
            <button type="button" onClick={startEditing} disabled={running} aria-label="Edit report" title="Edit" className={iconButton}>
              <Pencil size={16} />
            </button>
            {!running && <DownloadMenu content={content} placement="down" />}
            <button type="button" onClick={() => openReportInNewTab(content)} aria-label="Open report in a new tab" title="Open in new tab" className={iconButton}>
              <ExternalLink size={16} />
            </button>
          </div>
        )}

        {editing && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setEditing(false)}
              disabled={saving}
              className="rounded-lg px-3 py-1.5 text-xs text-gray-300 transition-colors hover:bg-white/10"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !draft.trim()}
              className="rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-gray-900 transition-colors hover:bg-gray-200 disabled:opacity-60"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        )}
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1">
        {view === 'activity' ? (
          <ResearchActivity events={events} running={running} />
        ) : editing ? (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            autoFocus
            aria-label="Report markdown"
            className="thin-scroll h-full w-full resize-none bg-transparent px-6 py-5 font-mono text-[13px] leading-6 text-gray-200 outline-none"
          />
        ) : hasReport ? (
          <div ref={reportScrollRef} className="thin-scroll h-full overflow-y-auto px-6 py-5">
            <div className="prose prose-invert max-w-none text-[15px]">
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]} components={markdownComponents}>
                {content}
              </ReactMarkdown>
              {running && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-gray-400 align-middle" />}
            </div>
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
            <p className="text-sm text-gray-300">The report is not written yet</p>
            <p className="text-xs text-gray-500">It will appear here once the research is done.</p>
            <button
              type="button"
              onClick={() => onViewChange('activity')}
              className="mt-2 rounded-full border border-gray-600 px-3 py-1 text-xs text-gray-300 transition-colors hover:bg-white/5"
            >
              View activity
            </button>
          </div>
        )}
      </div>
    </aside>
  );
};

export default ResearchPanel;
