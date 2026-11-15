import React from 'react';
import { Code2, ArrowUp } from 'lucide-react';

// Landing screen for the coding agent (/code). The agent service is not wired
// to the backend yet, so the composer is shown but disabled.
const CodeView = () => (
  <div className="flex-1 min-w-0 flex flex-col h-screen">
    {/* Header — matches the chat header */}
    <div className="flex-shrink-0 px-4 py-3 bg-chat-bg">
      <div className="flex items-center gap-2 pl-12 lg:pl-0">
        <span className="text-base font-semibold tracking-tight text-white select-none">
          OpenGPT
        </span>
        <span className="px-2 py-0.5 rounded-lg bg-gray-700/70 text-xs font-medium text-gray-300">
          Code
        </span>
      </div>
    </div>

    <div className="flex-1 min-h-0 flex items-center justify-center px-4 pb-16">
      <div className="w-full max-w-3xl">
        <div className="text-center mb-6">
          <div className="mx-auto mb-4 flex items-center justify-center w-12 h-12 rounded-2xl bg-gray-700/60 text-gray-200">
            <Code2 size={24} />
          </div>
          <h1 className="text-2xl font-bold text-gray-100">What should we build?</h1>
          <p className="mt-2 text-sm text-gray-400 max-w-md mx-auto">
            The coding agent reads and edits code, runs commands and asks before
            making risky changes.
          </p>
        </div>

        <div
          className="border-[#565869] bg-[#40414f] rounded-3xl border p-2 shadow-sm opacity-60 cursor-not-allowed"
          aria-disabled="true"
        >
          <textarea
            disabled
            rows={1}
            placeholder="Describe a coding task"
            aria-label="Describe a coding task"
            className="text-white min-h-[44px] w-full resize-none border-none bg-transparent px-2 py-2.5 outline-none placeholder-gray-400 cursor-not-allowed"
          />
          <div className="flex justify-end px-1 pb-1">
            <button
              type="button"
              disabled
              aria-label="Send"
              className="flex items-center justify-center w-8 h-8 rounded-full bg-gray-500 text-gray-800 cursor-not-allowed"
            >
              <ArrowUp size={16} />
            </button>
          </div>
        </div>

        <p className="mt-3 text-center text-xs text-gray-500">
          Coming soon: the coding agent is being connected.
        </p>
      </div>
    </div>
  </div>
);

export default CodeView;
