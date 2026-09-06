# ScoutFox AI Browser Agent 🦊

**ScoutFox** is an open-source, production-ready Chrome Extension (Manifest V3) and Python automation runner that empowers local models (Ollama 8B/14B/27B) and cloud APIs (Google Gemini, OpenAI, Claude, Groq) to autonomously control your web browser.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Chrome-Manifest--V3-brightgreen.svg)](manifest.json)

---

## 🌟 Key Features

* 🦊 **ScoutFox UI**: Glassmorphism Side Panel interface built with Vanilla CSS.
* 📋 **Batch Plan Checklist**: Automatically generates high-level execution checklists and checks off sub-goals as it navigates.
* 📜 **Multi-Session History**: Save, restore, and switch between past browser automation runs like ChatGPT / Claude.
* 📡 **Backend Telemetry Console**: Filter step-by-step DOM snapshots, raw LLM outputs, parser results, and network latency (`(842ms)`).
* ⚡ **Persistent Storage Model Caching**: Instant 0ms model dropdown loading on panel open.
* 🦙 **Universal Multi-Provider LLM Support**:
  * **Google Gemini API** (`gemini-2.0-flash`, `gemini-1.5-flash`, `gemini-1.5-pro`)
  * **Ollama (Local Host)** (`qwen2.5:14b`, `llama3.1:8b`, `gemma2:9b`)
  * **Groq Cloud / OpenAI-Compatible** (`llama-3.3-70b-versatile`, `llama-3.1-8b-instant`)
  * **OpenAI Official** (`gpt-4o-mini`, `gpt-4o`)
  * **Anthropic Claude** (`claude-3-5-sonnet-20241022`)
  * **OpenRouter** (`anthropic/claude-3.5-sonnet`, `deepseek/deepseek-r1`, and any other model OpenRouter hosts)
  * **AgentRouter** (`claude-3-5-sonnet`, `gpt-4o`, `deepseek-r1`)
* 🐍 **Standalone Python Playwright Agent**: Run terminal-based Playwright browser automation without registering a Web Store developer account!

---

## 🚀 Quick Setup (Chrome Extension)

1. Clone the repository:
   ```bash
   git clone https://github.com/preetdhanani/ScoutFox_browser_agent.git
   cd ScoutFox_browser_agent
   ```

2. Load unpacked extension in Chrome:
   - Open **`chrome://extensions/`** in Google Chrome.
   - Enable **Developer Mode** (toggle in top-right corner).
   - Click **Load unpacked** and select the repository directory.

3. Start Automating:
   - Open any web page (e.g. `https://google.com` or `https://news.ycombinator.com`).
   - Click the 🦊 ScoutFox icon in your toolbar to open the Side Panel.
   - Select your LLM Provider (e.g. Google Gemini or Ollama Local) and click **Run Task**!

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
4. In ScoutFox Settings, select **Ollama (Local Host)** and pick `qwen2.5:14b`!

---

## 🐍 Standalone Terminal Python Runner

No Chrome extension setup needed! Run ScoutFox directly from your Mac terminal using Playwright:

```bash
cd python_runner
pip install -r requirements.txt
playwright install chromium

# List available models
python agent.py --list-models

# Run automation goal
python agent.py --goal "Find top 3 trending python repositories on GitHub and summarize them"
```

---

## 📜 Community & Governance

* **[License](LICENSE)**: MIT License
* **[Code of Conduct](CODE_OF_CONDUCT.md)**: Contributor Covenant v2.1
* **[Contributing Guide](CONTRIBUTING.md)**: How to submit issues and Pull Requests.
