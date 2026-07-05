# Third-party software & credits

Spiel is MIT-licensed, but it stands on the shoulders of these projects:

## Voice engine (installed separately by `install.sh`)

| Project | License | Role |
|---|---|---|
| [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) by @remsky | Apache-2.0 | The local TTS server Spiel talks to |
| [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) by @hexgrad | Apache-2.0 | The neural text-to-speech model |
| [uv](https://github.com/astral-sh/uv) by Astral | MIT / Apache-2.0 | Python environment manager used by the installer |

### Kokoro training-data voice credits (CC BY)

The Kokoro model was trained in part on these openly licensed datasets, credited per their attribution requirements:

- **Koniwa** corpus — [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) — https://github.com/koniwa/koniwa
- **SIWIS** dataset — [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) — https://datashare.ed.ac.uk/handle/10283/2353

## Extension (bundled in `dist/`)

| Project | License | Role |
|---|---|---|
| [@mozilla/readability](https://github.com/mozilla/readability) | Apache-2.0 | Article text extraction |
| [esbuild](https://github.com/evanw/esbuild) | MIT | Build tool (dev dependency, not shipped) |

## Trademark note

Speechify is a trademark of Speechify Inc. Spiel is an independent project, not affiliated with, endorsed by, or connected to Speechify Inc. The comparison in the README exists solely to describe what category of product this is.
