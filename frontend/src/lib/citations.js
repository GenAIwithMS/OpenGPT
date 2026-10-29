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

// Links opened from an answer carry utm_source=opengpt (as ChatGPT does with
// utm_source=chatgpt.com) so site owners can see where the visit came from.
// The stored message text keeps the clean URL; the tag is added at render time.
export const SOURCE_TAG = 'opengpt';

export const withSourceTag = (url) => {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return url;
    u.searchParams.set('utm_source', SOURCE_TAG);
    return u.toString();
  } catch {
    return url;
  }
};

// Tables hold data only. Before rendering, every table row is scrubbed of
// citation markers, markdown links (whole, or broken by a "|" in their title),
// link remnants and bare URLs. This also covers answers saved before links
// were kept out of tables on the backend.
const TABLE_DELIM = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

const scrubCell = (cell) =>
  cell
    .replace(/【[^】]*】/g, '')
    .replace(/\[[^\]]*\]\([^)]*\)/g, '') // complete [text](url "title")
    .replace(/\[[^\]]*\]\([^)]*$/g, '') // link cut off by a "|" in its title
    .replace(/^[^"]*"\)/, '') // tail of such a link in the next cell
    .replace(/<?https?:\/\/[^\s>]+>?/g, '')
    .replace(/\(\s*(?:see|source|via|ref)?\s*\)/gi, '')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ');

export const cleanTableRows = (markdown) => {
  if (!markdown || !markdown.includes('|')) return markdown;
  const lines = markdown.split('\n');
  let i = 0;
  while (i < lines.length) {
    if (TABLE_DELIM.test(lines[i]) && i > 0 && lines[i - 1].includes('|')) {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() && lines[j].includes('|')) j += 1;
      // A "|" inside a link title split a cell in two; once scrubbed, the
      // extra empty cell is merged back so rows match the header width.
      const width = lines[i].split('|').length;
      for (let k = i + 1; k < j; k += 1) {
        const cells = lines[k].split('|').map(scrubCell);
        while (cells.length > width && cells[cells.length - 1].trim() === '') cells.pop();
        lines[k] = cells.length > width ? cells.join('|') : `${cells.join('|')}${cells.length === width ? '' : ' |'}`;
      }
      i = j;
    } else {
      i += 1;
    }
  }
  return lines.join('\n');
};
