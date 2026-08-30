# Product Requirement Document (PRD)
## Strawberry AI Agentic Browser (Chrome Extension MVP)

> **Version**: 1.0.0  
> **Status**: Approved / Draft  
> **Target Audience**: Privacy-First Power Users, Developers, & Local AI Enthusiasts (Ollama / Open-Source 8B-32B LLMs)

---

## 1. Executive Summary & Niche Definition

### 1.1 The Niche & Problem Statement
Existing browser automation agents (like MultiON, Browser-Use, Stagehand) are predominantly built for massive cloud frontier models (GPT-4o, Claude 3.5 Sonnet). When users attempt to run these agents with small, locally-hosted models (such as **Llama 3.1 8B**, **Qwen 2.5 14B/32B**, or **Gemma 2 9B** via Ollama/vLLM), the agents fail due to:
1. **DOM Bloat & Token Overflow**: Raw HTML pages contain 100k+ tokens of scripts, SVGs, and hidden containers, overwhelming 8k-32k context windows.
2. **Strict Schema Fragility**: Small models struggle with strict multi-nested JSON function calling schemas.
3. **Privacy & Cost Concerns**: Users want local, offline web automation without sending sensitive session cookies or DOM content to remote cloud servers.

### 1.2 The Value Proposition
**Strawberry Agentic Browser** is a lightweight, privacy-first Manifest V3 Chrome Extension engineered specifically to run reliably on **local small models (8B–32B)** as well as low-cost cloud endpoints. 

By utilizing an **Indexed DOM Distillation Engine**, **Visual On-Screen Action Badges**, and a **Fault-Tolerant Action Loop**, Strawberry enables small local models to browse, search, extract data, click, fill forms, and automate complex web tasks directly within Chrome.

---

## 2. Product Architecture & System Component Design

### Core Components
1. **DOM Distiller & Indexer (`content/domCompressor.js`)**: Traverses visible DOM, identifies interactive elements (`a`, `button`, `input`, `select`), tags them with single-token numeric IDs `[1]`, `[2]`, `[3]`, and outputs a clean, lightweight text snapshot (< 2,500 tokens).
2. **Visual Action Overlay (`content/actionExecutor.js`)**: Injects floating numeric badges on page elements so users see target elements in real-time.
3. **Multi-Provider API Client (`background/apiClients.js`)**: Universal REST client supporting Ollama (`http://localhost:11434`), OpenAI-compatible endpoints (Groq, LM Studio, vLLM, Llama API), OpenAI, Anthropic Claude, and Google Gemini.
4. **Fault-Tolerant Action Loop (`background/agentEngine.js`)**: Self-correcting execution loop with JSON fallback parser and error recovery for 8B-32B small models.
5. **Glassmorphism SidePanel UI (`sidepanel/`)**: Chrome Side Panel interface with Chat timeline, Provider settings, and live DOM debug console.
