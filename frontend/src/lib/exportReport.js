// Download a markdown report as a .md, .txt or .pdf file.
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';

const parseMarkdown = (markdown) =>
  unified().use(remarkParse).use(remarkGfm).parse(markdown);

const inlineText = (node) => {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value;
  if (node.type === 'break') return '\n';
  if (node.type === 'image') return node.alt || '';
  if (node.type === 'html') return '';
  return (node.children || []).map(inlineText).join('');
};

// File name from the report's first heading, e.g. "langgraph-release-overview"
export const reportFileName = (markdown) => {
  const heading = parseMarkdown(markdown).children.find((n) => n.type === 'heading');
  const slug = (heading ? inlineText(heading) : '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'research-report';
};

const saveBlob = (blob, fileName) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

/* ----------------------------- plain text ----------------------------- */

const linkText = (node) => {
  const text = inlineText(node);
  return !node.url || text === node.url ? text : `${text} (${node.url})`;
};

const plainInline = (node) => {
  if (node.type === 'link') return linkText(node);
  if (node.children) return node.children.map(plainInline).join('');
  return inlineText(node);
};

const plainBlock = (node, indent = '') => {
  switch (node.type) {
    case 'heading': {
      const text = plainInline(node);
      if (node.depth === 1) return `${text.toUpperCase()}\n${'='.repeat(text.length)}`;
      if (node.depth === 2) return `${text}\n${'-'.repeat(text.length)}`;
      return text;
    }
    case 'paragraph':
      return indent + plainInline(node).replace(/\n/g, `\n${indent}`);
    case 'list':
      return node.children
        .map((item, i) => {
          const marker = node.ordered ? `${(node.start || 1) + i}. ` : '- ';
          const body = item.children
            .map((child) => plainBlock(child, indent + ' '.repeat(marker.length)))
            .join('\n');
          return indent + marker + body.trimStart();
        })
        .join('\n');
    case 'code':
      return node.value
        .split('\n')
        .map((line) => `${indent}    ${line}`)
        .join('\n');
    case 'blockquote':
      return node.children.map((child) => plainBlock(child, `${indent}> `)).join('\n');
    case 'table':
      return node.children
        .map((row) => row.children.map(plainInline).join(' | '))
        .join('\n');
    case 'thematicBreak':
      return '----------------------------------------';
    case 'html':
      return '';
    default:
      return indent + plainInline(node);
  }
};

export const markdownToPlainText = (markdown) =>
  parseMarkdown(markdown)
    .children.map((node) => plainBlock(node))
    .filter(Boolean)
    .join('\n\n') + '\n';

/* -------------------------------- PDF --------------------------------- */

// The embedded PDF font has no glyphs for typographic spaces and hyphens that
// models like to emit; swap them for their plain equivalents.
const pdfSafe = (text) =>
  text
    .replace(/[\u00A0\u2007\u2009\u200A\u202F]/g, ' ')
    .replace(/[\u2010\u2011]/g, '-')
    .replace(/\u200B/g, '');

// Inline mdast nodes -> pdfmake text runs, carrying bold/italic/link styling down
const pdfInline = (node, style = {}) => {
  switch (node.type) {
    case 'text':
      return [{ text: pdfSafe(node.value), ...style }];
    case 'strong':
      return node.children.flatMap((c) => pdfInline(c, { ...style, bold: true }));
    case 'emphasis':
      return node.children.flatMap((c) => pdfInline(c, { ...style, italics: true }));
    case 'delete':
      return node.children.flatMap((c) => pdfInline(c, { ...style, decoration: 'lineThrough' }));
    case 'inlineCode':
      return [{ text: pdfSafe(node.value), ...style, background: '#f0f1f3' }];
    case 'link':
      return node.children.flatMap((c) =>
        pdfInline(c, { ...style, link: node.url, color: '#1d4ed8', decoration: 'underline' })
      );
    case 'break':
      return [{ text: '\n', ...style }];
    case 'image':
      return node.alt ? [{ text: node.alt, ...style, italics: true }] : [];
    case 'html':
      return [];
    default:
      return (node.children || []).flatMap((c) => pdfInline(c, style));
  }
};

const HEADING_SIZES = { 1: 21, 2: 16, 3: 13.5, 4: 12, 5: 11, 6: 11 };

const pdfBlock = (node) => {
  switch (node.type) {
    case 'heading':
      return {
        text: node.children.flatMap((c) => pdfInline(c)),
        fontSize: HEADING_SIZES[node.depth],
        bold: true,
        color: '#111827',
        margin: [0, node.depth <= 2 ? 14 : 10, 0, 6],
      };
    case 'paragraph':
      return { text: node.children.flatMap((c) => pdfInline(c)), margin: [0, 0, 0, 8] };
    case 'list': {
      const items = node.children.map((item) => {
        const blocks = item.children.map(pdfBlock).filter(Boolean);
        return blocks.length === 1 ? blocks[0] : { stack: blocks };
      });
      return node.ordered
        ? { ol: items, start: node.start || 1, margin: [0, 0, 0, 8] }
        : { ul: items, margin: [0, 0, 0, 8] };
    }
    case 'code':
      return {
        table: {
          widths: ['*'],
          body: [[{ text: pdfSafe(node.value), fontSize: 9, color: '#1f2937', preserveLeadingSpaces: true }]],
        },
        layout: {
          hLineWidth: () => 0,
          vLineWidth: () => 0,
          fillColor: () => '#f3f4f6',
          paddingLeft: () => 8,
          paddingRight: () => 8,
          paddingTop: () => 6,
          paddingBottom: () => 6,
        },
        margin: [0, 2, 0, 10],
      };
    case 'blockquote':
      return {
        stack: node.children.map(pdfBlock).filter(Boolean),
        margin: [14, 2, 0, 8],
        color: '#4b5563',
        italics: true,
      };
    case 'table': {
      const columns = Math.max(...node.children.map((row) => row.children.length));
      const body = node.children.map((row, rowIndex) =>
        Array.from({ length: columns }, (_, i) => {
          const cell = row.children[i];
          return {
            text: cell ? cell.children.flatMap((c) => pdfInline(c)) : '',
            bold: rowIndex === 0,
            fillColor: rowIndex === 0 ? '#f3f4f6' : undefined,
            fontSize: 9.5,
          };
        })
      );
      // Columns holding only short values (numbers, labels) shrink to fit;
      // the rest share the remaining page width.
      const widths = Array.from({ length: columns }, (_, i) =>
        node.children.every((row) => (row.children[i] ? inlineText(row.children[i]).length : 0) <= 14)
          ? 'auto'
          : '*'
      );
      return {
        table: { headerRows: 1, widths, body },
        layout: {
          hLineColor: () => '#d1d5db',
          vLineColor: () => '#d1d5db',
          hLineWidth: () => 0.5,
          vLineWidth: () => 0.5,
          paddingLeft: () => 6,
          paddingRight: () => 6,
          paddingTop: () => 4,
          paddingBottom: () => 4,
        },
        margin: [0, 2, 0, 10],
      };
    }
    case 'thematicBreak':
      return {
        canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.5, lineColor: '#d1d5db' }],
        margin: [0, 6, 0, 10],
      };
    case 'html':
      return null;
    default:
      return node.children ? { text: node.children.flatMap((c) => pdfInline(c)), margin: [0, 0, 0, 8] } : null;
  }
};

