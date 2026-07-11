# Spiel launch posts — ready to paste

Store link everywhere: https://chromewebstore.google.com/detail/spiel/dkfdbjaghlaldbdleidhkinpekabffij

Always mention the Apple Silicon requirement — it prevents 1-star reviews from
Windows/Intel users who install and hear nothing.

Always mention that setup is two steps (extension + one Terminal command for the
voice engine) — the extension alone is silent until Kokoro is installed. Posts
that link only the store with no setup context set up a bad first-run experience.

On platforms that support code blocks (HN, Reddit), paste the actual install
command inline rather than just saying "run the setup command." A reader
shouldn't have to leave the post to find out what the two steps actually are —
"click here, then run this" beats "click here, instructions on the other end."

---

## X / Twitter

> I built Spiel — a free Chrome extension that reads any article or PDF aloud
> with a natural AI voice, running 100% on your own Mac.
>
> No cloud. No account. No $139/yr subscription. Turn off Wi-Fi and it still works.
>
> Setup: add the extension, then paste one Terminal command that installs the
> local voice engine (~2 min — your Mac literally says "Spiel is ready").
>
> Open source (MIT). Now on the Chrome Web Store:
> https://chromewebstore.google.com/detail/spiel/dkfdbjaghlaldbdleidhkinpekabffij
> (Mac, Apple Silicon)

(Attach the word-highlighting screenshot or a short screen recording — posts with
a demo clip do dramatically better.)

**Reply to your own tweet** with the actual command, so anyone who wants to
install doesn't have to hunt for it:

> The voice engine step, in full — paste this in Terminal after adding the
> extension:
>
> curl -fsSL https://raw.githubusercontent.com/preet01/spiel/main/install.sh | bash
>
> ~2 min, your Mac says "Spiel is ready" when it's done.

---

## Show HN (news.ycombinator.com/submit)

**Title:** Show HN: Spiel – Chrome extension that reads articles/PDFs aloud with local TTS

