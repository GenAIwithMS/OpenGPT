import React, { useState, useEffect } from 'react';
import {
  Plus,
  Edit2,
  Trash2,
  Menu,
  X,
  MoreVertical,
  ChevronDown,
  Search as SearchIcon,
  PanelLeftClose,
  PanelLeftOpen,
  Code2,
} from 'lucide-react';
import UserMenu from './settings/UserMenu';

const SquarePenIcon = (props) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="lucide lucide-square-pen-icon lucide-square-pen"
    {...props}
  >
    <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" />
  </svg>
);

const Sidebar = ({
  threads,
  currentThreadId,
  onThreadSelect,
  onNewThread,
  onThreadRename,
  onThreadDelete,
  isSidebarOpen,
  toggleSidebar,
  isCollapsed,
  onToggleCollapse,
  isCodeActive = false,
  onOpenCode,
  listLabel = 'Recents',
  emptyText = 'No chats yet',
  displayName = 'Muhammad',
  onOpenSettings = () => {},
  onOpenSearch = () => {},
}) => {
  const [editingThreadId, setEditingThreadId] = useState(null);
  const [editTitle, setEditTitle] = useState('');
  const [openMenuId, setOpenMenuId] = useState(null);
  const [recentsOpen, setRecentsOpen] = useState(true);

  const handleRename = (threadId, currentTitle) => {
    setEditingThreadId(threadId);
    setEditTitle(currentTitle);
    setOpenMenuId(null);
  };

  const handleSaveRename = (threadId) => {
    if (editTitle.trim()) {
      onThreadRename(threadId, editTitle);
    }
    setEditingThreadId(null);
    setEditTitle('');
  };

  const handleDelete = (threadId) => {
    if (onThreadDelete) {
      onThreadDelete(threadId);
    }
    setOpenMenuId(null);
  };

  const toggleMenu = (e, threadId) => {
    e.stopPropagation();
    setOpenMenuId(openMenuId === threadId ? null : threadId);
  };

  const openChat = (thread) => {
    if (!thread) return;
    onThreadSelect(thread.thread_id);
    if (window.innerWidth < 1024) toggleSidebar();
  };

  // Close thread dropdown menus when clicking elsewhere
  useEffect(() => {
    if (!openMenuId) return;
    const handle = (e) => {
      if (!e.target.closest('[data-thread-menu]')) {
        setOpenMenuId(null);
      }
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [openMenuId]);

  return (
    <>
      {/* Mobile open button — fades out while the drawer is open */}
      <button
        onClick={toggleSidebar}
        aria-label="Open sidebar"
        className={`
          lg:hidden fixed top-4 left-4 z-50 p-2 rounded-xl bg-sidebar-bg text-white shadow-lg
          transition-opacity duration-300 ease-in-out
          ${isSidebarOpen ? 'opacity-0 pointer-events-none' : 'opacity-100'}
        `}
      >
        <Menu size={24} />
      </button>

      {/* Single sidebar element: animates width in place on desktop,
          slides as a drawer on mobile. */}
      <div
        className={`
          fixed lg:static inset-y-0 left-0 z-40
          ${isCollapsed ? 'w-[60px] lg:w-[60px]' : 'w-64 lg:w-64'}
          bg-sidebar-bg text-white flex flex-col
          transform transition-[transform,width] duration-300 ease-in-out will-change-[transform,width]
          ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
        `}
      >
        {/* Mobile-only close button — inside the drawer, away from chat */}
        <button
          onClick={toggleSidebar}
          aria-label="Close sidebar"
          className="lg:hidden absolute top-3 right-3 z-50 p-2 rounded-xl text-gray-300 hover:text-white hover:bg-gray-700 transition-colors"
        >
          <X size={20} />
        </button>

        {isCollapsed ? (
          /* Collapsed rail (desktop) */
          <div className="flex flex-1 flex-col items-center py-3 px-2">
            {/* Brand — click the "O" to expand; hovering reveals the expand icon */}
            <button
              onClick={() => onToggleCollapse?.()}
              title="OpenGPT — click to expand"
              className="group/brand relative flex items-center justify-center w-9 h-9 mb-2 text-lg font-semibold text-white select-none rounded-xl hover:bg-gray-700 transition-colors"
            >
              <span className="group-hover/brand:opacity-0 transition-opacity">O</span>
              <PanelLeftOpen
                size={18}
                className="absolute opacity-0 group-hover/brand:opacity-100 transition-opacity"
              />
            </button>

            <button
              onClick={onNewThread}
              title="New chat"
              className="flex items-center justify-center w-10 h-10 rounded-xl hover:bg-gray-700 transition-colors mt-1"
            >
              <Plus size={20} />
            </button>

            <button
              onClick={onOpenSearch}
              title="Search chats"
              className="flex items-center justify-center w-10 h-10 rounded-xl hover:bg-gray-700 transition-colors mt-1"
            >
              <SearchIcon size={18} />
            </button>

            <button
              onClick={onOpenCode}
              title="Code"
              aria-current={isCodeActive ? 'page' : undefined}
              className={`flex items-center justify-center w-10 h-10 rounded-xl transition-colors mt-1 ${
                isCodeActive ? 'bg-gray-700/90' : 'hover:bg-gray-700'
              }`}
            >
              <Code2 size={18} />
            </button>

            <div className="mt-auto">
              <UserMenu displayName={displayName} onOpenSettings={onOpenSettings} collapsed />
            </div>
          </div>
        ) : (
          /* Expanded sidebar */
          <>
            {/* Brand header */}
            <div className="flex items-center justify-between px-2 pt-3 pb-1 shrink-0">
              <span className="px-2 text-base font-semibold tracking-tight text-white select-none whitespace-nowrap overflow-hidden">
                OpenGPT
              </span>
              <button
                onClick={() => onToggleCollapse?.()}
                title="Close sidebar"
                className="hidden lg:flex items-center justify-center w-9 h-9 rounded-lg text-gray-400 hover:text-white hover:bg-gray-700 transition-colors shrink-0"
              >
                <PanelLeftClose size={18} />
              </button>
            </div>

            {/* New chat */}
            <div className="flex items-center gap-1 px-2 pt-1">
              <button
                onClick={onNewThread}
                className="group flex items-center gap-2.5 flex-1 px-3 py-2.5 rounded-xl hover:bg-gray-700/80 transition-colors text-left"
                title="New chat"
              >
                <span className="flex items-center justify-center w-5 h-5 shrink-0">
                  <SquarePenIcon size={18} />
                </span>
                <span className="text-sm font-medium whitespace-nowrap">New chat</span>
              </button>
            </div>

            {/* Search chats: opens the search window (Ctrl/Cmd+K) */}
            <div className="px-2 pt-2 pb-1">
              <button
                type="button"
                onClick={onOpenSearch}
                aria-haspopup="dialog"
                className="
                  flex w-full items-center gap-2 px-3 py-2 rounded-xl text-left
                  bg-transparent border border-transparent hover:bg-gray-700/60
                  transition-colors
                "
              >
                <SearchIcon size={16} className="text-gray-400 shrink-0" />
                <span className="w-full text-sm text-gray-500">Search chats</span>
              </button>
            </div>

            {/* Code — coding agent */}
            <div className="px-2">
              <button
                onClick={onOpenCode}
                aria-current={isCodeActive ? 'page' : undefined}
                className={`
                  flex items-center gap-2.5 w-full px-3 py-2.5 rounded-xl transition-colors text-left
                  ${isCodeActive ? 'bg-gray-700/90' : 'hover:bg-gray-700/80'}
                `}
                title="Code"
              >
                <span className="flex items-center justify-center w-5 h-5 shrink-0">
                  <Code2 size={18} />
                </span>
                <span className="text-sm font-medium whitespace-nowrap">Code</span>
              </button>
            </div>

            {/* Scrollable middle: Recents header + chat history.
                This region is the only flexible part; the OpenGPT header and
                footer stay pinned (shrink-0) so collapsing Recents doesn't move
                them. */}
            <div className="flex-1 min-h-0 flex flex-col">
              {/* Recents header — toggles the chat history list visibility */}
              <button
                type="button"
                onClick={() => setRecentsOpen((o) => !o)}
                className="group flex items-center gap-1 px-3 pt-3 pb-1 text-left shrink-0"
              >
                <span className="text-sm font-medium text-gray-300 group-hover:text-gray-100 transition-colors truncate">
                  {listLabel}
                </span>
                <ChevronDown
                  size={16}
                  className={`
                    text-gray-400 opacity-0 group-hover:opacity-100
                    transition-transform duration-300 ease-out group-hover:text-gray-200
                    ${recentsOpen ? 'rotate-0' : '-rotate-90'}
                  `}
                />
              </button>

              {/* Chat history */}
              <div
                className={`
                  overflow-y-auto px-2 py-2 space-y-0.5 thin-scroll
                  transition-[max-height,opacity] duration-300 ease-out
                  ${recentsOpen
                    ? 'flex-1 min-h-0 max-h-[100vh] opacity-100' /* fill down to the footer, scroll inside */
                    : 'flex-none max-h-0 opacity-0 overflow-hidden'}
                `}
              >
              {threads.length === 0 ? (
                <div className="px-3 py-6 text-center text-xs text-gray-500">
                  {emptyText}
                </div>
              ) : (
                threads.map((thread) => {
                  const isActive = currentThreadId === thread.thread_id;
                  const isEditing = editingThreadId === thread.thread_id;
                  return (
                    <div
                      key={thread.thread_id}
                      data-thread-menu
                      className={`
                        group relative flex items-center gap-2 px-3 py-2 rounded-xl cursor-pointer
                        transition-colors duration-100 outline-none focus-visible:ring-2 focus-visible:ring-white/50
                        ${isActive ? 'bg-gray-700/90' : 'hover:bg-gray-700/60'}
                      `}
                      role={isEditing ? undefined : 'button'}
                      tabIndex={isEditing ? undefined : 0}
                      aria-current={isActive ? 'page' : undefined}
                      onClick={() => {
                        if (isEditing) return;
                        openChat(thread);
                      }}
                      onKeyDown={(e) => {
                        // Only the row itself, not the options button inside it
                        if (isEditing || e.target !== e.currentTarget) return;
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          openChat(thread);
                        }
                      }}
                    >
                      {isEditing ? (
                        <input
                          type="text"
                          maxLength={100}
                          aria-label="Chat title"
                          value={editTitle}
                          onChange={(e) => setEditTitle(e.target.value)}
                          onBlur={() => handleSaveRename(thread.thread_id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleSaveRename(thread.thread_id);
                            if (e.key === 'Escape') {
                              setEditingThreadId(null);
                              setEditTitle('');
                            }
                          }}
                          className="w-full bg-gray-600 px-2 py-1 rounded-lg text-sm text-white outline-none focus:ring-2 focus:ring-blue-500"
                          autoFocus
                          onClick={(e) => e.stopPropagation()}
                        />
                      ) : (
                        <>
                          <span className="text-sm text-gray-100 truncate flex-1 min-w-0">
                            {thread.title || 'New Chat'}
                          </span>
                          <button
                            onClick={(e) => toggleMenu(e, thread.thread_id)}
                            aria-label="Chat options"
                            className={`
                              shrink-0 p-1 rounded-md text-gray-300 hover:bg-gray-600 opacity-0
                              group-hover:opacity-100 focus:opacity-100 transition-opacity
                              ${openMenuId === thread.thread_id ? 'opacity-100' : ''}
                            `}
                          >
                            <MoreVertical size={15} />
                          </button>

                          {openMenuId === thread.thread_id && (
                            <div
                              className="absolute right-2 top-full mt-1 w-36 bg-gray-800 rounded-xl shadow-xl shadow-black/40 z-50 py-1 border border-gray-700/70 animate-menu-in origin-top-right"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleRename(thread.thread_id, thread.title);
                                }}
                                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-200 hover:bg-gray-700 rounded-lg mx-1"
                              >
                                <Edit2 size={14} />
                                <span>Rename</span>
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleDelete(thread.thread_id);
                                }}
                                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-red-400 hover:bg-gray-700 rounded-lg mx-1"
                              >
                                <Trash2 size={14} />
                                <span>Delete</span>
                              </button>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  );
                })
              )}
            </div>
            </div>

            {/* Footer: you, and the menu for Account / Settings */}
            <div className="px-2 py-2 border-t border-gray-700/60 shrink-0">
              <UserMenu displayName={displayName} onOpenSettings={onOpenSettings} />
            </div>
          </>
        )}
      </div>

      {/* Overlay for mobile — fades with the drawer */}
      <div
        className={`
          lg:hidden fixed inset-0 bg-black bg-opacity-50 z-30
          transition-opacity duration-300 ease-in-out
          ${isSidebarOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'}
        `}
        onClick={toggleSidebar}
      />
    </>
  );
};

export default Sidebar;
