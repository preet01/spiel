# 🎙 Spiel

**Listen to any article with a natural AI voice — free, private, and open source.**

Spiel is a Chrome extension that reads web pages aloud with a high-quality neural voice ([Kokoro](https://huggingface.co/hexgrad/Kokoro-82M)) running **entirely on your own Mac**. No cloud, no account, no subscription. Turn off Wi-Fi and it still works.

An open-source alternative to Speechify* — without the $139/year and without your reading history flowing through someone else's servers.

## Features

- ▶️ **One click to listen** — open any article, press Play
- 🖍 **Word-by-word highlighting** that follows the voice
- 👆 **Click anywhere to listen from there** — click a paragraph, reading jumps to it
- ✂️ **Read your selection** — select text on any page for instant playback
- 🎚 **4 curated voices** (American/British, male/female) and speed up to 3×
- ⏱ **Time-remaining estimate** at your current speed
- 🧹 **Smart skipping** — URLs, [reference brackets], (parentheses) — your choice
- 🌙 **Dark mode** everywhere, matched to the page
- 🔒 **100% local** — text-to-speech happens at `127.0.0.1`; nothing ever leaves your machine

## Install (2 steps, ~3 minutes)

**Requirements:** Mac with Apple Silicon (M1 or newer), ~8 GB free disk, Chrome. (Intel Macs and Windows/Linux: on the roadmap.)

### Step 1 — The extension

*Until the Chrome Web Store listing is live:*

```bash
git clone https://github.com/preet01/spiel.git
cd spiel && npm install && npm run build
```

Then open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and pick the `dist/` folder.

### Step 2 — The voice engine

Paste this in the **Terminal** app and press Enter:

```bash
curl -fsSL https://raw.githubusercontent.com/preet01/spiel/main/install.sh | bash
```

Wait ~2 minutes. When your Mac says **"Spiel is ready"** out loud, you're done — open any article and press Play in the Spiel popup.

<details>
<summary><strong>What does that command install, exactly?</strong></summary>

Everything goes under `~/.spiel` (plus one LaunchAgent). The script:

1. Checks your Mac (macOS, disk space)
2. Installs the [uv](https://github.com/astral-sh/uv) Python manager if missing
3. Downloads [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) (pinned commit, Apache-2.0)
4. Downloads the Kokoro voice model (~330 MB, Apache-2.0)
5. Creates a LaunchAgent so the engine auto-starts on boot, bound to `127.0.0.1` only — unreachable from the network
6. Starts it and speaks a test sentence

It's ~300 lines of plain bash — [read it yourself](install.sh) before running, as you should with any `curl | bash`.

</details>

## How it works

```
┌────────────────────────── Your Mac ──────────────────────────┐
│                                                              │
│  Chrome                            Kokoro voice engine       │
│  ┌──────────────────┐   text   ┌───────────────────────┐     │
│  │ Spiel extension  │ ───────▶ │ FastAPI + Kokoro-82M   │    │
│  │ (UI, highlights) │ ◀─────── │ at 127.0.0.1:8880      │    │
│  └──────────────────┘   audio  └───────────────────────┘     │
│                                                              │
└────────────── nothing crosses this line ─────────────────────┘
```

The extension extracts the article ([Readability](https://github.com/mozilla/readability)), sends it sentence-by-sentence to the local engine, and plays the audio with synchronized word highlighting (via Kokoro's word timestamps).

## Privacy

- No analytics, no telemetry, no accounts, no remote servers.
- The voice engine listens on `127.0.0.1` only — your own machine, not your network.
- The only network traffic Spiel ever creates is the one-time download of the engine and model at install.

## Troubleshooting

| Problem | Fix |
|---|---|
| Popup says "Voice not installed" | Run the Step 2 command; the popup updates itself when the engine is up |
| Installed but silent | Engine log: `~/Library/Logs/spiel-voice-engine.log` · installer log: `~/.spiel/install.log` |
| Port 8880 already in use | Another app owns it — `lsof -iTCP:8880 -sTCP:LISTEN` to find it |
| First play of the day is slow | The model warms up on first request (~5–15 s); Spiel keeps it warm afterwards |
| Uninstall everything | `curl -fsSL https://raw.githubusercontent.com/preet01/spiel/main/uninstall.sh \| bash` + remove the extension at `chrome://extensions` |

## Building from source

```bash
npm install
npm run build      # bundles TS → dist/, generates icons, copies popup + manifest
npx tsc --noEmit   # type-check
npm run package    # dist → spiel-extension.zip (for the Chrome Web Store)
```

## Roadmap

- [ ] **True one-click:** run the voice inside Chrome via WebGPU (no Terminal step at all)
- [ ] Chrome Web Store listing
- [ ] Windows & Linux installers
- [ ] More voices and languages
- [ ] Firefox support

## License & credits

[MIT](LICENSE) © Harpreet Vishnoi. Built on excellent open-source work — see [THIRD_PARTY.md](THIRD_PARTY.md) for full credits (Kokoro model & Kokoro-FastAPI, Apache-2.0; Mozilla Readability, Apache-2.0; and the CC BY voice datasets behind Kokoro).

\* *Spiel is not affiliated with, endorsed by, or connected to Speechify Inc. in any way.*
