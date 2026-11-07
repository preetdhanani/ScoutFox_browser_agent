// src/background/mcp/tools.ts
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

/**
 * The step note every tool but finish asks for. It is how the model keeps its own thread: the
 * tool arguments stay in the history, so each round it reads what it concluded the round before.
 */
export const REASON_TEXT = 'One or two sentences: what the last result told you, and why this step comes next.';

export const TARKA_TOOLS: ToolDef[] = [
  // === PLANNING ===
  {
    name: 'update_plan',
    description: 'The plan of a multi-step task, and its progress. Call it with plan (the steps) before you start; simple tasks (one action, summarize the page) can skip it. Call it again with done (the numbers of the finished steps) whenever a step is finished: with the same plan, or without plan, the steps are only marked, nothing is asked again. A plan with other steps replaces the old one.',
    inputSchema: {
      type: 'object',
      properties: {
        plan: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ordered list of steps to accomplish the task. Leave it out to only mark steps done.'
        },
        done: {
          type: 'array',
          items: { type: 'integer', minimum: 1 },
          description: 'The numbers (1 for the first) of the steps that are finished now'
        },
        requires_approval: {
          type: 'boolean',
          default: true,
          description: 'Whether to wait for user approval (true for complex tasks)'
        },
        reason: { type: 'string', description: REASON_TEXT }
      },
      required: ['reason'],
      additionalProperties: false
    }
  },

  // === PAGE READING ===
  {
    name: 'read_page',
    description: 'Read the text of the whole page, in parts of about 3000 characters: the result says "part i of M" and how to get the next part. Use it FIRST to understand the page. Panels that scroll on their own are included, not only what is in view. The links of each part are listed under its text with their full addresses ("Links in this part:"). Give element_id (from get_page_elements or find) to read only that element, for example one code cell or one search result. A code editor draws only the lines near the view; the result says so when it does.',
    inputSchema: {
      type: 'object',
      properties: {
        part: { type: 'integer', minimum: 1, description: 'Which part to read, 1 for the start (the default). The result names the next part.' },
        element_id: { type: 'number', minimum: 1, description: 'Read only this element (from get_page_elements or find)' },
        reason: { type: 'string', description: REASON_TEXT }
      },
      required: ['reason'],
      additionalProperties: false
    }
  },
  {
    name: 'get_page_elements',
    description: 'Get interactive elements (links, buttons, inputs) with numeric IDs [1], [2], [3]... for clicking/typing.',
    inputSchema: { type: 'object', properties: { reason: { type: 'string', description: REASON_TEXT } }, required: ['reason'], additionalProperties: false }
  },
  {
    name: 'find',
    description: 'Search ALL elements of the page (also far below the first screen) by the words on them. Returns up to 8 matches with ids that click, type, scroll and read_page take. Use it when the element list is long or the target is not in it.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The words to look for (e.g., "download", "email", "Cell 14")' },
        reason: { type: 'string', description: REASON_TEXT }
      },
      required: ['query', 'reason'],
      additionalProperties: false
    }
  },
  {
    name: 'take_screenshot',
    description: 'Take a picture of the visible page and look at it. Use when the text alone does not tell you what you need: is a control disabled, is something covering the page, what does the layout look like, where is a target that has no text. The picture is the visible viewport, not the whole page.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: REASON_TEXT }
      },
      required: ['reason'],
      additionalProperties: false
    }
  },

  // === PAGE ACTING ===
  {
    name: 'click',
    description: 'Click an element by its ID from get_page_elements or find, or at pixel coordinates read off a take_screenshot picture. Use IDs for links, buttons, checkboxes, tabs. Use coordinates only for a target you read off a screenshot.',
    inputSchema: {
      type: 'object',
      properties: {
        element_id: { type: 'number', minimum: 1, description: 'The element ID, when clicking by element' },
        x: { type: 'number', description: 'The x pixel in the picture from take_screenshot' },
        y: { type: 'number', description: 'The y pixel in the picture from take_screenshot' },
        reason: { type: 'string', description: REASON_TEXT }
      },
      // Either element_id, or both x and y. The server enforces the rule, so a half-specified
      // coordinate never reaches the mouse.
      required: ['reason'],
      additionalProperties: false
    }
  },
  {
    name: 'type',
    description: 'Type text into a field. By default it REPLACES the whole content of the field (it selects everything first); mode "append" adds the text at the end instead. With element_id it clicks that field first. Without element_id it types into the element that has focus now: click into an editor (by id or x,y), then call type without element_id. Set submit=true to press Enter after typing. The result reads the field back.',
    inputSchema: { 
      type: 'object', 
      properties: { 
        element_id: { type: 'number', minimum: 1, description: 'The field to type into. Leave it out to type into the focused element' },
        text: { type: 'string' },
        mode: { type: 'string', enum: ['replace', 'append'], default: 'replace', description: 'replace (default) the whole content, or append at the end' },
        submit: { type: 'boolean', default: false },
        reason: { type: 'string', description: REASON_TEXT }
      }, 
      required: ['text', 'reason'],
      additionalProperties: false 
    }
  },
  {
    name: 'press_key',
    description: 'Press one real key on the focused element, optionally with modifiers. Use it for editors and shortcuts: key "select_all" selects everything (Cmd+A on a Mac, Ctrl+A elsewhere), "Enter" with modifiers ["shift"] runs a notebook cell, "Escape" closes a dialog, "Tab" moves focus. key is a key name (Enter, Tab, Escape, Backspace, Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp, PageDown, Space), a single character such as "a", or "select_all".',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'A key name, a single character, or "select_all"' },
        modifiers: { type: 'array', items: { type: 'string', enum: ['ctrl', 'shift', 'alt', 'meta'] }, description: 'Keys held while pressing, e.g. ["shift"] or ["ctrl"]' },
        reason: { type: 'string', description: REASON_TEXT }
      },
      required: ['key', 'reason'],
      additionalProperties: false
    }
  },
  {
    name: 'scroll',
    description: 'Scroll with the mouse wheel, by most of one screen. Without element_id or x,y it scrolls the biggest scrolling area in view (the page, or the main panel of an app whose page does not scroll). Give element_id to scroll the area that holds that element, or x and y from a take_screenshot picture to scroll the area under that point. The result says what moved and how far, or "Did not move" with the reason (for example already at the bottom).',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down'] },
        element_id: { type: 'number', minimum: 1, description: 'Scroll the area that holds this element' },
        x: { type: 'number', description: 'The x pixel in the picture from take_screenshot, inside the area to scroll' },
        y: { type: 'number', description: 'The y pixel in the picture from take_screenshot, inside the area to scroll' },
        reason: { type: 'string', description: REASON_TEXT }
      },
      required: ['direction', 'reason'],
      additionalProperties: false
    }
  },
  {
    name: 'navigate',
    description: 'Navigate to a new URL. Must be full https:// or http:// URL.',
    inputSchema: { 
      type: 'object', 
      properties: { 
        url: { type: 'string', pattern: '^https?://' },
        reason: { type: 'string', description: REASON_TEXT }
      }, 
      required: ['url', 'reason'],
      additionalProperties: false 
    }
  },
  {
    name: 'wait',
    description: 'Wait for page to load, element to appear, or action to complete (1-5 seconds).',
    inputSchema: { 
      type: 'object', 
      properties: { 
        amount: { type: 'number', minimum: 1, maximum: 5 },
        reason: { type: 'string', description: REASON_TEXT }
      }, 
      required: ['amount', 'reason'],
      additionalProperties: false 
    }
  },
  {
    name: 'go_back',
    description: 'Go back in browser history.',
    inputSchema: { type: 'object', properties: { reason: { type: 'string', description: REASON_TEXT } }, required: ['reason'], additionalProperties: false }
  },
  {
    name: 'go_forward',
    description: 'Go forward in browser history.',
    inputSchema: { type: 'object', properties: { reason: { type: 'string', description: REASON_TEXT } }, required: ['reason'], additionalProperties: false }
  },

  // === RESEARCH (outside the tab) ===
  {
    name: 'web_search',
    description: 'Search the web from the background, WITHOUT touching the user\'s tab (the tab stays where it is). Returns up to 8 results, each a title, its URL and a snippet. Use it to find the official source of a fact (a download URL, a version, a command) before you write it. Snippets can be old or wrong: read the page itself with fetch_url before you rely on it.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for, as you would type it into a search engine' },
        max_results: { type: 'integer', minimum: 1, maximum: 8, description: 'How many results to return (default 6)' },
        reason: { type: 'string', description: REASON_TEXT }
      },
      required: ['query', 'reason'],
      additionalProperties: false
    }
  },
  {
    name: 'fetch_url',
    description: 'Read one web address from the background, WITHOUT touching the user\'s tab, and without the user\'s cookies or logins. Works for web pages (as text), JSON APIs, raw files and scripts (for example an install.sh or a GitHub releases API URL). A long text comes in parts: the result says "part i of M"; read more with part. Give query to get only the lines that contain one of its words (for example "linux amd64"). Redirects are followed and the final URL is reported.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', pattern: '^https?://', description: 'The full http:// or https:// address to read' },
        part: { type: 'integer', minimum: 1, description: 'Which part to read, 1 for the start (the default)' },
        query: { type: 'string', description: 'Only the lines that contain one of these words' },
        reason: { type: 'string', description: REASON_TEXT }
      },
      required: ['url', 'reason'],
      additionalProperties: false
    }
  },

  // === COLLECTING ===
  {
    name: 'save_data',
    description: 'Save records you found (for example one per item of a list: {"name": ..., "date": ..., "url": ...}) to the run\'s collected data. Saved records are kept for the whole run, whatever is read later, and every round shows how many you have. Save as soon as you read them; finish can write them into a file with records_file.',
    inputSchema: {
      type: 'object',
      properties: {
        records: {
          type: 'array',
          items: { type: 'object' },
          description: 'The records, each an object with the same fields. Copy values exactly as the page shows them.'
        },
        reason: { type: 'string', description: REASON_TEXT }
      },
      required: ['records', 'reason'],
      additionalProperties: false
    }
  },

  // === COMPLETION ===
  {
    name: 'finish',
    description: 'End the task with a final answer for the user. Call it when the task is done, and also when you cannot go on: then say in the answer what worked, what did not, and why.',
    inputSchema: {
      type: 'object',
      properties: {
        answer: { type: 'string', description: 'Complete answer addressing the user\'s task' },
        outcome: {
          type: 'string',
          enum: ['done', 'partial', 'blocked'],
          description: 'How the task went, said honestly. "done": you did what the user asked. "partial": you did only part of it, or your answer is a guess you could not check. "blocked": you could not do it (a button that does nothing, a login, a bot check, an error you could not get past).'
        },
        table: { type: 'object', description: 'A table to show alongside the answer, for quick comparison of prices, sites, or any rows the model found.' },
        records_file: { type: 'string', description: 'When the user asks for a file of the data: a file name ending in .json or .csv. The records saved with save_data are written into it, and the user gets it as a download.' },
        files: {
          type: 'array',
          description: 'Small files you write yourself (at most 3, 20 KB in all), for the user to download. For collected records use records_file instead.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'The file name, for example notes.md or data.json' },
              content: { type: 'string', description: 'The whole content of the file' }
            },
            required: ['name', 'content'],
            additionalProperties: false
          }
        }
      },
      required: ['answer', 'outcome'],
      additionalProperties: false
    }
  }
];

/** The tools that read the web outside the tab. They need no tab and are offered only when Settings > Research is on. */
export const RESEARCH_TOOL_NAMES: ReadonlySet<string> = new Set(['web_search', 'fetch_url']);

/**
 * The tools a run offers: all of them, without the research tools when research is off, and
 * without take_screenshot when the model cannot see pictures.
 */
export function offeredToolDefs({ research, vision }: { research: boolean; vision: boolean }): ToolDef[] {
  return TARKA_TOOLS.filter((tool) => (research || !RESEARCH_TOOL_NAMES.has(tool.name)) && (vision || tool.name !== 'take_screenshot'));
}

export const TOOL_NAMES = TARKA_TOOLS.map(t => t.name);
export const TOOL_MAP = new Map(TARKA_TOOLS.map(t => [t.name, t]));