import { useCallback, useEffect, useState } from 'react';
import { codeService } from '../services/api';

const PROJECT_KEY = 'opengpt.code.projectId';

const readProject = () => {
  try {
    return localStorage.getItem(PROJECT_KEY) || null;
  } catch {
    return null;
  }
};

// Code page state shared with the sidebar: agent status, project folders, the
// chosen project (by id) and its sessions. Only active while the Code page is open.
export function useCodeWorkspace(active) {
  const [status, setStatus] = useState(null);
  const [projects, setProjects] = useState([]);
  const [projectsRoot, setProjectsRoot] = useState('');
  const [canBrowse, setCanBrowse] = useState(false);
  const [projectId, setProjectIdState] = useState(readProject);
  const [sessions, setSessions] = useState([]);
  const [error, setError] = useState(null);

  const setProject = useCallback((id) => {
    setProjectIdState(id);
    try {
      if (id) localStorage.setItem(PROJECT_KEY, id);
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
      const data = await codeService.getProjects();
      setProjects(data.projects);
      setProjectsRoot(data.projects_root);
      setCanBrowse(data.can_browse);
      // Forget a remembered project that is no longer in the list.
      setProjectIdState((current) => (current && !data.projects.some((p) => p.id === current) ? null : current));
    } catch (e) {
      setError(e.message);
    }
  }, []);

  const project = projects.find((p) => p.id === projectId) || null;

  const refreshSessions = useCallback(async () => {
    if (!projectId || !status?.available) {
      setSessions([]);
      return;
    }
    try {
      setSessions(await codeService.getSessions(projectId));
    } catch (e) {
      setSessions([]);
      setError(e.message);
    }
  }, [projectId, status?.available]);

  useEffect(() => { if (active) refreshProjects(); }, [active, refreshProjects]);
  useEffect(() => { if (active) refreshSessions(); }, [active, refreshSessions]);

  // A project was opened or created: select it and refresh the list.
  const addProject = useCallback(async (info) => {
    setProject(info.id);
    await refreshProjects();
  }, [setProject, refreshProjects]);

  const removeProject = useCallback(async (id) => {
    await codeService.removeProject(id);
    if (id === projectId) setProject(null);
    await refreshProjects();
  }, [projectId, setProject, refreshProjects]);

  const renameSession = useCallback(async (id, title) => {
    await codeService.renameSession(id, title);
    refreshSessions();
  }, [refreshSessions]);

  const deleteSession = useCallback(async (id) => {
    await codeService.deleteSession(id);
    setSessions((list) => list.filter((s) => s.id !== id));
  }, []);

  return {
    status, projects, projectsRoot, canBrowse, projectId, project, setProject, addProject, removeProject,
    sessions, error, setError, refreshProjects, refreshSessions, renameSession, deleteSession,
  };
}
