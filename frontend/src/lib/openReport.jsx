import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { reportTitle } from './research';

const PAGE_STYLE = `
  :root { color-scheme: light dark; --text: #1f2937; --muted: #6b7280; --line: #e5e7eb; --soft: #f3f4f6; --link: #1d4ed8; --bg: #ffffff; }
  @media (prefers-color-scheme: dark) {
    :root { --text: #e5e7eb; --muted: #9ca3af; --line: #3f4046; --soft: #2a2b32; --link: #93c5fd; --bg: #1f2026; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.7 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 56px 24px 96px; }
  h1, h2, h3, h4 { line-height: 1.3; margin: 1.8em 0 0.6em; }
  h1 { font-size: 2rem; margin-top: 0; }
  h2 { font-size: 1.45rem; padding-bottom: 0.3em; border-bottom: 1px solid var(--line); }
  h3 { font-size: 1.15rem; }
  a { color: var(--link); }
  code { background: var(--soft); padding: 0.15em 0.4em; border-radius: 4px; font-size: 0.9em; }
  pre { background: var(--soft); padding: 14px 16px; border-radius: 10px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  blockquote { margin: 1em 0; padding-left: 1em; border-left: 3px solid var(--line); color: var(--muted); }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: 0.93em; display: block; overflow-x: auto; }
  th, td { border: 1px solid var(--line); padding: 8px 12px; text-align: left; vertical-align: top; }
  th { background: var(--soft); }
  hr { border: 0; border-top: 1px solid var(--line); margin: 2em 0; }
  @media print { main { padding: 0; max-width: none; } }
`;

const escapeHtml = (text) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Open a report as a clean, standalone page in a new browser tab
export const openReportInNewTab = (markdown) => {
  const body = renderToStaticMarkup(
    <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
  );
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(reportTitle(markdown))}</title><style>${PAGE_STYLE}</style></head>
<body><main>${body}</main></body></html>`;

  const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
};
