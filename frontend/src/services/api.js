import axios from 'axios';

// Backend base URL. The Vite dev server proxies /api to the backend; set
// VITE_API_URL (e.g. https://api.example.com/api) when it lives elsewhere.
const API_BASE_URL = import.meta.env.VITE_API_URL || '/api';

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

// Pull the readable message out of a backend error body.
// App errors: {error: {message}}. Request validation: {detail: [{msg}]}.
const errorMessageFrom = (body) => {
  if (!body || typeof body !== 'object') return null;
  const validation = Array.isArray(body.detail) ? body.detail[0]?.msg : body.detail;
  return body.error?.message || (typeof validation === 'string' ? validation : null);
};

// Show the backend's message instead of axios' "Request failed with status code 400".
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const message = errorMessageFrom(error.response?.data);
    if (message) error.message = message;
    return Promise.reject(error);
  },
);

const enc = encodeURIComponent;

// POST a JSON body and read the Server-Sent Events reply. Returns an object
// with close(), which aborts the request (used by the Stop button).
// A stream that ends without a final event (by default `done` or `error`) is
// reported as an error.
const isChatFinal = (event) => Boolean(event.done || event.error);
const postStream = (path, body, onMessage, onError, isFinal = isChatFinal) => {
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
          detail = errorMessageFrom(await response.json()) || detail;
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
          if (isFinal(parsed)) finished = true;
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
    fetch(`${API_BASE_URL}/chat/temp/${enc(tempSessionId)}/end`, {
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

  // Answer a connector tool's question in chat: decision 'allow' | 'deny'.
  answerApproval: async (approvalId, decision) => {
    await api.post(`/chat/approvals/${enc(approvalId)}`, { decision });
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
    const response = await api.get(`/threads/${enc(threadId)}`);
    return response.data;
  },

  // Save an edited deep research report (reportIndex: its position among the
  // thread's deep research answers)
  updateReport: async (threadId, reportIndex, content) => {
    const response = await api.put(`/threads/${enc(threadId)}/reports/${enc(reportIndex)}`, { content });
    return response.data;
  },

  // Update thread title
  updateThreadTitle: async (threadId, title) => {
    const response = await api.put(`/threads/${enc(threadId)}/title`, { title });
    return response.data;
  },

  // Delete thread
  deleteThread: async (threadId) => {
    const response = await api.delete(`/threads/${enc(threadId)}`);
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

// App settings (the Settings popup). See backend/app/services/settings.py.
export const settingsService = {
  // {profile, general, display_name}
  get: async () => (await api.get('/settings')).data,
  // Partial update, e.g. {general: {sound_on_finish: true}}; returns all settings.
  update: async (changes) => (await api.put('/settings', changes)).data,

  // Knowledge base: {files: [{id, filename, chunks, pages}], max_files, max_mb}
  listKnowledge: async () => (await api.get('/settings/knowledge')).data,
  addKnowledge: async (file) => {
    const form = new FormData();
    form.append('file', file);
    return (await api.post('/settings/knowledge', form, { headers: { 'Content-Type': 'multipart/form-data' } })).data;
  },
  removeKnowledge: async (id) => { await api.delete(`/settings/knowledge/${enc(id)}`); },
};

// Connectors (MCP servers). See backend/app/router/connectors.py.
export const connectorsService = {
  list: async () => (await api.get('/connectors')).data.connectors,
  catalog: async () => (await api.get('/connectors/catalog')).data.catalog,
  // {name, kind: 'local'|'remote', command?, url?, env?, headers?}
  create: async (body) => (await api.post('/connectors', body)).data,
  addFromCatalog: async (id, values = {}) => (await api.post(`/connectors/catalog/${enc(id)}`, { values })).data,
  importJson: async (json) => (await api.post('/connectors/import', { json })).data.connectors,
  update: async (id, changes) => (await api.put(`/connectors/${enc(id)}`, changes)).data,
  remove: async (id) => { await api.delete(`/connectors/${enc(id)}`); },
  // Sign in: {catalog_id} | {name, url} | {connector_id}. Returns {authorize_url} (page to open)
  // or {device: {flow_id, user_code, verification_uri, interval}} (enter a code, e.g. GitHub).
  startSignIn: async (target) => (await api.post('/connectors/oauth/start', target)).data,
  // Device sign-in: {status: 'pending'|'done'|'denied'|'expired', connector?}
  pollDeviceSignIn: async (flowId) => (await api.post(`/connectors/oauth/device/${enc(flowId)}`)).data,
};

// Skills. See backend/app/router/skills.py. Ids look like "builtin/name",
// "personal/name" or "local/claude/name" (sent as a path, so not encoded).
const skillPath = (id) => id.split('/').map(enc).join('/');
export const skillsService = {
  list: async () => (await api.get('/skills')).data.skills,
  get: async (id) => (await api.get(`/skills/item/${skillPath(id)}`)).data,
  setEnabled: async (id, enabled) => (await api.put(`/skills/item/${skillPath(id)}`, { enabled })).data,
  saveContent: async (id, skillMd) => (await api.put(`/skills/content/${skillPath(id)}`, { skill_md: skillMd })).data,
  remove: async (id) => { await api.delete(`/skills/item/${skillPath(id)}`); },
  create: async (body) => (await api.post('/skills', body)).data,
  upload: async (file, replace = false) => {
    const form = new FormData();
    form.append('file', file);
    form.append('replace', replace ? 'true' : 'false');
    return (await api.post('/skills/upload', form, { headers: { 'Content-Type': 'multipart/form-data' } })).data.skills;
  },
  importGithub: async (url, replace = false) => (await api.post('/skills/import', { url, replace })).data.skills,
  catalog: async () => (await api.get('/skills/catalog')).data.catalog,
  install: async (id) => (await api.post(`/skills/catalog/${enc(id)}`)).data,
};

// Model providers (Settings > Developer). See backend/app/router/providers.py.
export const providersService = {
  // {env, providers, active, roles, presets}
  overview: async () => (await api.get('/providers')).data,
  create: async (body) => (await api.post('/providers', body)).data,
  update: async (id, changes) => (await api.put(`/providers/${enc(id)}`, changes)).data,
  remove: async (id) => { await api.delete(`/providers/${enc(id)}`); },
  // {provider_id} for a saved one ('env' for backend/.env), or {preset, kind, base_url, api_key}
  test: async (body) => (await api.post('/providers/test', body)).data.models,
  setActive: async (active, roles) => (await api.put('/providers/active', { active, roles })).data,
};

// Coding agent (the Code page). See backend/app/router/code.py.
export const codeService = {
  getStatus: async () => (await api.get('/code/status')).data,

  // {projects, projects_root, can_browse}
  getProjects: async () => (await api.get('/code/projects')).data,
  createProject: async (name) => (await api.post('/code/projects', { name })).data,
  openProject: async (path) => (await api.post('/code/projects/open', { path })).data,
  removeProject: async (id) => { await api.delete(`/code/projects/${enc(id)}`); },
  // A folder's subfolders: {path, name, parent, roots, can_open, entries: [{name, path}]}
  browseFolders: async (path) => (await api.get('/code/folders', { params: path ? { path } : {} })).data,

  getSessions: async (project) => (await api.get('/code/sessions', { params: { project } })).data.sessions,
  createSession: async (project, title) => (await api.post('/code/sessions', { project, title })).data,
  renameSession: async (id, title) => (await api.put(`/code/sessions/${enc(id)}/title`, { title })).data,
  deleteSession: async (id) => { await api.delete(`/code/sessions/${enc(id)}`); },
  getMessages: async (id) => (await api.get(`/code/sessions/${enc(id)}/messages`)).data,

  // Send a message and stream the agent's work. Events: start, text,
  // reasoning, tool, approval, approval_done, title, error, done.
  streamTurn: (id, text, onEvent, onError) =>
    postStream(`/code/sessions/${enc(id)}/stream`, { text }, onEvent, onError, (e) => e.type === 'done'),
  stop: async (id) => (await api.post(`/code/sessions/${enc(id)}/stop`)).data,

  getApprovals: async (id) => (await api.get(`/code/sessions/${enc(id)}/approvals`)).data.approvals,
  answerApproval: async (id, approvalId, decision, reason) => {
    await api.post(`/code/sessions/${enc(id)}/approvals/${enc(approvalId)}`, { decision, reason: reason || undefined });
  },
  getSavedApprovals: async (project) => (await api.get(`/code/projects/${enc(project)}/approvals`)).data.approvals,
  revokeSavedApproval: async (project, savedId) => {
    await api.delete(`/code/projects/${enc(project)}/approvals/${enc(savedId)}`);
  },
};
