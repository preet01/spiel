# Chrome Web Store listing — Spiel

Everything needed to submit. You do: pay the one-time $5 developer fee at
https://chrome.google.com/webstore/devconsole, upload `spiel-extension.zip`
(`npm run package`), and paste the text below.

## Basics

| Field | Value |
|---|---|
| Name | Spiel — Local AI Text to Speech |
| Category | Accessibility (alt: Productivity) |
| Language | English |

## Summary (max 132 chars)

> Read articles & PDFs aloud with a natural AI voice running 100% on your Mac. Private, free, open source. No cloud, no account.

(128 chars)

## Description

```
Spiel reads any article, blog post, PDF, or selection aloud with a natural neural
voice — and unlike every other text-to-speech extension, the voice runs
entirely on YOUR computer. Nothing you read is ever sent to a cloud server.

WHY SPIEL
• 100% private — text-to-speech happens locally at 127.0.0.1. Turn off
  Wi-Fi and it still works.
• Free forever — no account, no subscription, no trial. Open source (MIT).
• Natural voices — powered by the Kokoro-82M neural TTS model.

FEATURES
• One click to listen on any article or PDF (research papers included)
• Word-by-word highlighting that follows the voice, with auto-scroll
• Click any paragraph to listen from there
• Select text on any page for instant playback
• 4 curated voices (American/British, male/female), speed up to 3×
• Time-remaining estimate, smart skipping of URLs and [references]
• Dark mode throughout

SETUP (one extra step, ~2 minutes)
Spiel's voice engine runs on your own machine — that's the whole point.
After installing this extension, the popup shows a one-line Terminal command
that installs the engine. Paste it, wait two minutes, and your Mac will
literally say "Spiel is ready." Requires macOS; Apple Silicon recommended.

Open source: https://github.com/preet01/spiel
Spiel is not affiliated with, endorsed by, or connected to Speechify Inc.
```

## Single-purpose statement

> Spiel has one purpose: reading page text (web pages and PDFs) aloud (text-to-speech) using a speech engine that runs locally on the user's computer.

## Permission justifications

| Permission | Justification to paste |
|---|---|
| `activeTab` | Used only when the user clicks the Spiel icon or presses Play, to read the text of the article the user asked to hear. No background access to browsing. |
| `storage` | Stores the user's voice, speed, and skip preferences (sync) and transient playback state (session). No user content is stored. |
| `offscreen` | Chrome MV3 requires an offscreen document to play audio; the service worker cannot. Used solely for audio playback. |
| `alarms` | Schedules a tiny periodic keep-warm request to the local speech engine so playback starts in under a second. No user data involved. |
| `scripting` | Injects the reader (text extraction + word highlighting) into the page the user asked Spiel to read, on user action only. |
| Host permission `http://127.0.0.1:8880/*` | Spiel's text-to-speech engine runs on the user's own machine at this loopback address. The extension sends article text there and receives audio back. This is the privacy feature: no remote server is ever contacted. |
| Host permission `http://localhost:8880/*` | Same local engine as above — included only for configurations where the loopback resolves via localhost. Never a remote host. |
| Host permission `file:///*` | Lets users play their own local PDF files (e.g. downloaded research papers). Used only when the user opens a local PDF and presses Play; the file's text is extracted on-device with the bundled pdf.js and sent only to the local (127.0.0.1) speech engine. Chrome additionally requires the user to opt in via "Allow access to file URLs". |

## Privacy tab answers

- Does your extension collect user data? **No.**
- Remote code? **No** — all code is bundled, including the pdf.js library and its worker (`pdf.worker.min.mjs`, shipped in the package as a web-accessible resource). The loopback host serves only audio data, never code.
- Privacy policy URL: `https://github.com/preet01/spiel#privacy` (README section).

## Assets — ready in `store/assets/`

- [x] `screenshot-1-article-1280x800.png` — word highlighting + floating player on an article
- [x] `screenshot-2-pdf-1280x800.png` — PDF/research-paper reading with caption karaoke
- [x] `screenshot-3-privacy-1280x800.png` — "nothing leaves your Mac" diagram
- [x] `promo-tile-440x280.png` — small promo tile
- [x] `marquee-1400x560.png` — marquee banner
- [x] Icon: 128px is generated into `dist/icons/` by the build

## Submission walkthrough (~15 minutes)

1. Go to https://chrome.google.com/webstore/devconsole → sign in with your Google
   account → pay the one-time **$5** registration fee.
2. **New item** → upload `spiel-extension.zip` (from the repo root; regenerate any
   time with `npm run package`).
3. **Store listing tab:** paste the Summary and Description above; upload the 3
   screenshots + promo tile + marquee from `store/assets/`; category
   **Accessibility**; language English.
4. **Privacy tab:** paste the single-purpose statement, each permission
   justification from the table above, and the data-collection answers (all "No").
   Privacy policy URL: `https://github.com/preet01/spiel#privacy`.
5. **Distribution tab:** Public, all regions, free.
6. Submit for review. Typical review: a few days (the localhost + file access
   permissions may add a manual-review day — the justifications above are written
   to answer exactly what reviewers ask).
7. When approved: update README + landing page Step 1 to the store URL (I'll do
   this — just share the link).

## Review-risk notes

- The localhost fetch is the usual reviewer question — the single-purpose
  statement + host-permission justification above address it head-on.
- "Alternative to Speechify" is intentionally NOT in the store name/summary
  (trademark policy); the non-affiliation line covers the description.
