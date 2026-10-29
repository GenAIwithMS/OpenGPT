import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import { Loader2, Copy, Check, ThumbsUp, ThumbsDown, RotateCcw, Pencil } from 'lucide-react';
import AttachmentCard from './AttachmentCard';
import ThinkingIndicator from './ThinkingIndicator';
import ResearchCard from './ResearchCard';
import ReportCard from './ReportCard';
import { CodeBlock, CodeBlockCode, CodeBlockGroup, CopyButton } from './ui/code-block';
import CitationChip from './CitationChip';
import { parseCitation, stripCitationMarkers, withSourceTag } from '../lib/citations';

function nodeToString(node) {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(nodeToString).join('');
  if (node && node.props && node.props.children) return nodeToString(node.props.children);
  return '';
}

const btnClass =
  'inline-flex items-center justify-center p-1.5 rounded-md text-gray-400 transition-colors hover:bg-white/5 hover:text-gray-200';

function UserActions({ content, onEdit }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      // clipboard may be unavailable; ignore
    }
  };

  return (
    <div className="mt-2 flex items-center gap-1 justify-end">
      <button
        type="button"
        onClick={handleCopy}
        title="Copy"
        aria-label="Copy"
        className={`${btnClass} ${copied ? 'text-green-400' : ''}`}
      >
        {copied ? <Check size={15} /> : <Copy size={15} />}
        {copied && <span className="text-xs ml-1">Copied</span>}
      </button>
      <button
        type="button"
        onClick={onEdit}
        title="Edit"
        aria-label="Edit"
        className={btnClass}
      >
        <Pencil size={15} />
      </button>
    </div>
  );
}

function MessageActions({ content, onRegenerate }) {
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState(null); // 'like' | 'dislike'

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      // clipboard may be unavailable; ignore
    }
  };

  const btn = btnClass;

  return (
    <div className="mt-2 flex items-center gap-1 justify-end">
      <button
        type="button"
        onClick={handleCopy}
        title="Copy"
        aria-label="Copy"
        className={`${btn} ${copied ? 'text-green-400' : ''}`}
      >
        {copied ? <Check size={15} /> : <Copy size={15} />}
        {copied && <span className="text-xs ml-1">Copied</span>}
      </button>
      <button
        type="button"
        title="Helpful"
        aria-label="Helpful"
        onClick={() => setFeedback(feedback === 'like' ? null : 'like')}
        className={`${btn} ${feedback === 'like' ? 'text-green-400' : ''}`}
      >
        <ThumbsUp size={15} />
      </button>
      <button
        type="button"
        title="Not helpful"
        aria-label="Not helpful"
        onClick={() => setFeedback(feedback === 'dislike' ? null : 'dislike')}
        className={`${btn} ${feedback === 'dislike' ? 'text-red-400' : ''}`}
      >
        <ThumbsDown size={15} />
      </button>
      <button
        type="button"
        title="Regenerate"
        aria-label="Regenerate"
        onClick={() => onRegenerate()}
        className={btn}
      >
        <RotateCcw size={15} />
      </button>
    </div>
  );
}

// Links written by the backend's citation pass carry a title attribute
// ("Page title (date)"); ordinary markdown links the model writes do not.
const isCitation = (el) => React.isValidElement(el) && el.type === MarkdownLink && !!el.props.title;

const MarkdownLink = ({ href, title, children }) => {
  if (title) {
    return <CitationChip sources={[parseCitation({ href, title, label: nodeToString(children) })]} />;
  }
  return (
    <a
      href={withSourceTag(href)}
      target="_blank"
      rel="noopener noreferrer"
      className="text-blue-400 hover:text-blue-300 underline break-words"
    >
      {children}
    </a>
  );
};

