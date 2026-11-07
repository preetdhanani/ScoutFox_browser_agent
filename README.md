# ScoutFox: Autonomous Browser Runtime for Local and Cloud AI

ScoutFox is an open-source autonomous browser agent implemented as a Chrome Manifest V3 extension.
It executes complex, multi-step web workflows by operating inside Google Chrome's native Side Panel.
Unlike cloud-hosted headless browser wrappers, ScoutFox runs directly inside the user's authentic browser context, executing actions via Chrome DevTools Protocol (CDP) trusted hardware events, extracting semantic accessibility trees, and grounding model assertions against an independent evidence ledger.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Runtime](https://img.shields.io/badge/Node.js-%3E%3D22.18-brightgreen.svg)](package.json)
[![Platform](https://img.shields.io/badge/Chrome-Manifest%20V3-orange.svg)](public/manifest.json)
[![Security Check](https://img.shields.io/badge/CSP-Zero%20Eval%20Enforced-blueviolet.svg)](scripts/evalscan.mjs)

---

## Architectural Highlights

### 1. Dual Input Dispatch Engine (Hardware CDP + Fallback)
ScoutFox routes input events through `chrome.debugger` to produce real OS-level dispatch sequences rather than fragile JavaScript synthetic clicks.
- **Trusted Events:** Emits genuine `Input.dispatchMouseEvent` (hover, mouse-down, mouse-up, click) and `Input.dispatchKeyEvent` sequences.
- **Bot Trap Resilience:** Defeats anti-automation barriers that reject `isTrusted: false` synthetic events.
- **Selective Fallback:** Falls back to safe DOM dispatch on restricted internal schemes (`chrome://`) or native `<select>` dropdown controls.
- **Focus Emulation:** Emulates tab window focus state across background tasks, preventing pages from throttling inactive tabs.

### 2. Viewport-Ordered Perception Pipeline
Passing raw HTML or massive DOM trees to LLMs quickly saturates prompt budgets and pollutes context.
- **Semantic Compression (`DOMCompressor`):** Extracts an accessibility-oriented snapshot ordered by visual viewport coordinates.
- **Stable References:** Generates ephemeral integer reference IDs for interactive controls (`[12]`) that survive DOM reflows.
- **Deterministic Off-Screen Matching (`find_element`):** Employs weighted heuristic scoring across text, ARIA attributes, placeholders, names, and roles to resolve targets located beyond the active scroll window.
- **Embedded Frame Agent (`frameAgent`):** Injects dedicated frame agents across nested cross-origin iframes, computing absolute coordinate offsets and boundary masks.

### 3. Provenance Evidence Ledger and Anti-Hallucination Gate
Most LLM agents blindly report their final answer without auditing whether their outputs correspond to facts on the visited pages.
- **Independent Evidence Ledger:** Tracks every URL visited, full text segments extracted, and research documents fetched throughout the session.
- **Pre-Finish Audit Gate:** Mechanically audits the model's generated answer before showing completion to the user.
- **Policy Enforcement:** Enforces `send_back` (instructs model to self-correct missing facts), `annotate` (flags ungrounded claims), or `replace` (prevents hallucinated success cards).

### 4. Heterogeneous Vision Coordinate Reconciliation
Different visual frontier models disagree on coordinate spaces.
Claude and GPT emit absolute pixel coordinates, while Nemotron, Qwen-VL, and Gemini emit normalized 0-1000 per-mille or 0-1 fractional values.
- **Dynamic Tool Schema Rewriting:** Rewrites tool definitions per active provider (`clickToolFor`).
- **Coordinate Space Normalizer:** Detects the model's coordinate convention and applies scale normalization into physical hardware device pixels.
- **Sub-pixel Snapping:** Corrects near-miss clicks within bounding box tolerances before dispatch.

### 5. KV-Cache-Friendly Memory and Compaction
Context exhaustion is managed with architectural awareness of LLM provider prefix caching.
- **Staggered Block Compaction:** Compaction triggers in fixed historical blocks, preserving stable prompt prefixes to maintain provider KV-cache hits.
- **Image Budget Pruning:** Retains only the most recent visual screenshots, dropping historical picture buffers from model payloads.
- **Untrusted Content Envelopes:** Wraps all extracted web content and external search outputs inside strict untrusted demarcation blocks to mitigate indirect prompt injection attacks.

### 6. Blink-Style Quadratic HTML Protection (`parse5`)
During background research, untrusted external pages can attempt denial-of-service via adversarial tag nesting.
- **Linear Depth Capping:** Flattens HTML nesting exceeding 512 levels using a linear tokenizer pre-pass.
- **Fast WHATWG Compliance:** Guarantees standard WHATWG compliance without leaking attributes or Stimulus/React metadata into model context.

---

## Core Execution Loop

ScoutFox operates an explicit perception-action loop driven by the Model Context Protocol (MCP):

```
       ┌───────────────────────────────┐
       │   1. Observe Current State    │
       │  (DOMCompressor + FrameAgent) │
       └──────────────┬────────────────┘
                      ▼
       ┌───────────────────────────────┐
       │  2. Reason & Tool Selection   │
       │  (LLM Provider + Context Ring)│
       └──────────────┬────────────────┘
                      ▼
       ┌───────────────────────────────┐
       │  3. Execute via Trusted Path  │
       │    (CDP Hardware Dispatch)    │
       └──────────────┬────────────────┘
                      ▼
       ┌───────────────────────────────┐
       │  4. Probe Effect & Log Record │
       │   (Provenance Evidence Ledger)│
       └──────────────┬────────────────┘
                      ▼
       ┌───────────────────────────────┐
       │   5. Audit & Validate Finish  │
       │    (Mechanical Grounding Gate)│
       └───────────────────────────────┘
```

---

## Real-World Workflows

### Autonomous Multi-Site Sourcing
- Dispatches web research via DuckDuckGo or self-hosted SearXNG instances.
- Paginates large web documents cleanly through background workers without navigating the user's primary tab.
- Reconciles conflicting information across tabs into structured, typed markdown tables.

### Deep Application Workflows
- Interacts with single-page applications, custom design systems, shadow DOMs, and nested frame architectures.
- Performs multi-step form completion, table sorting, keyboard navigation, and file preview extraction.

### Resumable Long-Horizon Tasks
- Saves task states and session snapshots incrementally in local extension storage.
- Allows users to pause, inspect DOM steps, manually resolve ambiguous authentication challenges, and resume task execution seamlessly.

---

## Supported Model Infrastructure

ScoutFox supports any OpenAI-compatible API format, as well as native SDK integrations:

| Provider | Runtime Mode | Recommended Models |
| --- | --- | --- |
| **Ollama** | Local / Offline | `qwen3.8:27b-mlx`, `gemma4:12b`, `llama3.3:70b` |
| **Google Gemini** | Cloud API | `gemini-2.0-flash`, `gemini-1.5-pro` |
| **Anthropic** | Cloud API | `claude-3-7-sonnet`, `claude-3-5-sonnet` |
| **OpenAI** | Cloud API | `gpt-4o`, `o3-mini` |
| **NVIDIA NIM** | Enterprise / Cloud | `nvidia/nemotron-3.5-super-vl-120b-a12b` |
| **Groq** | Low-Latency Cloud | `llama-3.3-70b-versatile` |
| **OpenRouter / AgentRouter** | Multi-Provider Gateway | Dynamic model routing |
| **Custom Endpoints** | Local or Hosted | Self-hosted vLLM, SGLang, LISA, or custom proxies |

---

## Installation & Development Setup

### Requirements
- Google Chrome (or modern Chromium equivalent).
- Node.js 22.18 or higher.
- npm.

### Quickstart

1. **Clone the repository:**
   ```bash
   git clone https://github.com/preetdhanani/ScoutFox_browser_agent.git
   cd ScoutFox_browser_agent
   ```

2. **Install dependencies:**
   ```bash
   npm ci
   ```

3. **Build the extension:**
   ```bash
   npm run build
   ```

4. **Load into Google Chrome:**
   - Open Chrome and navigate to `chrome://extensions`.
   - Toggle **Developer mode** in the top right.
   - Click **Load unpacked**.
   - Select the `dist/` directory generated by the build.

5. **Open Side Panel:**
   - Click the ScoutFox icon in Chrome's toolbar to launch the Side Panel.
   - Open **Settings**, configure your desired LLM endpoint, and begin.

---

## Security Model

- **Zero Remote Code Execution:** Built strictly under Chrome MV3 CSP.
- **Visual Credential Protection:** Password, cardholder, and verification fields are visually shielded with non-mutating overlay masks before any screenshot leaves the browser.
- **Prompt Injection Defense:** External page content is demarcated within structured untrusted boundary tags.
- **No CAPTCHA Tampering:** Refuses automated bot bypasses, pausing execution for human intervention.
- **Device-Local Data Ownership:** Session histories, token logs, and API credentials are kept strictly inside local browser storage.

---

## Contributing

We welcome contributions from systems engineers, browser automation specialists, and AI researchers.
Please review:
- [CONTRIBUTING.md](CONTRIBUTING.md) for code submission standards.
- [DEVELOPMENT.md](DEVELOPMENT.md) for complete architecture, debugging, and bundle analysis guidelines.
- [AGENTS.md](AGENTS.md) for verification and testing requirements.

---

## License

ScoutFox AI Browser Agent is open-source software licensed under the [MIT License](LICENSE).
