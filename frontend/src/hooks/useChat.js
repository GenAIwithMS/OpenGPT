import { useState, useEffect, useRef } from 'react';
import { chatService } from '../services/api';
import { saveMessageAttachments, withStoredAttachments } from '../lib/attachmentPreview';

const STATUS_LINE = /^(Thinking\.\.\.|Using .+\.\.\.|Finished using .+\.)$/;

// Stable per-message ids, used as React keys and to find a stream's placeholder.
let messageSeq = 0;
const newMessageId = () => `m${Date.now().toString(36)}-${++messageSeq}`;
const withId = (m) => (m.id ? m : { ...m, id: newMessageId() });

const aiPlaceholder = (extra = {}) => ({
  id: newMessageId(),
  type: 'ai',
  content: '',
  timestamp: new Date().toISOString(),
  streaming: true,
  ...extra,
});

const researchPlaceholder = () => aiPlaceholder({ tool_used: 'deep_research', research: [] });

// Random id for one temporary chat session, so temporary chats never share memory.
const newTempSessionId = () =>
  (globalThis.crypto?.randomUUID?.() ??
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    }));

const BLOG_STEPS = [
  { label: 'Routing...', status: 'in-progress' },
  { label: 'Researching...', status: 'pending' },
  { label: 'Planning...', status: 'pending' },
  { label: 'Writing sections...', status: 'pending' },
  { label: 'Finalizing...', status: 'pending' },
];

// Blog progress events: which step finishes for each graph node.
const BLOG_NODE_STEP = {
  router: ['Routing...', 'Researching...'],
  research: ['Researching...', 'Planning...'],
  orchestrator: ['Planning...', 'Writing sections...'],
};

