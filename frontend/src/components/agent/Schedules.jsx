import React, { useEffect, useState } from 'react';
import { CalendarClock, Loader2, Pause, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { agentService } from '../../services/api';
import { Modal, inputClass } from '../settings/controls';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];   // Monday is 0, as the backend counts
const OUTCOME = { started: 'ran', skipped_busy: 'skipped: the last run was still going', missed: 'missed: OpenGPT was off' };
const browserZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };

/** "Every weekday at 09:00", in plain words. */
export const describeSchedule = (s) => {
  if (s.repeat === 'once') return `Once on ${s.date} at ${s.time}`;
  if (s.repeat === 'daily') return `Every day at ${s.time}`;
  if (s.repeat === 'weekly') {
    const days = [...(s.days || [])].sort();
    const label = days.join(',') === '0,1,2,3,4' ? 'weekday' : days.map((d) => DAYS[d]).join(', ');
    return `Every ${label} at ${s.time}`;
  }
  return `Cron: ${s.cron}`;
};

const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');

/**
 * Create or edit a schedule. `initial` prefills it (a session's task, or an existing schedule).
 */
export const ScheduleDialog = ({ initial = {}, onClose, onSaved }) => {
  const editing = Boolean(initial.id);
  const [spec, setSpec] = useState({
    task: initial.task || '', repeat: initial.repeat || 'daily', time: initial.time || '09:00',
    date: initial.date || new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
    days: initial.days?.length ? initial.days : [0, 1, 2, 3, 4], cron: initial.cron || '0 9 * * 1-5',
    timezone: initial.timezone || browserZone(),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (key) => (e) => setSpec((s) => ({ ...s, [key]: e.target.value }));
  const toggleDay = (d) => setSpec((s) => ({ ...s, days: s.days.includes(d) ? s.days.filter((x) => x !== d) : [...s.days, d] }));

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const saved = editing ? await agentService.updateSchedule(initial.id, spec) : await agentService.createSchedule(spec);
      onSaved(saved);
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal title={editing ? 'Edit schedule' : 'Schedule a task'} onClose={onClose}>
      <form onSubmit={save} className="space-y-4 text-sm">
        <div className="space-y-1">
          <label htmlFor="schedule-task" className="text-gray-200">Task</label>
          <textarea id="schedule-task" rows={3} value={spec.task} onChange={set('task')} maxLength={20000}
            className={`${inputClass} thin-scroll resize-y`} placeholder="e.g. Summarise my unread GitHub issues and draft a status update" />
        </div>
        <div className="space-y-1">
          <label htmlFor="schedule-repeat" className="text-gray-200">Repeat</label>
          <select id="schedule-repeat" value={spec.repeat} onChange={set('repeat')} className={inputClass}>
            <option value="once">Once</option>
            <option value="daily">Every day</option>
            <option value="weekly">On some days of the week</option>
            <option value="cron">Cron line (advanced)</option>
          </select>
        </div>
        {spec.repeat === 'weekly' && (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Days">
            {DAYS.map((label, d) => (
              <button key={label} type="button" aria-pressed={spec.days.includes(d)} onClick={() => toggleDay(d)}
                className={`rounded-lg border px-2.5 py-1 ${spec.days.includes(d) ? 'border-blue-500 bg-blue-500/15 text-white' : 'border-gray-600 text-gray-300'}`}>
                {label}
              </button>
            ))}
          </div>
        )}
        {spec.repeat === 'cron' ? (
          <div className="space-y-1">
            <label htmlFor="schedule-cron" className="text-gray-200">Cron line</label>
            <input id="schedule-cron" value={spec.cron} onChange={set('cron')} className={`${inputClass} font-mono`} />
            <p className="text-xs text-gray-500">minute hour day month weekday, e.g. 0 9 * * 1-5 (09:00 on weekdays)</p>
          </div>
        ) : (
          <div className="flex gap-3">
            {spec.repeat === 'once' && (
              <div className="flex-1 space-y-1">
                <label htmlFor="schedule-date" className="text-gray-200">Date</label>
                <input id="schedule-date" type="date" value={spec.date} onChange={set('date')} className={inputClass} />
              </div>
            )}
            <div className="flex-1 space-y-1">
              <label htmlFor="schedule-time" className="text-gray-200">Time</label>
              <input id="schedule-time" type="time" value={spec.time} onChange={set('time')} className={inputClass} />
            </div>
          </div>
        )}
        <p className="text-xs text-gray-500">
          Times are in {spec.timezone}. The agent prepares everything and waits for you before it changes
          anything; an approval nobody answers within a day expires. OpenGPT must be running at that time.
        </p>
        {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-2 text-gray-300 hover:bg-white/5">Cancel</button>
          <button type="submit" disabled={busy || !spec.task.trim()}
            className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 font-medium text-white hover:bg-blue-500 disabled:opacity-50">
            {busy && <Loader2 size={14} className="animate-spin" />} {editing ? 'Save' : 'Schedule'}
          </button>
        </div>
      </form>
    </Modal>
  );
};

/** The schedule list on the Agent page: pause, run now, edit, delete. */
export const SchedulesList = ({ onOpenSession }) => {
  const [list, setList] = useState(null);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState(null);
  const load = () => agentService.schedules().then(setList).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const act = async (fn) => {
    setError(null);
    try { await fn(); } catch (e) { setError(e.message); }
    load();
  };

  return (
    <div className="mt-8">
      <div className="mb-2 flex items-center">
        <p className="flex-1 text-xs font-medium uppercase tracking-wide text-gray-500">Schedules</p>
        <button type="button" onClick={() => setEditing({})}
          className="flex items-center gap-1 rounded-lg px-2 py-1 text-sm text-gray-300 hover:bg-white/5"><Plus size={14} /> New schedule</button>
      </div>
      {error && <p role="alert" className="mb-2 text-sm text-red-300">{error}</p>}
      {list && list.length === 0 && (
        <p className="text-sm text-gray-500">No schedules. Schedule a task to run it at set times, e.g. every weekday at 09:00.</p>
      )}
      <ul className="space-y-1.5">
        {(list || []).map((s) => (
          <li key={s.id} className="flex items-start gap-3 rounded-xl border border-gray-700/70 px-3 py-2">
            <CalendarClock size={16} className={`mt-0.5 shrink-0 ${s.enabled ? 'text-gray-300' : 'text-gray-600'}`} />
            <div className="min-w-0 flex-1">
              <p className={`truncate text-sm ${s.enabled ? 'text-gray-100' : 'text-gray-500'}`}>{s.title}</p>
              <p className="text-xs text-gray-500">
                {describeSchedule(s)}{s.enabled && s.next_run_at ? ` · next ${when(s.next_run_at)}` : !s.enabled ? ' · paused' : ''}
                {s.last_run_at ? ` · last ${when(s.last_run_at)} (${OUTCOME[s.last_outcome] || s.last_outcome})` : ''}
              </p>
            </div>
            <div className="flex shrink-0 items-center">
              <button type="button" title="Run now" aria-label={`Run ${s.title} now`}
                onClick={() => act(async () => { const session = await agentService.runSchedule(s.id); onOpenSession?.(session.id); })}
                className="rounded-lg p-1.5 text-gray-400 hover:bg-white/5 hover:text-white"><Play size={14} /></button>
              <button type="button" title={s.enabled ? 'Pause' : 'Resume'} aria-label={`${s.enabled ? 'Pause' : 'Resume'} ${s.title}`}
                onClick={() => act(() => agentService.updateSchedule(s.id, { enabled: !s.enabled }))}
                className="rounded-lg p-1.5 text-gray-400 hover:bg-white/5 hover:text-white">{s.enabled ? <Pause size={14} /> : <CalendarClock size={14} />}</button>
              <button type="button" title="Edit" aria-label={`Edit ${s.title}`} onClick={() => setEditing(s)}
                className="rounded-lg p-1.5 text-gray-400 hover:bg-white/5 hover:text-white"><Pencil size={14} /></button>
              <button type="button" title="Delete" aria-label={`Delete ${s.title}`}
                onClick={() => act(() => agentService.deleteSchedule(s.id))}
                className="rounded-lg p-1.5 text-gray-400 hover:bg-white/5 hover:text-red-300"><Trash2 size={14} /></button>
            </div>
          </li>
        ))}
      </ul>
      {editing && <ScheduleDialog initial={editing} onClose={() => setEditing(null)} onSaved={load} />}
    </div>
  );
};
