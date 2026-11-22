import React, { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import {
  Bot, Check, ChevronRight, Circle, CheckCircle2, Loader2, MessageCircleQuestion, Play, Send,
  ShieldQuestion, Square, Wrench, X,
} from 'lucide-react';
import { agentService } from '../../services/api';
import { markdownComponents } from '../MessageList';

const STATUS = {
  queued: { label: 'Queued', className: 'bg-gray-600/40 text-gray-200' },
  running: { label: 'Working', className: 'bg-blue-500/15 text-blue-200' },
  waiting: { label: 'Needs you', className: 'bg-amber-500/15 text-amber-200' },
  done: { label: 'Done', className: 'bg-green-500/15 text-green-200' },
  failed: { label: 'Failed', className: 'bg-red-500/15 text-red-200' },
  stopped: { label: 'Stopped', className: 'bg-gray-600/40 text-gray-200' },
  interrupted: { label: 'Interrupted', className: 'bg-gray-600/40 text-gray-200' },
};
const ACTIVE = new Set(['queued', 'running']);
const EXAMPLES = [
  'Find the three most discussed AI papers this week and summarise each in two lines.',
  'Check my open GitHub issues and draft a short status update.',
  'Compare the weather in London and Lahore for the next three days.',
];

export const StatusPill = ({ status }) => {
  const s = STATUS[status] || STATUS.queued;
  return <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${s.className}`}>{s.label}</span>;
};

const Markdown = ({ children }) => (
  <div className="prose prose-invert prose-sm max-w-none break-words">
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} components={markdownComponents}>
      {children || ''}
    </ReactMarkdown>
  </div>
);

const pretty = (value) => {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
};

// ---------------------------------------------------------------- new task

const NewTask = ({ onCreated }) => {
  const [task, setTask] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const start = async (e) => {
    e?.preventDefault();
    if (!task.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const session = await agentService.create(task.trim());
      onCreated(session.id);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-1 items-center justify-center overflow-y-auto px-4 py-10">
      <div className="w-full max-w-2xl">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/5"><Bot size={20} /></span>
          <div>
            <h1 className="text-xl font-semibold text-gray-100">What should the agent do?</h1>
            <p className="text-sm text-gray-400">
              It works in the background with your connected apps and tools, and asks before it changes anything.
            </p>
          </div>
        </div>
        <form onSubmit={start} className="rounded-2xl border border-gray-700 bg-[#2b2c33] p-3 focus-within:border-gray-500">
          <label htmlFor="agent-task" className="sr-only">Task</label>
          <textarea
            id="agent-task" value={task} rows={4} autoFocus maxLength={20000}
            onChange={(e) => setTask(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) start(e); }}
            placeholder="Describe the task. Say what you want at the end, e.g. a summary, a draft or a list."
            className="thin-scroll w-full resize-none bg-transparent text-sm text-gray-100 placeholder-gray-500 outline-none"
          />
          <div className="flex items-center justify-between gap-3 pt-2">
            <span className="text-xs text-gray-500">Ctrl+Enter to start</span>
            <button type="submit" disabled={!task.trim() || busy}
              className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50">
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Start
            </button>
          </div>
        </form>
        {error && <p role="alert" className="mt-3 text-sm text-red-300">{error}</p>}
        <div className="mt-6 space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Examples</p>
          {EXAMPLES.map((example) => (
            <button key={example} type="button" onClick={() => setTask(example)}
              className="block w-full rounded-xl border border-gray-700/70 px-3 py-2 text-left text-sm text-gray-300 hover:bg-white/5">
              {example}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------- timeline pieces

const UserBubble = ({ label, text }) => (
  <div className="flex justify-end">
    <div className="max-w-[85%] rounded-2xl bg-[#3a3b44] px-4 py-2.5 text-sm text-gray-100">
      {label && <p className="mb-0.5 text-xs text-gray-400">{label}</p>}
      <p className="whitespace-pre-wrap break-words">{text}</p>
    </div>
  </div>
);

const Plan = ({ plan }) => (
  <div className="rounded-xl border border-gray-700/70 p-3">
    <p className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500">Plan</p>
    <ol className="space-y-1.5">
      {plan.steps.map((step, i) => (
        <li key={i} className="flex items-start gap-2 text-sm">
          {i < plan.completed
            ? <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-green-300" />
            : <Circle size={16} className="mt-0.5 shrink-0 text-gray-500" />}
          <span className={i < plan.completed ? 'text-gray-400' : 'text-gray-100'}>{step}</span>
        </li>
      ))}
    </ol>
  </div>
);

const ToolStep = ({ call, result }) => {
  const [open, setOpen] = useState(false);
  const running = !result;
  return (
    <div className="rounded-xl border border-gray-700/70 text-sm">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-white/5">
        {running ? <Loader2 size={14} className="animate-spin text-gray-400" />
          : result.error ? <X size={14} className="text-red-300" /> : <Wrench size={14} className="text-gray-400" />}
        <span className="min-w-0 flex-1 truncate text-gray-200">{call.label}</span>
        <ChevronRight size={14} className={`text-gray-500 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="space-y-2 border-t border-gray-700/70 px-3 py-2">
          {call.args && Object.keys(call.args).length > 0 && (
            <pre className="thin-scroll max-h-40 overflow-auto rounded-lg bg-black/30 p-2 font-mono text-[11px] text-gray-300">{pretty(call.args)}</pre>
          )}
          {result && (
            <pre className="thin-scroll max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-black/30 p-2 font-mono text-[11px] text-gray-300">{result.text}</pre>
          )}
        </div>
      )}
    </div>
  );
};