**URL:** https://github.com/preet01/spiel
(link the repo, not the store — HN prefers source; the README's first button is the store)

**First comment (post immediately after submitting):**

Hi HN! I read a lot and wanted Speechify-quality read-aloud without the
> subscription or sending everything I read to someone's server.
>
> Spiel is a Chrome (MV3) extension paired with a local voice engine: the
> Kokoro-82M TTS model served by FastAPI at 127.0.0.1:8880. The extension
> extracts the article (Mozilla Readability) or PDF (pdf.js, on-device), streams
> it sentence-by-sentence to the local engine, and plays audio with word-by-word
> highlighting driven by Kokoro's word timestamps. Turn off Wi-Fi and it keeps working.
>
> Setup is two steps, both doable from this comment:
>
> 1. Install the extension: https://chromewebstore.google.com/detail/spiel/dkfdbjaghlaldbdleidhkinpekabffij
> 2. Paste this in Terminal and press Enter:
>
> ```
> curl -fsSL https://raw.githubusercontent.com/preet01/spiel/main/install.sh | bash
> ```
>
> That installs the engine under ~/.spiel (~300 lines of bash, readable before
> you run it — https://github.com/preet01/spiel/blob/main/install.sh). Wait
> ~2 minutes; when your Mac literally says "Spiel is ready," you're done.
>
> Currently macOS/Apple Silicon; Intel/Windows/Linux and an in-browser WebGPU
> engine (no Terminal step at all) are on the roadmap. MIT licensed — feedback
> and PRs very welcome.

---

## Reddit — r/macapps (also fits r/ChromeExtensions, r/opensource)

**Title:** I made a free, open-source Speechify alternative that runs 100% locally on your Mac (Chrome extension, now on the Web Store)

> I read a ton of articles and papers and wanted them read aloud — but every
> option is either a $139/yr subscription or a cloud service that sees
> everything you read. So I built Spiel.
>
> **What it does**
> - Reads any article, blog post, or PDF (research papers included) with a natural neural voice (Kokoro-82M)
> - Word-by-word highlighting that follows the voice, with auto-scroll
> - Click any paragraph to jump there; select text to read just that
> - 4 voices, up to 3× speed, dark mode
>
> **The privacy part:** the voice engine runs on *your* Mac at 127.0.0.1.
> No account, no telemetry, no cloud — turn off Wi-Fi and it still works.
>
> Free forever, MIT licensed. Needs an Apple Silicon Mac (M1+) — Intel/Windows
> are on the roadmap.
>
> **Setup (2 steps, both here):**
>
> 1. Add the extension: https://chromewebstore.google.com/detail/spiel/dkfdbjaghlaldbdleidhkinpekabffij
> 2. Paste this in Terminal, press Enter, wait ~2 min:
>
> ```
> curl -fsSL https://raw.githubusercontent.com/preet01/spiel/main/install.sh | bash
> ```
>
> Your Mac will say "Spiel is ready" out loud when it's done. Source:
> https://github.com/preet01/spiel
>
> Would love feedback — especially on what would make you switch from whatever you use now.

---

## Reddit — r/LocalLLaMA (angle: local-first AI)

**Title:** Built a Chrome extension that does Speechify-style read-aloud entirely locally (Kokoro-82M + FastAPI on 127.0.0.1)

> Kokoro-82M is good enough now that cloud TTS subscriptions don't make sense
> for read-aloud. Spiel wires it into Chrome: extract article/PDF text on-device
> (Readability / pdf.js), stream sentences to a local Kokoro-FastAPI server, play
> with word-level highlighting from Kokoro's timestamps. MV3 offscreen document
> for audio, prefetch cache so there's no gap between sentences.
>
> 100% local, MIT, no telemetry. Apple Silicon for now (the installer sets up
> uv + Kokoro-FastAPI under ~/.spiel with a LaunchAgent bound to loopback).
>
> **Setup (2 steps, both here):**
>
> 1. Add the extension: https://chromewebstore.google.com/detail/spiel/dkfdbjaghlaldbdleidhkinpekabffij
> 2. Paste this in Terminal, press Enter, wait ~2 min:
>
> ```
> curl -fsSL https://raw.githubusercontent.com/preet01/spiel/main/install.sh | bash
> ```
>
> Code: https://github.com/preet01/spiel

---

## LinkedIn

> I just shipped my first Chrome extension to the Web Store 🎉
>
> Spiel reads any article or PDF aloud with a natural AI voice — and unlike
> every read-aloud tool I could find, it runs 100% on your own machine. Nothing
> you read ever touches a cloud server, and it's free and open source (MIT).
>
> Under the hood: the Kokoro-82M neural TTS model served locally, a Chrome MV3
> extension doing on-device article/PDF extraction, and word-by-word highlighting
> synced to the voice's own timestamps.
>
> Setup is two steps:
> 1. Add the extension — https://chromewebstore.google.com/detail/spiel/dkfdbjaghlaldbdleidhkinpekabffij
> 2. Paste this in Terminal and press Enter: curl -fsSL https://raw.githubusercontent.com/preet01/spiel/main/install.sh | bash
>
> ~2 minutes, and your Mac literally says "Spiel is ready" when it's done.
>
> If you read a lot (or know a student/researcher who does), try it.
> (Mac with Apple Silicon for now.)

---

## Posting order that works

1. **Show HN** first, on a weekday morning US time (Tue–Thu, ~8–10am ET) — it's
   the audience most receptive to "local, open source, read the bash script yourself."
2. Reddit r/macapps + r/LocalLLaMA the same day or next (don't cross-post the
   identical text — the versions above are already angled per subreddit).
3. X + LinkedIn anytime, with a 15–30s screen recording of the highlighting.
4. Later: Product Hunt needs more prep (gallery, tagline, first-comment) — do it
   once a few store reviews exist.

## One more thing before posting

Ask 2–3 friends to install and leave an honest review first — a listing with
zero reviews converts far worse than one with even three.
