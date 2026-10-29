import React, { useRef, useState } from 'react';
import { faviconUrl, formatCitationDate, hostOf, withSourceTag } from '../lib/citations';

const Favicon = ({ url, size = 14 }) => {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span
        className="inline-block shrink-0 rounded-sm bg-gray-500/60"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <img
      src={faviconUrl(url)}
      alt=""
      width={size}
      height={size}
      className="shrink-0 rounded-sm"
      onError={() => setFailed(true)}
    />
  );
};

// Inline pill citing one or more sources: favicon + site name, "+N" when
// several sources back the same sentence. Hovering shows a card listing each
// source's page title and date; clicking anything opens the page.
const CitationChip = ({ sources }) => {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef(null);
  const first = sources[0];

  const show = () => {
    clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const hide = () => {
    closeTimer.current = setTimeout(() => setOpen(false), 120);
  };

  return (
    <span
      className="citation relative inline-block align-baseline mx-0.5"
      onMouseEnter={show}
      onMouseLeave={hide}
    >
      <a
        href={withSourceTag(first.url)}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex max-w-[150px] items-center gap-1 rounded-full bg-[#34353d] px-1.5 py-[1px] text-[11px] leading-4 text-gray-300 no-underline transition-colors hover:bg-[#42434c] hover:text-gray-100"
      >
        <Favicon url={first.url} size={12} />
        <span className="truncate">{first.label || hostOf(first.url)}</span>
        {sources.length > 1 && (
          <span className="shrink-0 text-gray-400">+{sources.length - 1}</span>
        )}
      </a>

      {open && (
        <span
          className="absolute left-0 top-full z-40 mt-1.5 block w-[360px] max-w-[85vw] whitespace-normal rounded-2xl border border-gray-700/80 bg-[#1f2026] p-1.5 text-left shadow-2xl animate-fade-in"
          onMouseEnter={show}
          onMouseLeave={hide}
        >
          {sources.map((s, i) => (
            <a
              key={`${s.url}-${i}`}
              href={withSourceTag(s.url)}
              target="_blank"
              rel="noopener noreferrer"
              className={`block rounded-xl px-3 py-2.5 no-underline transition-colors hover:bg-[#2a2b32] ${
                i > 0 ? 'border-t border-gray-700/70' : ''
              }`}
            >
              <span className="flex items-center gap-1.5 text-xs text-gray-400">
                <Favicon url={s.url} size={14} />
                <span className="truncate">{s.label || hostOf(s.url)}</span>
              </span>
              <span className="mt-1 block text-sm font-medium leading-snug text-gray-100">
                {s.title || s.url}
              </span>
              {s.date && (
                <span className="mt-1 block text-xs text-gray-400">{formatCitationDate(s.date)}</span>
              )}
            </a>
          ))}
        </span>
      )}
    </span>
  );
};

export default CitationChip;
