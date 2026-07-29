import React, { useState, useRef, useEffect } from "react";
import {
  Send,
  Square,
  Paperclip,
  FileText,
  Loader2,
  Plus,
  Search,
  FileEdit,
  FileText as BlogIcon,
  BookOpen,
  X,
  Check,
} from "lucide-react";
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
      description: "Attach a document",
      icon: Paperclip,
      iconClass: "text-blue-400",
      onClick: () => fileInputRef.current?.click(),
      active: false,
    },
    {
      key: "search",
      label: "Search",
      description: "Search the web",
      icon: Search,
      iconClass: "text-emerald-400",
      onClick: () => handleToolSelect("search"),
      active: selectedTools.includes("search"),
    },
    {
      key: "blogs",
      label: "Blog",
      description: "Generate a blog post",
      icon: BlogIcon,
      iconClass: "text-purple-400",
      onClick: () => handleToolSelect("blogs"),
      active: selectedTools.includes("blogs"),
    },
    {
      key: "deep_research",
      label: "Deep Research",
      description: "In-depth research report",
      icon: BookOpen,
      iconClass: "text-orange-400",
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

  const handleToolSelect = (tool) => {
    if (!selectedTools.includes(tool)) {
      setSelectedTools([...selectedTools, tool]);
    }
    closeMenu();
  };

  const handleRemoveTool = (tool) => {
    setSelectedTools(selectedTools.filter((t) => t !== tool));
  };

  const getToolIcon = (tool) => {
    if (tool === "search") return <Search size={14} />;
    if (tool === "blogs") return <FileEdit size={14} />;
    if (tool === "deep_research") return <BookOpen size={14} />;
    return null;
  };

  const getToolLabel = (tool) => {
    if (tool === "search") return "Search";
    if (tool === "blogs") return "Blogs";
    if (tool === "deep_research") return "Deep Research";
    return tool;
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
        {/* Pending attachment chips (ChatGPT-style) — shown before sending */}
        {pendingAttachments.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 mx-1 mb-1">
            {pendingAttachments.map((att) => {
              const fname = att.file?.name || att.name || "document";
              const ext = (fname.split(".").pop() || "doc").toUpperCase();
              return (
                <div
                  key={att.id}
                  className="flex items-center gap-2 bg-[#1f2026] border border-gray-600 rounded-lg pl-3 pr-2 py-2 text-sm max-w-[220px]"
                >
                  <FileText size={16} className="text-blue-400 shrink-0" />
                  <span className="text-gray-200 truncate" title={fname}>
                    {fname}
                  </span>
                  <span className="text-xs text-gray-400 shrink-0">{ext}</span>
                  <button
                    type="button"
                    onClick={() => onRemoveAttachment(att.id)}
                    aria-label={`Remove ${fname}`}
                    className="shrink-0 flex items-center justify-center w-5 h-5 rounded-full text-gray-400 hover:text-gray-100 hover:bg-gray-700 transition-colors"
                  >
                    <X size={14} />
                  </button>
                </div>
              );
            })}
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
                  className="absolute bottom-full left-0 mb-3 w-60 origin-bottom-left rounded-2xl bg-[#2a2b32] border border-gray-700/80 shadow-2xl shadow-black/40 p-1.5 z-50 animate-scale-in"
                  style={{ transformOrigin: "bottom left" }}
                >
                  {menuActions.map((action, index) => {
                    const Icon = action.icon;
                    const isActive = index === activeIndex;
                    return (
                      <button
                        key={action.key}
                        ref={(el) => (menuItemsRef.current[index] = el)}
                        role="menuitem"
                        type="button"
                        onClick={action.onClick}
                        onMouseEnter={() => setActiveIndex(index)}
                        onFocus={() => setActiveIndex(index)}
                        tabIndex={isActive ? 0 : -1}
                        className={[
                          "group w-full flex items-center gap-3 px-2.5 py-2 rounded-xl text-left",
                          "transition-colors duration-100",
                          isActive ? "bg-gray-700/70" : "bg-transparent",
                        ].join(" ")}
                      >
                        <span
                          className={[
                            "flex-shrink-0 flex items-center justify-center w-9 h-9 rounded-lg bg-gray-700/60",
                            "transition-colors duration-100 group-hover:bg-gray-600/70",
                            action.iconClass,
                          ].join(" ")}
                        >
                          <Icon size={18} strokeWidth={2} />
                        </span>
                        <span className="flex flex-col min-w-0">
                          <span className="text-sm font-medium text-gray-100 leading-tight">
                            {action.label}
                          </span>
                          <span className="text-xs text-gray-400 leading-tight truncate">
                            {action.description}
                          </span>
                        </span>
                        {action.active && (
                          <span className="ml-auto flex-shrink-0 text-emerald-400">
                            <Check size={16} />
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Selected Tools Chips */}
            {selectedTools.map((tool) => (
              <div
                key={tool}
                className="group flex items-center gap-1 bg-gray-600 border border-gray-500 rounded px-1.5 py-0.5 text-xs"
              >
                {getToolIcon(tool)}
                <span className="text-gray-200">{getToolLabel(tool)}</span>
                <button
                  onClick={() => handleRemoveTool(tool)}
                  className="opacity-0 group-hover:opacity-100 p-0.5 hover:bg-gray-500 rounded transition-all"
                  title="Remove tool"
                >
                  <X size={10} className="text-gray-300" />
                </button>
              </div>
            ))}
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
