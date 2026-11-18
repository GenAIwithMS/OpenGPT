import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, X } from 'lucide-react';

// Small building blocks shared by the settings pages.

/** A settings page's title and one-line description. */
export const PageHeader = ({ title, description }) => (
  <div className="mb-6 border-b border-gray-700/70 pb-4">
    <h2 className="text-xl font-semibold text-gray-100">{title}</h2>
    {description && <p className="mt-1 text-sm text-gray-400">{description}</p>}
  </div>
);

/** A titled group of rows on a settings page. */
export const Section = ({ title, children }) => (
  <section className="mb-8">
    {title && <h3 className="mb-3 text-base font-medium text-gray-200">{title}</h3>}
    <div className="divide-y divide-gray-700/50">{children}</div>
  </section>
);

/**
 * One setting: label and description on the left, its control on the right.
 * Pass `htmlFor` with the control's id so clicking the label focuses it.
 */
// One setting: label + description on the left, control on the right.
export const Row = ({ label, description, children, htmlFor }) => (
  <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
    <div className="min-w-0">
      <label htmlFor={htmlFor} className="block text-sm text-gray-100">{label}</label>
      {description && <p className="mt-0.5 text-xs leading-relaxed text-gray-400">{description}</p>}
    </div>
    <div className="shrink-0">{children}</div>
  </div>
);

/**
 * An on/off switch.
 *
 * @param {object} props
 * @param {boolean} props.checked
 * @param {(value: boolean) => void} props.onChange
 * @param {string} props.label  Read by screen readers (the switch has no visible text).
 * @param {boolean} [props.disabled]
 */
export const Toggle = ({ checked, onChange, label, disabled }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:opacity-50 ${
      checked ? 'bg-blue-600' : 'bg-gray-600'
    }`}
  >
    <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
      checked ? 'translate-x-[18px]' : 'translate-x-0.5'
    }`} />
  </button>
);

/**
 * A dropdown styled for the dark theme, with keyboard support (arrows, Enter,
 * Escape closes only the list).
 *
 * @param {object} props
 * @param {string} props.id
 * @param {string} props.value
 * @param {(value: string) => void} props.onChange
 * @param {{value: string, label: string}[]} props.options
 * @param {string} props.label  Accessible name.
 */
// A dropdown in the app's theme (a native <select> opens an unstyled system list).
// Keyboard: Enter/Space/Arrow keys open it, arrows move, Enter picks, Escape closes.
export const Select = ({ id, value, onChange, options, label }) => {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const ref = useRef(null);
  const listRef = useRef(null);
  const selected = options.find((o) => o.value === value) || options[0];

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    // Escape closes just this list, not the settings popup around it
    // (captured first, wherever the focus is).
    const onEscape = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onEscape, true);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onEscape, true);
    };
  }, [open]);

  useEffect(() => {
    if (open) listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const openList = () => {
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  };
  const pick = (option) => {
    setOpen(false);
    if (option.value !== value) onChange(option.value);
  };

  const onKeyDown = (e) => {
    if (!open) {
      if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); openList(); }
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % options.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i - 1 + options.length) % options.length); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(options[active]); }
    else if (e.key === 'Tab') setOpen(false);
  };

  return (
    <div ref={ref} className="relative w-full sm:w-64">
      <button
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-label={label}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKeyDown}
        className={`flex w-full items-center justify-between gap-2 rounded-lg border bg-[#26272e] px-3 py-1.5 text-left text-sm text-gray-100 outline-none transition-colors ${
          open ? 'border-gray-400' : 'border-gray-600 hover:border-gray-500 focus-visible:border-gray-400'
        }`}
      >
        <span className="truncate">{selected?.label}</span>
        <ChevronDown size={15} className={`shrink-0 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <ul
          id={`${id}-list`}
          ref={listRef}
          role="listbox"
          aria-labelledby={id}
          className="thin-scroll absolute right-0 z-50 mt-1 max-h-60 w-full overflow-y-auto rounded-xl border border-gray-700/80 bg-[#2a2b32] p-1 shadow-2xl shadow-black/40 animate-menu-in origin-top"
        >
          {options.map((option, i) => {
            const isSelected = option.value === value;
            return (
              <li
                key={option.value}
                role="option"
                aria-selected={isSelected}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(option)}
                className={`flex cursor-pointer items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm ${
                  i === active ? 'bg-gray-700 text-white' : 'text-gray-200'
                }`}
              >
                <span className="min-w-0">
                  <span className="block truncate">{option.label}</span>
                  {option.description && <span className="block truncate text-xs text-gray-500">{option.description}</span>}
                </span>
                {isSelected && <Check size={14} className="shrink-0 text-gray-300" />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

/** A round avatar with the first letter of `name`. */
export const Avatar = ({ name, size = 'h-8 w-8 text-sm' }) => (
  <span className={`flex shrink-0 items-center justify-center rounded-full bg-violet-600 font-semibold text-white ${size}`} aria-hidden="true">
    {(name || 'M').trim().charAt(0).toUpperCase()}
  </span>
);

/** Classes for text inputs and textareas in settings. */
export const inputClass =
  'w-full rounded-lg border border-gray-600 bg-[#26272e] px-3 py-2 text-sm text-gray-100 placeholder-gray-500 outline-none focus:border-gray-400';

// A dialog above the settings popup; Escape or a click outside closes it.
export const Modal = ({ title, onClose, children, wide = false }) => {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="animate-backdrop-in fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}
        className={`animate-dialog-in flex w-full flex-col rounded-2xl border border-gray-700 bg-[#26272e] shadow-2xl ${
          wide ? 'h-[85vh] max-w-3xl' : 'max-h-[85vh] max-w-lg'
        }`}>
        <div className="flex items-center border-b border-gray-700/70 px-5 py-3.5">
          <h2 className="text-base font-semibold text-gray-100">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="ml-auto rounded-lg p-1 text-gray-400 hover:bg-white/5">
            <X size={17} />
          </button>
        </div>
        <div className="thin-scroll min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
};
