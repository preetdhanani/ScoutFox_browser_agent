# ScoutFox AI Browser Agent 🦊

**ScoutFox** is an open-source, production-ready Chrome Extension (Manifest V3) and Python automation runner that empowers local models (Ollama 8B/14B/27B) and cloud APIs (Google Gemini, OpenAI, Claude, Groq, NVIDIA NIM) to autonomously control your web browser.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Chrome-Manifest--V3-brightgreen.svg)](public/manifest.json)

---

## 🌟 Key Features

* 🦊 **ScoutFox UI**: Glassmorphism Side Panel interface built with Vanilla CSS.
* 📋 **Batch Plan Checklist**: Automatically generates high-level execution checklists and checks off sub-goals as it navigates.
* 📜 **Multi-Session History**: Save, restore, and switch between past browser automation runs like ChatGPT / Claude.
* 📡 **Backend Telemetry Console**: Filter step-by-step DOM snapshots, raw LLM outputs, parser results, and network latency (`(842ms)`).
* ⚡ **Persistent Storage Model Caching**: Instant 0ms model dropdown loading on panel open.
* 🦙 **Universal Multi-Provider LLM Support**:
  * **Google Gemini API** (`gemini-2.0-flash`, `gemini-1.5-flash`, `gemini-1.5-pro`)
  * **NVIDIA NIM (`build.nvidia.com`)** (`meta/llama-3.3-70b-instruct`, `deepseek-ai/deepseek-r1`, `nvidia/llama-3.1-nemotron-70b-instruct`)
  * **Ollama (Local Host)** (`qwen2.5:14b`, `llama3.1:8b`, `gemma2:9b`)
  * **Groq Cloud / OpenAI-Compatible** (`llama-3.3-70b-versatile`, `llama-3.1-8b-instant`)
  * **OpenAI Official** (`gpt-4o-mini`, `gpt-4o`)
  * **Anthropic Claude** (`claude-3-5-sonnet-20241022`)
  * **OpenRouter** (`anthropic/claude-3.5-sonnet`, `deepseek/deepseek-r1`, and any other model OpenRouter hosts)
  * **AgentRouter** (`claude-3-5-sonnet`, `gpt-4o`, `deepseek-r1`)
* 🐍 **Standalone Python Playwright Agent**: Run terminal-based Playwright browser automation without registering a Web Store developer account!

---

## 🚀 Quick Setup (Chrome Extension)

You need:
- Node.js 22.18 or newer, to build the extension and run the tests.
- Google Chrome.

1. Clone the repository and build the extension:
   ```bash
   git clone https://github.com/preetdhanani/ScoutFox_browser_agent.git
   cd ScoutFox_browser_agent
   npm ci
   npm run build
   ```
   The build writes the extension into the `dist/` folder.

2. Load unpacked extension in Chrome:
   - Open **`chrome://extensions/`** in Google Chrome.
   - Enable **Developer Mode** (toggle in top-right corner).
   - Click **Load unpacked** and select the **`dist/`** folder, not the repository folder.
   - Chrome ties saved data (settings, API keys, sessions) to the extension's ID, and an unpacked extension's ID comes from its folder.
   - So an extension loaded from `dist/` is a new extension for Chrome, and you enter your settings once again.

3. Start Automating:
   - Open any web page (e.g. `https://google.com` or `https://news.ycombinator.com`).
   - Click the 🦊 ScoutFox icon in your toolbar to open the Side Panel.
   - Select your LLM Provider (e.g. Google Gemini or Ollama Local) and click **Run Task**!

After you change the code:
- Run `npm run build` again.
- Press **Reload** on the ScoutFox card in `chrome://extensions/`.

---

## 🧭 How to Use the Extension

### Give it a task
1. Click the 🦊 icon to open the Side Panel - it opens on the **Agent** tab.
2. Type your goal in the box at the bottom (e.g. *"Find the price of product X and click Add to Cart"*) and hit the **send** button (▶).
3. Clicking the icon opens the panel and nothing else - no tab group, no rearranging your tabs. That happens when you actually give it a task.
4. Clicking the icon on an idle panel starts fresh, unless it has a finished run on screen - a result you haven't read yet is never wiped just because you reopened the panel.

### One session per tab
- Each **tab** gets its own independent session: its own history, its own running task, its own Stop button. Two tabs side by side in the same window can run completely different tasks without noticing each other.
- The panel shows up only on tabs that have a session, so switching to one of your own tabs hides it rather than following you around.
- A session lives as long as its tab. Closing the tab ends it; a background restart mid-task doesn't.

### Watch it work
- ScoutFox automates the tab its panel is attached to - the one you're looking at. If that tab is an empty new-tab page it reuses it in place; if it's a page it can't script and shouldn't navigate away from (settings, the Web Store), it opens a new tab right beside it.
- Once a task starts, the tabs it touches get grouped into an orange **ScoutFox** tab group, so you always know which tabs are sandboxed for automation. A tab you open yourself stays independent and is never pulled in - even when Chrome tries to add it for you.
- The status pill in the header (Idle / Running / Paused) and the progress bar under the input box show what step it's on and out of how many.
- Each action it takes (click, type, scroll, navigate, ...) appears as its own line in the timeline, with its reasoning available if you click the row.

