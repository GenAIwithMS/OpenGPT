import { useState, useEffect, useRef } from 'react';
import { chatService } from '../services/api';

export const useChat = (threadId, onThreadCreated, skipLoadRef, isTempChat = false) => {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [streamingProgress, setStreamingProgress] = useState(null);
  const eventSourceRef = useRef(null);
  const lastPromptRef = useRef('');

  useEffect(() => {
    if (threadId) {
      // When a brand-new thread was just created by streaming the first
      // message, the UI already holds the messages — skip the backend reload
      // (which can briefly return an empty/partial state and wipe the answer).
      if (skipLoadRef?.current) {
        skipLoadRef.current = false;
        return;
      }
      loadMessages();
    } else {
      setMessages([]);
    }
  }, [threadId, isTempChat]);

  const loadMessages = async () => {
    if (!threadId) return;
    
    try {
      setLoading(true);
      const data = await chatService.getThreadMessages(threadId);
      setMessages(data.messages || []);
      setError(null);
    } catch (err) {
      setError(err.message);
      console.error('Error loading messages:', err);
    } finally {
      setLoading(false);
    }
  };

  const updateProgressStep = (stepLabel, status) => {
    setStreamingProgress(prev => {
      if (!prev) return null;
      
      const stepIndex = prev.steps.findIndex(s => s.label === stepLabel);
      if (stepIndex === -1) return prev;
      
      const newSteps = [...prev.steps];
      newSteps[stepIndex] = { ...newSteps[stepIndex], status };
      
      // Mark previous steps as completed
      for (let i = 0; i < stepIndex; i++) {
        if (newSteps[i].status !== 'completed') {
          newSteps[i] = { ...newSteps[i], status: 'completed' };
        }
      }
      
      return { ...prev, steps: newSteps };
    });
  };

  const handleStreamError = (err) => {
    setError('Streaming error occurred');
    setMessages(prev => prev.filter(m => !m.streaming));
    setStreamingProgress(null);
    setLoading(false);
  };

  // Shared SSE handler for the chatbot path (token streaming + live thinking)
  const handleChatChunk = (data) => {
    if (data.error) {
      setError(data.error);
      setMessages(prev => prev.filter(m => !m.streaming));
      setStreamingProgress(null);
      setLoading(false);
      return;
    }

    if (data.message_type === 'thinking') {
      setStreamingProgress(prev =>
        prev
          ? { ...prev, current: data.content, thoughts: [...(prev.thoughts || []), data.content] }
          : prev
      );
    } else if (data.message_type === 'ai') {
      setStreamingProgress(prev =>
        prev ? { ...prev, current: 'Generating response...' } : prev
      );
      setMessages(prev => {
        const copy = [...prev];
        const idx = copy.findIndex(m => m.streaming);
        if (idx !== -1) {
          copy[idx] = { ...copy[idx], content: copy[idx].content + data.content };
        }
        return copy;
      });
    }

    if (data.done) {
      // If the backend created a brand-new thread (first message in a New Chat),
      // update the URL silently via the callback from App.
      if (data.thread_id && onThreadCreated && data.thread_id !== threadId) {
        onThreadCreated(data.thread_id);
      }
      setMessages(prev =>
        prev.map(m => (m.streaming ? { ...m, streaming: false } : m))
      );
      setStreamingProgress(null);
      setLoading(false);
    }
  };

  const sendMessage = async (message, tools = [], threadIdOverride = null, attachments = []) => {
    if (!message.trim()) return;

    const activeThreadId = threadIdOverride || threadId;
    lastPromptRef.current = message;

    // Optimistically render the user's message right away (with any attached
    // documents) so it appears instantly — no waiting on network round-trips.
    const userMessage = {
      type: 'human',
      content: message,
      timestamp: new Date().toISOString(),
      tools: tools.length > 0 ? tools : undefined,
      attachments: attachments.length > 0
        ? attachments.map((a) => ({ name: a.file?.name || a.name }))
        : undefined,
    };
    setMessages(prev => [...prev, userMessage]);

    try {
      setLoading(true);
      setError(null);

      const handleError = (error) => {
        setError('Streaming error occurred');
        setStreamingProgress(null);
        setLoading(false);
      };

      // Upload attached documents before streaming so the AI sees them with
      // this prompt (and the doc is linked to the same thread as the message).
      // The user message is already rendered above, so this adds no perceived
      // latency to sending — only the AI answer waits on ingestion.
      let uploadThreadId = activeThreadId;
      if (attachments.length > 0) {
        for (const att of attachments) {
          const response = await chatService.uploadPDF(uploadThreadId, att.file);
          if (response.thread_id && response.thread_id !== uploadThreadId) {
            uploadThreadId = response.thread_id;
          }
        }
        if (uploadThreadId !== activeThreadId && onThreadCreated && uploadThreadId) {
          onThreadCreated(uploadThreadId);
        }
      }
      const streamThreadId = uploadThreadId;

      // Blogs tool: keep the fixed-step progress UI
      if (tools.includes('blogs')) {
        setStreamingProgress({
          isStreaming: true,
          toolName: 'blogs',
          steps: [
            { label: 'Routing...', status: 'in-progress' },
            { label: 'Researching...', status: 'pending' },
            { label: 'Planning...', status: 'pending' },
            { label: 'Writing sections...', status: 'pending' },
            { label: 'Finalizing...', status: 'pending' },
          ],
        });

        let aiResponse = '';

        const handleMessage = (data) => {
          if (data.message_type === 'progress') {
            if (data.node === 'router') {
              updateProgressStep('Routing...', 'completed');
              updateProgressStep('Researching...', 'in-progress');
              setStreamingProgress(prev => {
                if (!prev) return null;
                const newSteps = [...prev.steps];
                const idx = newSteps.findIndex(s => s.label === 'Routing...');
                if (idx !== -1) newSteps[idx] = { ...newSteps[idx], details: data.content };
                return { ...prev, steps: newSteps };
              });
            } else if (data.node === 'research') {
              updateProgressStep('Researching...', 'completed');
              updateProgressStep('Planning...', 'in-progress');
              setStreamingProgress(prev => {
                if (!prev) return null;
                const newSteps = [...prev.steps];
                const idx = newSteps.findIndex(s => s.label === 'Researching...');
                if (idx !== -1) newSteps[idx] = { ...newSteps[idx], details: data.content };
                return { ...prev, steps: newSteps };
              });
            } else if (data.node === 'orchestrator') {
              updateProgressStep('Planning...', 'completed');
              updateProgressStep('Writing sections...', 'in-progress');
              setStreamingProgress(prev => {
                if (!prev) return null;
                const newSteps = [...prev.steps];
                const idx = newSteps.findIndex(s => s.label === 'Planning...');
                if (idx !== -1) newSteps[idx] = { ...newSteps[idx], details: data.content };
                return { ...prev, steps: newSteps };
              });
            } else if (data.node === 'worker') {
              setStreamingProgress(prev => {
                if (!prev) return null;
                const newSteps = [...prev.steps];
                const idx = newSteps.findIndex(s => s.label === 'Writing sections...');
                if (idx !== -1) {
                  const currentCount = newSteps[idx].sectionCount || 0;
                  newSteps[idx] = { ...newSteps[idx], sectionCount: currentCount + 1, details: `${currentCount + 1} sections completed` };
                }
                return { ...prev, steps: newSteps };
              });
            }
          } else if (data.message_type === 'ai') {
            aiResponse += data.content;
            updateProgressStep('Writing sections...', 'completed');
            updateProgressStep('Finalizing...', 'completed');
          }

          if (data.done) {
            if (data.thread_id && onThreadCreated && data.thread_id !== threadId) {
              onThreadCreated(data.thread_id);
            }
            setMessages(prev => [...prev, {
              type: 'ai',
              content: aiResponse,
              timestamp: new Date().toISOString(),
            }]);
            setStreamingProgress(null);
            setLoading(false);
          }
        };

        eventSourceRef.current = chatService.streamMessage(streamThreadId, message, tools, handleMessage, handleError, isTempChat);
        return;
      }

      // Deep Research tool: show step-based progress
      if (tools.includes('deep_research')) {
        setStreamingProgress({
          isStreaming: true,
          toolName: 'deep_research',
          steps: [
            { label: 'Clarifying scope...', status: 'in-progress' },
            { label: 'Writing research brief...', status: 'pending' },
            { label: 'Researching...', status: 'pending' },
            { label: 'Generating report...', status: 'pending' },
          ],
        });

        let aiResponse = '';

        const handleMessage = (data) => {
          if (data.message_type === 'progress') {
            if (data.node === 'clarify') {
              updateProgressStep('Clarifying scope...', 'completed');
              updateProgressStep('Writing research brief...', 'in-progress');
            } else if (data.node === 'brief') {
              updateProgressStep('Writing research brief...', 'completed');
              updateProgressStep('Researching...', 'in-progress');
            } else if (data.node === 'research') {
              updateProgressStep('Researching...', 'completed');
              updateProgressStep('Generating report...', 'in-progress');
            }
          } else if (data.message_type === 'ai') {
            aiResponse += data.content;
          }

          if (data.done) {
            if (data.thread_id && onThreadCreated && data.thread_id !== streamThreadId) {
              onThreadCreated(data.thread_id);
            }
            setMessages(prev => [...prev, {
              type: 'ai',
              content: aiResponse,
              timestamp: new Date().toISOString(),
            }]);
            setStreamingProgress(null);
            setLoading(false);
          }
        };

        eventSourceRef.current = chatService.streamMessage(streamThreadId, message, tools, handleMessage, handleError, isTempChat);
        return;
      }

      // Chatbot path: live thinking bar + token streaming into a placeholder message
      setStreamingProgress({
        isStreaming: true,
        toolName: 'chat',
        current: 'Thinking...',
        thoughts: [],
      });

      setMessages(prev => [
        ...prev,
        {
          type: 'ai',
          content: '',
          timestamp: new Date().toISOString(),
          streaming: true,
        },
      ]);

      eventSourceRef.current = chatService.streamMessage(streamThreadId, message, tools, handleChatChunk, handleStreamError, isTempChat);
    } catch (err) {
      setError(err.message);
      console.error('Error sending message:', err);
      setStreamingProgress(null);
      setLoading(false);
    }
  };

  const regenerate = async () => {
    if (!threadId) return;

    const lastHuman = [...messages].reverse().find(m => m.type === 'human');
    if (!lastHuman) return;

    const tools = lastHuman.tools && lastHuman.tools.length > 0 ? lastHuman.tools : [];

    try {
      setLoading(true);
      setError(null);
      setStreamingProgress({
        isStreaming: true,
        toolName: 'chat',
        current: 'Regenerating response...',
        thoughts: [],
      });

      // Drop the trailing AI message and add a placeholder that fills live
      setMessages(prev => {
        const copy = [...prev];
        if (copy.length && copy[copy.length - 1].type === 'ai') copy.pop();
        copy.push({
          type: 'ai',
          content: '',
          timestamp: new Date().toISOString(),
          streaming: true,
        });
        return copy;
      });

      const response = await chatService.regenerateMessage(threadId, tools);

      setMessages(prev =>
        prev.map(m =>
          m.streaming ? { ...m, content: response.response, streaming: false } : m
        )
      );
    } catch (err) {
      setError(err.message);
      console.error('Error regenerating:', err);
    } finally {
      setLoading(false);
      setStreamingProgress(null);
    }
  };

  const editMessage = async (newContent, messageIndex) => {
    if (!threadId || !newContent.trim()) return;

    // 0-based index of the edited human message among all human turns
    const humanIndex = messages.slice(0, messageIndex + 1).filter(m => m.type === 'human').length - 1;
    const targetMsg = messages[messageIndex];
    const tools = targetMsg?.tools && targetMsg.tools.length > 0 ? targetMsg.tools : [];

    try {
      setLoading(true);
      setError(null);
      setStreamingProgress({
        isStreaming: true,
        toolName: 'chat',
        current: 'Updating...',
        thoughts: [],
      });

      // Rewrite the edited message, drop everything after it, and add a
      // placeholder bubble that fills live (like regenerate).
      setMessages(prev => {
        const updated = prev.slice(0, messageIndex + 1);
        updated[messageIndex] = { ...updated[messageIndex], content: newContent, streaming: false };
        updated.push({
          type: 'ai',
          content: '',
          timestamp: new Date().toISOString(),
          streaming: true,
        });
        return updated;
      });

      chatService.editStream(threadId, newContent, humanIndex, tools, handleChatChunk, handleStreamError);
    } catch (err) {
      setError(err.message);
      console.error('Error editing message:', err);
      setStreamingProgress(null);
      setLoading(false);
    }
  };

  // Abort an in-flight generation. Closes the SSE connection so streaming
  // stops at the current point, then keeps the partial assistant message
  // (marked as finished) visible to the user and removes the just-sent human
  // message so the prompt can return to the input box. Returns the cancelled
  // prompt text.
  const stop = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setLoading(false);
    setStreamingProgress(null);
    setMessages(prev => {
      const hadStreaming = prev.some(m => m.streaming);
      // Keep the partial response, just stop the streaming indicator.
      const next = prev.map(m => (m.streaming ? { ...m, streaming: false } : m));
      // Drop the just-sent human message so the prompt returns to the input.
      if (hadStreaming && next.length && next[next.length - 1]?.type === 'human') {
        return next.slice(0, -1);
      }
      return next;
    });
    return lastPromptRef.current || '';
  };

  return {
    messages,
    loading,
    error,
    sendMessage,
    regenerate,
    editMessage,
    loadMessages,
    streamingProgress,
    stop,
  };
};
