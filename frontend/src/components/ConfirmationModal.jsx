import React, { useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, Loader2, X } from 'lucide-react';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const ConfirmationModal = ({
  isOpen,
  onClose,
  onConfirm,
  title = "Confirm Action",
  message = "Are you sure?",
  confirmText = "Confirm",
  cancelText = "Cancel",
  danger = false
}) => {
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef(null);
  const cancelRef = useRef(null);
  const titleId = useId();
  const messageId = useId();
  // Latest handlers, so the key listener doesn't re-bind every render.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    if (!isOpen) return;
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Start on Cancel, the safe choice for a destructive action.
    cancelRef.current?.focus();

    const handleKey = (e) => {
      if (e.key === 'Escape') {
        if (!busyRef.current) closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      // Keep Tab inside the dialog.
      const items = [...dialogRef.current.querySelectorAll(FOCUSABLE)];
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      } else if (!dialogRef.current.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKey);

    return () => {
      document.removeEventListener('keydown', handleKey);
      document.body.style.overflow = previousOverflow;
      if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) setBusy(false);
  }, [isOpen]);

  if (!isOpen) return null;

  const close = () => {
    if (!busy) onClose();
  };

  // Ignore further clicks until the action finishes (no double delete).
  const handleConfirm = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 animate-fade-in"
      onClick={(e) => e.target === e.currentTarget && close()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        className="bg-white dark:bg-gray-900 rounded-lg shadow-xl max-w-sm w-full border border-gray-200 dark:border-gray-700 animate-scale-in"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2">
            {danger && (
              <AlertTriangle className="w-5 h-5 text-red-600 dark:text-red-400" aria-hidden="true" />
            )}
            <h2 id={titleId} className="text-base font-semibold text-gray-900 dark:text-white">
              {title}
            </h2>
          </div>
          <button
            type="button"
            onClick={close}
            disabled={busy}
            aria-label="Close"
            title="Close"
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors disabled:opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="px-4 py-3">
          <p id={messageId} className="text-sm text-gray-600 dark:text-gray-300">
            {message}
          </p>
        </div>

        {/* Actions */}
        <div className="flex gap-2 px-4 pb-4 justify-end">
          <button
            ref={cancelRef}
            type="button"
            onClick={close}
            disabled={busy}
            className="px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-600 transition-all duration-200 disabled:opacity-50"
          >
            {cancelText}
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={busy}
            aria-busy={busy}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white rounded-md transition-all duration-200 disabled:opacity-70 disabled:cursor-not-allowed ${
              danger
                ? 'bg-red-600 hover:bg-red-700'
                : 'bg-blue-600 hover:bg-blue-700'
            }`}
          >
            {busy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConfirmationModal;
