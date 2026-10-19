// src/background/mcp/server.ts
// MCP server that wraps existing browser APIs. Uses in-memory JSON-RPC transport
// (no stdio, no external app, no @modelcontextprotocol/sdk dependency).
import { takeSnapshot } from '../browser/snapshot.js';
import { executeAction } from '../browser/execute.js';
import { Logger } from '../../shared/logger.js';
import type { RunRuntime } from '../runner/runtimeRegistry.js';

export interface CallToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export class ScoutFoxMCPServer {
  private runtime: RunRuntime | null = null;

  setRuntime(runtime: RunRuntime) {
    this.runtime = runtime;
  }

  // List available tools - returns the same definitions as SCOUTFOX_TOOLS
  async listTools(): Promise<any[]> {
    const { SCOUTFOX_TOOLS } = await import('./tools.js');
    return SCOUTFOX_TOOLS;
  }

  // Execute a tool call
  async callTool(name: string, args: any): Promise<CallToolResult> {
    if (!this.runtime) {
      return { content: [{ type: 'text', text: 'Error: No active browser session' }], isError: true };
    }

    const tabId = this.runtime.tabs.activeTabId ?? this.runtime.tabs.ownerTabId;

    if (!tabId) {
      return { content: [{ type: 'text', text: 'Error: No active tab' }], isError: true };
    }

    try {
      return await this.executeTool(name, args, tabId);
    } catch (err: any) {
      Logger.error('MCP Server', `Tool ${name} failed`, err);
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }

  private async executeTool(name: string, args: any, tabId: number): Promise<CallToolResult> {
    const rt = this.runtime!;

    switch (name) {
      case 'get_page_text': {
        const snapshot = await takeSnapshot(tabId, { showBadges: false, maxElements: 0 }, {
          isTabInScope: async () => true,
          sleep: (ms) => rt.clock.sleep(ms)
        });
        return { content: [{ type: 'text', text: snapshot.pageText || '(page has no text)' }] };
      }

      case 'get_page_elements': {
        const snapshot = await takeSnapshot(tabId, { showBadges: true, maxElements: 100 }, {
          isTabInScope: async () => true,
          sleep: (ms) => rt.clock.sleep(ms)
        });
        return { content: [{ type: 'text', text: snapshot.elementsText || '(no interactive elements found)' }] };
      }

      case 'find': {
        const snapshot = await takeSnapshot(tabId, { showBadges: true, maxElements: 100 }, {
          isTabInScope: async () => true,
          sleep: (ms) => rt.clock.sleep(ms)
        });
        const matches = this.findElements(snapshot.elementsText || '', args.query);
        return { content: [{ type: 'text', text: matches }] };
      }

      case 'read_page_text': {
        await executeAction(tabId, { action: 'scroll', direction: 'down' }, { runRuntime: rt, signal: rt.control.stepSignal() });
        await rt.clock.sleep(500);
        const snapshot = await takeSnapshot(tabId, { showBadges: false, maxElements: 0 }, {
          isTabInScope: async () => true,
          sleep: (ms) => rt.clock.sleep(ms)
        });
        return { content: [{ type: 'text', text: snapshot.pageText || '(empty)' }] };
      }

      case 'click': {
        await executeAction(tabId, { action: 'click', element_id: args.element_id }, { runRuntime: rt, signal: rt.control.stepSignal() });
        return { content: [{ type: 'text', text: `Clicked element [${args.element_id}]${args.reason ? `: ${args.reason}` : ''}` }] };
      }

      case 'type': {
        await executeAction(tabId, { action: 'type', element_id: args.element_id, text: args.text, submit: args.submit }, { runRuntime: rt, signal: rt.control.stepSignal() });
        return { content: [{ type: 'text', text: `Typed into element [${args.element_id}]${args.reason ? `: ${args.reason}` : ''}` }] };
      }

      case 'scroll': {
        await executeAction(tabId, { action: 'scroll', direction: args.direction }, { runRuntime: rt, signal: rt.control.stepSignal() });
        return { content: [{ type: 'text', text: `Scrolled ${args.direction}${args.reason ? `: ${args.reason}` : ''}` }] };
      }

      case 'navigate': {
        await executeAction(tabId, { action: 'navigate', url: args.url }, { runRuntime: rt, signal: rt.control.stepSignal() });
        return { content: [{ type: 'text', text: `Navigated to ${args.url}${args.reason ? `: ${args.reason}` : ''}` }] };
      }

      case 'wait': {
        await rt.clock.sleep(args.amount * 1000);
        return { content: [{ type: 'text', text: `Waited ${args.amount}s${args.reason ? `: ${args.reason}` : ''}` }] };
      }

      case 'go_back': {
        await executeAction(tabId, { action: 'go_back' }, { runRuntime: rt, signal: rt.control.stepSignal() });
        return { content: [{ type: 'text', text: 'Went back in history' }] };
      }

      case 'go_forward': {
        await executeAction(tabId, { action: 'go_forward' }, { runRuntime: rt, signal: rt.control.stepSignal() });
        return { content: [{ type: 'text', text: 'Went forward in history' }] };
      }

      case 'finish': {
        return { content: [{ type: 'text', text: `TASK_COMPLETE: ${args.answer}` }] };
      }

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
  }

  private findElements(elementsText: string, query: string): string {
    const lines = elementsText.split('\n');
    const queryLower = query.toLowerCase();
    const matches = lines
      .filter(line => line.toLowerCase().includes(queryLower))
      .slice(0, 10)
      .map(line => `${line} | matches "${query}"`);
    
    return matches.length > 0 
      ? matches.join('\n')
      : `No elements found matching "${query}". Try get_page_elements to see all.`;
  }
}