### Stay in control
- **Pause** freezes the run mid-step; **Resume** (the same button) picks it back up from exactly where it left off.
- **Stop Task** ends the run for good.
- If a single LLM call to your provider fails, ScoutFox retries it automatically before giving up - and if it does give up, the task pauses (not dies), so **Resume** continues from the exact step that failed instead of you having to start over.
- If the agent needs to ask you something mid-task, a question box appears right in the timeline - type your answer and hit **Send**, and it continues with that answer.

### Read the result honestly
- A green **"✓ Done"** card means the agent finished and verified the answer against visited page evidence.
- An amber **"⚠ Partial answer"** card means the answer is missing data from one or more planned sites that were not opened.
- A red **"⚠ Unverified answer"** card means the answer cited links, prices, or numbers not observed on visited pages.
- An amber **"⚠ Unconfirmed answer"** card means the model replied in plain text instead of a structured action - the run still ended, but the answer was not explicitly confirmed as final.
- A turn marked **"did not finish"** (no card at all) means it ran out of its step budget or hit an error before completing - it is never silently shown as done.

### Configure it (Settings tab)
- **LLM Provider / Model**: pick from OpenRouter, AgentRouter, Gemini, Ollama, OpenAI, Anthropic, NVIDIA NIM, or Groq, and search/select the exact model.
- **Model Overrides**: configure dedicated Planner Model and Reflect Model overrides for the graph engine.
- **Max Steps** (default 250, up to 1,000), **Delay (ms)**, and **LLM Timeout (ms)**: tune how long a task can run, how long it pauses between actions, and how long it waits for a single LLM reply before retrying (default 120s, or 300s for NVIDIA NIM).
- **Show Floating Element Badges**: toggle the numbered `[1]`, `[2]` overlays ScoutFox draws on page elements it can see.
- **Engine**: configure `settings.engine` (`'graph'` vs `'legacy'`, defaulting to `'graph'`) to choose between the LangGraph orchestrator/worker engine and the legacy execution loop.
- **Default Effort Level**: select from Medium (default), Low, High, XHigh, or Max as the baseline effort.

### Everything else
- **History (top-right)**: browse, reopen, or delete past runs.
- **Logs tab**: filterable, real-time backend telemetry (DOM snapshots, raw LLM output, parser results, timings) - the first place to look if a run misbehaves.

---

## 🦙 Running Local Models with Ollama

To use ScoutFox 100% locally and privately without sending data to cloud APIs:

