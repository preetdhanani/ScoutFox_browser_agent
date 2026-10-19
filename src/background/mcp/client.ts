// src/background/mcp/client.ts
// MCP client: drives the LLM tool-calling loop. The LLM chooses tools, the server
// executes them in the browser, results are fed back to the LLM. Loops until finish.
import { ScoutFoxMCPServer } from './server.js';
import { SCOUTFOX_TOOLS } from './tools.js';
import { Storage } from '../../shared/storage.js';
import { Logger } from '../../shared/logger.js';
import { broadcastToSession } from '../background.js';
import type { RunRuntime } from '../runner/runtimeRegistry.js';

export interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    function: { name: string; arguments: string };
  }>;
}

export interface ToolCall {
  id: string;
  function: { name: string; arguments: string };
}

export class ScoutFoxMCPClient {
  private server: ScoutFoxMCPServer;
  private runtime: RunRuntime;
  private sessionId: number;
  private messageHistory: Message[] = [];
  private isRunning = false;
  private pendingApproval = false;
  private pendingToolCallId = '';
  private currentPageUrl = '';
  private currentPageTitle = '';

  constructor(runtime: RunRuntime, sessionId: number) {
    this.runtime = runtime;
    this.sessionId = sessionId;
    this.server = new ScoutFoxMCPServer();
    this.server.setRuntime(runtime);
  }

  async startTask(userPrompt: string) {
    if (this.isRunning) return;
    this.isRunning = true;
    this.messageHistory = [];
    this.pendingApproval = false;

    // Get initial page context
    const tabId = this.runtime.tabs.activeTabId ?? this.runtime.tabs.ownerTabId;
    const snapshot = await this.callTool('get_page_text', {});
    
    this.currentPageUrl = (snapshot as any).url || '';
    this.currentPageTitle = (snapshot as any).title || '';

    this.messageHistory.push(
      { role: 'system', content: this.buildSystemPrompt() },
      { 
        role: 'user', 
        content: `TASK: ${userPrompt}\n\nCURRENT PAGE: ${this.currentPageTitle}\n${this.currentPageUrl}\n\nPage preview:\n${(snapshot as any).pageText?.slice(0, 2000) || '(empty)'}` 
      }
    );

    await this.runNextStep();
  }

  private buildSystemPrompt(): string {
    const toolsJson = JSON.stringify(SCOUTFOX_TOOLS, null, 2);
    return `You are ScoutFox, an AI browser agent controlling a Chrome tab.

AVAILABLE TOOLS:
${toolsJson}

CURRENT CONTEXT:
- Active tab: ${this.runtime.tabs.activeTabId ?? this.runtime.tabs.ownerTabId}
- Page URL: ${this.currentPageUrl}
- Page title: ${this.currentPageTitle}

RULES (MANDATORY):
1. PLAN FIRST for multi-step tasks: Call update_plan with your plan before ANY other tool.
   - Simple tasks (summarize, single click, single extract): skip planning, act directly
   - Complex tasks (multi-site, multi-step, conditional): MUST call update_plan first

2. ALWAYS CALL A TOOL BEFORE RESPONDING WITH TEXT (turn_answer_start rule).
   - No "I'll help you..." without a tool call
   - No explanatory text without a tool call

3. ELEMENT INTERACTION:
   - Use get_page_elements to see clickable items with IDs [1], [2], [3]...
   - Use find {query} to search elements by description when list is long
   - ONLY use element IDs returned by get_page_elements or find

4. READING vs ACTING:
   - If answer is on current page: call get_page_text, then finish
   - If action needed: call click/type/scroll/navigate, then continue

5. SAFETY:
   - Never type passwords, card numbers, OTP codes
   - If user declines an action: DO NOT workaround, respect the decision
   - Stay on the current site unless navigate is explicitly needed

6. COMPLETION:
   - Call finish {answer} when task is done
   - Answer should be complete and directly address the user's task

WORKFLOW EXAMPLES:

Example 1 - Summarize (answer task):
  User: "Summarize this paper"
  -> get_page_text -> finish {answer: "..."}

Example 2 - Click & Download (action task):
  User: "Click View PDF and download"
  -> get_page_elements -> find "View PDF" -> click [ref] -> wait -> finish

Example 3 - Multi-step (planning required):
  User: "Find cheapest Framework laptop across 3 sites"
  -> update_plan {plan: ["Search site1", "Search site2", "Search site3", "Compare prices"]}
  -> (user approves) -> navigate -> get_page_text -> ... -> finish`;
  }

