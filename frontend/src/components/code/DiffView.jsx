import React from 'react';

// A unified diff with added and removed lines coloured.
const lineClass = (line) => {
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-gray-500';
  if (line.startsWith('+')) return 'bg-green-500/10 text-green-300';
  if (line.startsWith('-')) return 'bg-red-500/10 text-red-300';
  if (line.startsWith('@@')) return 'text-blue-300';
  return 'text-gray-400';
};

const DiffView = ({ diff, maxHeight = 'max-h-80' }) => (
  <pre className={`thin-scroll ${maxHeight} overflow-auto rounded-md bg-black/30 py-2 font-mono text-xs leading-relaxed`}>
    {diff.split('\n').map((line, i) => (
      <div key={i} className={`whitespace-pre-wrap break-words px-3 ${lineClass(line)}`}>
        {line || ' '}
      </div>
    ))}
  </pre>
);

export default DiffView;
