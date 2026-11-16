import React, { memo, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import { AlertTriangle, ChevronRight, StopCircle, Loader2, TerminalSquare } from 'lucide-react';
import { markdownComponents } from '../MessageList';
import ToolCard from './ToolCard';
import ApprovalCard from './ApprovalCard';

// Finished thinking: one line that opens to the full text.
const Reasoning = ({ text, live }) => {
  const [open, setOpen] = useState(false);
  if (!text.trim()) return null;
  return (
    <div className="not-prose my-2 text-sm">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="flex items-center gap-1.5 text-gray-400 hover:text-gray-200">
        <span className={live ? 'thinking-shimmer font-medium' : 'font-medium'}>{live ? 'Thinking…' : 'Thought'}</span>
        <ChevronRight size={14} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="thin-scroll mt-2 max-h-56 overflow-y-auto whitespace-pre-wrap border-l-2 border-gray-700 pl-3 text-xs leading-relaxed text-gray-400">
          {text}
        </div>
      )}
    </div>
  );
};

const Markdown = ({ text }) => (
  <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} components={markdownComponents}>
    {text}
  </ReactMarkdown>
);

const Assistant = memo(function Assistant({ message, approvals, onAnswer }) {
  const parts = message.parts || [];
  const lastIndex = parts.length - 1;
  const empty = parts.length === 0;
  return (
    <div className="py-3 px-4">
      <div className="max-w-3xl mx-auto">
        <div className="prose prose-invert max-w-none min-w-0 px-4 text-gray-100">
          {parts.map((part, i) => {
            if (part.type === 'text') return <Markdown key={i} text={part.text} />;
            if (part.type === 'reasoning') {
              return <Reasoning key={i} text={part.text} live={message.streaming && i === lastIndex} />;
            }
            if (part.type === 'tool') return <ToolCard key={part.id || i} part={part} />;
            if (part.type === 'approval') {
              return <ApprovalCard key={part.id} approval={approvals[part.id]} onAnswer={onAnswer} />;
            }
            return null;
          })}
          {message.streaming && empty && (
            <div className="not-prose flex items-center gap-2 text-sm text-gray-400">
              <Loader2 size={15} className="animate-spin" /> Working…
            </div>
          )}
          {message.stopped && (
            <p className="not-prose mt-2 flex items-center gap-1.5 text-xs text-gray-500">
              <StopCircle size={13} /> Stopped
            </p>
          )}
          {message.error && (
            <div role="alert" className="not-prose mt-2 flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
              <AlertTriangle size={15} className="mt-0.5 shrink-0" />
              <span className="break-words">{message.error}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

const User = ({ message }) => (
  <div className="py-3 px-4">
    <div className="max-w-3xl mx-auto flex justify-end">
      <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl bg-[#2a2b32] px-4 py-3 text-gray-100">
        {message.text}
      </div>
    </div>
  </div>
);

const Shell = ({ message }) => (
  <div className="py-2 px-4">
    <div className="max-w-3xl mx-auto px-4">
      <div className="rounded-lg border border-gray-700/80 bg-[#1f2026] text-sm">
        <div className="flex items-center gap-2 px-3 py-2">
          <TerminalSquare size={15} className="text-gray-400" />
          <code className="truncate font-mono text-xs text-gray-200">{message.command}</code>
          {message.exit != null && <span className="ml-auto text-xs text-gray-500">exit {message.exit}</span>}
        </div>
        {message.output?.trim() && (
          <pre className="thin-scroll max-h-60 overflow-auto border-t border-gray-700/80 px-3 py-2 font-mono text-xs text-gray-300 whitespace-pre-wrap">
            {message.output}
          </pre>
        )}
      </div>
    </div>
  </div>
);

const Status = ({ message }) => (
  <div className="py-1 px-4">
    <div className="max-w-3xl mx-auto px-4 text-xs text-gray-500">
      {message.error ? (
        <span className="text-red-300">{message.error}</span>
      ) : message.outcome === 'interrupted' ? 'Stopped' : 'Failed'}
    </div>
  </div>
);

const CodeMessages = ({ messages, approvals, onAnswer }) => {
  const endRef = useRef(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [messages, approvals]);

  return (
    <div className="pb-4">
      {messages.map((m) => {
        if (m.role === 'user') return <User key={m.id} message={m} />;
        if (m.role === 'assistant') return <Assistant key={m.id} message={m} approvals={approvals} onAnswer={onAnswer} />;
        if (m.role === 'shell') return <Shell key={m.id} message={m} />;
        if (m.role === 'status') return <Status key={m.id} message={m} />;
        return null;
      })}
      <div ref={endRef} />
    </div>
  );
};

export default CodeMessages;
