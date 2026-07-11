<div align="center">

<img src="assets/icon.svg" width="96" alt="Spiel icon — coral waveform">

# Spiel

**Listen to any article or PDF with a natural AI voice — free, private, and 100% local.**

[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/dkfdbjaghlaldbdleidhkinpekabffij?color=FF385C&label=chrome%20web%20store)](https://chromewebstore.google.com/detail/spiel/dkfdbjaghlaldbdleidhkinpekabffij)
[![Release](https://img.shields.io/github/v/release/preet01/spiel?color=FF385C&label=release)](https://github.com/preet01/spiel/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-FF385C.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20(Apple%20Silicon)-1a1719.svg)](#install-2-steps-3-minutes)
[![Website](https://img.shields.io/badge/website-preet01.github.io%2Fspiel-FF385C.svg)](https://preet01.github.io/spiel/)

An open-source alternative to Speechify\* — without the $139/year, and without your
reading history flowing through someone else's servers.

**[Add to Chrome](https://chromewebstore.google.com/detail/spiel/dkfdbjaghlaldbdleidhkinpekabffij) · [Website](https://preet01.github.io/spiel/) · [Report a bug](https://github.com/preet01/spiel/issues)**

</div>

---

## Why Spiel

Read-aloud tools are either expensive subscriptions or cloud services that see
everything you read. Spiel is neither: the neural voice
([Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M)) runs **on your own Mac** at
`127.0.0.1`. No account, no telemetry, no cloud. Turn off Wi-Fi and it still works.

Built for students, researchers, and anyone who reads a lot and wants to pay nothing.

## Features

- ▶️ **One click to listen** — open any article or PDF, press Play
- 🖍 **Word-by-word highlighting** that follows the voice, with auto-scroll
- 📄 **Reads PDFs** — research papers, web-hosted or local, extracted on-device with pdf.js
- 👆 **Click anywhere to listen from there** — click a paragraph, reading jumps to it
- ✂️ **Read your selection** — select text on any page for instant playback
- 🎚 **4 curated voices** (American/British, male/female) and speed up to 3×
- ⏱ **Time-remaining estimate** at your current speed
- 🧹 **Smart skipping** — URLs, [reference brackets], (parentheses) — your choice
- 🌙 **Dark mode** everywhere, matched to the page
- 🔒 **100% local** — text-to-speech happens at `127.0.0.1`; nothing ever leaves your machine

## Install (2 steps, ~3 minutes)

**Requirements:** Mac with Apple Silicon (M1 or newer) · ~8 GB free disk · Chrome.
*(Intel Macs and Windows/Linux: [on the roadmap](#roadmap).)*

### Step 1 — The extension

**[➕ Add Spiel to Chrome](https://chromewebstore.google.com/detail/spiel/dkfdbjaghlaldbdleidhkinpekabffij)** (Chrome Web Store, one click), then pin the 🎙 Spiel icon to your toolbar.

<details>
<summary><strong>Or install manually / build from source</strong></summary>

**Manual:** [download the latest spiel-extension.zip](https://github.com/preet01/spiel/releases/latest),
unzip it somewhere permanent (not Downloads), open `chrome://extensions`, toggle
**Developer mode** ON, click **Load unpacked**, and pick the unzipped folder.

**From source:**

```bash
git clone https://github.com/preet01/spiel.git
cd spiel && npm install && npm run build
```

Then Load unpacked → pick the `dist/` folder.

</details>

### Step 2 — The voice engine

Paste this in the **Terminal** app and press Enter:

```bash
curl -fsSL https://raw.githubusercontent.com/preet01/spiel/main/install.sh | bash
```

Wait ~2 minutes. When your Mac says **"Spiel is ready"** out loud, you're done —
open any article and press Play in the Spiel popup.

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
│  │ Spiel extension  │ ───────▶ │ FastAPI + Kokoro-82M  │     │
│  │ (UI, highlights) │ ◀─────── │ at 127.0.0.1:8880     │     │
│  └──────────────────┘   audio  └───────────────────────┘     │
│                                                              │
└────────────── nothing crosses this line ─────────────────────┘
```

The extension extracts the article ([Readability](https://github.com/mozilla/readability))
or PDF ([pdf.js](https://mozilla.github.io/pdf.js/), on-device), sends it
sentence-by-sentence to the local engine, and plays the audio with synchronized
word highlighting driven by Kokoro's word timestamps.

## Privacy

- No analytics, no telemetry, no accounts, no remote servers.
- The voice engine listens on `127.0.0.1` only — your own machine, not your network.
- The only network traffic Spiel ever creates is the one-time download of the engine and model at install.

## Troubleshooting

| Problem | Fix |
|---|---|
| Popup says "Voice not installed" | Run the Step 2 command; the popup updates itself when the engine is up |
| Installed but silent | Engine log: `~/Library/Logs/spiel-voice-engine.log` · installer log: `~/.spiel/install.log` |
| Local PDF won't read | Enable **Allow access to file URLs** for Spiel at `chrome://extensions` |
| Port 8880 already in use | Another app owns it — `lsof -iTCP:8880 -sTCP:LISTEN` to find it |
| First play of the day is slow | The model warms up on first request (~5–15 s); Spiel keeps it warm afterwards |
| Uninstall everything | `curl -fsSL https://raw.githubusercontent.com/preet01/spiel/main/uninstall.sh \| bash` + remove the extension at `chrome://extensions` |

## Contributing

Issues and PRs welcome — especially **Intel Mac / Windows / Linux ports**, new
voices, and Firefox support. The codebase is small and documented:

| File | What it does |
|---|---|
| `src/background.ts` | Playback state machine, TTS fetches, prefetch cache |
| `src/content.ts` | Article extraction, word highlighting, floating player |
| `src/offscreen.ts` | Audio playback (Web Audio, autoplay-exempt) |
| `src/pdf-content.ts` | On-device PDF text extraction (pdf.js) |

The build has two quality gates: a strict TypeScript check and a dist-completeness
check that fails if any runtime file is missing. Before contributing, read
[`LESSONS.md`](LESSONS.md) — every past bug, its root cause, and the pre-flight
checklist that keeps them from coming back.

```bash
npm run build      # typecheck → bundle → icons → verify dist/ completeness
npm run package    # dist/ → spiel-extension.zip
```

## Roadmap

- [x] Chrome Web Store listing — [live here](https://chromewebstore.google.com/detail/spiel/dkfdbjaghlaldbdleidhkinpekabffij)
- [ ] **True one-click:** run the voice inside Chrome via WebGPU (no Terminal step at all)
- [ ] In-PDF page highlighting (Spiel Reader view)
- [ ] Windows & Linux installers
- [ ] More voices and languages
- [ ] Firefox support

## License & credits

[MIT](LICENSE) © Harpreet Vishnoi. Built on excellent open-source work — see [THIRD_PARTY.md](docs/THIRD_PARTY.md) for full credits (Kokoro model & Kokoro-FastAPI, Apache-2.0; Mozilla Readability, Apache-2.0; pdf.js, Apache-2.0; and the CC BY voice datasets behind Kokoro).
