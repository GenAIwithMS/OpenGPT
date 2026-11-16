import { useCallback, useEffect, useState } from 'react';
import { codeService } from '../services/api';

const PROJECT_KEY = 'opengpt.code.project';

const readProject = () => {
  try {
    return localStorage.getItem(PROJECT_KEY) || null;
  } catch {
    return null;
  }
};

// Code page state shared with the sidebar: agent status, projects, the chosen
// project and its sessions. Only active while the Code page is open.
export function useCodeWorkspace(active) {
  const [status, setStatus] = useState(null);
  const [projects, setProjects] = useState([]);
  const [project, setProjectState] = useState(readProject);
  const [sessions, setSessions] = useState([]);
  const [error, setError] = useState(null);

  const setProject = useCallback((name) => {
    setProjectState(name);
    try {
      if (name) localStorage.setItem(PROJECT_KEY, name);
      else localStorage.removeItem(PROJECT_KEY);
    } catch { /* storage unavailable */ }
  }, []);

  // Agent status; rechecked every few seconds until it is ready.
  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    let timer;
    const check = async () => {
      try {
        const next = await codeService.getStatus();
        if (cancelled) return;
        setStatus(next);
        if (!next.available && next.state === 'starting') timer = setTimeout(check, 3000);
      } catch (e) {
        if (!cancelled) setStatus({ available: false, state: 'unavailable', detail: e.message });
      }
    };
    check();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [active]);

  const refreshProjects = useCallback(async () => {
    try {
      const list = await codeService.getProjects();
      setProjects(list);
      // Forget a remembered project that no longer exists.
      setProjectState((current) => (current && !list.some((p) => p.name === current) ? null : current));
    } catch (e) {
      setError(e.message);
    }
  }, []);

  const refreshSessions = useCallback(async () => {
    if (!project || !status?.available) {
      setSessions([]);
      return;
    }
    try {
      setSessions(await codeService.getSessions(project));
    } catch (e) {
      setError(e.message);
    }
  }, [project, status?.available]);

  useEffect(() => { if (active) refreshProjects(); }, [active, refreshProjects]);
  useEffect(() => { if (active) refreshSessions(); }, [active, refreshSessions]);

  const renameSession = useCallback(async (id, title) => {
    await codeService.renameSession(id, title);
    refreshSessions();
  }, [refreshSessions]);

  const deleteSession = useCallback(async (id) => {
    await codeService.deleteSession(id);
    setSessions((list) => list.filter((s) => s.id !== id));
  }, []);

  return {
    status, projects, project, setProject, sessions, error, setError,
    refreshProjects, refreshSessions, renameSession, deleteSession,
  };
}
