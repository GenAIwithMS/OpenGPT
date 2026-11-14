import axios from 'axios';

const API_BASE_URL = 'http://localhost:8000/api';

// Optional API token (VITE_API_TOKEN in frontend/.env.local). It must match
// API_TOKEN in backend/.env when the backend requires one.
const API_TOKEN = import.meta.env.VITE_API_TOKEN;
const authHeaders = () => (API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {});

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
    ...authHeaders(),
  },
});

// POST a JSON body and read the Server-Sent Events reply. Returns an object
// with close(), which aborts the request (used by the Stop button).
// A stream that ends without a `done` or `error` event is reported as an error.
const postStream = (path, body, onMessage, onError) => {
  const controller = new AbortController();
  let finished = false;
  const fail = (err) => {
    if (finished || controller.signal.aborted) return;
    finished = true;
    console.error('Stream error:', err);
    if (onError) onError(err);
  };

  fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
    signal: controller.signal,
  })
    .then(async (response) => {
      if (!response.ok) {
        let detail = `Request failed (${response.status})`;
        try {
          const err = await response.json();
          // App errors: {error: {message}}. Request validation: {detail: [{msg}]}.
          const validation = Array.isArray(err?.detail) ? err.detail[0]?.msg : err?.detail;
          detail = err?.error?.message || validation || detail;
        } catch { /* not JSON */ }
        fail(new Error(detail));
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';
        for (const part of parts) {
          const trimmed = part.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') continue;
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch (error) {
            console.error('Error parsing message:', error);
            continue;
          }
          if (parsed.done || parsed.error) finished = true;
          onMessage(parsed);
        }
      }
      if (!finished) fail(new Error('The connection closed before the reply finished.'));
    })
    .catch(fail);

  return { close: () => controller.abort() };
};

export const chatService = {
  // Regenerate the last AI response for a thread (no new user message sent)
  regenerateMessage: async (threadId, tools = []) => {
    const response = await api.post('/chat/regenerate', {
      thread_id: threadId,
      tools: tools,
    });
    return response.data;
  },

  // Stream a chat reply. The message goes in a POST body, not the URL, so it
  // never lands in server logs or browser history.
  // `tempSessionId` is set only for temporary chats: it marks the chat as
  // session-only and keeps each temporary chat's memory separate.
  streamMessage: (threadId, message, tools = [], onMessage, onError, tempSessionId = null) =>
    postStream(
      '/chat/stream',
      {
        message,
        // Omit thread_id for a brand-new chat; the backend creates the thread
        // and returns its id in the final `done` event.
        thread_id: threadId || undefined,
        tools: tools.length > 0 ? tools : undefined,
        temporary: Boolean(tempSessionId),
        session_id: tempSessionId || undefined,
      },
      onMessage,
      onError,
    ),

  // Tell the backend to forget a temporary chat's memory. `keepalive` lets the
  // request finish even while the tab is closing.
  endTempSession: (tempSessionId) => {
    if (!tempSessionId) return;
    fetch(`${API_BASE_URL}/chat/temp/${encodeURIComponent(tempSessionId)}/end`, {
      method: 'POST',
      keepalive: true,
      headers: authHeaders(),
    }).catch(() => {});
  },

  // Edit a previously sent user message and stream the regenerated response.
  editStream: (threadId, message, index, tools = [], onMessage, onError) =>
    postStream(
      '/chat/edit',
      {
        thread_id: threadId,
        message,
        index,
        tools: tools.length > 0 ? tools : undefined,
      },
      onMessage,
      onError,
    ),

  // Get all threads
  getThreads: async () => {
    const response = await api.get('/threads');
    return response.data.threads;
  },

  // Create a new thread
  createThread: async () => {
    const response = await api.post('/threads/new');
    return response.data;
  },

  // Get messages from a specific thread
  getThreadMessages: async (threadId) => {
    const response = await api.get(`/threads/${threadId}`);
    return response.data;
  },

  // Update thread title
  // Save an edited deep research report (reportIndex: its position among the
  // thread's deep research answers)
  updateReport: async (threadId, reportIndex, content) => {
    const response = await api.put(`/threads/${threadId}/reports/${reportIndex}`, { content });
    return response.data;
  },

  updateThreadTitle: async (threadId, title) => {
    const response = await api.put(`/threads/${threadId}/title`, { title });
    return response.data;
  },

  // Delete thread
  deleteThread: async (threadId) => {
    const response = await api.delete(`/threads/${threadId}`);
    return response.data;
  },

  // Upload PDF
  uploadPDF: async (threadId, file) => {
    const formData = new FormData();
    formData.append('file', file);
    // A new chat has no thread yet. Leave the field out so the backend creates
    // one; appending null would send the literal string "null".
    if (threadId) formData.append('thread_id', threadId);

    const response = await api.post('/upload-pdf', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    return response.data;
  },
};