// pdfmake (and its embedded font) is loaded on demand, only when a PDF is requested
const buildPdf = async (markdown) => {
  const [{ default: pdfMake }, { default: pdfFonts }] = await Promise.all([
    import('pdfmake/build/pdfmake'),
    import('pdfmake/build/vfs_fonts'),
  ]);
  pdfMake.addVirtualFileSystem(pdfFonts);

  return pdfMake.createPdf({
    pageSize: 'A4',
    pageMargins: [40, 48, 40, 48],
    defaultStyle: { fontSize: 10.5, lineHeight: 1.35, color: '#1f2937' },
    content: parseMarkdown(markdown).children.map(pdfBlock).filter(Boolean),
    footer: (currentPage, pageCount) => ({
      text: `${currentPage} / ${pageCount}`,
      alignment: 'center',
      fontSize: 8,
      color: '#9ca3af',
      margin: [0, 18, 0, 0],
    }),
  });
};

/* ------------------------------ downloads ----------------------------- */

export const downloadReport = async (markdown, format) => {
  const name = reportFileName(markdown);
  if (format === 'md') {
    saveBlob(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }), `${name}.md`);
  } else if (format === 'txt') {
    saveBlob(new Blob([markdownToPlainText(markdown)], { type: 'text/plain;charset=utf-8' }), `${name}.txt`);
  } else if (format === 'pdf') {
    const pdf = await buildPdf(markdown);
    await pdf.download(`${name}.pdf`);
  }
};
