<<<<<<< HEAD
# ScoutFox_browser_agent
=======
# 🍓 Strawberry AI Agentic Browser (Chrome Extension MVP)

> **Autonomous Web Browsing Agent** optimized for **Local Small LLMs (8B, 9B, 14B, 27B, 32B)** via Ollama / OpenAI-compatible APIs, as well as Cloud LLMs (OpenAI, Claude, Gemini).

---

## 🌟 Key Features

* 🦙 **Optimized for Small Local LLMs**: Built specifically to run on 8B, 9B, 14B, and 27B/32B open-source models (e.g. `qwen2.5:14b`, `llama3.1:8b`, `gemma2:9b`).
* 🏷️ **Indexed DOM Distillation**: Compresses massive web DOM trees into concise, single-token element IDs `[1]`, `[2]`, `[3]` (< 2,500 tokens context usage).
* 🎯 **Visual On-Screen Action Badges**: Displays floating numeric badges over active web elements so you can visually watch the agent target elements in real-time.
* ⚡ **Fault-Tolerant Action Parser**: Automatic JSON codeblock fallback extraction and self-correction loop when 8B/9B models output slightly broken formatting.
* 🔒 **Privacy-First Local Execution**: Zero external telemetry. Direct local execution via `http://localhost:11434` (Ollama) or local vLLM / LM Studio instances.
* 🎨 **Sleek Glassmorphism Side Panel UI**: Modern Chrome SidePanel interface with live timeline feed, provider settings, and DOM debug console.

---

## 🚀 Quick Setup & Installation

### Step 1: Install Extension in Chrome
1. Open Google Chrome and navigate to `chrome://extensions`.
2. Enable **Developer mode** (toggle switch in the top-right corner).
3. Click **Load unpacked**.
4. Select the project directory: `/Users/pritdhanani/Study/projects/agent browser`.
5. The 🍓 **Strawberry AI Agent** icon will appear in your Chrome toolbar!

---

### Step 2: Configure Ollama for Local Models (Recommended)

1. **Install & Pull Model**:
   ```bash
   ollama pull qwen2.5:14b
   # or
   ollama pull llama3.1:8b
   ```

2. **Configure Ollama CORS (Required for Web Extension API access)**:
   - **macOS**:
     ```bash
     OLLAMA_ORIGINS="*" ollama serve
     ```
   - **Linux / Windows**: Set environment variable `OLLAMA_ORIGINS="*"` in your system settings before running `ollama serve`.

3. **In Strawberry Extension Settings**:
   - Open Chrome Side Panel (click 🍓 icon in extension toolbar).
   - Click **Settings** tab.
   - Click the **🦙 Ollama Local** preset button (or set Provider to `Ollama`, Base URL to `http://localhost:11434`, and Model to `qwen2.5:14b`).
   - Click **Save Settings**.

---

### Step 3: Using Cloud or OpenAI-Compatible APIs

Strawberry also supports high-speed cloud providers and custom self-hosted endpoints:

| Provider | Base URL | Model Example |
| :--- | :--- | :--- |
| **Ollama** | `http://localhost:11434` | `qwen2.5:14b`, `llama3.1:8b` |
| **Groq / Llama API** | `https://api.groq.com/openai` | `llama-3.1-70b-versatile` |
| **LM Studio / vLLM** | `http://localhost:1234` | `local-model` |
| **OpenAI** | `https://api.openai.com` | `gpt-4o-mini`, `gpt-4o` |
| **Anthropic** | `https://api.anthropic.com` | `claude-3-5-sonnet-20241022` |
| **Google Gemini** | `https://generativelanguage.googleapis.com` | `gemini-1.5-flash` |

---

## 💡 How to Use Strawberry Agent

1. Open any webpage in Chrome (e.g. `https://google.com` or `https://news.ycombinator.com`).
2. Open the **Strawberry AI SidePanel** (click the extension icon in top right).
3. Enter your task in the input box:
   - *"Search for best open source AI browser agents on GitHub"*
   - *"Find the top 3 headlines on Hacker News and summarize them"*
   - *"Navigate to Amazon and check the price of wireless mouse"*
4. Click **Run Task** (or press `Enter`).
5. Watch Strawberry index elements, display visual badges `[1]`, `[2]`, and execute actions step-by-step in real-time!

---

## 📁 Codebase Architecture

```text
agent browser/
├── manifest.json            # Chrome Extension Manifest V3
├── PRD.md                   # Product Requirement Document
├── icons/                   # High-res extension icons (16, 48, 128px)
├── utils/
│   ├── storage.js           # Chrome storage manager & defaults
│   └── logger.js            # Structured console logging
├── content/
│   ├── domCompressor.js     # DOM distiller & element tagger [1], [2]
│   ├── actionExecutor.js    # Element click/type/scroll & badge renderer
│   └── content.js           # Content script message router
├── background/
│   ├── apiClients.js        # Universal REST client (Ollama, OpenAI, Claude, Gemini)
│   ├── agentEngine.js       # Agent execution loop, prompt generator, action parser
│   └── background.js        # Service worker entry point
└── sidepanel/
    ├── sidepanel.html       # UI layout (Chat, Settings, Logs)
    ├── sidepanel.css        # Glassmorphism dark void theme
    └── sidepanel.js         # Sidepanel UI controller script
```

---

## 📄 License
MIT License. Created for local AI browser automation.
>>>>>>> d5aca47 (Initial commit: ScoutFox AI Browser Agent Extension with Multi-Provider Support, Live Planner, Session History, and Custom Telemetry Logs)
