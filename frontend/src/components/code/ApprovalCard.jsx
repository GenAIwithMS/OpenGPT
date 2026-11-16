import React, { useState } from 'react';
import { Check, Loader2, ShieldQuestion, X } from 'lucide-react';
import DiffView from './DiffView';

const ACTION_TITLES = {
  shell: 'Run a command',
  edit: 'Edit files',
  read: 'Read a file',
  webfetch: 'Open a web page',
  websearch: 'Search the web',
  external_directory: 'Access outside the project',
};

const DECISION_TEXT = {
  once: 'Allowed once',
  always: 'Always allowed',
  reject: 'Denied',
};

// The agent asks before acting. Allow once, always allow (in this project), or deny.
const ApprovalCard = ({ approval, onAnswer }) => {
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState('');
  if (!approval) return null;

  const decided = approval.decision;
  const busy = Boolean(approval.sending);
  const title = ACTION_TITLES[approval.action] || `Use ${approval.action}`;

  return (
    <div
      role="group"
      aria-label={`Approval: ${title}`}
      className={`not-prose my-3 rounded-lg border text-sm ${
        decided ? 'border-gray-700/80 bg-[#1f2026]' : 'border-amber-500/40 bg-amber-500/5'
      }`}
    >
      <div className="flex items-center gap-2 px-3 pt-3">
        <ShieldQuestion size={16} className={decided ? 'text-gray-500' : 'text-amber-300'} />
        <span className="font-medium text-gray-100">{decided ? title : `The agent wants to: ${title.toLowerCase()}`}</span>
        {decided && (
          <span
            className={`ml-auto flex items-center gap-1 text-xs ${
              decided === 'reject' ? 'text-red-300' : 'text-green-300'
            }`}
          >
            {decided === 'reject' ? <X size={13} /> : <Check size={13} />}
            {DECISION_TEXT[decided] || decided}
          </span>
        )}
      </div>

      <div className="space-y-2 px-3 py-2">
        {approval.message && <p className="text-gray-300">{approval.message}</p>}
        {approval.resources?.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {approval.resources.map((r, i) => (
              <code key={i} className="rounded bg-black/30 px-1.5 py-0.5 font-mono text-xs text-gray-200 break-all">
                {r}
              </code>
            ))}
          </div>
        )}
        {approval.files?.length > 0 && (
          <ul className="text-xs text-gray-400">
            {approval.files.map((f) => (
              <li key={f.file}>
                {f.file}{' '}
                <span className="text-green-400">+{f.additions ?? 0}</span>{' '}
                <span className="text-red-400">-{f.deletions ?? 0}</span>
              </li>
            ))}
          </ul>
        )}
        {approval.diff && !decided && <DiffView diff={approval.diff} />}
      </div>

      {!decided && (
        <div className="border-t border-amber-500/20 px-3 py-2.5">
          {denying ? (
            <form
              className="flex flex-col gap-2 sm:flex-row"
              onSubmit={(e) => {
                e.preventDefault();
                onAnswer(approval.id, 'reject', reason);
              }}
            >
              <input
                autoFocus
                value={reason}
                maxLength={2000}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Tell the agent why or what to do instead (optional)"
                aria-label="Reason for denying"
                className="min-w-0 flex-1 rounded-md border border-gray-600 bg-[#1a1b1e] px-2.5 py-1.5 text-sm text-gray-100 outline-none focus:border-gray-400"
              />
              <div className="flex gap-2">
                <button type="submit" disabled={busy}
                  className="rounded-md bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-500 disabled:opacity-60">
                  Deny
                </button>
                <button type="button" onClick={() => setDenying(false)}
                  className="rounded-md px-3 py-1.5 text-sm text-gray-300 hover:bg-white/5">
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" disabled={busy} onClick={() => onAnswer(approval.id, 'once')}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-60">
                Allow once
              </button>
              <button type="button" disabled={busy} onClick={() => onAnswer(approval.id, 'always')}
                title={`Saved for this project; you can revoke it later`}
                className="rounded-md border border-gray-600 px-3 py-1.5 text-sm text-gray-200 hover:bg-white/5 disabled:opacity-60">
                Always allow {approval.always}
              </button>
              <button type="button" disabled={busy} onClick={() => setDenying(true)}
                className="rounded-md px-3 py-1.5 text-sm text-red-300 hover:bg-red-500/10 disabled:opacity-60">
                Deny
              </button>
              {busy && <Loader2 size={15} className="animate-spin text-gray-400" />}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ApprovalCard;
