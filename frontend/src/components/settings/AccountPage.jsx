import React from 'react';
import { HardDrive } from 'lucide-react';
import { Avatar, PageHeader } from './controls';

// No sign-in yet: the account is this OpenGPT install. The name comes from
// Personalization (nickname), "Muhammad" until it is set.
const AccountPage = ({ displayName, onOpenPersonalization }) => (
  <div>
    <PageHeader title="Account" />

    <div className="flex items-center gap-4">
      <Avatar name={displayName} size="h-14 w-14 text-2xl" />
      <div className="min-w-0">
        <p className="text-xs text-gray-400">Name</p>
        <p className="truncate text-base text-gray-100">{displayName}</p>
        <button type="button" onClick={onOpenPersonalization} className="mt-1 text-xs text-blue-400 hover:text-blue-300">
          Change in Personalization
        </button>
      </div>
    </div>

    <div className="mt-6 flex items-start gap-3 rounded-xl border border-gray-700/70 bg-black/10 p-4">
      <HardDrive size={18} className="mt-0.5 shrink-0 text-gray-400" />
      <div className="text-sm">
        <p className="text-gray-100">Local mode</p>
        <p className="mt-1 text-gray-400">
          OpenGPT runs on your computer and has no sign-in yet. Your chats, projects and settings are stored in
          this install&apos;s database, not in an online account.
        </p>
      </div>
    </div>
  </div>
);

export default AccountPage;