const QuestionCard = ({ question, answer, current, sessionId, onChanged }) => {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const send = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await agentService.answer(sessionId, text.trim());
      onChanged();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  return (
    <div className={`rounded-xl border p-3 text-sm ${current ? 'border-amber-500/40 bg-amber-500/5' : 'border-gray-700/70'}`}>
      <p className="flex items-start gap-2 text-gray-100">
        <MessageCircleQuestion size={16} className="mt-0.5 shrink-0 text-amber-300" />
        <span className="whitespace-pre-wrap">{question}</span>
      </p>
      {answer && <p className="mt-2 pl-6 text-gray-400">You answered: {answer}</p>}
      {current && (
        <form onSubmit={send} className="mt-3 flex gap-2 pl-6">
          <label htmlFor="agent-answer" className="sr-only">Your answer</label>
          <input id="agent-answer" value={text} onChange={(e) => setText(e.target.value)} autoFocus maxLength={4000}
            placeholder="Your answer"
            className="min-w-0 flex-1 rounded-lg border border-gray-600 bg-transparent px-3 py-1.5 text-gray-100 outline-none focus:border-gray-400" />
          <button type="submit" disabled={busy || !text.trim()} aria-label="Send answer"
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-white hover:bg-blue-500 disabled:opacity-50">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
          </button>
        </form>
      )}
      {error && <p role="alert" className="mt-2 pl-6 text-xs text-red-300">{error}</p>}
    </div>
  );
};

