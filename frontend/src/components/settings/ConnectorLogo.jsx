import React from 'react';
import { Brain, Clock, DownloadCloud, ListOrdered } from 'lucide-react';
import {
  siAsana, siBrave, siGit, siGithub, siGooglechrome, siLinear, siNotion, siPaypal,
  siSentry, siStripe, siVercel,
} from 'simple-icons';
import canvaLogo from '../../assets/connectors/canva.png';
import firecrawlLogo from '../../assets/connectors/firecrawl.png';
import context7Logo from '../../assets/connectors/context7.png';
import playwrightLogo from '../../assets/connectors/playwright.svg';

// Official logos downloaded from the companies' own sites (see
// src/assets/connectors/SOURCES.md), for brands not in Simple Icons.
const IMAGES = {
  canva: canvaLogo,
  firecrawl: firecrawlLogo,
  context7: context7Logo,
  playwright: playwrightLogo,
};

// Official brand marks (Simple Icons, CC0) for the other catalog connectors.
// Anything without a logo (custom servers) gets a letter tile.
const ICONS = {
  github: siGithub,
  notion: siNotion,
  linear: siLinear,
  sentry: siSentry,
  vercel: siVercel,
  stripe: siStripe,
  paypal: siPaypal,
  asana: siAsana,
  git: siGit,
  'chrome-devtools': siGooglechrome,
  'brave-search': siBrave,
};

// The MCP project's reference servers have no logos of their own, so each
// gets an icon for what it does, on its own colour.
const GLYPHS = {
  fetch: { Icon: DownloadCloud, color: '#38bdf8', bg: 'rgba(56,189,248,0.14)' },
  memory: { Icon: Brain, color: '#f472b6', bg: 'rgba(244,114,182,0.14)' },
  'sequential-thinking': { Icon: ListOrdered, color: '#a78bfa', bg: 'rgba(167,139,250,0.14)' },
  time: { Icon: Clock, color: '#fbbf24', bg: 'rgba(251,191,36,0.14)' },
};

// Brand colours that would vanish on the dark tile are shown in white.
const visible = (hex) => {
  const n = parseInt(hex, 16);
  const luminance = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return luminance < 0.35 ? '#ffffff' : `#${hex}`;
};

const ConnectorLogo = ({ id, name, size = 'h-9 w-9' }) => {
  const icon = ICONS[id];
  const image = IMAGES[id];
  const glyph = GLYPHS[id];
  if (glyph) {
    const { Icon } = glyph;
    return (
      <span className={`flex shrink-0 items-center justify-center rounded-lg ring-1 ring-white/5 ${size}`} style={{ background: glyph.bg }}>
        <Icon size={18} color={glyph.color} strokeWidth={2} role="img" aria-label={`${name || id} icon`} />
      </span>
    );
  }
  return (
    <span className={`flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-white/[0.06] ring-1 ring-white/5 ${size}`}>
      {image ? (
        <img src={image} alt={`${name || id} logo`} className="h-6 w-6 rounded object-contain" draggable="false" />
      ) : icon ? (
        <svg role="img" aria-label={`${name || icon.title} logo`} viewBox="0 0 24 24" className="h-[18px] w-[18px]">
          <path d={icon.path} fill={visible(icon.hex)} />
        </svg>
      ) : (
        <span aria-hidden="true" className="text-sm font-semibold text-gray-200">
          {(name || id || '?').trim().charAt(0).toUpperCase()}
        </span>
      )}
    </span>
  );
};

export default ConnectorLogo;
