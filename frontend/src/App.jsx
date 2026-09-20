import React, { useState, useEffect, useRef, useLayoutEffect } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import Sidebar from './components/Sidebar';
import MessageList from './components/MessageList';
import MessageInput from './components/MessageInput';
import ConfirmationModal from './components/ConfirmationModal';
import { useThreads } from './hooks/useThreads';
import { useChat } from './hooks/useChat';
import { chatService } from './services/api';
import { buildAttachmentPreview } from './lib/attachmentPreview';

// Derive the active thread id from the URL path:
//   /                 -> new chat
//   /chat             -> new chat
//   /chat/new         -> new chat
//   /chat/<threadId>  -> that thread
function threadIdFromPath(pathname) {
  const path = pathname.replace(/\/+$/, '');
  if (path === '' || path === '/chat' || path === '/chat/new') return null;
  const m = path.match(/^\/chat\/(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

const TempChatIcon = (props) => (
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
    className="lucide lucide-message-circle-dashed lucide-message-circle-dashed"
    {...props}
  >
    <path d="M10.1 2.182a10 10 0 0 1 3.8 0" />
    <path d="M13.9 21.818a10 10 0 0 1-3.8 0" />
    <path d="M17.609 3.72a10 10 0 0 1 2.69 2.7" />
    <path d="M2.182 13.9a10 10 0 0 1 0-3.8" />
    <path d="M20.28 17.61a10 10 0 0 1-2.7 2.69" />
    <path d="M21.818 10.1a10 10 0 0 1 0 3.8" />
    <path d="M3.721 6.391a10 10 0 0 1 2.7-2.69" />
    <path d="m6.163 21.117-2.906.85a1 1 0 0 1-1.236-1.169l.965-2.98" />
  </svg>
);

const TempChatCheckedIcon = (props) => (
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
    className="lucide lucide-message-circle-dashed-check lucide-message-circle-dashed-check"
    {...props}
  >
    <path d="M10.1 2.182a10 10 0 0 1 3.8 0" />
    <path d="M13.9 21.818a10 10 0 0 1-3.8 0" />
    <path d="M17.609 3.72a10 10 0 0 1 2.69 2.7" />
    <path d="M2.182 13.9a10 10 0 0 1 0-3.8" />
    <path d="M20.28 17.61a10 10 0 0 1-2.7 2.69" />
    <path d="M21.818 10.1a10 10 0 0 1 0 3.8" />
    <path d="M3.721 6.391a10 10 0 0 1 2.7-2.69" />
    <path d="m6.163 21.117-2.906.85a1 1 0 0 1-1.236-1.169l.965-2.98" />
    <path d="m8.5 12 2.2 2.2 4.8-4.8" />
  </svg>
);

function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const urlThreadId = threadIdFromPath(location.pathname);
  // Temporary mode is driven by the `?temporary-chat=true` URL query param, so
  // it survives refreshes and is shareable. A temp chat is never persisted.
  const tempFromUrl = searchParams.get('temporary-chat') === 'true';
  const [currentThreadId, setCurrentThreadId] = useState(urlThreadId || null);
  // Temporary chat mode: the conversation lives only in the current session and
  // is never added to the persisted sidebar history. Initialized from the URL.
  const [isTempChat, setIsTempChat] = useState(tempFromUrl);
  // Set right before navigating to a freshly created thread so useChat skips
  // its backend reload (the messages were just streamed into the UI).
  const skipLoadRef = useRef(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState([]);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [threadToDelete, setThreadToDelete] = useState(null);

  const {
    threads,
    loading: threadsLoading,
    error: threadsError,
    fetchThreads,
    updateThreadTitle,
  } = useThreads();

  // Keep the active thread in sync with the URL (deep links, back/forward).
  useEffect(() => {
    const id = urlThreadId || null;
    setCurrentThreadId((prev) => (prev === id ? prev : id));
  }, [urlThreadId]);

  // Called when the backend creates a brand-new thread (first message in a
  // "New Chat"). Silently updates the URL without interrupting the user.
  // In temporary-chat mode this is a no-op so the chat never becomes a
  // persisted thread in the sidebar/history.
  const handleThreadCreated = (id) => {
    if (isTempChat) return;
    skipLoadRef.current = true;
    setCurrentThreadId(id);
    navigate(`/chat/${id}`, { replace: true });
    fetchThreads();
  };

  const {
    messages,
    loading: chatLoading,
    error: chatError,
    sendMessage,
    regenerate,
    editMessage,
    loadMessages,
    streamingProgress,
    stop,
  } = useChat(currentThreadId, handleThreadCreated, skipLoadRef, isTempChat);

  // Centered layout (welcome heading + input in the middle of the viewport)
  // only when the conversation has no messages yet. Driven purely by message
  // count so it resets on new/temp chat and matches a refresh of an existing chat.
  const centered = messages.length === 0;

  // Smoothly slide the input between the centered (empty) and bottom states by
  // translating it up from the bottom. Only `transform` is animated so there is
  // no layout shift or snap.
  const chatSectionRef = useRef(null);
  const inputBlockRef = useRef(null);
  const [slideUp, setSlideUp] = useState(0);
  const [inputHeight, setInputHeight] = useState(0);

  useLayoutEffect(() => {
    const block = inputBlockRef.current;
    const section = chatSectionRef.current;
    if (!block || !section) return;
    // Measure the input block so the scroll area can reserve matching bottom
    // space (keeping the last message visible above the absolute input).
    setInputHeight(block.offsetHeight);
    if (!centered) {
      setSlideUp(0);
      return;
    }
    const containerH = section.clientHeight;
    const blockH = block.offsetHeight;
    setSlideUp(Math.max(0, containerH / 2 - blockH / 2));
  }, [centered, messages.length, isTempChat, chatLoading, uploadingAttachment]);

  const handleNewThread = () => {
    // New chat stays client-side until the first message is sent; the backend
    // then creates the thread and the URL is updated silently. Clearing the
    // temporary-chat query param exits temp mode.
    setCurrentThreadId(null);
    setIsTempChat(false);
    setIsSidebarOpen(false);
    setPendingAttachments([]);
    navigate('/chat');
  };

  // Toggle temporary (session-only) chat mode. When On, the conversation is
  // never persisted to the sidebar history; when Off, chats are saved normally.
  // The toggle only appears on the New Chat screen, so we reset any active
  // thread and return to a fresh new chat when toggling.
  const toggleTempChat = () => {
    setIsTempChat((prev) => {
      const next = !prev;
      setCurrentThreadId(null);
      setIsSidebarOpen(false);
      // Reflect temp mode in the URL so it survives refresh and is shareable.
      navigate(next ? '/chat?temporary-chat=true' : '/chat');
      return next;
    });
  };

  const handleThreadSelect = (threadId) => {
    setIsTempChat(false);
    setCurrentThreadId(threadId);
    setIsSidebarOpen(false);
    setPendingAttachments([]);
    navigate(`/chat/${threadId}`);
  };

  const handleThreadDelete = (threadId) => {
    setThreadToDelete(threadId);
    setDeleteModalOpen(true);
  };

  const confirmDeleteThread = async () => {
    if (!threadToDelete) return;
    
    try {
      // Call the delete API
      await chatService.deleteThread(threadToDelete);
      
      // If deleting current thread, switch to another or go to new chat
      if (threadToDelete === currentThreadId) {
        const remainingThreads = threads.filter(t => t.thread_id !== threadToDelete);
        if (remainingThreads.length > 0) {
          const nextId = remainingThreads[0].thread_id;
          setCurrentThreadId(nextId);
          navigate(`/chat/${nextId}`);
        } else {
          setCurrentThreadId(null);
          navigate('/chat');
        }
      }
      
      // Refresh threads list
      await fetchThreads();
      
      // Close modal and reset state
      setDeleteModalOpen(false);
      setThreadToDelete(null);
    } catch (error) {
      console.error('Error deleting thread:', error);
      alert('Failed to delete chat. Please try again.');
    }
  };

  const cancelDeleteThread = () => {
    setDeleteModalOpen(false);
    setThreadToDelete(null);
  };

  const handleSendMessage = async (message, tools = [], attachments = []) => {
    // ChatGPT-style attachment flow: the user's message (with its attachments)
    // is shown instantly and the document(s) are uploaded together with the
    // prompt so the backend processes them as one request. Attachments are
    // cleared only after a successful send.
    if (attachments.length > 0 && isTempChat) {
      alert('Document upload is not available in Temporary Chat.');
      return;
    }

    const pending = attachments;
    // Optimistically hand the message + attachments to the chat hook, which
    // renders the user message immediately and uploads the docs itself.
    try {
      setUploadingAttachment(true);
      // The previews move into the chat with the message, so clear them from
      // the input right away (restored below if the send fails).
      setPendingAttachments([]);
      await sendMessage(message, tools, null, pending);
      // Refresh threads so a newly created chat (and updated titles) show in the
      // sidebar — skipped for temporary chats, which must not be persisted.
      if (!isTempChat) fetchThreads();
    } catch (error) {
      console.error('Error sending message with attachments:', error);
      alert('Failed to send message with the attached document. Please try again.');
      // Preserve attachments (and the prompt stays in the input) so the user can
      // retry without re-uploading the file.
      setPendingAttachments(pending);
    } finally {
      setUploadingAttachment(false);
    }
  };

  // Add a file as a pending attachment (shown as a chip). It is only uploaded
  // when the message is sent, matching ChatGPT's behavior.
  const handleAddAttachment = (file) => {
    if (isTempChat) {
      alert('Document upload is not available in Temporary Chat.');
      return;
    }
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setPendingAttachments((prev) => [...prev, { id, file, previewLoading: true }]);
    // Build the preview (PDF first page / text snippet) in the background and
    // fill it into the card once ready.
    buildAttachmentPreview(file).then((preview) => {
      setPendingAttachments((prev) =>
        prev.map((a) => (a.id === id ? { ...a, preview, previewLoading: false } : a))
      );
    });
  };

  const handleRemoveAttachment = (id) => {
    setPendingAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const toggleSidebar = () => {
    setIsSidebarOpen(!isSidebarOpen);
  };

  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const toggleSidebarCollapse = () => {
    setIsSidebarCollapsed((c) => !c);
  };

  // Keep temp mode in sync with the URL (refresh, back/forward, shared links).
  useEffect(() => {
    setIsTempChat(tempFromUrl);
  }, [tempFromUrl]);

  return (
    <div className="flex h-screen bg-chat-bg text-white overflow-hidden">
      {/* Sidebar */}
      <Sidebar
        threads={threads}
        currentThreadId={currentThreadId}
        onThreadSelect={handleThreadSelect}
        onNewThread={handleNewThread}
        onThreadRename={updateThreadTitle}
        onThreadDelete={handleThreadDelete}
        isSidebarOpen={isSidebarOpen}
        toggleSidebar={toggleSidebar}
        isCollapsed={isSidebarCollapsed}
        onToggleCollapse={toggleSidebarCollapse}
      />

      {/* Main Chat Area */}
      <div className="flex-1 flex h-screen relative">
          {/* Chat Section */}
          <div ref={chatSectionRef} className="flex-1 flex flex-col relative">
          {/* Header */}
          <div className="flex-shrink-0 px-4 py-3 bg-chat-bg">
            <div className="flex items-center justify-between">
              <span className="text-base font-semibold tracking-tight text-white select-none">
                OpenGPT
              </span>
              {/* Temporary chat toggle — only on the New Chat screen.
                  Once a temp chat has messages, it can't be toggled off
                  (start a new chat to leave temp mode). */}
              {!currentThreadId && (
                <button
                  onClick={() => { if (messages.length === 0) toggleTempChat(); }}
                  disabled={isTempChat && messages.length > 0}
                  title={isTempChat && messages.length > 0 ? "This chat won't appear in your chat history" : 'Temporary chat'}
                  className={`
                    flex items-center gap-1.5 px-2 py-1.5 rounded-xl text-sm font-medium transition-colors
                    ${isTempChat
                      ? 'text-yellow-200 hover:bg-gray-700/70'
                      : 'text-gray-300 hover:text-white hover:bg-gray-700/70'}
                    ${isTempChat && messages.length > 0 ? 'cursor-not-allowed' : ''}
                  `}
                >
                  {isTempChat ? <TempChatCheckedIcon width={16} height={16} /> : <TempChatIcon width={16} height={16} />}
                  {isTempChat && messages.length > 0 && <span>Temporary Chat</span>}
                </button>
              )}
            </div>
          </div>

          {/* Messages — scrolling area. Collapses to height 0 while centered so
              the input can occupy the full viewport; present otherwise. When not
              centered it reserves bottom space for the absolute input so the
              last message stays fully visible (no overlap / broken scroll). */}
          <div
            className={`flex-1 min-h-0 ${centered ? 'h-0 overflow-hidden' : 'block overflow-y-auto'}`}
            style={{ paddingBottom: centered ? 0 : inputHeight }}
          >
            <MessageList
              messages={messages}
              loading={chatLoading}
              streaming={streamingProgress?.isStreaming}
              streamingProgress={streamingProgress}
              onRegenerate={regenerate}
              onEditMessage={editMessage}
            />
          </div>

          {/* Input — single instance. Anchored to the bottom and slid upward
              (translateY) to center it when the conversation is empty. Because
              only `transform` animates, the move is smooth with no layout shift.
              `centered` is driven purely by message count, so it resets on
              new/temp chat and matches a refresh (existing chats load messages
              -> bottom; empty chats -> centered). */}
          <div
            ref={inputBlockRef}
            className="absolute inset-x-0 bottom-0 z-20 px-4 pb-4 transition-transform duration-300 ease-out"
            style={{ transform: centered ? `translateY(-${slideUp}px)` : 'translateY(0)' }}
          >
            {/* Welcome heading — only above a centered, empty conversation */}
            <div
              className={`
                w-full max-w-3xl mx-auto text-center mb-6
                transition-all duration-200
                ${centered ? 'opacity-100 mb-6' : 'opacity-0 h-0 mb-0 overflow-hidden pointer-events-none'}
              `}
            >
              {isTempChat ? (
                <>
                  <h1 className="text-2xl font-bold text-gray-100">Temporary Chat</h1>
                  <p className="mt-2 text-sm text-gray-400 max-w-md mx-auto">
                    This chat won't appear in history or be used to train our models
                  </p>
                </>
              ) : (
                <h1 className="text-2xl font-bold text-gray-100">How can I help you today?</h1>
              )}
            </div>

            <div className="w-full max-w-3xl mx-auto">
              <MessageInput
                onSendMessage={handleSendMessage}
                onAddAttachment={handleAddAttachment}
                onRemoveAttachment={handleRemoveAttachment}
                onStop={stop}
                disabled={chatLoading || uploadingAttachment}
                pendingAttachments={pendingAttachments}
                uploadingAttachment={uploadingAttachment}
              />
            </div>
          </div>

          {/* Error Display */}
          {(threadsError || chatError) && (
            <div className="fixed bottom-20 right-4 bg-red-600 text-white px-4 py-2 rounded-lg shadow-lg">
              {threadsError || chatError}
            </div>
          )}
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      <ConfirmationModal
        isOpen={deleteModalOpen}
        onClose={cancelDeleteThread}
        onConfirm={confirmDeleteThread}
        title="Delete Chat"
        message="Are you sure you want to delete this chat? This action cannot be undone and will permanently remove all messages and uploaded documents."
        confirmText="Delete"
        cancelText="Cancel"
        danger={true}
      />
    </div>
  );
}

export default App;
