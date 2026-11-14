import React from 'react';

// Shows a simple fallback instead of a blank page when rendering crashes.
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('App crashed:', error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-screen items-center justify-center bg-chat-bg p-6 text-white">
        <div className="max-w-md text-center">
          <h1 className="text-xl font-semibold text-gray-100">Something went wrong</h1>
          <p className="mt-2 text-sm text-gray-400">
            The page hit an unexpected error. Reload to continue.
          </p>
          <div className="mt-5 flex justify-center gap-2">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500"
            >
              Reload
            </button>
            <button
              type="button"
              onClick={() => window.location.assign('/chat')}
              className="rounded-md border border-gray-600 px-3 py-1.5 text-sm font-medium text-gray-200 hover:bg-gray-700"
            >
              New chat
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