const ApprovalCard = ({ approval, decision, current, sessionId, onChanged }) => {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const decide = async (value) => {
    setBusy(value);
    setError(null);
    try {
      await agentService.decide(sessionId, value);
      onChanged();
    } catch (err) {
      setError(err.message);
      setBusy(null);
    }
  };
  return (
    <div className={`rounded-xl border text-sm ${current ? 'border-amber-500/40 bg-amber-500/5' : 'border-gray-700/70'}`}>
      <div className="flex items-center gap-2 px-3 pt-3">
        <ShieldQuestion size={16} className="shrink-0 text-amber-300" />
        <p className="min-w-0 flex-1 font-medium text-gray-100">
          {current ? `Allow ${approval.tool}?` : approval.tool}
          <span className="ml-2 font-normal text-gray-400">{approval.connector}</span>
        </p>
        {decision && (
          <span className={`flex items-center gap-1 text-xs ${decision === 'deny' ? 'text-red-300' : 'text-green-300'}`}>
            {decision === 'deny' ? <X size={13} /> : <Check size={13} />}{decision === 'deny' ? 'Denied' : 'Allowed'}
          </span>
        )}
      </div>
      <div className="space-y-2 px-3 py-2.5">
        {current && (
          <p className="text-xs text-gray-400">
            {approval.destructive
              ? 'The agent wants to use a tool that can change or delete data in your account.'
              : 'The agent wants to use a tool that can make changes in your account.'}
          </p>
        )}
        {approval.arguments && approval.arguments !== '{}' && (
          <pre className="thin-scroll max-h-40 overflow-auto rounded-lg bg-black/30 p-2.5 font-mono text-[11px] text-gray-200">{approval.arguments}</pre>
        )}
        {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
      </div>
      {current && (
        <div className="flex items-center gap-2 border-t border-amber-500/20 px-3 py-2.5">
          <button type="button" disabled={!!busy} onClick={() => decide('allow')}
            className="rounded-md bg-blue-600 px-3 py-1.5 font-medium text-white hover:bg-blue-500 disabled:opacity-60">Allow</button>
          <button type="button" disabled={!!busy} onClick={() => decide('deny')}
            className="rounded-md px-3 py-1.5 text-red-300 hover:bg-red-500/10 disabled:opacity-60">Deny</button>
          {busy && <Loader2 size={15} className="animate-spin text-gray-400" />}
        </div>
      )}
    </div>
  );
};

// Turn the event list into timeline items: a tool call with its result, a
// question with its answer, an approval with its decision.
function buildTimeline(events, session) {
  const items = [];
  const calls = new Map();
  let openQuestion = null;
  let openApproval = null;
  let plan = null;
  for (const e of events) {
    const d = e.data || {};
    if (e.type === 'task') items.push({ key: e.seq, kind: 'user', label: 'Task', text: d.text });
    else if (e.type === 'instruction') items.push({ key: e.seq, kind: 'user', label: 'Instruction', text: d.text });
    else if (e.type === 'plan') plan = d;
    else if (e.type === 'message') items.push({ key: e.seq, kind: 'message', text: d.text });
    else if (e.type === 'tool_call') {
      const item = { key: e.seq, kind: 'tool', call: d, result: null };
      calls.set(d.id, item);
      items.push(item);
    } else if (e.type === 'tool_result') {
      const item = calls.get(d.id);
      if (item) item.result = d;
    } else if (e.type === 'question') {
      openQuestion = { key: e.seq, kind: 'question', question: d.question, answer: null };
      items.push(openQuestion);
    } else if (e.type === 'answer') {
      if (openQuestion) openQuestion.answer = d.text;
      openQuestion = null;
    } else if (e.type === 'approval') {
      openApproval = { key: e.seq, kind: 'approval', approval: d, decision: null };
      items.push(openApproval);
    } else if (e.type === 'approval_done') {
      if (openApproval) openApproval.decision = d.decision;
      openApproval = null;
    } else if (e.type === 'result') items.push({ key: e.seq, kind: 'result', text: d.text });
    else if (e.type === 'status' && d.reason && ['stopped', 'failed', 'interrupted'].includes(d.status)) {
      items.push({ key: e.seq, kind: 'note', status: d.status, text: d.reason });
    }
  }
  // Only the latest open question or approval can be answered, and only while waiting.
  const waiting = session?.status === 'waiting' ? session.waiting?.kind : null;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if ((item.kind === 'question' || item.kind === 'approval') && !item.answer && !item.decision) {
      item.current = waiting === item.kind;
      break;
    }
  }
  return { items, plan };
}

// ---------------------------------------------------------------- session

