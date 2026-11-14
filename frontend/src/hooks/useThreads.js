import { useState, useEffect } from 'react';
import { chatService } from '../services/api';

export const useThreads = () => {
  const [threads, setThreads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchThreads = async () => {
    try {
      setLoading(true);
      const data = await chatService.getThreads();
      setThreads(data);
      setError(null);
    } catch (err) {
      setError(err.message);
      console.error('Error fetching threads:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchThreads();
  }, []);

  const createNewThread = async () => {
    try {
      const newThread = await chatService.createThread();
      await fetchThreads();
      return newThread.thread_id;
    } catch (err) {
      setError(err.message);
      console.error('Error creating thread:', err);
      return null;
    }
  };

  const updateThreadTitle = async (threadId, title) => {
    try {
      await chatService.updateThreadTitle(threadId, title);
      await fetchThreads();
    } catch (err) {
      setError(err.message);
      console.error('Error updating thread title:', err);
    }
  };

  return {
    threads,
    loading,
    error,
    clearError: () => setError(null),
    fetchThreads,
    createNewThread,
    updateThreadTitle,
  };
};
