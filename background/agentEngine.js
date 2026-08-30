/**
 * AgentEngine for ScoutFox AI Agent
 * Orchestrates plan generation, execution loop, fault-tolerant action parsing,
 * resilient service worker state restoration, and persistent log integration.
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
            
            // Service worker restart guard: If SW restarted while running, reset status to idle
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
            status: this.status
          }
        });
      }
    } catch (e) {
      Logger.warn('AgentEngine', 'Could not persist state', e);
    }
  }

  setStateChangeCallback(cb) {
    this.onStateChangeCallback = cb;
  }

  notifyStateChange(extraData = {}) {
    this.persistState();
    if (this.onStateChangeCallback) {
      this.onStateChangeCallback({
        status: this.status,
        stepCount: this.stepCount,
        task: this.currentTask,
        history: this.history,
        planSteps: this.planSteps,
        currentPhase: this.currentPhase,
        logs: Logger.getLogsHistory(),
        ...extraData
      });
    }
  }

  setPhase(phaseText) {
    this.currentPhase = phaseText;
    this.notifyStateChange({ currentPhase: phaseText });
  }

  clearHistory() {
    this.history = [];
    this.planSteps = [];
    this.stepCount = 0;
    this.currentTask = null;
    this.status = 'idle';
    this.currentPhase = '';
    this.isLoopActive = false;
    Logger.clearLogs();
    this.notifyStateChange();
  }

  async startTask(userPrompt, tabId) {
    // If a zombie task state exists, force reset to idle for the new user prompt
    if (this.status === 'running' && !this.isLoopActive) {
      Logger.info('AgentEngine', '[TASK_OVERRIDE] Overriding zombie running status for new user task.');
      this.status = 'idle';
    }

    if (this.status === 'running' && this.isLoopActive) {
      Logger.info('AgentEngine', '[TASK_INTERRUPT] Stopping active running task to execute new user prompt.');
      this.status = 'stopped';
      this.isLoopActive = false;
      await new Promise(r => setTimeout(r, 300));
    }

    this.status = 'running';
    this.currentTask = userPrompt;
    this.stepCount = 0;
    this.activeTabId = tabId;

    // Instant initial plan checklist (0ms latency)
    this.planSteps = [
      { id: 1, text: 'Inspect & index webpage interactive elements', status: 'in_progress' },
      { id: 2, text: 'Plan sub-goals and execute browser actions', status: 'pending' },
      { id: 3, text: 'Extract target data & synthesize answer', status: 'pending' }
    ];

    Logger.info('AgentEngine', `================ TASK START ================`);
    Logger.info('AgentEngine', `[GOAL] "${userPrompt}"`);
    Logger.info('AgentEngine', `[TARGET TAB] Tab ID: ${tabId}`);

    this.history.push({
      type: 'user_goal',
      prompt: userPrompt,
      timestamp: new Date().toLocaleTimeString()
    });

    this.notifyStateChange();

    const settings = await Storage.getSettings();

    // Refine AI plan in background
    this.setPhase('📋 Refining execution plan checklist...');
    this.generatePlan(userPrompt, settings).catch(err => {
      Logger.warn('AgentEngine', 'Background plan refinement failed', err);
    });

    try {
      await this.runLoop();
    } catch (err) {
      Logger.error('AgentEngine', '[LOOP ERROR] Unhandled exception in execution loop', err);
      this.status = 'idle';
      this.isLoopActive = false;
      this.currentPhase = '';
      this.history.push({
        type: 'error',
        content: `Execution Error: ${err.message}`
      });
      this.notifyStateChange({ error: err.message });
    }
  }

  async generatePlan(userPrompt, settings) {
    const planPrompt = `Task: "${userPrompt}"
Generate a concise 3-5 step plan to accomplish this web task.
Output ONLY a raw JSON array of strings representing the sub-goals.

Example Output:
["Navigate to target website", "Search for query", "Extract relevant items", "Summarize results"]`;

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
        Logger.info('AgentEngine', `[PLANNER_REFINED] Updated plan checklist with ${this.planSteps.length} sub-goals`, this.planSteps);
        this.notifyStateChange();
      }
    } catch (err) {
      Logger.warn('AgentEngine', '[PLANNER_REFINED_WARN] Using initial plan checklist', err.message);
    }
  }

  updatePlanProgress(currentStepNum, maxSteps, isFinished = false) {
    if (!this.planSteps || this.planSteps.length === 0) return;

    if (isFinished) {
      this.planSteps.forEach(step => step.status = 'completed');
      this.notifyStateChange();
      return;
    }

    const totalPlanSteps = this.planSteps.length;
    const currentPlanIndex = Math.min(
      totalPlanSteps - 1,
      Math.floor(((currentStepNum - 1) / maxSteps) * totalPlanSteps)
    );

    this.planSteps.forEach((step, idx) => {
      if (idx < currentPlanIndex) {
        step.status = 'completed';
      } else if (idx === currentPlanIndex) {
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
      this.runLoop();
    }
  }

  stop() {
    this.status = 'stopped';
    this.isLoopActive = false;
    this.currentPhase = '';
    Logger.info('AgentEngine', '[STOPPED] Task stopped by user.');
    this.notifyStateChange({ message: 'Task stopped.' });
  }

  async waitForTabComplete(tabId, timeoutMs = 6000) {
    return new Promise((resolve) => {
      let timer = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, timeoutMs);

      const listener = (updatedTabId, changeInfo) => {
        if (updatedTabId === tabId && changeInfo.status === 'complete') {
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
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

  async runLoop() {
    const settings = await Storage.getSettings();
    const maxSteps = settings.maxSteps || 25;
    this.isLoopActive = true;

    while (this.status === 'running' && this.stepCount < maxSteps) {
      this.stepCount++;
      Logger.info('AgentEngine', `---------------- STEP ${this.stepCount}/${maxSteps} ----------------`);

      this.updatePlanProgress(this.stepCount, maxSteps);

      // 1. DOM Extraction Input
      this.setPhase(`🌐 Step ${this.stepCount}/${maxSteps}: Reading webpage elements...`);

      let domSnapshot;
      try {
        domSnapshot = await this.getTabDOMWithAutoInject(this.activeTabId, settings.showElementBadges);
        Logger.info('AgentEngine', `[DOM_SNAPSHOT_INPUT] Title: "${domSnapshot.title}" | URL: ${domSnapshot.url} | Elements: ${domSnapshot.elementCount}`);
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
      const userMessage = this.buildStepMessage(domSnapshot);

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

      // 3. Action Parsing
      this.setPhase(`🔍 Step ${this.stepCount}/${maxSteps}: Parsing action...`);
      const actionResult = this.parseResponse(responseText);

      this.history.push({
        step: this.stepCount,
        type: 'agent_response',
        rawResponse: responseText,
        thought: actionResult.thought,
        action: actionResult.action
      });

      this.notifyStateChange();

      if (actionResult.error) {
        Logger.warn('AgentEngine', '[PARSER_WARN] Invalid response format', actionResult.error);
        this.history.push({
          step: this.stepCount,
          type: 'execution_result',
          success: false,
          error: `Parsing Error: ${actionResult.error}`
        });
        this.notifyStateChange();
        continue;
      }

      const action = actionResult.action;

      if (action.action === 'finish') {
        this.status = 'idle';
        this.isLoopActive = false;
        this.currentPhase = '';
        this.updatePlanProgress(this.stepCount, maxSteps, true);
        this.history.push({
          step: this.stepCount,
          type: 'finish',
          answer: action.answer || action.reason || 'Task finished successfully.'
        });
        Logger.info('AgentEngine', `[TASK_COMPLETE] Final Answer:\n${action.answer}`);
        this.notifyStateChange({ finished: true, finalAnswer: action.answer });
        return;
      }

      if (action.action === 'ask_user') {
        this.status = 'paused';
        this.setPhase('Waiting for user feedback...');
        this.history.push({
          step: this.stepCount,
          type: 'ask_user',
          question: action.question
        });
        Logger.info('AgentEngine', `[ASK_USER] Question: "${action.question}"`);
        this.notifyStateChange({ needsUserFeedback: true, question: action.question });
        return;
      }

      // 4. Action Execution Output
      const actDesc = formatActionSummary(action);
      this.setPhase(`⚡ Step ${this.stepCount}/${maxSteps}: Executing ${actDesc}...`);

      let execRes;
      try {
        execRes = await this.executeActionOnTab(this.activeTabId, action);
        Logger.info('AgentEngine', `[EXECUTION_RESULT] Success: ${execRes.success} | Message: "${execRes.message || ''}"`);
      } catch (err) {
        Logger.error('AgentEngine', '[EXECUTION_ERROR] Action failed', err);
        execRes = { success: false, error: err.message };
      }

      this.history.push({
        step: this.stepCount,
        type: 'execution_result',
        success: execRes.success,
        message: execRes.message || execRes.error,
        error: execRes.error
      });

      this.notifyStateChange();

      // 5. Synchronize Navigation & Delay
      if (action.action === 'navigate' || action.action === 'click') {
        this.setPhase(`🌐 Waiting for web page navigation to complete...`);
        await this.waitForTabComplete(this.activeTabId, 5000);
      }

      const delayMs = settings.actionDelayMs || 1000;
      this.setPhase(`⏳ Step ${this.stepCount}/${maxSteps}: Settling page state...`);
      await new Promise(r => setTimeout(r, delayMs));
    }

    this.isLoopActive = false;
    if (this.stepCount >= maxSteps && this.status === 'running') {
      this.status = 'idle';
      this.currentPhase = '';
      Logger.warn('AgentEngine', `[MAX_STEPS_REACHED] Terminating task execution at ${maxSteps} steps.`);
      this.notifyStateChange({ message: 'Reached max execution steps limit.' });
    }
  }

  async getTabDOMWithAutoInject(tabId, showBadges) {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || !tab.url) {
      throw new Error('No active browser tab found. Please open a webpage first.');
    }
    if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('edge://') || tab.url.startsWith('about:')) {
      throw new Error(`Cannot run agent on browser internal page (${tab.url}). Please navigate to a web page like https://google.com first.`);
    }

    try {
      return await this.sendTabMessage(tabId, { action: 'GET_DOM_SNAPSHOT', payload: { showBadges } });
    } catch (err) {
      Logger.info('AgentEngine', `Content script not responding on tab [${tabId}]. Injecting content scripts...`);
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
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
    return `${customInstructions || 'You are an autonomous web browsing AI agent.'}

You are provided with a goal and a compressed list of interactive web page elements labeled with numerical IDs like [1], [2], [3].

Your objective is to choose the single best action to move closer to the goal.

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

6. Task finished (Output final summary answer):
   {"action": "finish", "answer": "<final_answer_text>", "reason": "<explanation>"}

7. Ask user for input/help:
   {"action": "ask_user", "question": "<question_text>", "reason": "<explanation>"}

### Output Format Rules:
- First, output your reasoning inside <thought>...</thought>.
- Second, output your exact single action inside a valid JSON block inside \`\`\`json ... \`\`\`.
- ONLY select element_id numbers that exist in the provided Interactive Elements list.`;
  }

  buildStepMessage(snapshot) {
    return `Current Page Title: "${snapshot.title}"
Current URL: ${snapshot.url}
Scroll Position: Y=${snapshot.scrollState.scrollY} / ${snapshot.scrollState.pageHeight}px

Interactive Elements on Page:
${snapshot.elementsText || '(No interactive elements detected)'}

Choose your next action based on the goal: "${this.currentTask}"`;
  }

  parseResponse(text) {
    let thought = '';
    const thoughtMatch = text.match(/<thought>([\s\S]*?)<\/thought>/i);
    if (thoughtMatch) {
      thought = thoughtMatch[1].trim();
    }

    let jsonStr = '';
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1].trim();
    } else {
      const braceMatch = text.match(/\{[\s\S]*"action"[\s\S]*\}/i);
      if (braceMatch) {
        jsonStr = braceMatch[0].trim();
      }
    }

    if (!jsonStr) {
      return { thought, error: 'No valid JSON action object found in model output.', raw: text };
    }

    try {
      const actionObj = JSON.parse(jsonStr);
      if (!actionObj.action) {
        return { thought, error: 'JSON object missing required "action" key.', raw: text };
      }
      return { thought, action: actionObj };
    } catch (err) {
      return { thought, error: `Invalid JSON syntax: ${err.message}`, raw: text };
    }
  }
}

function formatActionSummary(act) {
  if (act.action === 'click') return `Click [${act.element_id}]`;
  if (act.action === 'type') return `Type "${act.text || ''}" in [${act.element_id}]`;
  if (act.action === 'scroll') return `Scroll ${act.direction || 'down'}`;
  if (act.action === 'navigate') return `Navigate to ${act.url || ''}`;
  return act.action;
}
