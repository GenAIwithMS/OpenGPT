import axios from 'axios';

const API_BASE_URL = 'http://localhost:8000/api';

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

export const chatService = {
  // Send a message to the chatbot
  sendMessage: async (threadId, message, tools = []) => {
    const response = await api.post('/chat', {
      thread_id: threadId,
      message: message,
      tools: tools,
    });
    return response.data;
  },

  // Regenerate the last AI response for a thread (no new user message sent)
  regenerateMessage: async (threadId, tools = []) => {
    const response = await api.post('/chat/regenerate', {
      thread_id: threadId,
      tools: tools,
    });
    return response.data;
  },

  // Stream messages (using EventSource for SSE)
  streamMessage: (threadId, message, tools = [], onMessage, onError, temporary = false) => {
    const params = new URLSearchParams();
    params.set('message', message);
    // Omit thread_id for a brand-new ("New Chat") conversation so the backend
    // creates the thread and returns its id in the final `done` event.
    if (threadId) params.set('thread_id', threadId);
    if (tools.length > 0) params.set('tools', tools.join(','));
    if (temporary) params.set('temporary', 'true');
    const eventSource = new EventSource(
      `${API_BASE_URL}/chat/stream?${params.toString()}`
    );

    eventSource.onmessage = (event) => {
      if (event.data === '[DONE]') {
        eventSource.close();
        return;
      }
      try {
        const data = JSON.parse(event.data);
        // Close on terminal events so the browser doesn't surface a false
        // "connection closed" error when the backend ends the stream.
        if (data.done || data.error) {
          eventSource.close();
        }
        onMessage(data);
      } catch (error) {
        console.error('Error parsing message:', error);
      }
    };

    eventSource.onerror = (error) => {
      // EventSource fires "error" on a normal connection close too. Only surface
      // it as a real error if the connection is still open/connecting.
      if (eventSource.readyState !== EventSource.CLOSED) {
        console.error('EventSource error:', error);
        eventSource.close();
        if (onError) onError(error);
      }
    };

    return eventSource;
  },

  // Edit a previously sent user message and stream the regenerated response.
  // Uses POST (because editing mutates state) with a manual SSE read.
  editStream: (threadId, message, index, tools = [], onMessage, onError) => {
    const body = {
      thread_id: threadId,
      message: message,
      index: index,
      tools: tools.length > 0 ? tools : undefined,
    };

    fetch(`${API_BASE_URL}/chat/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then((response) => {
        if (!response.ok) {
          if (onError) onError(new Error(`Edit failed (${response.status})`));
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        const read = () => {
          reader.read().then(({ done, value }) => {
            if (done) return;
            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split('\n\n');
            buffer = parts.pop() || '';
            for (const part of parts) {
              const trimmed = part.trim();
              if (!trimmed.startsWith('data:')) continue;
              const data = trimmed.slice(5).trim();
              if (data === '[DONE]') continue;
              try {
                onMessage(JSON.parse(data));
              } catch (error) {
                console.error('Error parsing message:', error);
              }
            }
            read();
          }).catch((err) => {
            console.error('Edit stream error:', err);
            if (onError) onError(err);
          });
        };

        read();
      })
      .catch((err) => {
        console.error('Edit fetch error:', err);
        if (onError) onError(err);
      });
  },

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
    formData.append('thread_id', threadId);

    const response = await api.post('/upload-pdf', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    return response.data;
  },

  // Query document
  queryDocument: async (threadId, query) => {
    const response = await api.post('/query-document', {
      thread_id: threadId,
      query: query,
    });
    return response.data;
  },

  // Get document info
  getDocumentInfo: async (threadId) => {
    const response = await api.get(`/threads/${threadId}/document`);
    return response.data;
  },
};