1. Install [Ollama](https://ollama.com).
2. Pull a recommended model:
   ```bash
   ollama pull qwen2.5:14b
   ```
3. Start Ollama with browser origin access enabled:
   ```bash
   OLLAMA_ORIGINS="*" ollama serve
   ```
   Quit the Ollama menu-bar app first, or port 11434 will be busy.
   If you use the macOS menu-bar app instead, set the variable once and restart the app:
   ```bash
   launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"
   ```
4. In ScoutFox Settings, select **Ollama (Local Host)** and pick `qwen2.5:14b`!

### Troubleshooting: HTTP 403 from Ollama

Ollama rejects requests from `chrome-extension://` origins unless `OLLAMA_ORIGINS` was set when the server started.
Check it with this command (`200` is good, `403` means the variable did not reach the running server):

```bash
curl -s -o /dev/null -w "%{http_code}\n" -H "Origin: chrome-extension://test" http://localhost:11434/api/tags
```

Plain `curl` without the `Origin` header always works, so it cannot detect this problem.
The `launchctl` setting is lost after a reboot, so run it again if the error comes back.

---

## 🟢 Running NVIDIA NIM Hosted Models

To use NVIDIA NIM hosted models with 1,000 free inference credits:
1. Create a free account at `build.nvidia.com`.
2. Generate an API key starting with `nvapi-` (public model catalog listing also works keylessly).
3. In ScoutFox Settings, select **NVIDIA NIM (build.nvidia.com)**.
4. Enter your `nvapi-...` key and click **Save Settings**.
5. Select a hosted model such as `meta/llama-3.3-70b-instruct` or `deepseek-ai/deepseek-r1`.
6. Rate limit is typically 40 requests per minute (RPM) on the free tier.

---

## 🐍 Standalone Terminal Python Runner

No Chrome extension setup needed!
Run ScoutFox directly from your Mac terminal using Playwright:

```bash
cd python_runner
pip install -r requirements.txt
playwright install chromium

# List available models (Ollama, OpenAI, or NVIDIA NIM)
python agent.py --list-models

# Run with local Ollama
python agent.py --goal "Find top 3 trending python repositories on GitHub and summarize them"

# Run with NVIDIA NIM (reads $NVIDIA_API_KEY or pass --api-key)
export NVIDIA_API_KEY="nvapi-..."
python agent.py --provider nvidia --goal "Search for open source browser agents"

# Run with OpenAI (reads $OPENAI_API_KEY or pass --api-key)
export OPENAI_API_KEY="sk-..."
python agent.py --provider openai --goal "Search for open source browser agents"
```

---

## 🗺️ Roadmap

### Next version (planned, decided 2026-09-28)

The next version is a rework of the agent on [LangGraph.js](https://github.com/langchain-ai/langgraphjs).
Phases P0 through P7b are built, including real CDP clicks, visual cursor overlay, long-horizon multi-site graph runtime, risk gating, side panel UI card overhaul, default graph engine switch, xhigh/max effort profiles, and interactive holds.
Everything above in this README describes the extension as it works today.

What will change for you:

* **Approve the plan first (built in phase P6)**: the agent shows its plan and the sites it will visit in an interactive Plan Approval Card.
  You review the targets and effort level, approve it once, and then it runs.
* **Real clicks (built in phase P3)**: while a task runs, the agent clicks through Chrome's debugger, like a real mouse, with animated cursor overlay and click ripples.
  Chrome shows a yellow "is debugging this browser" bar during the task.
  If the debugger cannot attach (for example when DevTools is open), it falls back to synthetic clicks.
* **Better long tasks**: a notebook where the agent saves what it finds, a longer memory of past steps, and an honest checklist.
  A checklist step is marked done only when its goal is really met.
* **Blocked sites are skipped**: if a site shows a challenge or error page again and again, the agent marks it blocked and moves on.
  The result shows what it found and which sources were blocked, instead of retrying forever.
* **Effort levels (updated in phase P7b)**: you pick Auto, Low, Medium, High, XHigh, or Max before a task (Medium is the default).
  Auto selects an effort level from task keywords and target sites.
  You can also set the default effort in Settings, and an active badge shows the current effort during execution.
  A higher level gives each site more steps, more retries and stricter checks, and it takes longer.
  XHigh adds multi-site key field cross-checking and 4x step budgets.
  Max adds full-field cross-checking, interactive bot challenge assistance, budget soft-cap holds, and mid-site reflection.
* **Interactive human assistance (built in phase P7b)**: when encountering bot verification screens or reaching soft budget limits, the agent shows Challenge Help or Continue Budget cards.
  You can solve the captcha directly in the tab and continue, or skip to other sources.
* **Cross-checking and dispute flags (built in phase P7b)**: findings across multiple websites are compared for numerical variance (>20%) and textual consistency.
  Conflicting or deviating findings are marked with dispute notes and downgraded to unverified status.
* **Reflection and replanning**: after each site finishes, the agent can reflect on findings to continue, stop early when goals are met, or replan alternative sites.
* **One worker per site**: every website is handled on its own, with its own step budget.
  The result says which sites are done, partial or blocked.
* **Checks after every action**: the agent checks whether an action changed the page, and it stops loops instead of repeating the same click.
* **Asks before risky actions (built in phases P5d and P6)**: buying, logging in, submitting a form, or leaving the sites you approved trigger an interactive Action Confirmation Card.
  The risk gate evaluates keyword-based heuristics for speed and determinism.
  The agent never types passwords, card numbers or one-time codes.
* **Sources for every number (built in phase P6)**: each value in the Provenance Findings Table links to its page, with verification status and a snippet of the evidence text.
* **Live graph view (built in phase P6)**: the side panel displays a nested live graph breadcrumb strip that shows which step of the graph the agent is in right now.
* **Default graph engine (built in phase P7)**: the LangGraph engine is now the default engine for all new tasks.
  You can switch back to the legacy engine anytime in Settings.
* **Python runner too**: `python_runner/agent.py` also moves to LangGraph (Python).
* **LangSmith tracing**: opt-in in Settings, off by default.
* **Local models keep working**: small local Ollama models stay supported.
* **Architecture rework (built in phases P0-P7b)**: the project now has a Vite build step.
  You run `npm run build` and load the `dist/` folder in Chrome, as in the Quick Setup above.
  The shared core is TypeScript (phase P1).
  Providers use LangChain clients behind the API client surface (phase P2).
  Final answers are audited against visited page evidence before completion.
  Real clicks run through Chrome debugger (CDP) trusted events with visual cursor animation and fallback (phase P3).
  The LangGraph runtime foundation and AgentRunner are the primary engine (phases P4 and P7).
  Long-horizon multi-site orchestration, dynamic scheduling, multi-mode worker policy, budgeting with slack recycling, blocked escalation ladders, loop/stuck detection, effort profiles, and LLM reflection with plan revisions are available in the graph engine (phase P5).
  Deterministic keyword-based risk gating and banned action recovery protect against hazardous executions (phase P5d).
  The side panel UI features interactive Plan Approval, Action Confirmation, Security Challenge Help, Continue Budget, and Provenance Findings cards with Studio Mono styling and live graph breadcrumbs (phases P6 and P7b).
  The legacy engine, content scripts, and side panel core are still plain JavaScript, and they move in later phases.

See [PRD.md](PRD.md) for the details.

---

## 📜 Community & Governance

* **[License](LICENSE)**: MIT License
* **[Code of Conduct](CODE_OF_CONDUCT.md)**: Contributor Covenant v2.1
* **[Contributing Guide](CONTRIBUTING.md)**: How to submit issues and Pull Requests.
