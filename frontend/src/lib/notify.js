import { getPreferences } from './preferences';

// Tell the user a reply or coding task finished while they were in another
// tab: a browser notification and/or a short chime (General settings).

let audio;

function chime() {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const now = audio.currentTime;
    [660, 880].forEach((freq, i) => {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + i * 0.15);
      gain.gain.exponentialRampToValueAtTime(0.15, now + i * 0.15 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.15 + 0.3);
      osc.connect(gain).connect(audio.destination);
      osc.start(now + i * 0.15);
      osc.stop(now + i * 0.15 + 0.32);
    });
  } catch { /* audio unavailable */ }
}

export function notifyFinished(title, body) {
  if (typeof document === 'undefined' || document.visibilityState === 'visible') return;
  const prefs = getPreferences();
  if (prefs.sound_on_finish) chime();
  if (prefs.notify_on_finish && 'Notification' in window && Notification.permission === 'granted') {
    try {
      const n = new Notification(title, { body, tag: 'opengpt-finished' });
      n.onclick = () => { window.focus(); n.close(); };
    } catch { /* notifications unavailable */ }
  }
}

// Ask for permission when the user turns notifications on. Returns true if allowed.
export async function requestNotificationPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  return (await Notification.requestPermission()) === 'granted';
}

export { chime as testChime };
