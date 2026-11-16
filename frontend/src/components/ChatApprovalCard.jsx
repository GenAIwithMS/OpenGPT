import React, { useState } from 'react';
import { Check, Loader2, ShieldQuestion, X } from 'lucide-react';
import ConnectorLogo from './settings/ConnectorLogo';
import { chatService } from '../services/api';

const DECISION_TEXT = { allow: 'Allowed', deny: 'Denied' };

// A connector tool that may change something asks first. Read-only tools
// never show this. No answer within 5 minutes, or Stop, counts as Deny.
const ChatApprovalCard = ({ approval }) => {
  const [sending, setSending] = useState(null);
  const [error, setError] = useState(null);
  const decided = approval.decision;

  const answer = async (decision) => {
    setSending(decision);
    setError(null);
    try {
      await chatService.answerApproval(approval.id, decision);
    } catch (e) {
      setError(e.message);
      setSending(null);
    }
  };

  return (
    <div
      role="group"
      aria-label={`Approval: ${approval.tool} on ${approval.connector}`}
      className={`not-prose animate-dialog-in my-3 rounded-xl border text-sm ${
        decided ? 'border-gray-700/80 bg-[#1f2026]' : 'border-amber-500/40 bg-amber-500/5'
      }`}
    >
      <div className="flex items-center gap-2.5 px-3 pt-3">
        <ConnectorLogo id={approval.connector_id} name={approval.connector} size="h-7 w-7" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-gray-100">
            {decided ? approval.tool : `Allow ${approval.tool}?`}
          </p>
          <p className="text-xs text-gray-400">{approval.connector}</p>
        </div>
        {decided ? (
          <span className={`flex items-center gap-1 text-xs ${decided === 'deny' ? 'text-red-300' : 'text-green-300'}`}>
            {decided === 'deny' ? <X size={13} /> : <Check size={13} />}
            {DECISION_TEXT[decided] || decided}
          </span>
        ) : (
          <ShieldQuestion size={16} className="text-amber-300" />
        )}
      </div>

      <div className="space-y-2 px-3 py-2.5">
        {!decided && (
          <p className="text-xs text-gray-400">
            {approval.destructive
              ? 'The assistant wants to use a tool that can change or delete data in your account.'
              : 'The assistant wants to use a tool that can make changes in your account.'}
          </p>
        )}
        {approval.description && !decided && <p className="text-xs text-gray-500">{approval.description}</p>}
        {approval.arguments && approval.arguments !== '{}' && (
          <pre className="thin-scroll max-h-40 overflow-auto rounded-lg bg-black/30 p-2.5 font-mono text-[11px] leading-relaxed text-gray-200">
            {approval.arguments}
          </pre>
        )}
        {error && <p className="text-xs text-red-300">{error}</p>}
      </div>

      {!decided && (
        <div className="flex items-center gap-2 border-t border-amber-500/20 px-3 py-2.5">
          <button type="button" disabled={!!sending} onClick={() => answer('allow')}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-60">
            Allow
          </button>
          <button type="button" disabled={!!sending} onClick={() => answer('deny')}
            className="rounded-md px-3 py-1.5 text-sm text-red-300 hover:bg-red-500/10 disabled:opacity-60">
            Deny
          </button>
          {sending && <Loader2 size={15} className="animate-spin text-gray-400" />}
        </div>
      )}
    </div>
  );
};

export default ChatApprovalCard;
