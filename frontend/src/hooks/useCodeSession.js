import { useCallback, useEffect, useRef, useState } from 'react';
import { codeService } from '../services/api';

// One coding session: its messages, the live turn, and pending approvals.
//
// Messages use the backend's format (see backend/app/services/coding_agent/
// sessions.py): user, assistant (parts: text | reasoning | tool | approval),
// shell, status. While a turn streams, the last assistant message has
// `streaming: true` and is built from the live events.

let localId = 0;
const nextId = () => `local-${++localId}`;

// Apply one live event to the assistant message being written.
function applyEvent(message, event) {
  const parts = [...message.parts];
  const last = parts[parts.length - 1];
  switch (event.type) {
    case 'text':
    case 'reasoning':
      if (last && last.type === event.type) {
        parts[parts.length - 1] = { ...last, text: last.text + event.delta };
      } else {
        parts.push({ type: event.type, text: event.delta });
      }
      return { ...message, parts };
    case 'tool': {
      const i = parts.findIndex((p) => p.type === 'tool' && p.id === event.id);
      const { type: _type, ...fields } = event;
      if (i === -1) parts.push({ type: 'tool', input: {}, output: '', ...fields });
      else parts[i] = { ...parts[i], ...fields, name: fields.name || parts[i].name };
      return { ...message, parts };
    }
    case 'approval':
      if (!parts.some((p) => p.type === 'approval' && p.id === event.id)) {
        parts.push({ type: 'approval', id: event.id });
      }
      return { ...message, parts };
    case 'error':
      return { ...message, error: event.message };
    default:
      return message;
  }
}

export function useCodeSession(sessionId, { onTitle, onTurnEnd } = {}) {
  const [session, setSession] = useState(null);
  const [messages, setMessages] = useState([]);
  // Approvals by id: {id, action, resources, always, diff?, files?, decision?}
  const [approvals, setApprovals] = useState({});
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState(null);
  const streamRef = useRef(null);
  const callbacks = useRef({ onTitle, onTurnEnd });
  callbacks.current = { onTitle, onTurnEnd };

  const load = useCallback(async (id, { quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    try {
      const [{ session: info, messages: history }, pending] = await Promise.all([
        codeService.getMessages(id),
        codeService.getApprovals(id),
      ]);
      setSession(info);
      setMessages(history);
      const waiting = Object.fromEntries(pending.map((a) => [a.id, a]));
      setApprovals(waiting);
      // Approvals still waiting are shown at the end of the conversation.
      if (pending.length) {
        setMessages((list) => [
          ...list,
          { id: nextId(), role: 'assistant', parts: pending.map((a) => ({ type: 'approval', id: a.id })) },
        ]);
      }
      setError(null);
    } catch (e) {
      setError(e.message || 'Could not load this session.');
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  // Switch sessions: drop the old stream (the agent keeps working) and load.
  // A session whose first message is streaming right now (just created on the
  // landing page) is kept as it is.
  useEffect(() => {
    if (sessionId && streamRef.current?.id === sessionId) return undefined;
    streamRef.current?.close();
    streamRef.current = null;
    setStreaming(false);
    setMessages([]);
    setApprovals({});
    setSession(null);
    setError(null);
    if (sessionId) load(sessionId);
    return undefined;
  }, [sessionId, load]);

  // Leaving the Code page closes the stream; the agent keeps working.
  useEffect(() => () => {
    streamRef.current?.close();
    streamRef.current = null;
  }, []);

  const updateLive = (fn) =>
    setMessages((list) => {
      const i = list.length - 1;
      if (i < 0 || !list[i].streaming) return list;
      const copy = [...list];
      copy[i] = fn(copy[i]);
      return copy;
    });

  // Send a message in `id` (the current session, or one just created).
  const send = useCallback((id, text) => {
    if (!id || !text.trim() || streamRef.current) return;
    setError(null);
    setStreaming(true);
    setMessages((list) => [
      ...list,
      { id: nextId(), role: 'user', text },
      { id: nextId(), role: 'assistant', parts: [], streaming: true },
    ]);

    const finish = () => {
      streamRef.current = null;
      setStreaming(false);
      updateLive((m) => ({ ...m, streaming: false }));
      callbacks.current.onTurnEnd?.(id);
    };

    const handle = codeService.streamTurn(
      id,
      text,
      (event) => {
        if (event.type === 'start') {
          setSession(event.session);
        } else if (event.type === 'title') {
          setSession((s) => (s ? { ...s, title: event.title } : s));
          callbacks.current.onTitle?.(id, event.title);
        } else if (event.type === 'approval') {
          const { type: _type, ...approval } = event;
          setApprovals((all) => ({ ...all, [approval.id]: approval }));
          updateLive((m) => applyEvent(m, event));
        } else if (event.type === 'approval_done') {
          setApprovals((all) =>
            all[event.id] ? { ...all, [event.id]: { ...all[event.id], decision: event.decision } } : all,
          );
        } else if (event.type === 'done') {
          if (event.outcome === 'interrupted') {
            updateLive((m) => ({ ...m, stopped: true }));
          }
          finish();
        } else {
          updateLive((m) => applyEvent(m, event));
        }
      },
      (err) => {
        updateLive((m) => ({ ...m, error: err.message || 'The connection to the coding agent was lost.' }));
        finish();
      },
    );
    streamRef.current = { ...handle, id };
  }, []);

  // Reopened while the agent is still working (no live stream here): follow
  // along by reloading until it is done.
  const busy = Boolean(session?.busy) && !streaming;
  useEffect(() => {
    if (!busy || !sessionId) return undefined;
    const timer = setInterval(() => load(sessionId, { quiet: true }), 3000);
    return () => clearInterval(timer);
  }, [busy, sessionId, load]);

  const stop = useCallback(async () => {
    if (!session?.id) return;
    try {
      await codeService.stop(session.id);
    } catch (e) {
      setError(e.message || 'Could not stop the agent.');
    }
  }, [session?.id]);

  const answer = useCallback(async (approvalId, decision, reason) => {
    if (!session?.id) return;
    setApprovals((all) => ({ ...all, [approvalId]: { ...all[approvalId], sending: true } }));
    try {
      await codeService.answerApproval(session.id, approvalId, decision, reason);
      setApprovals((all) => ({ ...all, [approvalId]: { ...all[approvalId], sending: false, decision } }));
      // Answered after reopening the page (no live stream): refresh to see what happened next.
      if (!streamRef.current) setTimeout(() => load(session.id, { quiet: true }), 1500);
    } catch (e) {
      setApprovals((all) => ({ ...all, [approvalId]: { ...all[approvalId], sending: false } }));
      setError(e.message || 'Could not send your answer.');
    }
  }, [session?.id, load]);

  return { session, messages, approvals, loading, streaming, busy, error, setError, send, stop, answer, reload: load };
}