export const useChat = (threadId, onThreadCreated, skipLoadRef, isTempChat = false) => {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [streamingProgress, setStreamingProgress] = useState(null);
  const eventSourceRef = useRef(null);
  // Bumped whenever a request starts or is abandoned; replies from an older
  // request (another thread, a stopped stream) are dropped.
  const requestIdRef = useRef(0);
  const loadIdRef = useRef(0);
  const tempSessionRef = useRef(newTempSessionId());
  // True once the current temporary session has sent a message to the backend.
  const tempUsedRef = useRef(false);

  // Free the current temporary chat's server memory and start a fresh session.
  const endTempSession = () => {
    if (tempUsedRef.current) {
      chatService.endTempSession(tempSessionRef.current);
      tempUsedRef.current = false;
    }
    tempSessionRef.current = newTempSessionId();
  };

  const claimTempSession = () => {
    tempUsedRef.current = true;
    return tempSessionRef.current;
  };

  // Close the active stream (if any) and invalidate every pending request.
  const abandonRequests = () => {
    requestIdRef.current += 1;
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  };

  const startRequest = () => {
    abandonRequests();
    return requestIdRef.current;
  };

  const isCurrent = (requestId) => requestIdRef.current === requestId;

  // Closing or reloading the tab also ends the temporary chat.
  useEffect(() => {
    const onUnload = () => {
      if (tempUsedRef.current) chatService.endTempSession(tempSessionRef.current);
    };
    window.addEventListener('pagehide', onUnload);
    return () => {
      window.removeEventListener('pagehide', onUnload);
      abandonRequests();
    };
  }, []);

  useEffect(() => {
    // Any switch (new chat, another thread, leaving temporary mode) ends the
    // previous temporary chat, so a new one never sees its memory.
    endTempSession();
    // When a brand-new thread was just created by our own stream, the UI
    // already holds the messages and the stream may still be running: keep it
    // and skip the reload.
    if (threadId && skipLoadRef?.current) {
      skipLoadRef.current = false;
      return;
    }
    abandonRequests();
    setStreamingProgress(null);
    setLoading(false);
    setError(null);
    if (threadId) {
      loadMessages();
    } else {
      loadIdRef.current += 1;
      setMessages([]);
    }
  }, [threadId, isTempChat]);

  const loadMessages = async () => {
    if (!threadId) return;
    const loadId = ++loadIdRef.current;
    const forThread = threadId;

    try {
      setLoading(true);
      const data = await chatService.getThreadMessages(forThread);
      if (loadIdRef.current !== loadId) return;
      setMessages(withStoredAttachments(forThread, data.messages || []).map(withId));
      setError(null);
    } catch (err) {
      if (loadIdRef.current !== loadId) return;
      setError(err.message);
      console.error('Error loading messages:', err);
    } finally {
      if (loadIdRef.current === loadId) setLoading(false);
    }
  };

  // Start a fresh "new chat" even while its first reply is still streaming.
  const reset = () => {
    abandonRequests();
    loadIdRef.current += 1;
    endTempSession();
    setMessages([]);
    setStreamingProgress(null);
    setLoading(false);
    setError(null);
  };

  const updateMessage = (id, fn) =>
    setMessages(prev => prev.map(m => (m.id === id ? fn(m) : m)));

  // End a stream with an error: keep any partial text, drop an empty bubble.
  const failStream = (placeholderId, message) => {
    setError(message || 'Something went wrong while generating the reply.');
    setMessages(prev =>
      prev.flatMap(m => {
        if (m.id !== placeholderId) return [m];
        const hasContent = !!m.content || (m.research && m.research.length > 0);
        return hasContent ? [{ ...m, streaming: false, unsaved: true }] : [];
      })
    );
    setStreamingProgress(null);
    setLoading(false);
    eventSourceRef.current = null;
  };

  const finishStream = (placeholderId, data, originThreadId) => {
    // If the backend created a brand-new thread (first message in a New Chat),
    // update the URL silently via the callback from App.
    if (data.thread_id && onThreadCreated && data.thread_id !== originThreadId) {
      onThreadCreated(data.thread_id);
    }
    updateMessage(placeholderId, m => ({ ...m, streaming: false }));
    setStreamingProgress(null);
    setLoading(false);
    eventSourceRef.current = null;
  };

  // SSE handler for the chatbot and deep research paths (token streaming,
  // live thinking and research activity), bound to one request and bubble.
  const chatHandlers = (requestId, placeholderId, originThreadId) => {
    const onMessage = (data) => {
      if (!isCurrent(requestId)) return;
      if (data.error) {
        failStream(placeholderId, data.error);
        return;
      }

      if (data.message_type === 'thinking') {
        // Thinking events are either short status lines ("Using search...") or
        // token chunks of the model's reasoning. Status lines become the label;
        // reasoning tokens are appended into one running text.
        const isStatus = STATUS_LINE.test(data.content);
        setStreamingProgress(prev => {
          if (!prev) return prev;
          return isStatus
            ? { ...prev, current: data.content }
            : { ...prev, reasoning: (prev.reasoning || '') + data.content };
        });
      } else if (data.message_type === 'research') {
        // Deep research activity (planning, searches, sources, ...) is kept on
        // the message so it stays with the conversation.
        updateMessage(placeholderId, m => ({ ...m, research: [...(m.research || []), data.event] }));
      } else if (data.message_type === 'ai_replace') {
        // Final answer with citation markers rewritten as source links
        updateMessage(placeholderId, m => ({ ...m, content: data.content }));
      } else if (data.message_type === 'ai') {
        // The answer has started — the thinking row steps aside.
        setStreamingProgress(prev =>
          prev && !prev.answering ? { ...prev, answering: true } : prev
        );
        updateMessage(placeholderId, m => ({ ...m, content: m.content + data.content }));
      }

      if (data.done) finishStream(placeholderId, data, originThreadId);
    };
    const onError = (err) => {
      if (!isCurrent(requestId)) return;
      failStream(placeholderId, err?.message);
    };
    return [onMessage, onError];
  };

  const blogHandlers = (requestId, placeholderId, originThreadId) => {
    let aiResponse = '';

    const setStep = (label, status, details) =>
      setStreamingProgress(prev => {
        if (!prev?.steps) return prev;
        const idx = prev.steps.findIndex(s => s.label === label);
        if (idx === -1) return prev;
        const steps = prev.steps.map((s, i) => {
          if (i === idx) return { ...s, status, ...(details !== undefined ? { details } : {}) };
          // Earlier steps are done once a later one moves
          return i < idx && s.status !== 'completed' ? { ...s, status: 'completed' } : s;
        });
        return { ...prev, steps };
      });

    const onMessage = (data) => {
      if (!isCurrent(requestId)) return;
      if (data.error) {
        failStream(placeholderId, data.error);
        return;
      }

      if (data.message_type === 'progress') {
        const step = BLOG_NODE_STEP[data.node];
        if (step) {
          setStep(step[0], 'completed', data.content);
          setStep(step[1], 'in-progress');
        } else if (data.node === 'worker') {
          setStreamingProgress(prev => {
            if (!prev?.steps) return prev;
            const steps = prev.steps.map(s => {
              if (s.label !== 'Writing sections...') return s;
              const count = (s.sectionCount || 0) + 1;
              return { ...s, sectionCount: count, details: `${count} sections completed` };
            });
            return { ...prev, steps };
          });
        }
      } else if (data.message_type === 'ai') {
        aiResponse += data.content;
        setStep('Finalizing...', 'completed');
      }

      if (data.done) {
        updateMessage(placeholderId, m => ({ ...m, content: aiResponse }));
        finishStream(placeholderId, data, originThreadId);
      }
    };
    const onError = (err) => {
      if (!isCurrent(requestId)) return;
      failStream(placeholderId, err?.message);
    };
    return [onMessage, onError];
  };

  // Returns true when the message was sent. Throws when an attached document
  // could not be uploaded; the error carries `remainingAttachments` (the ones
  // not uploaded yet) so the caller can put them back for a retry.
  const sendMessage = async (message, tools = [], threadIdOverride = null, attachments = []) => {
    if (!message.trim()) return false;

    const requestId = startRequest();
    const activeThreadId = threadIdOverride || threadId;

    // Optimistically render the user's message right away (with any attached
    // documents) so it appears instantly — no waiting on network round-trips.
    const userMessage = {
      id: newMessageId(),
      type: 'human',
      content: message,
      timestamp: new Date().toISOString(),
      tools: tools.length > 0 ? tools : undefined,
      attachments: attachments.length > 0
        ? attachments.map((a) => ({
            name: a.file?.name || a.name,
            size: a.file?.size,
            type: a.file?.type,
            file: a.file,
            preview: a.preview,
          }))
        : undefined,
    };
    const humanIndex = messages.filter((m) => m.type === 'human').length;
    setMessages(prev => [...prev, userMessage]);
    setLoading(true);
    setError(null);

    // Upload attached documents before streaming so the AI sees them with
    // this prompt (and the doc is linked to the same thread as the message).
    let uploadThreadId = activeThreadId;
    for (let i = 0; i < attachments.length; i++) {
      try {
        const response = await chatService.uploadPDF(uploadThreadId, attachments[i].file);
        if (response.thread_id) uploadThreadId = response.thread_id;
      } catch (err) {
        console.error('Error uploading document:', err);
        if (!isCurrent(requestId)) return false;
        // Take the message back so the user can retry it as is.
        setMessages(prev => prev.filter(m => m.id !== userMessage.id));
        setError(err.message || 'Could not upload the document.');
        setLoading(false);
        // A new chat may already exist from an earlier file; keep using it.
        if (uploadThreadId && uploadThreadId !== activeThreadId && onThreadCreated) {
          onThreadCreated(uploadThreadId);
        }
        const failure = new Error(err.message || 'Could not upload the document.');
        failure.remainingAttachments = attachments.slice(i);
        throw failure;
      }
      // The user switched chats while the file was uploading.
      if (!isCurrent(requestId)) return false;
    }
    if (uploadThreadId && uploadThreadId !== activeThreadId && onThreadCreated) {
      onThreadCreated(uploadThreadId);
    }
    const streamThreadId = uploadThreadId;
    saveMessageAttachments(streamThreadId, humanIndex, userMessage.attachments);
    const tempSession = isTempChat ? claimTempSession() : null;

    // Blogs tool: fixed-step progress UI, the post is shown when it is done
    if (tools.includes('blogs')) {
      const placeholder = aiPlaceholder();
      setStreamingProgress({ isStreaming: true, toolName: 'blogs', steps: BLOG_STEPS });
      setMessages(prev => [...prev, placeholder]);
      const [onMessage, onError] = blogHandlers(requestId, placeholder.id, streamThreadId);
      eventSourceRef.current = chatService.streamMessage(streamThreadId, message, tools, onMessage, onError, tempSession);
      return true;
    }

    // Deep Research tool: the run's activity streams into the message itself
    // (shown in the research side panel) and the report streams in as content.
    if (tools.includes('deep_research')) {
      const placeholder = researchPlaceholder();
      setStreamingProgress({ isStreaming: true, toolName: 'deep_research' });
      setMessages(prev => [...prev, placeholder]);
      const [onMessage, onError] = chatHandlers(requestId, placeholder.id, streamThreadId);
      eventSourceRef.current = chatService.streamMessage(streamThreadId, message, tools, onMessage, onError, tempSession);
      return true;
    }

    // Chatbot path: live thinking bar + token streaming into a placeholder message
    const placeholder = aiPlaceholder();
    setStreamingProgress({
      isStreaming: true,
      toolName: 'chat',
      current: 'Thinking...',
      reasoning: '',
    });
    setMessages(prev => [...prev, placeholder]);
    const [onMessage, onError] = chatHandlers(requestId, placeholder.id, streamThreadId);
    eventSourceRef.current = chatService.streamMessage(streamThreadId, message, tools, onMessage, onError, tempSession);
    return true;
  };

  const regenerate = async () => {
    if (!threadId) return;

    const lastHuman = [...messages].reverse().find(m => m.type === 'human');
    if (!lastHuman) return;

    const tools = lastHuman.tools && lastHuman.tools.length > 0 ? lastHuman.tools : [];

    // Deep research re-runs through the streaming edit flow so its activity
    // is shown live again.
    if (tools.includes('deep_research')) {
      return editMessage(lastHuman.content, messages.lastIndexOf(lastHuman));
    }

    const requestId = startRequest();
    const placeholder = aiPlaceholder();
    let previous = null;
    try {
      setLoading(true);
      setError(null);
      setStreamingProgress({
        isStreaming: true,
        toolName: 'chat',
        current: 'Regenerating response...',
        reasoning: '',
      });

      // Swap the trailing AI message for a placeholder that fills live
      const last = messages[messages.length - 1];
      previous = last?.type === 'ai' ? last : null;
      setMessages(prev => [...(previous ? prev.slice(0, -1) : prev), placeholder]);

      const response = await chatService.regenerateMessage(threadId, tools);
      if (!isCurrent(requestId)) return;
      updateMessage(placeholder.id, m => ({ ...m, content: response.response, streaming: false }));
      setLoading(false);
      setStreamingProgress(null);
    } catch (err) {
      console.error('Error regenerating:', err);
      if (!isCurrent(requestId)) return;
      // Put the old answer back
      setMessages(prev => prev.flatMap(m => (m.id === placeholder.id ? (previous ? [previous] : []) : [m])));
      setError(err.message);
      setLoading(false);
      setStreamingProgress(null);
    }
  };

  const editMessage = async (newContent, messageIndex) => {
    if (!threadId || !newContent.trim()) return;

    // 0-based index of the edited human message among all human turns
    const humanIndex = messages.slice(0, messageIndex + 1).filter(m => m.type === 'human').length - 1;
    const targetMsg = messages[messageIndex];
    const tools = targetMsg?.tools && targetMsg.tools.length > 0 ? targetMsg.tools : [];

    const requestId = startRequest();
    setLoading(true);
    setError(null);
    const isResearch = tools.includes('deep_research');
    setStreamingProgress(
      isResearch
        ? { isStreaming: true, toolName: 'deep_research' }
        : { isStreaming: true, toolName: 'chat', current: 'Updating...', reasoning: '' }
    );

    // Rewrite the edited message, drop everything after it, and add a
    // placeholder bubble that fills live (like regenerate).
    const placeholder = isResearch ? researchPlaceholder() : aiPlaceholder();
    setMessages(prev => {
      const updated = prev.slice(0, messageIndex + 1);
      updated[messageIndex] = { ...updated[messageIndex], content: newContent, streaming: false };
      updated.push(placeholder);
      return updated;
    });

    const [onMessage, onError] = chatHandlers(requestId, placeholder.id, threadId);
    eventSourceRef.current = chatService.editStream(threadId, newContent, humanIndex, tools, onMessage, onError);
  };

  // Abort an in-flight generation. The backend keeps a chat answer's partial
  // text, so the partial answer and the user's message both stay in the chat.
  // A bubble with nothing in it yet is removed.
  const stop = () => {
    abandonRequests();
    setLoading(false);
    setStreamingProgress(null);
    setMessages(prev =>
      prev.flatMap(m => {
        if (!m.streaming) return [m];
        const hasContent = !!m.content || (m.research && m.research.length > 0);
        if (!hasContent) return [];
        // Only the chat path saves a stopped answer on the server.
        const saved = !isTempChat && m.tool_used !== 'deep_research';
        return [{ ...m, streaming: false, ...(saved ? {} : { unsaved: true }) }];
      })
    );
  };

  // Replace a deep research report's text (edited in the side panel) and save
  // it to the thread when the report exists there.
  const updateReport = async (messageIndex, content) => {
    const target = messages[messageIndex];
    if (!target) return;
    const isSavedReport = (m) => m.type === 'ai' && m.tool_used === 'deep_research' && !m.unsaved;
    if (threadId && !isTempChat && isSavedReport(target)) {
      const reportIndex = messages.slice(0, messageIndex).filter(isSavedReport).length;
      await chatService.updateReport(threadId, reportIndex, content);
    }
    setMessages(prev => prev.map((m, i) => (i === messageIndex ? { ...m, content } : m)));
  };

  return {
    messages,
    updateReport,
    loading,
    error,
    clearError: () => setError(null),
    sendMessage,
    regenerate,
    editMessage,
    loadMessages,
    reset,
    streamingProgress,
    stop,
  };
};
