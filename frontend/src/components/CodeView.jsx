import React, { useEffect, useState } from 'react';
import { AlertTriangle, ArrowUp, Code2, Loader2, Square } from 'lucide-react';
import { PromptInput, PromptInputTextarea, PromptInputActions, PromptInputAction } from './ui/prompt-input';
import ModelPicker from './ModelPicker';
import ProjectPicker from './code/ProjectPicker';
import CodeMessages from './code/CodeMessages';
import { useCodeSession } from '../hooks/useCodeSession';
import { codeService } from '../services/api';
import { notifyFinished } from '../lib/notify';

// Message box with Send, or Stop while the agent works.
const Composer = ({ onSend, onStop, working, disabled, placeholder }) => {
  const [value, setValue] = useState('');
  const submit = () => {
    if (working || disabled || !value.trim()) return;
    onSend(value.trim());
    setValue('');
  };
  return (
    <PromptInput value={value} onValueChange={setValue} onSubmit={submit} disabled={disabled} maxHeight={200}>
      <PromptInputTextarea placeholder={placeholder} aria-label={placeholder} className="px-2" />
      <PromptInputActions className="flex items-center justify-end gap-1 px-1 pb-1">
        <ModelPicker page="code" disabled={disabled && !working} />
        <PromptInputAction tooltip={working ? 'Stop' : 'Send'}>
          <button
            type="button"
            onClick={working ? onStop : submit}
            disabled={!working && (disabled || !value.trim())}
            aria-label={working ? 'Stop the agent' : 'Send'}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-white text-gray-900 transition-colors hover:bg-gray-200 disabled:bg-gray-500 disabled:text-gray-800"
          >
            {working ? <Square size={13} fill="currentColor" /> : <ArrowUp size={16} />}
          </button>
        </PromptInputAction>
      </PromptInputActions>
    </PromptInput>
  );
};

const CodeView = ({
  sessionId,
  status,
  workspace,
  onSessionCreated,
}) => {
  const { projects, project, projectId } = workspace;
  const onProjectChange = workspace.setProject;
  const onSessionsChanged = workspace.refreshSessions;
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState(null);
  const code = useCodeSession(sessionId, {
    onTitle: () => onSessionsChanged?.(),
    onTurnEnd: () => {
      onSessionsChanged?.();
      notifyFinished('OpenGPT', 'The coding agent finished.');
    },
    onApproval: () => notifyFinished('OpenGPT', 'The coding agent is waiting for your approval.'),
  });

  const sessionProject = code.session?.project;

  // Opening a session (e.g. from a link) selects its project, so the sidebar
  // lists that project's sessions.
  useEffect(() => {
    if (sessionProject?.id && sessionProject.id !== projectId) onProjectChange(sessionProject.id);
  }, [sessionProject?.id, projectId, onProjectChange]);

  const available = Boolean(status?.available);
  const working = code.streaming || code.busy;

  // First message on the landing page: start a session, then send.
  const start = async (text) => {
    if (!project) {
      setStartError('Open a folder or create a project first.');
      return;
    }
    setStarting(true);
    setStartError(null);
    try {
      const session = await codeService.createSession(project.id);
      code.send(session.id, text);
      onSessionCreated(session.id);
    } catch (e) {
      setStartError(e.message || 'Could not start a session.');
    } finally {
      setStarting(false);
    }
  };

  const notice = !status ? null : !available ? (
    <div role="status" className="mx-auto mb-4 flex max-w-3xl items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
      {status.state === 'starting' ? <Loader2 size={15} className="mt-0.5 shrink-0 animate-spin" /> : <AlertTriangle size={15} className="mt-0.5 shrink-0" />}
      <span>{status.state === 'starting' ? 'The coding agent is starting…' : status.detail || 'The coding agent is not available.'}</span>
    </div>
  ) : null;

  const error = startError || code.error;

  return (
    <div className="flex-1 min-w-0 flex flex-col h-screen">
      {/* Header — matches the chat header */}
      <div className="flex-shrink-0 px-4 py-3 bg-chat-bg">
        <div className="flex items-center gap-2 pl-12 lg:pl-0">
          <span className="text-base font-semibold tracking-tight text-white select-none">OpenGPT</span>
          <span className="px-2 py-0.5 rounded-lg bg-gray-700/70 text-xs font-medium text-gray-300">Code</span>
          {sessionId ? (
            sessionProject && <span className="ml-1 truncate text-sm text-gray-400">{sessionProject.name} · {code.session?.title}</span>
          ) : (
            <ProjectPicker
              projects={projects}
              project={project}
              onChange={onProjectChange}
              onAdded={workspace.addProject}
              onRemove={(id) => workspace.removeProject(id).catch((e) => setStartError(e.message))}
              canBrowse={workspace.canBrowse}
              projectsRoot={workspace.projectsRoot}
              disabled={!available}
            />
          )}
        </div>
      </div>

      {!sessionId ? (
        <div className="flex-1 min-h-0 flex items-center justify-center px-4 pb-16">
          <div className="w-full max-w-3xl">
            {notice}
            <div className="text-center mb-6">
              <div className="mx-auto mb-4 flex items-center justify-center w-12 h-12 rounded-2xl bg-gray-700/60 text-gray-200">
                <Code2 size={24} />
              </div>
              <h1 className="text-2xl font-bold text-gray-100">What should we build?</h1>
              <p className="mt-2 text-sm text-gray-400 max-w-md mx-auto">
                The coding agent reads and edits code in your project and runs commands. It asks before changing
                files or running anything.
              </p>
            </div>
            <Composer onSend={start} working={starting} disabled={!available || starting}
              placeholder={project ? `Describe a coding task for ${project.name}` : 'Open a folder, then describe a task'} />
            {project && <p className="mt-2 truncate text-center text-xs text-gray-500" title={project.path}>Working in {project.path}</p>}
            {error && <p role="alert" className="mt-3 text-center text-sm text-red-300">{error}</p>}
          </div>
        </div>
      ) : (
        <>
          <div className="flex-1 min-h-0 overflow-y-auto">
            <div className="pt-2">{notice}</div>
            {code.loading ? (
              <div className="flex justify-center py-10"><Loader2 className="animate-spin text-gray-400" /></div>
            ) : (
              <CodeMessages messages={code.messages} approvals={code.approvals} onAnswer={code.answer} />
            )}
          </div>
          <div className="flex-shrink-0 px-4 pb-4">
            <div className="max-w-3xl mx-auto">
              {error && <p role="alert" className="mb-2 text-sm text-red-300">{error}</p>}
              {code.busy && <p className="mb-2 text-xs text-gray-400">The agent is still working on this session…</p>}
              <Composer onSend={(text) => code.send(sessionId, text)} onStop={code.stop} working={working}
                disabled={!available} placeholder="Ask for changes or a follow-up" />
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default CodeView;
