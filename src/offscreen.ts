// Spiel offscreen document — handles all audio playback
// Extension pages are exempt from Chrome's autoplay policy

const log = (...a: any[]) => console.log('[Spiel:OS]', ...a);
const err = (...a: any[]) => console.error('[Spiel:OS]', ...a);

// Created eagerly at document startup — saves ~50-100ms on the first play.
// Extension pages are exempt from autoplay policy; playAudio resumes if suspended.
let audioContext: AudioContext | null = new AudioContext();
let currentSource: AudioBufferSourceNode | null = null;
let isStopped = false;
// Per-play token. Each playAudio() claims a new token; if it's superseded (a newer play
// or a stop) while awaiting decodeAudioData, the stale call bails instead of starting a
// second overlapping source. This fixes audio loss/overlap on rapid Next presses.
let playToken = 0;
let currentGenId = 0;

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function stopCurrentAudio() {
  isStopped = true;
  if (currentSource) {
    try { currentSource.stop(); } catch {}
    try { currentSource.disconnect(); } catch {}
    currentSource = null;
  }
}

async function playAudio(audioBase64: string, genId: number): Promise<void> {
  stopCurrentAudio();          // halt whatever is playing
  const myToken = ++playToken; // claim this playback
  isStopped = false;
  currentGenId = genId;

  if (!audioContext || audioContext.state === 'closed') {
    audioContext = new AudioContext();
    log('AudioContext created');
  }
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

  const buffer = await audioContext.decodeAudioData(base64ToArrayBuffer(audioBase64));

  // Superseded by a newer play or a stop while we were decoding? Don't start a 2nd source.
  if (myToken !== playToken || isStopped) {
    throw new Error('stopped');
  }

  return new Promise((resolve) => {
    currentSource = audioContext!.createBufferSource();
    currentSource.buffer = buffer;
    currentSource.connect(audioContext!.destination);
    currentSource.onended = () => {
      // Resolve (→ AUDIO_ENDED) only if this is still the current clip and not stopped.
      if (myToken === playToken && !isStopped) resolve();
    };
    currentSource.start(0);
    // durationS lets the content script keep the word highlight moving even when the
    // server returns fewer timestamps than spoken words (it interpolates the tail).
    chrome.runtime.sendMessage({ type: 'AUDIO_STARTED', genId, durationS: buffer.duration }).catch(() => {});
    log('Audio started, duration:', buffer.duration.toFixed(1) + 's');
  });
}

chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
  if (msg.type === 'OFFSCREEN_PLAY') {
    const genId = msg.genId ?? 0;
    playAudio(msg.audioBase64, genId)
      .then(() => {
        log('Audio ended naturally — notifying background');
        chrome.runtime.sendMessage({ type: 'AUDIO_ENDED', genId }).catch(() => {});
      })
      .catch((e) => {
        if (e?.message === 'stopped') { log('Playback superseded/stopped'); return; }
        err('Playback failed:', e);
        chrome.runtime.sendMessage({ type: 'AUDIO_ERROR', genId }).catch(() => {});
      });
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'OFFSCREEN_PAUSE') {
    audioContext?.suspend().then(() => log('Paused')).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'OFFSCREEN_RESUME') {
    audioContext?.resume().then(() => log('Resumed')).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'OFFSCREEN_STOP') {
    stopCurrentAudio();
    log('Stopped current audio');
    sendResponse({ ok: true });
    return false;
  }
});

log('Offscreen document ready');
