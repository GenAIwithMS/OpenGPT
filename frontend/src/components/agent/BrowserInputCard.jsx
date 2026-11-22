import React, { useState } from 'react';
import { Check, Globe, KeyRound, Loader2 } from 'lucide-react';
import { agentService } from '../../services/api';

const field = 'w-full rounded-lg border border-gray-600 bg-transparent px-3 py-1.5 text-sm text-gray-100 outline-none focus:border-gray-400';
const host = (origin) => { try { return new URL(origin).hostname; } catch { return origin; } };

// One question's input. `value` and `onChange` hold the answer in the engine's format.
const Question = ({ q, value, onChange }) => {
  const id = `browser-q-${q.id}`;
  if (q.type === 'credential') {
    const v = value || {};
    const declined = Boolean(v.declined);
    return (
      <div className="space-y-2">
        <p className="flex items-center gap-2 text-gray-100"><KeyRound size={15} className="text-amber-300" />{q.prompt || `Log in to ${host(q.siteOrigin)}`}</p>
        {!declined && (
          <>
            {q.fields === 'username_password' && (
              <input aria-label="Username or email" autoComplete="username" className={field} placeholder="Username or email"
                value={v.username || ''} onChange={(e) => onChange({ ...v, username: e.target.value })} />
            )}
            <input aria-label="Password" type="password" autoComplete="current-password" className={field}
              placeholder={q.allowPasswordless ? 'Password (or leave empty for a sign-in code)' : 'Password'}
              value={v.password || ''} onChange={(e) => onChange({ ...v, password: e.target.value })} />
          </>
        )}
        {q.allowDecline && (
          <label className="flex items-center gap-2 text-xs text-gray-400">
            <input type="checkbox" checked={declined}
              onChange={(e) => onChange(e.target.checked ? { declined: 'no_account' } : {})} />
            I don&apos;t have an account here; use only what the site shows without signing in
          </label>
        )}
      </div>
    );
  }
  if (q.type === 'secret') {
    return (
      <label htmlFor={id} className="block space-y-1">
        <span className="text-gray-100">{q.prompt}</span>
        <input id={id} type="password" autoComplete="one-time-code" className={field} maxLength={q.maxLength}
          value={value || ''} onChange={(e) => onChange(e.target.value)} />
      </label>
    );
  }
  if (q.type === 'text') {
    return (
      <label htmlFor={id} className="block space-y-1">
        <span className="text-gray-100">{q.prompt}</span>
        <input id={id} className={field} maxLength={q.maxLength} value={value || ''} onChange={(e) => onChange(e.target.value)} />
      </label>
    );
  }
  if (q.type === 'confirm') {
    return (
      <div className="space-y-1.5">
        <p className="text-gray-100">{q.prompt}</p>
        <div className="flex gap-2">
          {[[true, 'Yes'], [false, 'No']].map(([confirmed, label]) => (
            <button key={label} type="button" onClick={() => onChange({ confirmed })}
              className={`rounded-lg border px-3 py-1 ${value?.confirmed === confirmed ? 'border-blue-500 bg-blue-500/15 text-white' : 'border-gray-600 text-gray-300'}`}>
              {label}
            </button>
          ))}
        </div>
      </div>
    );
  }
  if (q.type === 'choice' || q.type === 'multi_choice') {
    const multi = q.type === 'multi_choice';
    const picked = multi ? (Array.isArray(value) ? value : []) : value;
    const toggle = (optionId) => onChange(multi
      ? (picked.includes(optionId) ? picked.filter((x) => x !== optionId) : [...picked, optionId])
      : optionId);
    return (
      <fieldset className="space-y-1.5">
        <legend className="mb-1 text-gray-100">{q.prompt}</legend>
        {q.options.map((o) => (
          <label key={o.id} className="flex items-center gap-2 text-gray-200">
            <input type={multi ? 'checkbox' : 'radio'} name={id}
              checked={multi ? picked.includes(o.id) : picked === o.id} onChange={() => toggle(o.id)} />
            {o.label}
          </label>
        ))}
        {!multi && q.allowOther && (
          <input aria-label="Something else" className={field} placeholder="Something else"
            value={typeof value === 'object' && value?.other ? value.other : ''}
            onChange={(e) => onChange(e.target.value ? { other: e.target.value } : undefined)} />
        )}
      </fieldset>
    );
  }
  return <p className="text-gray-400">{q.prompt}</p>;
};

const answered = (q, v) => {
  if (q.type === 'credential') return Boolean(v?.declined || v?.password || (q.allowPasswordless && v?.username));
  if (q.type === 'multi_choice') return Array.isArray(v) && v.length >= (q.minSelections || 0);
  if (q.type === 'confirm') return typeof v?.confirmed === 'boolean';
  return v !== undefined && v !== '';
};

// The engine's answer format for a credential, without empty fields.
const toAnswer = (q, v) => {
  if (q.type !== 'credential') return v;
  if (v?.declined) return { declined: v.declined, saveLogin: false };
  return {
    ...(v?.username ? { username: v.username } : {}),
    ...(v?.password ? { password: v.password } : {}),
    saveLogin: false,
  };
};

/**
 * Questions the browser asks while it works on a website: a login, a one-time code, a choice.
 * The answers go to the browser engine only; they are never saved or shown to a model.
 */
const BrowserInputCard = ({ request, current, done, sessionId, onChanged }) => {
  const [values, setValues] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const questions = request.questions || [];
  const site = questions.find((q) => q.siteOrigin)?.siteOrigin;
  const ready = questions.every((q) => answered(q, values[q.id]));

  const send = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const answers = Object.fromEntries(questions.map((q) => [q.id, toAnswer(q, values[q.id])]));
      await agentService.browserInput(sessionId, request.request_id, answers);
      setValues({});
      onChanged();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={send} className={`space-y-3 rounded-xl border p-3 text-sm ${current ? 'border-amber-500/40 bg-amber-500/5' : 'border-gray-700/70'}`}>
      <p className="flex items-center gap-2 text-xs text-gray-400">
        <Globe size={14} />The browser needs you{site ? ` on ${host(site)}` : ''}
        {done && <span className="ml-auto flex items-center gap-1 text-green-300"><Check size={13} />Answered</span>}
      </p>
      {request.notice && <p className="text-gray-300">{request.notice}</p>}
      {current ? (
        <>
          {questions.map((q) => (
            <Question key={q.id} q={q} value={values[q.id]} onChange={(v) => setValues((prev) => ({ ...prev, [q.id]: v }))} />
          ))}
          <p className="text-xs text-gray-500">
            Answers go only to the browser{site ? `, which types a login only on ${host(site)}` : ''}. Nothing is saved or shown to a model.
          </p>
          {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
          <button type="submit" disabled={busy || !ready}
            className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 font-medium text-white hover:bg-blue-500 disabled:opacity-50">
            {busy && <Loader2 size={14} className="animate-spin" />} Send
          </button>
        </>
      ) : (
        <ul className="list-disc pl-5 text-gray-400">{questions.map((q) => <li key={q.id}>{q.prompt || q.type}</li>)}</ul>
      )}
    </form>
  );
};

export default BrowserInputCard;
