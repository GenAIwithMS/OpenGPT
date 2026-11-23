import React, { useState } from 'react';
import { ArrowUp, Play, Square } from 'lucide-react';
import { PromptInput, PromptInputAction, PromptInputActions, PromptInputTextarea } from '../ui/prompt-input';
import { SEND_HINT } from '../../lib/preferences';

/**
 * The Agent page's input, built from the same parts as the chat's message box: the rounded
 * box, the growing textarea and the round send button (Stop while the agent works).
 *
 * @param {object} props
 * @param {(text: string) => (boolean|void|Promise<boolean|void>)} props.onSend  false gives the text back.
 * @param {string} [props.placeholder]
 * @param {boolean} [props.working]  The agent is working: the button stops it.
 * @param {() => void} [props.onStop]
 * @param {boolean} [props.allowEmpty]  Sending with no text (Continue).
 * @param {string} [props.emptyLabel]  The button's label when the box is empty and allowEmpty.
 * @param {boolean} [props.busy]
 * @param {boolean} [props.autoFocus]
 * @param {string} [props.text]  Controlled text (with onTextChange), e.g. filled in by an example.
 * @param {(text: string) => void} [props.onTextChange]
 */
const AgentInput = ({ onSend, placeholder = 'Describe the task', working = false, onStop, allowEmpty = false,
  emptyLabel = 'Continue', busy = false, autoFocus = false, text: controlled, onTextChange }) => {
  const [own, setOwn] = useState('');
  const text = controlled ?? own;
  const setText = (value) => (onTextChange ? onTextChange(typeof value === 'function' ? value(text) : value) : setOwn(value));
  const canSend = !busy && (text.trim() || allowEmpty);

  const submit = () => {
    if (working || !canSend) return;
    const sent = text;
    setText('');
    Promise.resolve(onSend(sent.trim())).then((ok) => {
      if (ok === false) setText((current) => current || sent);
    });
  };

  const continuing = allowEmpty && !text.trim();
  return (
    <div>
      <PromptInput value={text} onValueChange={setText} onSubmit={submit} disabled={busy} maxHeight={200}
        className="mx-auto max-w-3xl">
        <PromptInputTextarea aria-label="Task" placeholder={placeholder} disabled={busy} autoFocus={autoFocus} />
        <PromptInputActions className="flex items-center justify-end gap-2 px-1 pb-1">
          {continuing && !working && <span className="text-xs text-gray-400">{emptyLabel}</span>}
          <PromptInputAction tooltip={working ? 'Stop' : continuing ? emptyLabel : 'Send'}>
            <button type="button" onClick={working ? onStop : submit} disabled={!working && !canSend}
              aria-label={working ? 'Stop the agent' : continuing ? emptyLabel : 'Send'}
              title={working ? 'Stop' : continuing ? emptyLabel : 'Send'}
              className="relative flex h-8 w-8 items-center justify-center rounded-full bg-white text-gray-900 transition-colors after:absolute after:-inset-1.5 after:content-[''] hover:bg-gray-200 disabled:cursor-not-allowed disabled:bg-gray-500 disabled:text-gray-800 [@media(hover:hover)]:after:hidden">
              {working ? <Square size={13} fill="currentColor" /> : continuing ? <Play size={14} /> : <ArrowUp size={16} />}
            </button>
          </PromptInputAction>
        </PromptInputActions>
      </PromptInput>
      <p className="mt-2 text-center text-xs text-gray-500">{SEND_HINT}</p>
    </div>
  );
};

export default AgentInput;
