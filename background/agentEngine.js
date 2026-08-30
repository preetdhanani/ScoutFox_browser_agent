/**
 * AgentEngine for ScoutFox AI Agent
 * Orchestrates dynamic task-tailored plan generation, real action-driven checklist progress tracking,
 * tab completion waiting, page text body extraction module, resilient service worker state restoration,
 * Few-Shot System Prompting, and Universal Model Guardrails.
 */

import { ApiClients } from './apiClients.js';
import { Storage } from '../utils/storage.js';
import { Logger } from '../utils/logger.js';

export class AgentEngine {
  constructor() {
    this.status = 'idle'; // 'idle' | 'running' | 'paused' | 'stopped'
    this.currentTask = null;
    this.history = [];
    this.planSteps = [];
    this.stepCount = 0;
    this.activeTabId = null;
    this.currentPhase = '';
    this.isLoopActive = false;
    this.onStateChangeCallback = null;
    this.stateVersion = 0;
    this.recentActionSignatures = [];
    this.currentPlanIndex = 0;
    
    this.restoreState();
  }

  async restoreState() {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(['agent_session'], (res) => {
          if (res && res.agent_session) {
            this.history = res.agent_session.history || [];
            this.planSteps = res.agent_session.planSteps || [];
            this.currentTask = res.agent_session.task || null;
            this.stepCount = res.agent_session.stepCount || 0;
            this.currentPlanIndex = res.agent_session.currentPlanIndex || 0;
            
            if (res.agent_session.status === 'running' && !this.isLoopActive) {
              Logger.info('AgentEngine', '[STATE_RESTORE] Service worker restarted. Resetting zombie running state to idle.');
              this.status = 'idle';
              this.currentPhase = '';
            } else {
              this.status = res.agent_session.status || 'idle';
            }
            
            this.notifyStateChange();
          }
        });
      }
    } catch (e) {
      Logger.warn('AgentEngine', 'Could not restore state', e);
    }
  }

  async persistState() {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({
          agent_session: {
            history: this.history,
            planSteps: this.planSteps,
            task: this.currentTask,
            stepCount: this.stepCount,
            status: this.status,
            currentPlanIndex: this.currentPlanIndex
          }
        });
      }
    } catch (e) {
      Logger.warn('AgentEngine', 'Could not persist state', e);
    }
  }

  clearHistory() {
    this.history = [];
    this.planSteps = [];
    this.stepCount = 0;
    this.currentPlanIndex = 0;
    this.currentTask = null;
    this.notifyStateChange();
    Logger.info('AgentEngine', '[CLEAR_HISTORY] Task history and plan cleared.');
  }

  setStateChangeCallback(cb) {
    this.onStateChangeCallback = cb;
  }

  notifyStateChange(extraData = {}) {
    this.stateVersion++;
    this.persistState();
    if (this.onStateChangeCallback) {
      try {
        this.onStateChangeCallback({
          status: this.status,
          stepCount: this.stepCount,
          task: this.currentTask,
          history: this.history,
          planSteps: this.planSteps,
          currentPhase: this.currentPhase,
          logs: Logger.getLogsHistory(),
          stateVersion: this.stateVersion,
          ...extraData
        });
      } catch (err) {
        console.error('[AgentEngine] notifyStateChange callback threw', err);
      }
    }
  }

  setPhase(phaseText) {
    this.currentPhase = phaseText;
    this.notifyStateChange();
  }

  async startTask(userPrompt, tabId) {
    if (!userPrompt || !userPrompt.trim()) return;

    this.status = 'running';
    this.currentTask = userPrompt.trim();
    this.history = [];
    this.recentActionSignatures = [];
    this.stepCount = 0;
    this.currentPlanIndex = 0;
    this.activeTabId = tabId;
    this.isLoopActive = true;

    this.history.push({
      type: 'user_goal',
      prompt: userPrompt,
      timestamp: new Date().toLocaleTimeString()
    });

    const settings = await Storage.getSettings();

    this.setPhase('📋 Generating dynamic execution plan checklist...');
    await this.generatePlan(userPrompt, settings);

    this.notifyStateChange();
    await this.runLoop();
  }

  async generatePlan(userPrompt, settings) {
    const planPrompt = `Task: "${userPrompt}"
Generate a concise 3-4 step execution plan tailored specifically for this web browsing task.
Output ONLY a raw JSON array of short action strings.

Example for task "Summarize README for scout":
["Identify target project repository", "Access README file in repository", "Extract key documentation text", "Synthesize concise summary"]`;

    try {
      const resp = await ApiClients.generateCompletion(settings, [{ role: 'user', content: planPrompt }], 'You are a web task planner.');
      
      let planArray = [];
      const match = resp.match(/\[[\s\S]*\]/);
      if (match) {
        planArray = JSON.parse(match[0]);
      }

      if (Array.isArray(planArray) && planArray.length > 0) {
        this.planSteps = planArray.map((text, idx) => ({
          id: idx + 1,
          text: String(text).replace(/^Step \d+:?/i, '').trim(),
          status: idx === 0 ? 'in_progress' : 'pending'
        }));
        Logger.info('AgentEngine', `[PLANNER_DYNAMIC] Generated dynamic plan checklist with ${this.planSteps.length} sub-goals`, this.planSteps);
      } else {
        throw new Error('Could not parse plan array');
      }
    } catch (err) {
      Logger.warn('AgentEngine', '[PLANNER_FALLBACK] Using dynamic fallback checklist for task', err.message);
      this.planSteps = [
        { id: 1, text: `Analyze page state for "${this.currentTask}"`, status: 'in_progress' },
        { id: 2, text: 'Execute targeted web actions & navigate', status: 'pending' },
        { id: 3, text: 'Extract relevant information & synthesize answer', status: 'pending' }
      ];
    }
  }

  updatePlanProgress(lastActionObj = null, isFinished = false) {
    if (!this.planSteps || this.planSteps.length === 0) return;

    if (isFinished) {
      this.planSteps.forEach(step => step.status = 'completed');
      this.currentPlanIndex = this.planSteps.length;
      this.notifyStateChange();
      return;
    }

    if (lastActionObj) {
      const totalSteps = this.planSteps.length;
      if (this.currentPlanIndex < totalSteps - 1) {
        if (lastActionObj.action === 'navigate' || lastActionObj.action === 'type' || (lastActionObj.action === 'click' && this.stepCount > 2)) {
          this.currentPlanIndex = Math.min(totalSteps - 1, this.currentPlanIndex + 1);
        }
      }
    }

    this.planSteps.forEach((step, idx) => {
      if (idx < this.currentPlanIndex) {
        step.status = 'completed';
      } else if (idx === this.currentPlanIndex) {
        step.status = 'in_progress';
      } else {
        step.status = 'pending';
      }
    });

    this.notifyStateChange();
  }

  pause() {
    if (this.status === 'running') {
      this.status = 'paused';
      this.setPhase('Task paused by user');
      Logger.info('AgentEngine', '[PAUSED] Task paused by user.');
    }
  }

  resume() {
    if (this.status === 'paused') {
      this.status = 'running';
      this.setPhase('Resuming task...');
      Logger.info('AgentEngine', '[RESUMED] Task resumed by user.');
      this.runLoop().catch((err) => {
        Logger.error('AgentEngine', '[RESUME_ERROR] Uncaught exception resuming loop', err);
      });
    }
  }

  stop() {
    this.status = 'stopped';
    this.isLoopActive = false;
    this.currentPhase = '';
    Logger.info('AgentEngine', '[STOPPED] Task stopped by user.');
    this.notifyStateChange({ message: 'Task stopped.' });
  }

  async runLoop() {
    try {
      await this.runLoopBody();
    } catch (err) {
      Logger.error('AgentEngine', '[LOOP_ERROR] Unhandled exception in execution loop', err);
      this.history.push({
        type: 'error',
        content: `Execution Error: ${err.message}`
      });
      this.notifyStateChange({ error: err.message });
    } finally {
      this.isLoopActive = false;
      if (this.status === 'running') {
        Logger.warn('AgentEngine', '[LOOP_SAFETY_NET] Loop exited while still marked running — forcing status to idle.');
        this.status = 'idle';
        this.currentPhase = '';
        this.notifyStateChange();
      }
    }
  }

  async runLoopBody() {
    const settings = await Storage.getSettings();
    const maxSteps = settings.maxSteps || 25;
    this.isLoopActive = true;

    while (this.status === 'running' && this.stepCount < maxSteps) {
      this.stepCount++;
      Logger.info('AgentEngine', `---------------- STEP ${this.stepCount}/${maxSteps} ----------------`);

      // 1. DOM Extraction Input
      this.setPhase(`🌐 Step ${this.stepCount}/${maxSteps}: Reading webpage elements & text body...`);

      let domSnapshot;
      try {
        domSnapshot = await this.getTabDOMWithAutoInject(this.activeTabId, settings.showElementBadges);
        Logger.info('AgentEngine', `[DOM_SNAPSHOT_INPUT] Title: "${domSnapshot.title}" | URL: ${domSnapshot.url} | Elements: ${domSnapshot.elementCount} | PageTextLen: ${domSnapshot.pageText ? domSnapshot.pageText.length : 0}`);
      } catch (err) {
        Logger.error('AgentEngine', '[DOM_ERROR] Failed to read page state', err);
        this.history.push({
          step: this.stepCount,
          type: 'error',
          content: `${err.message}`
        });
        this.status = 'idle';
        this.isLoopActive = false;
        this.currentPhase = '';
        this.notifyStateChange({ error: err.message });
        break;
      }

      const systemPrompt = this.buildSystemPrompt(settings.systemInstructions);
      let userMessage = this.buildStepMessage(domSnapshot);

      // Universal Guardrail: Anti-Stuck Loop Detection
      if (this.recentActionSignatures.length >= 2) {
        const last1 = this.recentActionSignatures[this.recentActionSignatures.length - 1];
        const last2 = this.recentActionSignatures[this.recentActionSignatures.length - 2];
        if (last1 === last2 && !last1.includes('finish') && !last1.includes('scroll')) {
          userMessage += `\n\n[ANTI-STUCK GUARDRAIL WARNING]: You executed the exact same action ("${last1}") twice in a row. If the page did not update, DO NOT repeat it again. Choose a different element, type a new query, or scroll down.`;
          Logger.warn('AgentEngine', `[GUARDRAIL_LOOP_DETECTED] Injected anti-stuck warning into prompt for repeating action: ${last1}`);
        }
      }

      this.history.push({
        step: this.stepCount,
        type: 'step_start',
        url: domSnapshot.url,
        pageTitle: domSnapshot.title,
        elementCount: domSnapshot.elementCount
      });

      this.notifyStateChange();

      // 2. LLM Call Input & Output
      const providerName = settings.provider === 'ollama' ? `Ollama (${settings.model})` : settings.model;
      this.setPhase(`🧠 Step ${this.stepCount}/${maxSteps}: Thinking via [${providerName}]...`);

      let responseText = '';
      try {
        const messages = this.formatMessagesForLLM(userMessage);
        responseText = await ApiClients.generateCompletion(settings, messages, systemPrompt);
        Logger.info('AgentEngine', `[LLM_RAW_OUTPUT]\n${responseText}`);
      } catch (err) {
        Logger.error('AgentEngine', '[LLM_API_ERROR] Connection failure', err);
        this.history.push({
          step: this.stepCount,
          type: 'error',
          content: `LLM Connection Error (${settings.provider}): ${err.message}`
        });
        this.status = 'idle';
        this.isLoopActive = false;
        this.currentPhase = '';
        this.notifyStateChange({ error: err.message });
        return;
      }

      // 3. Action Parsing with Universal Guardrails
      this.setPhase(`🔍 Step ${this.stepCount}/${maxSteps}: Parsing action...`);
      const actionResult = this.parseResponse(responseText, domSnapshot.elementCount);

      this.history.push({
        step: this.stepCount,
        type: 'agent_response',
        thought: actionResult.thought || '',
        action: actionResult.action || null,
        rawResponse: responseText
      });

      if (actionResult.error) {
        Logger.warn('AgentEngine', `[PARSE_ERROR] Step ${this.stepCount} parsing failed`, actionResult.error);
        this.history.push({
          step: this.stepCount,
          type: 'execution_result',
          success: false,
          error: actionResult.error
        });
        this.notifyStateChange();
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }

      const actionObj = actionResult.action;
      
      const signature = `${actionObj.action}_${actionObj.element_id || ''}_${actionObj.text || ''}_${actionObj.url || ''}`;
      this.recentActionSignatures.push(signature);
      if (this.recentActionSignatures.length > 5) this.recentActionSignatures.shift();

      Logger.info('AgentEngine', `[ACTION_DISPATCH] Executing [${actionObj.action}]`, actionObj);

      if (actionObj.action === 'finish') {
        this.status = 'idle';
        this.isLoopActive = false;
        this.currentPhase = '';
        this.updatePlanProgress(null, true);
        this.history.push({
          type: 'finish',
          answer: actionObj.answer || 'Task completed successfully.'
        });
        Logger.info('AgentEngine', '[TASK_FINISHED] Task completed successfully.');
        this.notifyStateChange();
        break;
      }

      if (actionObj.action === 'ask_user') {
        this.status = 'paused';
        this.setPhase('Waiting for user input');
        Logger.info('AgentEngine', '[ASK_USER] Waiting for user input.');
        this.notifyStateChange({ question: actionObj.question });
        break;
      }

      // 4. Action Execution on Web Page
      this.setPhase(`⚡ Step ${this.stepCount}/${maxSteps}: Executing ${formatActionSummary(actionObj)}...`);
      
      try {
        const execResult = await this.executeActionOnTab(this.activeTabId, actionObj);
        Logger.info('AgentEngine', `[ACTION_RESULT] ${execResult.success ? 'Success' : 'Failed'}: ${execResult.message || execResult.error}`);

        this.history.push({
          step: this.stepCount,
          type: 'execution_result',
          success: execResult.success !== false,
          message: execResult.message,
          error: execResult.error
        });

        if (execResult.success !== false) {
          this.updatePlanProgress(actionObj, false);
        }

        if (actionObj.action === 'click' || actionObj.action === 'navigate' || (actionObj.action === 'type' && actionObj.submit)) {
          await this.waitForTabComplete(this.activeTabId, 4000);
        }

        const delay = settings.actionDelayMs || 1000;
        await new Promise(r => setTimeout(r, delay));
      } catch (execErr) {
        Logger.error('AgentEngine', '[ACTION_EXECUTION_ERROR] Action execution failed', execErr);
        this.history.push({
          step: this.stepCount,
          type: 'execution_result',
          success: false,
          error: execErr.message
        });
      }

      this.notifyStateChange();
    }

    if (this.stepCount >= maxSteps && this.status === 'running') {
      this.status = 'idle';
      this.isLoopActive = false;
      this.currentPhase = '';
      this.history.push({
        type: 'finish',
        answer: `Reached maximum allowed steps (${maxSteps}) without completing task.`
      });
      this.notifyStateChange();
    }
  }

  /**
   * Helper to wait for browser tab loading to complete following navigation/clicks
   */
  waitForTabComplete(tabId, timeoutMs = 4000) {
    return new Promise((resolve) => {
      let resolved = false;

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.onUpdated && chrome.tabs.onUpdated.hasListener(listener)) {
            chrome.tabs.onUpdated.removeListener(listener);
          }
          resolve();
        }
      }, timeoutMs);

      const listener = (updatedTabId, changeInfo) => {
        if (updatedTabId === tabId && changeInfo.status === 'complete') {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.onUpdated) {
              chrome.tabs.onUpdated.removeListener(listener);
            }
            resolve();
          }
        }
      };

      if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.onUpdated) {
        chrome.tabs.onUpdated.addListener(listener);
      } else {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  async getTabDOMWithAutoInject(tabId, showBadges = true) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab) throw new Error('No active browser tab detected');

    try {
      const responseData = await this.sendTabMessage(tabId, { action: 'GET_DOM_SNAPSHOT', payload: { showBadges } });
      return responseData;
    } catch (err) {
      Logger.info('AgentEngine', `Content script not active on tab [${tabId}]. Injecting script dependencies...`);
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: [
            'content/domCompressor.js',
            'content/actionExecutor.js',
            'content/content.js'
          ]
        });

        await new Promise(r => setTimeout(r, 400));
        return await this.sendTabMessage(tabId, { action: 'GET_DOM_SNAPSHOT', payload: { showBadges } });
      } catch (injectErr) {
        Logger.error('AgentEngine', 'Script injection failed on tab', injectErr);
        throw new Error(`Could not connect to tab (${tab.url}). Please refresh the web page tab once (press Cmd+R or F5) and try again.`);
      }
    }
  }

  sendTabMessage(tabId, msg) {
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, msg, (response) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        if (response && response.success) {
          resolve(response.data);
        } else {
          reject(new Error(response?.error || 'Failed to communicate with page script'));
        }
      });
    });
  }

  async executeActionOnTab(tabId, actionPayload) {
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, { action: 'EXECUTE_ACTION', payload: actionPayload }, (response) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        resolve(response || { success: true });
      });
    });
  }

  formatMessagesForLLM(latestUserMsg) {
    const messages = [];

    messages.push({
      role: 'user',
      content: `Goal: ${this.currentTask}`
    });

    const recentHistory = this.history.slice(-8);
    recentHistory.forEach(item => {
      if (item.type === 'agent_response') {
        messages.push({ role: 'assistant', content: item.rawResponse });
      } else if (item.type === 'execution_result') {
        messages.push({
          role: 'user',
          content: item.success
            ? `Action Executed Successfully: ${item.message}`
            : `Action Failed: ${item.error}. Choose a different element or action.`
        });
      }
    });

    messages.push({ role: 'user', content: latestUserMsg });

    return messages;
  }

  buildSystemPrompt(customInstructions) {
    return `${customInstructions || 'You are ScoutFox, an autonomous web browsing AI agent.'}

You are provided with a user goal, visible webpage text content, and a compressed list of interactive web page elements labeled with numerical IDs like [1], [2], [3].

Your objective is to choose the single best action to move closer to the goal.

### Critical Rule for Summarization & Reading Tasks:
- Read the "Webpage Visible Text Content". If the required information to answer or summarize the user's task is visible, do NOT scroll or navigate in circles! Output your final answer immediately using:
  {"action": "finish", "answer": "<your_summary_here>", "reason": "Target information is already visible"}

### Available Actions:
1. Click element:
   {"action": "click", "element_id": <number>, "reason": "<explanation>"}

2. Type into input/textarea:
   {"action": "type", "element_id": <number>, "text": "<text_to_type>", "submit": <true/false>, "reason": "<explanation>"}

3. Scroll page:
   {"action": "scroll", "direction": "down"|"up", "amount": 500, "reason": "<explanation>"}

4. Direct navigate to URL:
   {"action": "navigate", "url": "<https://...>", "reason": "<explanation>"}

5. Go back / forward:
   {"action": "go_back", "reason": "<explanation>"}

6. Explicitly extract full readable page text body:
   {"action": "read_page_text", "reason": "<explanation>"}

7. Task finished (Output final summary answer):
   {"action": "finish", "answer": "<final_answer_text>", "reason": "<explanation>"}

8. Ask user for input/help:
   {"action": "ask_user", "question": "<question_text>", "reason": "<explanation>"}

### FEW-SHOT OUTPUT EXAMPLES (Always follow these exact output patterns):

--- Example 1: Typing into a Search Bar ---
<thought>
Element [1] is the search input field. I will type the search query into element [1] and submit the form.
</thought>
\`\`\`json
{
  "action": "type",
  "element_id": 1,
  "text": "open source browser agents",
  "submit": true,
  "reason": "Enter search query into search box"
}
\`\`\`

--- Example 2: Clicking a Button or Link ---
<thought>
Element [4] is the main repository link relevant to the user's task. I will click element [4].
</thought>
\`\`\`json
{
  "action": "click",
  "element_id": 4,
  "reason": "Click target repository link"
}
\`\`\`

--- Example 3: Scrolling Down to Reveal Content ---
<thought>
The required information is further down the page. I need to scroll down to view more content.
</thought>
\`\`\`json
{
  "action": "scroll",
  "direction": "down",
  "amount": 500,
  "reason": "Scroll down to reveal hidden elements"
}
\`\`\`

--- Example 4: Completing the Task & Summarizing Answer ---
<thought>
I have read the visible text content from the webpage. I will synthesize the final summary and complete the task.
</thought>
\`\`\`json
{
  "action": "finish",
  "answer": "### Summary of ScoutFox Project:\n- Autonomous AI Browser Extension supporting OpenRouter, AgentRouter, Ollama, Gemini, OpenAI, Claude.\n- Built with Manifest V3 and Studio Mono design system.",
  "reason": "Extracted and summarized requested data"
}
\`\`\`

--- Example 5: Direct Navigation to a URL ---
<thought>
The goal requires visiting news.ycombinator.com directly. I will navigate to the URL.
</thought>
\`\`\`json
{
  "action": "navigate",
  "url": "https://news.ycombinator.com",
  "reason": "Navigate directly to requested website"
}
\`\`\`

--- Example 6: Extracting Full Readable Page Text Body ---
<thought>
I need to read the complete text body of the page to answer the user's question accurately.
</thought>
\`\`\`json
{
  "action": "read_page_text",
  "reason": "Extract full text body of webpage for reading"
}
\`\`\`

### Output Rules:
1. Always output your reasoning inside <thought>...</thought> (or <think>...</think>).
2. Always output your single action inside a valid \`\`\`json ... \`\`\` block matching the JSON structure in the examples above.
3. Only select element_id numbers that exist in the provided Interactive Elements list.`;
  }

  buildStepMessage(snapshot) {
    return `Current Page Title: "${snapshot.title}"
Current URL: ${snapshot.url}
Scroll Position: Y=${snapshot.scrollState.scrollY} / ${snapshot.scrollState.pageHeight}px

Webpage Visible Text Content (Use this to read content or summarize):
"""
${snapshot.pageText || '(No visible text extracted)'}
"""

Interactive Elements on Page:
${snapshot.elementsText || '(No interactive elements detected)'}

Choose your next action based on the goal: "${this.currentTask}"`;
  }

  /**
   * Universal Multi-Stage Guardrail Action Parser
   */
  parseResponse(text, maxElementCount = 999) {
    if (!text || typeof text !== 'string') {
      return { thought: '', error: 'Empty output from model.' };
    }

    let thought = '';
    
    // 1. Extract <think> or <thought> or <reasoning>
    const thinkMatch = text.match(/<(?:think|thought|reasoning)>([\s\S]*?)<\/(?:think|thought|reasoning)>/i);
    if (thinkMatch) {
      thought = thinkMatch[1].trim();
    }

    let cleanText = text.replace(/<(?:think|thought|reasoning)>[\s\S]*?<\/(?:think|thought|reasoning)>/gi, '').trim();

    let actionObj = null;

    // 2. Extract JSON from ```json ... ``` or ``` ... ```
    const codeBlockMatch = cleanText.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (codeBlockMatch) {
      try {
        actionObj = JSON.parse(codeBlockMatch[1].trim());
      } catch (_) { /* continue to fallback extractors */ }
    }

    // 3. Extract JSON object containing "action" key
    if (!actionObj) {
      const braceMatch = cleanText.match(/\{[\s\S]*?"action"\s*:[\s\S]*?\}/i);
      if (braceMatch) {
        try {
          actionObj = JSON.parse(braceMatch[0].trim());
        } catch (_) { /* continue */ }
      }
    }

    // 4. Reverse SCAN all { ... } blocks in text for valid action JSON
    if (!actionObj) {
      const matches = cleanText.match(/\{[\s\S]*?\}/g) || [];
      for (let i = matches.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(matches[i]);
          if (parsed && (parsed.action || parsed.click || parsed.type || parsed.finish || parsed.read_page_text)) {
            actionObj = parsed;
            break;
          }
        } catch (_) { /* ignore */ }
      }
    }

    // 5. REGEX Intent Extractor for Dumber / Smaller LLMs outputting plain text
    if (!actionObj) {
      const clickMatch = cleanText.match(/(?:action:?\s*)?(?:click|press|tap)\s+(?:on\s+)?(?:element\s+)?\[?(\d+)\]?/i);
      if (clickMatch) {
        actionObj = { action: 'click', element_id: parseInt(clickMatch[1], 10), reason: 'Extracted via text intent' };
      }

      if (!actionObj) {
        const typeMatch = cleanText.match(/(?:action:?\s*)?(?:type|enter|write|input)\s+["']([^"']+)["']\s+(?:in|into|on)\s+(?:element\s+)?\[?(\d+)\]?/i);
        if (typeMatch) {
          actionObj = { action: 'type', text: typeMatch[1], element_id: parseInt(typeMatch[2], 10), submit: true, reason: 'Extracted via text intent' };
        }
      }

      if (!actionObj) {
        const navMatch = cleanText.match(/(?:action:?\s*)?(?:navigate|go\s+to|open)\s+(https?:\/\/[^\s]+)/i);
        if (navMatch) {
          actionObj = { action: 'navigate', url: navMatch[1], reason: 'Extracted via text intent' };
        }
      }

      if (!actionObj) {
        const scrollMatch = cleanText.match(/(?:action:?\s*)?(?:scroll)\s+(down|up)/i);
        if (scrollMatch) {
          actionObj = { action: 'scroll', direction: scrollMatch[1].toLowerCase(), amount: 500, reason: 'Extracted via text intent' };
        }
      }

      if (!actionObj && /read.*page.*text|extract.*text|get.*page.*content/i.test(cleanText)) {
        actionObj = { action: 'read_page_text', reason: 'Extracted via text intent' };
      }
    }

    // 6. Freeform Text Auto-Wrapping Guardrail
    if (!actionObj && cleanText.length > 5) {
      Logger.info('AgentEngine', '[UNIVERSAL_GUARDRAIL] Model provided direct text response. Auto-wrapping into finish action.');
      actionObj = {
        action: 'finish',
        answer: cleanText,
        reason: 'Direct text output from model'
      };
    }

    if (!actionObj) {
      return { thought, error: 'No valid action or response text found in model output.', raw: text };
    }

    // 7. Action Schema & Element ID Sanitizer
    actionObj = this.sanitizeActionSchema(actionObj, maxElementCount);

    return { thought, action: actionObj };
  }

  /**
   * Action Schema Normalizer & Element ID Bounds Validator
   */
  sanitizeActionSchema(actionObj, maxElementCount = 999) {
    const act = { ...actionObj };
    
    if (act.click !== undefined && !act.action) { act.action = 'click'; act.element_id = act.click; }
    if (act.type !== undefined && !act.action) { act.action = 'type'; }
    if (act.action === 'click_element' || act.action === 'press') act.action = 'click';
    if (act.action === 'type_text' || act.action === 'input') act.action = 'type';
    if (act.action === 'done' || act.action === 'complete' || act.action === 'finished') act.action = 'finish';
    if (act.action === 'scroll_page') act.action = 'scroll';
    if (act.action === 'extract_text' || act.action === 'read_text' || act.action === 'extract_page_text') act.action = 'read_page_text';

    if (act.element_id === undefined) {
      if (act.element !== undefined) act.element_id = act.element;
      else if (act.id !== undefined) act.element_id = act.id;
      else if (act.elementId !== undefined) act.element_id = act.elementId;
    }

    if (act.element_id !== undefined) {
      act.element_id = parseInt(act.element_id, 10) || 1;
      if (maxElementCount > 0 && act.element_id > maxElementCount) {
        Logger.warn('AgentEngine', `[GUARDRAIL_BOUNDS] Model selected hallucinated element_id [${act.element_id}]. Clamping to valid range [1..${maxElementCount}]`);
        act.element_id = Math.min(act.element_id, maxElementCount);
      }
    }

    return act;
  }
}

function formatActionSummary(act) {
  if (act.action === 'click') return `Click [${act.element_id}]`;
  if (act.action === 'type') return `Type "${act.text || ''}" in [${act.element_id}]`;
  if (act.action === 'scroll') return `Scroll ${act.direction || 'down'}`;
  if (act.action === 'navigate') return `Navigate to ${act.url || ''}`;
  if (act.action === 'read_page_text') return `Extract text body`;
  return act.action;
}
