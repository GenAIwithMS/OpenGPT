// Citation links arrive from the backend as [Site](url "Page title (YYYY-MM-DD)").
// The link title carries the metadata shown in the hover card.

const DATE_SUFFIX = /\s\((\d{4}-\d{2}-\d{2})\)$/;

export const parseCitation = ({ href, title, label }) => {
  const match = DATE_SUFFIX.exec(title || '');
  return {
    url: href,
    label: label || hostOf(href),
    title: match ? title.slice(0, match.index) : title || '',
    date: match ? match[1] : '',
  };
};

export const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

export const faviconUrl = (url) =>
  `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostOf(url))}&sz=32`;

export const formatCitationDate = (iso) => {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
};

// While an answer streams, the model's raw 【n†source】 markers (and a marker
// cut off mid-stream) are hidden; the backend replaces them with links at the end.
export const stripCitationMarkers = (text) => text.replace(/【[^】]*(】|$)/g, '');