  private async runNextStep() {
    if (!this.isRunning) return;

    const settings = await Storage.getSettings();
    
    try {
      const response = await this.callProviderWithTools(settings);

      const calls = response.tool_calls;
      if (calls && calls.length > 0) {
        this.messageHistory.push({
          role: 'assistant',
          content: '',
          tool_calls: calls
        });

        for (const toolCall of calls) {
          await this.executeToolCall(toolCall);
        }
      } else if (response.text) {
        Logger.warn('MCP', 'Model responded without tool call', response.text);
        await this.onTaskComplete(response.text);
      }
    } catch (err: any) {
      Logger.error('MCP Client', 'Error in tool loop', err);
      this.isRunning = false;
      this.notifyError(err.message);
    }
  }

  private async callProviderWithTools(settings: any): Promise<{ text?: string; tool_calls?: ToolCall[] }> {
    const { callProviderWithTools } = await import('../llm/index.js');
    return callProviderWithTools(settings.provider, settings, this.messageHistory, '', {
      tools: SCOUTFOX_TOOLS,
      toolChoice: 'auto'
    });
  }

  private async executeToolCall(toolCall: ToolCall) {
    this.pendingToolCallId = toolCall.id;
    const { name, arguments: args } = toolCall.function;

    // Broadcast tool call to side panel
    broadcastToSession(this.getSession(), 'TOOL_CALL', { 
      tool: name, 
      args: JSON.parse(args) 
    });

    // Special handling for update_plan - wait for user approval
    if (name === 'update_plan') {
      const parsed = JSON.parse(args);
      await this.handlePlanApproval(parsed.plan);
      return;
    }

    // Send to MCP server
    const result = await this.callTool(name, JSON.parse(args));
    
    // Broadcast tool result to side panel
    const resultText = result.content?.[0]?.text || '';
    broadcastToSession(this.getSession(), 'TOOL_RESULT', { result: resultText });
    
    // Check for task completion
    if (resultText.startsWith('TASK_COMPLETE:')) {
      this.onTaskComplete(resultText.slice('TASK_COMPLETE:'.length).trim());
      return;
    }

    // Add tool result to history
    this.messageHistory.push({
      role: 'tool',
      tool_call_id: this.pendingToolCallId,
      content: resultText
    });

    // Continue loop
    this.runNextStep();
  }

  private async callTool(name: string, args: any): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    return this.server.callTool(name, args);
  }

  private async handlePlanApproval(plan: string[]) {
    this.pendingApproval = true;

    // Send plan to side panel for user approval
    broadcastToSession(this.getSession(), 'PLAN_PROPOSED', { plan });

    // Auto-approve simple plans (<=2 steps)
    if (plan.length <= 2) {
      this.onPlanApproved(true);
    }
    // Otherwise waits for APPROVE_PLAN message from side panel
  }

  onPlanApproved(approved: boolean) {
    if (!this.pendingApproval) return;
    this.pendingApproval = false;

    if (approved) {
      this.messageHistory.push({
        role: 'tool',
        tool_call_id: this.pendingToolCallId,
        content: 'Plan approved. Execute the plan step by step.'
      });
      this.runNextStep();
    } else {
      this.messageHistory.push({
        role: 'tool',
        tool_call_id: this.pendingToolCallId,
        content: 'Plan rejected. Please propose a new plan with update_plan.'
      });
      this.runNextStep();
    }
  }

  private onTaskComplete(answer: string) {
    this.isRunning = false;
    broadcastToSession(this.getSession(), 'TASK_COMPLETE', { answer });
  }

  private notifyError(error: string) {
    broadcastToSession(this.getSession(), 'TASK_ERROR', { error });
  }

  private getSession() {
    return (globalThis as any).__scoutfoxSessions?.get(this.sessionId);
  }

  stop() {
    this.isRunning = false;
  }

  handleApprovePlan(approved: boolean) {
    this.onPlanApproved(approved);
  }
}
