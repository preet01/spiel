/* Spiel popup controller — one action: Listen (Kokoro playback of the page). The popup
   closes once reading starts; the floating in-page player owns playback from there.
   Voice & speed live in the player, where changes are audible. */

const $ = id => document.getElementById(id);

const hintEl      = $('hint');
const btnPlay     = $('btn-play');
const actions     = $('actions');
const ctrlLoading = $('controls-loading');
const cardSetup   = $('card-setup');
const cardError   = $('card-error');
const errorMsg    = $('error-msg');
const btnCopyCmd  = $('btn-copy-cmd');
const setupCmd    = $('setup-cmd');

const HINT_IDLE = 'Open an article or PDF and press Listen.';

let closeOnPlayback = false;

// ── Init ──────────────────────────────────────────────────────────────────────
(function init() {
  pollStatus();
  setInterval(pollStatus, 600);
})();

// ── Playback status (also warms the voice engine via GET_STATUS) ─────────────
async function pollStatus() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
    if (res?.state) applyState(res.state);
  } catch { /* SW not ready yet */ }
}

function applyState(state) {
  const { status, errorMessage } = state;

  // Reading began → the floating in-page player is the UI now; this popup bows out.
  if (closeOnPlayback && (status === 'loading' || status === 'playing')) {
    window.close();
    return;
  }

  const playing = status === 'playing' || status === 'paused';
  const loading = status === 'loading';
  const needsSetup = !state.serverAvailable && !playing && !loading;

  // While reading, the player owns playback — the popup just says where to look.
  hintEl.textContent = playing ? 'Reading aloud — controls are on the page.' : HINT_IDLE;
  btnPlay.classList.toggle('hidden', playing);
  btnPlay.disabled = needsSetup;
  actions.classList.toggle('hidden', loading);
  ctrlLoading.classList.toggle('hidden', !loading);

  cardSetup.classList.toggle('hidden', !needsSetup);

  const showError = status === 'error' && !needsSetup;
  cardError.classList.toggle('hidden', !showError);
  if (showError) errorMsg.textContent = errorMessage || 'Something went wrong.';
}

// ── Listen ────────────────────────────────────────────────────────────────────
btnPlay.addEventListener('click', () => {
  closeOnPlayback = true;
  chrome.runtime.sendMessage({ type: 'PLAY' });
  setTimeout(pollStatus, 150);
  setTimeout(pollStatus, 400);
});

// ── Setup card: copy the install command ─────────────────────────────────────
const INSTALL_CMD = 'curl -fsSL https://raw.githubusercontent.com/preet01/spiel/main/install.sh | bash';

async function copyInstallCmd() {
  try {
    await navigator.clipboard.writeText(INSTALL_CMD);
    btnCopyCmd.textContent = '✓ Copied — paste in Terminal';
  } catch {
    btnCopyCmd.textContent = 'Select the command and copy it';
  }
  setTimeout(() => { btnCopyCmd.textContent = 'Copy command'; }, 2500);
}
btnCopyCmd.addEventListener('click', copyInstallCmd);
setupCmd.addEventListener('click', copyInstallCmd);

// Live status pushes from the background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STATUS_UPDATE' && msg.state) applyState(msg.state);
});
