// Helpers for reading a deep research activity log (list of events).

export const countSources = (events = []) => {
  const urls = new Set();
  for (const event of events) {
    if (event.kind === 'sources') event.sources.forEach((s) => urls.add(s.url));
  }
  return urls.size;
};

// One-line description of what the agent is doing right now
export const currentActivity = (events = []) => {
  const last = events[events.length - 1];
  if (!last) return 'Starting research';
  switch (last.kind) {
    case 'step':
      return last.title;
    case 'plan':
      return 'Research brief ready';
    case 'thinking':
      return 'Thinking';
    case 'delegate':
      return 'Investigating a subtopic';
    case 'search':
      return `Searching: ${last.queries[0]}`;
    case 'sources':
      return `Reading ${last.sources.length} sources`;
    case 'findings':
      return 'Reviewing findings';
    case 'status':
      return last.text;
    case 'error':
      return 'Something went wrong';
    default:
      return 'Researching';
  }
};

// Title for a report: its first markdown heading, without styling marks
export const reportTitle = (markdown = '', fallback = 'Research report') => {
  const heading = markdown.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/m);
  if (!heading) return fallback;
  return (
    heading[1]
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_`~]/g, '')
      .trim() || fallback
  );
};
