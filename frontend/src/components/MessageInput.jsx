import React, { useState, useRef, useEffect } from "react";
import {
  Send,
  Square,
  Paperclip,
  Loader2,
  Plus,
  Search,
  PenLine,
  BookOpen,
  X,
  Check,
} from "lucide-react";
import AttachmentCard from "./AttachmentCard";
import { PromptInput, PromptInputTextarea, PromptInputActions, PromptInputAction } from "./ui/prompt-input";

const MessageInput = ({
  onSendMessage,
  onAddAttachment,
  onRemoveAttachment,
  onStop,
  disabled,
  pendingAttachments = [],
  uploadingAttachment = false,
}) => {
  const [message, setMessage] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [showPlusMenu, setShowPlusMenu] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [selectedTools, setSelectedTools] = useState([]);
  const fileInputRef = useRef(null);
  const plusButtonRef = useRef(null);
  const menuRef = useRef(null);
  const menuItemsRef = useRef([]);

  const inputDisabled = uploadingAttachment;
  const showStop = disabled && !uploadingAttachment;

  const menuActions = [
    {
      key: "upload",
      label: "Upload Document",
      icon: Paperclip,
      onClick: () => fileInputRef.current?.click(),
      active: false,
    },
    {
      key: "search",
      label: "Search",
      icon: Search,
      onClick: () => handleToolSelect("search"),
      active: selectedTools.includes("search"),
    },
    {
      key: "blogs",
      label: "Blog",
      icon: PenLine,
      onClick: () => handleToolSelect("blogs"),
      active: selectedTools.includes("blogs"),
    },
    {
      key: "deep_research",
      label: "Deep Research",
      icon: BookOpen,
      onClick: () => handleToolSelect("deep_research"),
      active: selectedTools.includes("deep_research"),
    },
  ];

  const closeMenu = () => {
    setShowPlusMenu(false);
    setActiveIndex(-1);
  };

  // Close Plus menu when clicking outside
  useEffect(() => {
    if (!showPlusMenu) return;

    const handlePointerDown = (event) => {
      if (
        !menuRef.current?.contains(event.target) &&
        !plusButtonRef.current?.contains(event.target)
      ) {
        closeMenu();
      }
    };

    const handleKey = (event) => {
      if (event.key === "Escape") {
        closeMenu();
        plusButtonRef.current?.focus();
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKey);
    };
  }, [showPlusMenu]);

  const openMenu = () => {
    setShowPlusMenu(true);
    setActiveIndex(-1);
  };

  const handlePlusClick = () => {
    if (showPlusMenu) {
      closeMenu();
    } else {
      openMenu();
    }
  };

  const handleSubmit = () => {
    if (message.trim() && !disabled) {
      onSendMessage(message, selectedTools, pendingAttachments);
      setMessage("");
      setSelectedTools([]);
    }
  };

  const handleStop = () => {
    const prompt = onStop?.();
    if (prompt) setMessage(prompt);
  };

  // Search, Blog and Deep Research each route the message to a different
  // pipeline on the backend, so only one can be active at a time. Picking a
  // tool replaces the current one; picking the active tool turns it off.
  const handleToolSelect = (tool) => {
    setSelectedTools(selectedTools.includes(tool) ? [] : [tool]);
    closeMenu();
  };

  const handleRemoveTool = (tool) => {
    setSelectedTools(selectedTools.filter((t) => t !== tool));
  };

  const handleFileSelect = (file) => {
    const name = file?.name || "";
    const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
    const supported = [".pdf", ".md", ".txt"];
    if (file && (file.type === "application/pdf" || supported.includes(ext))) {
      // Hold the file as a pending attachment (ChatGPT-style chip). It is only
      // uploaded when the message is actually sent, together with the prompt.
      onAddAttachment(file);
    } else {
      alert("Please upload a PDF, Markdown (.md), or text (.txt) file");
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files);
    const docFile = files.find((file) => {
      const ext = (file.name || "").slice(file.name.lastIndexOf(".")).toLowerCase();
      return [".pdf", ".md", ".txt"].includes(ext);
    });

    if (docFile) {
      handleFileSelect(docFile);
    }
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleMenuKeyDown = (e) => {
    const count = menuActions.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % count);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + count) % count);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActiveIndex(count - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      if (activeIndex >= 0 && activeIndex < count) {
        e.preventDefault();
        menuActions[activeIndex].onClick();
      }
    } else if (e.key === "Tab") {
      // Let focus leave naturally but close the menu
      closeMenu();
    }
  };

  useEffect(() => {
    if (showPlusMenu && activeIndex >= 0) {
      menuItemsRef.current[activeIndex]?.focus();
    }
  }, [activeIndex, showPlusMenu]);

  return (
    <div className="border-t border-gray-700 bg-chat-bg">
      <PromptInput
        value={message}
        onValueChange={setMessage}
        onSubmit={handleSubmit}
        disabled={inputDisabled}
        maxHeight={200}
        className={`max-w-3xl mx-auto ${isDragging ? "ring-2 ring-blue-500" : ""}`}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        {/* Pending attachment previews — shown before sending */}
        {pendingAttachments.length > 0 && (
          <div className="flex flex-wrap gap-2.5 mx-1 mt-1.5 mb-1">
            {pendingAttachments.map((att) => (
              <AttachmentCard
                key={att.id}
                attachment={att}
                onRemove={() => onRemoveAttachment(att.id)}
              />
            ))}
          </div>
        )}

        <PromptInputTextarea
          placeholder={isDragging ? "Drop document here..." : "Send a message..."}
          disabled={inputDisabled}
        />

        <PromptInputActions className="flex items-center justify-between gap-2 px-1 pb-1">
          <div className="flex items-center gap-1">
            {/* Plus Menu (Attachments / Tools) */}
            <div className="relative">
              <PromptInputAction tooltip="Add">
                <button
                  ref={plusButtonRef}
                  type="button"
                  onClick={handlePlusClick}
                  aria-haspopup="menu"
                  aria-expanded={showPlusMenu}
                  aria-label="Add attachment or tool"
                  className={[
                    "flex-shrink-0 flex items-center justify-center w-9 h-9 rounded-full text-gray-400",
                    "transition-colors duration-150 ease-out",
                    "hover:text-gray-100 hover:bg-gray-700",
                    "focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
                    "active:scale-90",
                    showPlusMenu ? "bg-gray-700 text-gray-100 rotate-45" : "",
                  ].join(" ")}
                  title="Add"
                >
                  <Plus size={20} strokeWidth={2.25} />
                </button>
              </PromptInputAction>

              {showPlusMenu && (
                <div
                  ref={menuRef}
                  role="menu"
                  aria-label="Add"
                  onKeyDown={handleMenuKeyDown}
                  className="absolute bottom-full left-0 mb-3 w-48 origin-bottom-left rounded-xl bg-[#2a2b32] border border-gray-700/80 shadow-2xl shadow-black/40 p-1 z-50 animate-scale-in"
                  style={{ transformOrigin: "bottom left" }}
                >
                  {menuActions.map((action, index) => {
                    const Icon = action.icon;
                    const isActive = index === activeIndex;
                    return (
                      <React.Fragment key={action.key}>
                        {index === 1 && (
                          <div role="separator" className="my-1 mx-2 border-t border-gray-700/80" />
                        )}
                        <button
                          ref={(el) => (menuItemsRef.current[index] = el)}
                          role="menuitem"
                          type="button"
                          onClick={action.onClick}
                          onMouseEnter={() => setActiveIndex(index)}
                          onFocus={() => setActiveIndex(index)}
                          tabIndex={isActive ? 0 : -1}
                          className={[
                            "group w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-left",
                            "transition-colors duration-100",
                            isActive ? "bg-gray-700/70" : "bg-transparent",
                          ].join(" ")}
                        >
                          <Icon
                            size={16}
                            strokeWidth={2}
                            className={[
                              "flex-shrink-0 transition-colors duration-100",
                              isActive || action.active ? "text-gray-100" : "text-gray-400",
                            ].join(" ")}
                          />
                          <span className="text-sm text-gray-100 truncate">
                            {action.label}
                          </span>
                          {action.active && (
                            <span className="ml-auto flex-shrink-0 text-blue-400">
                              <Check size={15} />
                            </span>
                          )}
                        </button>
                      </React.Fragment>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Selected Tools Chips */}
            {selectedTools.map((tool) => {
              const action = menuActions.find((a) => a.key === tool);
              if (!action) return null;
              const Icon = action.icon;
              return (
                <div
                  key={tool}
                  className="flex items-center gap-1.5 rounded-[10px] border border-blue-400/30 bg-blue-500/10 pl-2.5 pr-1.5 py-1.5 text-sm text-blue-300"
                >
                  <Icon size={15} className="shrink-0" />
                  <span className="leading-none">{action.label}</span>
                  <button
                    type="button"
                    onClick={() => handleRemoveTool(tool)}
                    aria-label={`Remove ${action.label}`}
                    title="Remove tool"
                    className="flex items-center justify-center w-5 h-5 rounded-md text-blue-300/70 hover:text-blue-100 hover:bg-blue-400/20 transition-colors"
                  >
                    <X size={13} />
                  </button>
                </div>
              );
            })}
          </div>

          {/* Send / Stop Button */}
          <PromptInputAction tooltip={showStop ? "Stop generating" : "Send message"}>
            {showStop ? (
              <button
                type="button"
                onClick={handleStop}
                className="p-2 text-red-400 hover:text-red-300 hover:bg-gray-700 rounded-lg transition-colors"
                title="Stop generating"
              >
                <Square size={18} />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!message.trim() || disabled}
                className="p-2 text-gray-400 hover:text-white disabled:text-gray-600 disabled:cursor-not-allowed transition-colors"
              >
                <Send size={18} />
              </button>
            )}
          </PromptInputAction>
        </PromptInputActions>

        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.md,.txt"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFileSelect(file);
            e.target.value = "";
          }}
          className="hidden"
        />
      </PromptInput>

      <div className="mt-1 text-xs text-center text-gray-500">
        {isDragging ? (
          <span className="text-blue-400">Drop your document here</span>
        ) : (
          <span>
            Press Enter to send, Shift+Enter for new line • Drag & drop documents (PDF, MD, TXT) to upload
          </span>
        )}
      </div>
    </div>
  );
};

export default MessageInput;
