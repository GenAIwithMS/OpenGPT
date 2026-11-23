import { useCallback, useEffect, useRef, useState } from 'react';
import { agentService } from '../services/api';
import { notifyFinished } from '../lib/notify';

const ACTIVE = new Set(['queued', 'running']);

/**
 * Agent sessions for the sidebar and the Agent page. Polls the list: every
 * few seconds while a session is working or the Agent page is open, less
 * often otherwise. Tells the user (General settings: notification, chime)
 * when a session finishes or starts waiting for them while the tab is hidden.
 *
 * @param {boolean} pageOpen  The Agent page is showing.
 * @returns {{sessions: object[], needsYou: number, refresh: Function}}
 */
export function useAgentSessions(pageOpen) {
  const [sessions, setSessions] = useState([]);
  const previous = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const list = await agentService.list();
      const before = previous.current;
      if (before) {
        for (const s of list) {
          const was = before.get(s.id);
          if (!was || was === s.status) continue;
          if (s.status === 'waiting') notifyFinished('OpenGPT agent', `${s.title} needs you.`);
          else if (s.status === 'done') notifyFinished('OpenGPT agent', `${s.title} is done.`);
          else if (s.status === 'failed') notifyFinished('OpenGPT agent', `${s.title} failed.`);
        }
      }
      previous.current = new Map(list.map((s) => [s.id, s.status]));
      setSessions(list);
    } catch {
      // The backend may be restarting; the next poll tries again.
    }
  }, []);

  const working = sessions.some((s) => ACTIVE.has(s.status));
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, working || pageOpen ? 3000 : 15000);
    return () => clearInterval(timer);
  }, [refresh, working, pageOpen]);

  return { sessions, needsYou: sessions.filter((s) => s.status === 'waiting').length, refresh };
}