// Adjacent citation links (only whitespace between them) collapse into one
// chip that reads "Site +N", like the sources pill in ChatGPT.
const groupCitations = (children) => {
  const items = React.Children.toArray(children);
  if (!items.some(isCitation)) return children;
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length === 0) return;
    out.push(
      <CitationChip
        key={`cite-${out.length}`}
        sources={run.map((el) =>
          parseCitation({ href: el.props.href, title: el.props.title, label: nodeToString(el.props.children) })
        )}
      />
    );
    run = [];
  };
  items.forEach((item, i) => {
    if (isCitation(item)) {
      run.push(item);
      return;
    }
    const next = items[i + 1];
    if (run.length && typeof item === 'string' && item.trim() === '' && isCitation(next)) return;
    flush();
    out.push(item);
  });
  flush();
  return out;
};

// Table cells are too cramped for links: citation chips are dropped and any
// other link is reduced to its text so the row stays a clean grid.
const isLink = (el) => React.isValidElement(el) && el.type === MarkdownLink;
const withoutCitations = (children) => {
  const items = React.Children.toArray(children);
  if (!items.some(isLink)) return children;
  return items
    .filter((item) => !isCitation(item))
    .map((item) => (isLink(item) ? nodeToString(item.props.children) : item));
};

// --- Tables -----------------------------------------------------------------
// Borderless layout: bold header, thin row dividers, text columns left and
// numeric columns right. Cells wrap so a table always fits the message width
// instead of scrolling.
const TableContext = React.createContext([]);

const NUMERIC_CELL = /^[\s$€£₹+\-−–—(]*\d[\d.,]*\s*(%|[kKmMbB]n?|x)?\)?$/;
const PLACEHOLDER_CELL = /^([-–—]*|n\/?a|tbd|tba)$/i;

const hastText = (node) =>
  node.type === 'text' ? node.value : (node.children || []).map(hastText).join('');

// Which columns hold only numbers (or placeholders like "—"), from the table's
// syntax tree so every cell in the column can agree on its alignment.
const numericColumns = (tableNode) => {
  const rows = [];
  for (const section of tableNode?.children || []) {
    if (section.tagName !== 'tbody') continue;
    for (const tr of section.children || []) {
      if (tr.tagName === 'tr') rows.push(tr.children.filter((c) => c.tagName === 'td'));
    }
  }
  const count = Math.max(0, ...rows.map((r) => r.length));
  return Array.from({ length: count }, (_, i) => {
    let numeric = 0;
    for (const row of rows) {
      const text = row[i] ? hastText(row[i]).trim() : '';
      if (NUMERIC_CELL.test(text)) numeric += 1;
      else if (!PLACEHOLDER_CELL.test(text)) return false;
    }
    return numeric > 0;
  });
};

// Cells wrap between words so a table normally fits the message column; the
// wrapper only scrolls (itself, never the page) if whole words cannot fit.
const MarkdownTable = ({ node, children }) => (
  <TableContext.Provider value={numericColumns(node)}>
    <div className="thin-scroll my-4 w-full overflow-x-auto">
      <table className="w-full table-auto border-collapse text-[15px]">{children}</table>
    </div>
  </TableContext.Provider>
);

const TableRow = ({ children }) => {
  let col = 0;
  return (
    <tr className="border-b border-gray-700/60 last:border-b-0">
      {React.Children.map(children, (child) =>
        React.isValidElement(child) ? React.cloneElement(child, { colIndex: col++ }) : child
      )}
    </tr>
  );
};

const TableCell = ({ as: Tag, style, colIndex, children }) => {
  const numeric = React.useContext(TableContext);
  const explicit = style?.textAlign;
  const align =
    explicit === 'center' || explicit === 'right' ? explicit : numeric[colIndex] ? 'right' : 'left';
  const base = 'px-3 py-2.5 align-top leading-6 break-words';
  return Tag === 'th' ? (
    <th style={{ textAlign: align }} className={`${base} whitespace-nowrap font-semibold text-gray-100`}>
      {children}
    </th>
  ) : (
    <td style={{ textAlign: align }} className={`${base} text-gray-100`}>
      {withoutCitations(children)}
    </td>
  );
};

