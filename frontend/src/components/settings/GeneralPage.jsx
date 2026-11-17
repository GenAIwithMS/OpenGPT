import React, { useState } from 'react';
import { PageHeader, Row, Section, Toggle } from './controls';
import { requestNotificationPermission, testChime } from '../../lib/notify';

// General settings: only features OpenGPT supports today.
const GeneralPage = ({ settings, save }) => {
  const general = settings?.general;
  const [note, setNote] = useState(null);
  if (!general) return null;

  const set = (changes) => save({ general: changes }).catch(() => {});

  const toggleNotifications = async (on) => {
    setNote(null);
    if (on && !(await requestNotificationPermission())) {
      setNote('Your browser blocked notifications for this site. Allow them in the browser settings, then try again.');
      return;
    }
    set({ notify_on_finish: on });
  };

  return (
    <div>
      <PageHeader title="General" />

      <Section title="Chat preferences">
        <Row label="Start new chats as temporary"
          description="New chats aren't saved to your history unless you turn temporary off.">
          <Toggle label="Start new chats as temporary" checked={general.temporary_by_default}
            onChange={(v) => set({ temporary_by_default: v })} />
        </Row>
      </Section>

      <Section title="Notifications">
        <Row label="Browser notification when done"
          description="When a reply or a coding task finishes while OpenGPT is in another tab.">
          <Toggle label="Browser notification when done" checked={general.notify_on_finish}
            onChange={toggleNotifications} />
        </Row>
        <Row label="Sound when done"
          description="Play a short sound when a reply or a coding task finishes while you're away.">
          <div className="flex items-center gap-3">
            <button type="button" onClick={testChime} className="text-xs text-gray-400 hover:text-gray-200">Test</button>
            <Toggle label="Sound when done" checked={general.sound_on_finish}
              onChange={(v) => set({ sound_on_finish: v })} />
          </div>
        </Row>
        {note && <p role="alert" className="py-2 text-xs text-amber-300">{note}</p>}
      </Section>
    </div>
  );
};

export default GeneralPage;
