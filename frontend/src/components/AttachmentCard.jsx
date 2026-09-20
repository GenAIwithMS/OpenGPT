import React from "react";
import { FileText, Loader2, X } from "lucide-react";
import { formatFileSize, getFileExt } from "../lib/attachmentPreview";

// Document preview card, shared by the input box (with a remove button) and
// sent user messages. Shows the PDF's first page or a text snippet, with the
// file name and type underneath.
const AttachmentCard = ({ attachment, onRemove }) => {
  const { file, preview, previewLoading } = attachment;
  const name = file?.name || attachment.name || "document";
  const size = file?.size ?? attachment.size;
  const meta = [getFileExt(name), formatFileSize(size)].filter(Boolean).join(" · ");

  const handleOpen = () => {
    if (!file) return;
    // Markdown has no native viewer — serve it as plain text so it opens
    // in a tab instead of downloading.
    const blob = file.type === "application/pdf" ? file : new Blob([file], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  return (
    <div className="group relative w-36 shrink-0">
      <button
        type="button"
        onClick={handleOpen}
        disabled={!file}
        title={name}
        className="block w-full overflow-hidden rounded-xl border border-gray-600/80 bg-[#1f2026] text-left transition-colors enabled:hover:border-gray-500 disabled:cursor-default"
      >
        <div className="relative h-24 overflow-hidden bg-[#26272e]">
          {preview?.kind === "image" ? (
            <img src={preview.src} alt="" className="w-full object-cover object-top" />
          ) : preview?.kind === "text" ? (
            <p className="px-2 pt-2 text-[7px] leading-[1.45] text-gray-400 whitespace-pre-wrap break-words">
              {preview.text}
            </p>
          ) : (
            <div className="flex h-full items-center justify-center text-gray-500">
              {previewLoading ? <Loader2 size={20} className="animate-spin" /> : <FileText size={28} />}
            </div>
          )}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-[#1f2026] to-transparent" />
        </div>
        <div className="px-2.5 pb-2 pt-1">
          <div className="truncate text-xs font-medium text-gray-100">{name}</div>
          <div className="text-[11px] text-gray-400">{meta}</div>
        </div>
      </button>

      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${name}`}
          className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-gray-600 bg-[#2a2b32] text-gray-300 shadow transition-colors hover:bg-gray-600 hover:text-white"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
};

export default AttachmentCard;