export const markdownComponents = {
  pre: ({ children }) => <>{children}</>,
  code: ({ node, className, children, ...props }) => {
    const match = /language-(\w+)/.exec(className || '');
    const text = nodeToString(children).replace(/\n$/, '');
    const isBlock = !!match || text.includes('\n');

    if (!isBlock) {
      return (
        <code
          className="bg-[#1a1b1e] px-1.5 py-0.5 rounded text-sm font-mono text-gray-200"
          {...props}
        >
          {children}
        </code>
      );
    }

    const lang = match ? match[1] : 'text';
    return (
      <CodeBlock>
        <CodeBlockGroup>
          <span className="text-xs text-gray-400">{lang}</span>
        </CodeBlockGroup>
        <CopyButton value={text} />
        <CodeBlockCode code={text} language={lang} theme="github-dark" />
      </CodeBlock>
    );
  },
  p: ({ children }) => (
    <p className="mb-3 last:mb-0 leading-7 text-gray-100 whitespace-pre-wrap break-words">
      {groupCitations(children)}
    </p>
  ),
  ul: ({ children }) => (
    <ul className="list-disc ml-6 mb-3 space-y-1 text-gray-100">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal ml-6 mb-3 space-y-1 text-gray-100">
      {children}
    </ol>
  ),
  li: ({ children }) => (
    <li className="leading-7 text-gray-100">{groupCitations(children)}</li>
  ),
  h1: ({ children }) => (
    <h1 className="text-2xl font-bold mb-3 mt-4 text-gray-100">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-xl font-bold mb-3 mt-4 text-gray-100">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-lg font-bold mb-2 mt-3 text-gray-100">{children}</h3>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-4 border-gray-600 pl-4 my-3 italic text-gray-300">
      {children}
    </blockquote>
  ),
  table: MarkdownTable,
  thead: ({ children }) => <thead>{children}</thead>,
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: TableRow,
  th: (props) => <TableCell as="th" {...props} />,
  td: (props) => <TableCell as="td" {...props} />,
  a: MarkdownLink,
  strong: ({ children }) => (
    <strong className="font-semibold text-gray-100">{children}</strong>
  ),
  br: () => <br />,
};

