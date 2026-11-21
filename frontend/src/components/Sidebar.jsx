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
  Folder,
  FolderOpen,
  FolderInput,
  FolderMinus,
  FolderPlus,
  MoreHorizontal,
  Settings2,
  Pin,
  PinOff,
  Share,
} from 'lucide-react';
import UserMenu from './settings/UserMenu';
import Logo, { LogoMark } from './Logo';

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

/**
 * The left sidebar: new chat, search, Code, the list of chats (or coding
 * sessions on the Code page) with rename and delete, and the user menu.
 * Collapses to a narrow rail on desktop and slides in on mobile.
 *
 * @param {object} props
 * @param {{thread_id: string, title?: string}[]} props.threads  Chats, or coding sessions on the Code page.
 * @param {string|null} props.currentThreadId
 * @param {(id: string) => void} props.onThreadSelect
 * @param {() => void} props.onNewThread
 * @param {(id: string, title: string) => void} props.onThreadRename
 * @param {(id: string) => void} props.onThreadDelete
 * @param {boolean} props.isSidebarOpen  Mobile drawer open.
 * @param {() => void} props.toggleSidebar  Open or close the mobile drawer.
 * @param {boolean} props.isCollapsed  Desktop rail mode.
 * @param {() => void} props.onToggleCollapse
 * @param {boolean} [props.isCodeActive]  The Code page is showing.
 * @param {() => void} props.onOpenCode
 * @param {string} [props.listLabel]  Heading over the list ("Recents", "Sessions · project").
 * @param {string} [props.emptyText]
 * @param {string} [props.displayName]  Shown in the user menu.
 * @param {(section?: string) => void} [props.onOpenSettings]
 * @param {() => void} [props.onOpenSearch]  Open the search window.
 * @param {{id: string, name: string}[]} [props.projects]  Projects (not shown on the Code page).
 * @param {string|null} [props.currentProjectId]  The open project, or the open chat's project.
 * @param {(id: string) => void} [props.onOpenProject]
 * @param {(moveThreadId?: string) => void} [props.onNewProject]
 *   Create a project; with a chat id, the chat is moved into the new project.
 * @param {{thread_id: string, title?: string, project_id: string}[]} [props.projectThreads]
 *   Chats that are in a project, listed under their project when it is expanded.
 * @param {(id: string) => void} [props.onNewProjectChat]  Start a new chat in a project.
 * @param {(id: string) => void} [props.onProjectSettings]  Open a project's instructions.
 * @param {(id: string, name: string) => void} [props.onRenameProject]
 * @param {(project: object) => void} [props.onDeleteProject]  Ask to delete a project.
 * @param {(id: string, pinned: boolean) => void} [props.onPinProject]
 * @param {(threadId: string, projectId: string|null) => void} [props.onMoveThread]
 *   Move a chat into a project, or out of one. Without it the menu has no "Move to project".
 */
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
  projects = null,
  currentProjectId = null,
  onOpenProject = () => {},
  onNewProject = () => {},
  projectThreads = [],
  onNewProjectChat = () => {},
  onProjectSettings = () => {},
  onRenameProject = () => {},
  onDeleteProject = () => {},
  onPinProject = () => {},
  onMoveThread = null,
}) => {
  const [editingThreadId, setEditingThreadId] = useState(null);
  const [editTitle, setEditTitle] = useState('');
  const [openMenuId, setOpenMenuId] = useState(null);
  const [recentsOpen, setRecentsOpen] = useState(true);
  const [projectsOpen, setProjectsOpen] = useState(true);
  // The chat whose menu shows the project list ("Move to project").
  const [movingThreadId, setMovingThreadId] = useState(null);
  // Projects whose chats are listed under them, and the project being renamed.
  const [expandedProjects, setExpandedProjects] = useState(() => new Set());
  const [renamingProjectId, setRenamingProjectId] = useState(null);
  const [projectName, setProjectName] = useState('');
  // Where the open project menu sits. It floats so the scrolling list can't clip it.
  const [projectMenuPos, setProjectMenuPos] = useState(null);
  const [threadMenuStyle, setThreadMenuStyle] = useState(null);
  // The project whose link was just copied ("Share project").
  const [copiedProjectId, setCopiedProjectId] = useState(null);

  // The open project (or the open chat's project) shows its chats.
  useEffect(() => {
    if (currentProjectId) setExpandedProjects((s) => (s.has(currentProjectId) ? s : new Set(s).add(currentProjectId)));
  }, [currentProjectId]);

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
    setMovingThreadId(null);
    // The menu floats (position: fixed, inside the nav) so the scrolling
    // lists can't clip it.
    const row = e.currentTarget.closest('[data-thread-menu]').getBoundingClientRect();
    const nav = e.currentTarget.closest('nav').getBoundingClientRect();
    setThreadMenuStyle({ top: row.bottom - nav.top + 4, right: nav.right - row.right + 8 });
    setOpenMenuId(openMenuId === threadId ? null : threadId);
  };

  // Scrolling a list moves the rows away from an open floating menu: close it.
  const closeMenuOnScroll = () => {
    if (openMenuId) setOpenMenuId(null);
  };

  const moveThread = (threadId, projectId) => {
    setOpenMenuId(null);
    setMovingThreadId(null);
    onMoveThread?.(threadId, projectId);
  };

  const closeOnMobile = () => {
    if (window.innerWidth < 1024) toggleSidebar();
  };

  const openProject = (id) => {
    onOpenProject(id);
    closeOnMobile();
  };

  // Clicking a project shows or hides its chats; "Project home" in its menu
  // opens its page.
  const clickProject = (id) => {
    setExpandedProjects((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const projectAction = (action) => {
    setOpenMenuId(null);
    action();
  };

  // Share project: copy the project's address. It opens for anyone who can
  // already reach this OpenGPT (other devices, people on the same server).
  const shareProject = async (id) => {
    const link = `${window.location.origin}/project/${encodeURIComponent(id)}`;
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      // No clipboard API (e.g. plain http on another host): copy the old way.
      const field = document.createElement('textarea');
      field.value = link;
      document.body.appendChild(field);
      field.select();
      document.execCommand('copy');
      field.remove();
    }
    setCopiedProjectId(id);
    setTimeout(() => setCopiedProjectId((current) => (current === id ? null : current)), 2000);
  };

  const saveProjectName = (project) => {
    const name = projectName.trim();
    if (name && name !== project.name) onRenameProject(project.id, name);
    setRenamingProjectId(null);
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

  // One chat row with its menu (Rename, Move to project, Delete). `nested`
  // indents it under its project.
  const renderThread = (thread, nested = false) => {
                  const isActive = currentThreadId === thread.thread_id;
                  const isEditing = editingThreadId === thread.thread_id;
                  return (
                    <div
                      key={thread.thread_id}
                      data-thread-menu
                      className={`
                        group relative flex items-center gap-2 ${nested ? 'pl-9 pr-3' : 'px-3'} py-2 rounded-xl cursor-pointer
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
                              shrink-0 p-1.5 -my-1 rounded-md text-gray-300 hover:bg-gray-600 opacity-0
                              group-hover:opacity-100 focus:opacity-100 transition-opacity
                              [@media(hover:none)]:opacity-100
                              ${openMenuId === thread.thread_id ? 'opacity-100' : ''}
                            `}
                          >
                            <MoreVertical size={15} />
                          </button>

                          {openMenuId === thread.thread_id && movingThreadId === thread.thread_id && (
                            <div
                              style={threadMenuStyle}
                              className="fixed w-52 max-h-64 overflow-y-auto overflow-x-hidden thin-scroll bg-gray-800 rounded-xl shadow-xl shadow-black/40 z-50 py-1 border border-gray-700/70 animate-menu-in origin-top-right"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <p className="px-3 py-1.5 text-xs text-gray-500">Move to project</p>
                              {(projects || []).filter((p) => p.id !== thread.project_id).map((p) => (
                                <button
                                  key={p.id}
                                  onClick={() => moveThread(thread.thread_id, p.id)}
                                  className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-200 hover:bg-gray-700 rounded-lg mx-1"
                                >
                                  <Folder size={14} className="shrink-0" />
                                  <span className="truncate">{p.name}</span>
                                </button>
                              ))}
                              {(projects || []).some((p) => p.id !== thread.project_id) && (
                                <div className="my-1 border-t border-gray-700/70" />
                              )}
                              <button
                                onClick={() => {
                                  setOpenMenuId(null);
                                  setMovingThreadId(null);
                                  onNewProject(thread.thread_id);
                                }}
                                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-200 hover:bg-gray-700 rounded-lg mx-1"
                              >
                                <FolderPlus size={14} className="shrink-0" />
                                <span>New project</span>
                              </button>
                            </div>
                          )}

                          {openMenuId === thread.thread_id && movingThreadId !== thread.thread_id && (
                            <div
                              style={threadMenuStyle}
                              className="fixed w-52 bg-gray-800 rounded-xl shadow-xl shadow-black/40 z-50 py-1 border border-gray-700/70 animate-menu-in origin-top-right"
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
                              {onMoveThread && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setMovingThreadId(thread.thread_id);
                                  }}
                                  className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-200 hover:bg-gray-700 rounded-lg mx-1"
                                >
                                  <FolderInput size={14} />
                                  <span>Move to project</span>
                                </button>
                              )}
                              {onMoveThread && thread.project_id && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    moveThread(thread.thread_id, null);
                                  }}
                                  className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-200 hover:bg-gray-700 rounded-lg mx-1"
                                >
                                  <FolderMinus size={14} />
                                  <span>Remove from project</span>
                                </button>
                              )}
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
  };

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
      <nav aria-label="Sidebar"
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
              <LogoMark size={20} className="group-hover/brand:opacity-0 transition-opacity" />
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

            {projects && (
              <button
                onClick={() => onToggleCollapse?.()}
                title="Projects"
                className="flex items-center justify-center w-10 h-10 rounded-xl hover:bg-gray-700 transition-colors mt-1"
              >
                <Folder size={18} />
              </button>
            )}

            <div className="mt-auto">
              <UserMenu displayName={displayName} onOpenSettings={onOpenSettings} collapsed />
            </div>
          </div>
        ) : (
          /* Expanded sidebar */
          <>
            {/* Brand header */}
            <div className="flex items-center justify-between px-2 pt-3 pb-1 shrink-0">
              <Logo className="mx-2 h-5 text-white" />
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
                <span className="w-full text-sm text-gray-400">Search chats</span>
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
              {/* Projects: chats grouped with shared instructions and files */}
              {projects && (
                <div className="shrink-0">
                  <div className="flex items-center gap-0.5 px-3 pt-3 pb-1">
                    <button
                      type="button"
                      onClick={() => setProjectsOpen((o) => !o)}
                      className="group flex items-center gap-1 text-left"
                    >
                      <span className="text-sm font-medium text-gray-300 group-hover:text-gray-100 transition-colors">
                        Projects
                      </span>
                      <ChevronDown
                        size={16}
                        className={`
                          text-gray-400 opacity-0 group-hover:opacity-100
                          transition-transform duration-300 ease-out group-hover:text-gray-200
                          ${projectsOpen ? 'rotate-0' : '-rotate-90'}
                        `}
                      />
                    </button>
                    <button
                      type="button"
                      onClick={() => onNewProject()}
                      title="New project"
                      aria-label="New project"
                      className="ml-auto p-1 rounded-md text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
                    >
                      <Plus size={16} />
                    </button>
                  </div>
                  {projectsOpen && (
                    <div
                      onScroll={closeMenuOnScroll}
                      className="px-2 py-1 space-y-0.5 max-h-[40vh] overflow-y-auto overflow-x-hidden thin-scroll"
                    >
                      {projects.length === 0 && (
                        <p className="px-3 py-1.5 text-xs text-gray-500">No projects yet</p>
                      )}
                      {projects.map((project) => {
                        const expanded = expandedProjects.has(project.id);
                        const isCurrent = currentProjectId === project.id;
                        const menuId = `project:${project.id}`;
                        const chats = expanded ? projectThreads.filter((t) => t.project_id === project.id) : [];
                        const FolderIcon = expanded ? FolderOpen : Folder;
                        return (
                          <div key={project.id}>
                            <div
                              data-thread-menu
                              role={renamingProjectId === project.id ? undefined : 'button'}
                              tabIndex={renamingProjectId === project.id ? undefined : 0}
                              aria-expanded={expanded}
                              aria-current={isCurrent && !currentThreadId ? 'page' : undefined}
                              onClick={() => { if (renamingProjectId !== project.id) clickProject(project.id); }}
                              onKeyDown={(e) => {
                                if (renamingProjectId === project.id || e.target !== e.currentTarget) return;
                                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); clickProject(project.id); }
                              }}
                              className={`
                                group relative flex items-center gap-2.5 px-3 py-2 rounded-xl cursor-pointer transition-colors
                                outline-none focus-visible:ring-2 focus-visible:ring-white/50
                                ${isCurrent && !currentThreadId ? 'bg-gray-700/90' : 'hover:bg-gray-700/60'}
                              `}
                            >
                              <FolderIcon size={16} className="shrink-0 text-gray-400" />
                              {renamingProjectId === project.id ? (
                                <input
                                  type="text"
                                  maxLength={100}
                                  aria-label="Project name"
                                  value={projectName}
                                  onChange={(e) => setProjectName(e.target.value)}
                                  onBlur={() => saveProjectName(project)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') saveProjectName(project);
                                    if (e.key === 'Escape') setRenamingProjectId(null);
                                  }}
                                  onClick={(e) => e.stopPropagation()}
                                  className="w-full min-w-0 bg-gray-600 px-2 py-0.5 rounded-lg text-sm text-white outline-none focus:ring-2 focus:ring-blue-500"
                                  autoFocus
                                />
                              ) : (
                                <>
                                  <span className="truncate flex-1 min-w-0 text-sm text-gray-100">{project.name}</span>
                                  {copiedProjectId === project.id && (
                                    <span role="status" className="shrink-0 text-xs text-gray-400">Link copied</span>
                                  )}
                                  {project.pinned && copiedProjectId !== project.id && (
                                    <Pin size={12} aria-label="Pinned"
                                      className={`absolute right-4 text-gray-500 group-hover:hidden ${isCurrent || openMenuId === menuId ? 'hidden' : ''}`} />
                                  )}
                                  <span
                                    className={`
                                      flex items-center gap-0.5 -my-1 shrink-0 opacity-0 group-hover:opacity-100
                                      focus-within:opacity-100 transition-opacity [@media(hover:none)]:opacity-100
                                      ${isCurrent || openMenuId === menuId ? 'opacity-100' : ''}
                                    `}
                                  >
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setMovingThreadId(null);
                                        const r = e.currentTarget.getBoundingClientRect();
                                        const nav = e.currentTarget.closest('nav').getBoundingClientRect();
                                        setProjectMenuPos({ top: r.bottom - nav.top + 6, left: r.left - nav.left });
                                        setOpenMenuId(openMenuId === menuId ? null : menuId);
                                      }}
                                      aria-label="Project options"
                                      className="p-1 rounded-md text-gray-300 hover:bg-gray-600"
                                    >
                                      <MoreHorizontal size={15} />
                                    </button>
                                    <button
                                      type="button"
                                      onClick={(e) => { e.stopPropagation(); onNewProjectChat(project.id); closeOnMobile(); }}
                                      title={`New chat in ${project.name}`}
                                      aria-label={`New chat in ${project.name}`}
                                      className="p-1 rounded-md text-gray-300 hover:bg-gray-600"
                                    >
                                      <SquarePenIcon width={15} height={15} />
                                    </button>
                                  </span>
                                </>
                              )}

                              {openMenuId === menuId && projectMenuPos && (
                                <div
                                  style={{ top: projectMenuPos.top, left: projectMenuPos.left }}
                                  className="fixed w-48 bg-gray-800 rounded-xl shadow-xl shadow-black/40 z-50 py-1 border border-gray-700/70 animate-menu-in origin-top-right"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <button
                                    onClick={() => projectAction(() => onProjectSettings(project.id))}
                                    className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-200 hover:bg-gray-700 rounded-lg mx-1"
                                  >
                                    <Settings2 size={14} />
                                    <span>Project settings</span>
                                  </button>
                                  <button
                                    onClick={() => projectAction(() => onPinProject(project.id, !project.pinned))}
                                    className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-200 hover:bg-gray-700 rounded-lg mx-1"
                                  >
                                    {project.pinned ? <PinOff size={14} /> : <Pin size={14} />}
                                    <span>{project.pinned ? 'Unpin project' : 'Pin project'}</span>
                                  </button>
                                  <button
                                    onClick={() => projectAction(() => shareProject(project.id))}
                                    className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-200 hover:bg-gray-700 rounded-lg mx-1"
                                  >
                                    <Share size={14} />
                                    <span>Share project</span>
                                  </button>
                                  <button
                                    onClick={() => projectAction(() => { setProjectName(project.name); setRenamingProjectId(project.id); })}
                                    className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-200 hover:bg-gray-700 rounded-lg mx-1"
                                  >
                                    <Edit2 size={14} />
                                    <span>Rename project</span>
                                  </button>
                                  <button
                                    onClick={() => projectAction(() => openProject(project.id))}
                                    className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-200 hover:bg-gray-700 rounded-lg mx-1"
                                  >
                                    <Folder size={14} />
                                    <span>Project home</span>
                                  </button>
                                  <button
                                    onClick={() => projectAction(() => onDeleteProject(project))}
                                    className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-red-400 hover:bg-gray-700 rounded-lg mx-1"
                                  >
                                    <Trash2 size={14} />
                                    <span>Delete project</span>
                                  </button>
                                </div>
                              )}
                            </div>

                            {expanded && chats.map((chat) => renderThread(chat, true))}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

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
                onScroll={closeMenuOnScroll}
                className={`
                  overflow-y-auto px-2 py-2 space-y-0.5 thin-scroll
                  transition-[max-height,opacity] duration-300 ease-out
                  ${recentsOpen
                    ? 'flex-1 min-h-0 max-h-[100dvh] opacity-100' /* fill down to the footer, scroll inside */
                    : 'flex-none max-h-0 opacity-0 overflow-hidden'}
                `}
              >
              {threads.length === 0 ? (
                <div className="px-3 py-6 text-center text-xs text-gray-500">
                  {emptyText}
                </div>
              ) : (
                threads.map((thread) => renderThread(thread))
              )}
            </div>
            </div>

            {/* Footer: you, and the menu for Account / Settings */}
            <div className="px-2 py-2 border-t border-gray-700/60 shrink-0">
              <UserMenu displayName={displayName} onOpenSettings={onOpenSettings} />
            </div>
          </>
        )}
      </nav>

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