const Session = ({ sessionId, onChanged }) => {
  const [session, setSession] = useState(null);
  const [events, setEvents] = useState([]);
  const [error, setError] = useState(null);
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const lastSeq = useRef(0);
  const bottom = useRef(null);

  const load = async (fresh = false) => {
    try {
      const after = fresh ? 0 : lastSeq.current;
      const data = await agentService.get(sessionId, after);
      const { events: added, ...info } = data;
      setSession(info);
      if (added.length) {
        lastSeq.current = added[added.length - 1].seq;
        setEvents((prev) => (fresh ? added : [...prev, ...added]));
      } else if (fresh) setEvents([]);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  };

  useEffect(() => {
    lastSeq.current = 0;
    setSession(null);
    setEvents([]);
    load(true);
  }, [sessionId]);

  const active = session && ACTIVE.has(session.status);
  useEffect(() => {
    if (!session) return undefined;
    const timer = setInterval(() => load(), active ? 1500 : 5000);
    return () => clearInterval(timer);
  }, [sessionId, active, !!session]);

  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [events.length]);

  const { items, plan } = useMemo(() => buildTimeline(events, session), [events, session]);

  const changed = () => { load(); onChanged(); };
  const act = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setInstruction('');
      changed();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (!session) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-gray-400">
        {error ? <p role="alert">{error}</p> : <Loader2 size={20} className="animate-spin" />}
      </div>
    );
  }

  const canContinue = ['stopped', 'failed', 'interrupted'].includes(session.status);
  const canInstruct = ['done', 'stopped', 'failed', 'interrupted'].includes(session.status);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-gray-700/60 px-4 py-3 pl-14 lg:pl-4">
        <Bot size={18} className="shrink-0 text-gray-400" />
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium text-gray-100">{session.title}</h1>
        <StatusPill status={session.status} />
      </div>

      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-3 px-4 py-6">
          {plan && <Plan plan={plan} />}
          {items.map((item) => {
            if (item.kind === 'user') return <UserBubble key={item.key} label={item.label} text={item.text} />;
            if (item.kind === 'message') return <div key={item.key} className="text-gray-200"><Markdown>{item.text}</Markdown></div>;
            if (item.kind === 'tool') return <ToolStep key={item.key} call={item.call} result={item.result} />;
            if (item.kind === 'question') return <QuestionCard key={item.key} {...item} sessionId={sessionId} onChanged={changed} />;
            if (item.kind === 'approval') return <ApprovalCard key={item.key} {...item} sessionId={sessionId} onChanged={changed} />;
            if (item.kind === 'result') {
              return (
                <div key={item.key} className="rounded-xl border border-green-500/30 bg-green-500/5 p-4">
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-green-300">Result</p>
                  <Markdown>{item.text}</Markdown>
                </div>
              );
            }
            return <p key={item.key} className="text-center text-xs text-gray-500">{item.text}</p>;
          })}
          {active && (
            <p className="flex items-center gap-2 text-sm text-gray-400">
              <Loader2 size={14} className="animate-spin" />{session.status === 'queued' ? 'Waiting to start' : 'Working'}
            </p>
          )}
          <div ref={bottom} />
        </div>
      </div>

      <div className="border-t border-gray-700/60 px-4 py-3">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
          {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
          {active && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-gray-400">You can close this page; the agent keeps working.</span>
              <button type="button" disabled={busy} onClick={() => act(() => agentService.stop(sessionId))}
                className="flex items-center gap-1.5 rounded-lg border border-gray-600 px-3 py-1.5 text-sm text-gray-200 hover:bg-white/5 disabled:opacity-50">
                <Square size={13} /> Stop
              </button>
            </div>
          )}
          {session.status === 'waiting' && <p className="text-sm text-amber-200">The agent is waiting for you above.</p>}
          {canInstruct && (
            <form className="flex gap-2" onSubmit={(e) => {
              e.preventDefault();
              act(() => agentService.continue(sessionId, instruction.trim() || null));
            }}>
              <label htmlFor="agent-instruction" className="sr-only">Instruction</label>
              <input id="agent-instruction" value={instruction} onChange={(e) => setInstruction(e.target.value)} maxLength={20000}
                placeholder={session.status === 'done' ? 'Ask for more, e.g. "Now draft an email about it"' : 'Optional: a new instruction'}
                className="min-w-0 flex-1 rounded-lg border border-gray-600 bg-transparent px-3 py-2 text-sm text-gray-100 outline-none focus:border-gray-400" />
              <button type="submit" disabled={busy || (!canContinue && !instruction.trim())}
                className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50">
                {busy ? <Loader2 size={14} className="animate-spin" /> : canContinue && !instruction.trim() ? <Play size={14} /> : <Send size={14} />}
                {canContinue && !instruction.trim() ? 'Continue' : 'Send'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};

/**
 * The Agent page: start a task (no session open) or follow one (`/agent/<id>`).
 *
 * @param {object} props
 * @param {string|null} props.sessionId
 * @param {(id: string) => void} props.onCreated  A task was started: open it.
 * @param {() => void} props.onChanged  Something changed (refresh the sidebar list).
 */
const AgentView = ({ sessionId, onCreated, onChanged }) => (
  <main className="flex h-screen min-w-0 flex-1 flex-col bg-chat-bg">
    {sessionId ? <Session sessionId={sessionId} onChanged={onChanged} /> : <NewTask onCreated={onCreated} />}
  </main>
);

export default AgentView;
