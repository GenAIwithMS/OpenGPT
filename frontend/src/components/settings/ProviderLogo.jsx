import React from 'react';
import { Server } from 'lucide-react';
import {
  siAnthropic, siDeepseek, siGooglegemini, siHuggingface, siLmstudio, siMistralai, siOllama, siOpenrouter, siX,
} from 'simple-icons';
import openaiLogo from '../../assets/providers/openai.png';
import groqLogo from '../../assets/providers/groq.png';
import togetherLogo from '../../assets/providers/together.png';
import fireworksLogo from '../../assets/providers/fireworks.png';
import cerebrasLogo from '../../assets/providers/cerebras.png';

// Official logos: downloaded ones (src/assets/providers/SOURCES.md) and Simple Icons.
const IMAGES = {
  openai: openaiLogo, groq: groqLogo, together: togetherLogo, fireworks: fireworksLogo, cerebras: cerebrasLogo,
};
const ICONS = {
  anthropic: siAnthropic, gemini: siGooglegemini, openrouter: siOpenrouter, mistral: siMistralai,
  deepseek: siDeepseek, xai: siX, huggingface: siHuggingface, ollama: siOllama, lmstudio: siLmstudio,
};

const visible = (hex) => {
  const n = parseInt(hex, 16);
  const luminance = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return luminance < 0.35 ? '#ffffff' : `#${hex}`;
};

const ProviderLogo = ({ preset, name, size = 'h-9 w-9' }) => {
  const image = IMAGES[preset];
  const icon = ICONS[preset];
  return (
    <span className={`flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-white/[0.06] ring-1 ring-white/5 ${size}`}>
      {image ? (
        <img src={image} alt={`${name || preset} logo`} className="h-6 w-6 rounded object-contain" draggable="false" />
      ) : icon ? (
        <svg role="img" aria-label={`${name || icon.title} logo`} viewBox="0 0 24 24" className="h-[18px] w-[18px]">
          <path d={icon.path} fill={visible(icon.hex)} />
        </svg>
      ) : (
        <Server size={16} className="text-gray-300" aria-label={`${name || 'Custom'} provider`} />
      )}
    </span>
  );
};

export default ProviderLogo;