const MessageList = ({ messages, loading, streaming, streamingProgress, onRegenerate, onEditMessage, onOpenResearch, openResearch }) => {
  const messagesEndRef = useRef(null);
  const previousLengthRef = useRef(0);
  const [editIndex, setEditIndex] = useState(null);
  const [editValue, setEditValue] = useState('');

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
  };

  useEffect(() => {
    // Always keep the latest content in view: initial load, switching between
    // conversations, sending a new message, and live streaming.
    scrollToBottom();
    previousLengthRef.current = messages.length;
  }, [messages, streaming]);

  const renderMessage = (message, index) => {
    const isUser = message.type === 'human';
    const isResearch = !isUser && message.tool_used === 'deep_research' && !!message.research;
    // A research report is shown as a card that opens in the side panel; a
    // failed run's error text stays inline like a normal answer.
    const asReportCard = isResearch && !!message.content.trim() && !message.content.startsWith('⚠️');
    const openView = openResearch?.index === index ? openResearch.view : null;

    const commitEdit = () => {
      if (editIndex === null) return;
      const original = messages[editIndex]?.content;
      const value = editValue;
      setEditIndex(null);
      setEditValue('');
      if (value.trim() && value !== original) {
        onEditMessage(value, editIndex);
      }
    };

    // Edit mode for user messages
    if (isUser && editIndex === index) {
      return (
        <div key={index} className="py-4 px-4">
          <div className="max-w-3xl mx-auto flex justify-end">
            <div className="w-full max-w-[80%]">
              <textarea
                className="w-full resize-none rounded-lg border border-gray-600 bg-[#1a1b1e] p-3 text-sm text-gray-100 outline-none focus:border-gray-400"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                rows={Math.min(12, editValue.split('\n').length + 1)}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    commitEdit();
                  } else if (e.key === 'Escape') {
                    setEditIndex(null);
                    setEditValue('');
                  }
                }}
              />
              <div className="mt-2 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setEditIndex(null);
                    setEditValue('');
                  }}
                  className="px-3 py-1 text-xs rounded-md text-gray-300 hover:bg-white/5"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={commitEdit}
                  className="px-3 py-1 text-xs rounded-md bg-blue-600 text-white hover:bg-blue-500"
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      );
    }

    const bubbleInner = (
      <div className="prose prose-invert max-w-none min-w-0">
        {isResearch && (
          <ResearchCard
            events={message.research}
            running={!!message.streaming && !asReportCard}
            active={openView === 'activity'}
            onOpen={() => onOpenResearch?.(index, 'activity')}
          />
        )}

        {asReportCard && (
          <ReportCard
            content={message.content}
            writing={!!message.streaming}
            active={openView === 'report'}
            onOpen={() => onOpenResearch?.(index, 'report')}
          />
        )}

        {message.streaming && streamingProgress?.toolName === 'chat' && !streamingProgress.answering && (
          <ThinkingIndicator
            label={streamingProgress.current}
            reasoning={streamingProgress.reasoning}
          />
        )}

        {message.streaming && streamingProgress?.isStreaming && streamingProgress.steps && (
          <div className="mb-3 rounded-md border border-gray-700 bg-[#1a1b1e]/60 p-3">
            <div className="flex items-center gap-2 text-sm text-gray-300">
              <Loader2 size={15} className="animate-spin text-blue-400 shrink-0" />
              <span className="font-medium">
                {streamingProgress.current || 'Thinking...'}
              </span>
            </div>

            {streamingProgress.steps?.length > 0 && (
              <div className="mt-1.5 space-y-1">
                {streamingProgress.steps.map((s, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <span
                      className={
                        s.status === 'completed'
                          ? 'text-green-400'
                          : s.status === 'in-progress'
                          ? 'text-gray-200'
                          : 'text-gray-600'
                      }
                    >
                      •
                    </span>
                    <span
                      className={
                        s.status === 'in-progress'
                          ? 'text-gray-200'
                          : s.status === 'completed'
                          ? 'text-gray-400'
                          : 'text-gray-600'
                      }
                    >
                      {s.label}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {!asReportCard && (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeRaw]}
            components={markdownComponents}
          >
            {message.streaming ? stripCitationMarkers(message.content) : message.content}
          </ReactMarkdown>
        )}
        {message.streaming && !isResearch && (
          <span className="inline-block w-1.5 h-4 ml-0.5 align-middle bg-gray-400 animate-pulse" />
        )}
      </div>
    );

    // User messages: actions live below the bubble (not inside it)
    if (isUser) {
      const attachments = message.attachments;
      return (
        <div key={index} className="py-4 px-4">
          <div className="max-w-3xl mx-auto flex justify-end">
            <div className="max-w-[80%] flex flex-col items-end gap-1">
              {attachments && attachments.length > 0 && (
                <div className="flex flex-wrap justify-end gap-2.5 mb-1">
                  {attachments.map((att, i) => (
                    <AttachmentCard key={i} attachment={att} />
                  ))}
                </div>
              )}
              <div className="px-4 py-3 rounded-2xl bg-[#2a2b32] text-gray-100">
                {bubbleInner}
              </div>
              <UserActions
                content={message.content}
                onEdit={() => {
                  setEditValue(message.content);
                  setEditIndex(index);
                }}
              />
            </div>
          </div>
        </div>
      );
    }

    return (
      <div key={index} className="py-4 px-4">
        <div className="max-w-3xl mx-auto flex justify-start">
          <div className="w-full min-w-0 px-4 py-3 rounded-lg text-gray-100">
            {bubbleInner}
            <MessageActions content={message.content} onRegenerate={onRegenerate} />
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="flex-1 overflow-y-auto">
      {messages.map((message, index) => renderMessage(message, index))}

      {loading && !streaming && (
        <div className="py-4 px-4">
          <div className="max-w-3xl mx-auto flex justify-start">
            <div className="flex items-center gap-2">
              <Loader2 className="animate-spin text-gray-400" size={20} />
              <span className="text-gray-400">Thinking...</span>
            </div>
          </div>
        </div>
      )}

      <div ref={messagesEndRef} />
    </div>
  );
};

export default MessageList;
