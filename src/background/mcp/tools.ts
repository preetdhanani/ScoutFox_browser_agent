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

export const SCOUTFOX_TOOLS: ToolDef[] = [
  // === PLANNING ===
  {
    name: 'update_plan',
    description: 'REQUIRED for multi-step tasks. Present a plan for user approval before executing. Simple tasks (single action, summarize current page) can skip this.',
    inputSchema: {
      type: 'object',
      properties: {
        plan: { 
          type: 'array', 
          items: { type: 'string' },
          description: 'Ordered list of steps to accomplish the task'
        },
        requires_approval: { 
          type: 'boolean', 
          default: true,
          description: 'Whether to wait for user approval (true for complex tasks)'
        }
      },
      required: ['plan'],
      additionalProperties: false
    }
  },

  // === PAGE READING ===
  {
    name: 'get_page_text',
    description: 'Read ALL visible text content from the current page. Use FIRST to understand page content.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'get_page_elements',
    description: 'Get interactive elements (links, buttons, inputs) with numeric IDs [1], [2], [3]... for clicking/typing.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'find',
    description: 'Search page elements by natural language description. Returns matching element refs with reasons. Use when page has many elements.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for (e.g., "download button", "email input", "login link")' }
      },
      required: ['query'],
      additionalProperties: false
    }
  },
  {
    name: 'read_page_text',
    description: 'Read more text from the page (scrolls down). Use when get_page_text was truncated.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'take_screenshot',
    description: 'Take a picture of the visible page and look at it. Use when the text alone does not tell you what you need: is a control disabled, is something covering the page, what does the layout look like, where is a target that has no text. The picture is the visible viewport, not the whole page.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Why you need to look at the page' }
      },
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
        reason: { type: 'string', description: 'Why clicking this element' }
      },
      // Either element_id, or both x and y. The server enforces the rule, so a half-specified
      // coordinate never reaches the mouse.
      required: [],
      additionalProperties: false
    }
  },
  {
    name: 'type',
    description: 'Type text into an input field, textarea, or contenteditable by element ID. Set submit=true to press Enter.',
    inputSchema: { 
      type: 'object', 
      properties: { 
        element_id: { type: 'number', minimum: 1 },
        text: { type: 'string' },
        submit: { type: 'boolean', default: false },
        reason: { type: 'string', description: 'Why typing this text' }
      }, 
      required: ['element_id', 'text'],
      additionalProperties: false 
    }
  },
  {
    name: 'scroll',
    description: 'Scroll the page up or down by one viewport.',
    inputSchema: { 
      type: 'object', 
      properties: { 
        direction: { type: 'string', enum: ['up', 'down'] },
        reason: { type: 'string' }
      }, 
      required: ['direction'],
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
        reason: { type: 'string' }
      }, 
      required: ['url'],
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
        reason: { type: 'string' }
      }, 
      required: ['amount'],
      additionalProperties: false 
    }
  },
  {
    name: 'go_back',
    description: 'Go back in browser history.',
    inputSchema: { type: 'object', properties: { reason: { type: 'string' }}, additionalProperties: false }
  },
  {
    name: 'go_forward',
    description: 'Go forward in browser history.',
    inputSchema: { type: 'object', properties: { reason: { type: 'string' }}, additionalProperties: false }
  },

  // === COMPLETION ===
  {
    name: 'finish',
    description: 'Complete the task with a final answer for the user. Call when task is fully done.',
    inputSchema: {
      type: 'object',
      properties: {
        answer: { type: 'string', description: 'Complete answer addressing the user\'s task' },
        table: { type: 'object', description: 'A table to show alongside the answer, for quick comparison of prices, sites, or any rows the model found.' }
      },
      required: ['answer'],
      additionalProperties: false
    }
  },
  {
    name: 'render_table',
    description: 'Build a comparison table from data the model found on the sites it visited: columns are headers (shop, price, shipping, total, ...), rows are one entry per item. Call this when the answer is easier to read as a table than as prose - price comparisons, site lists, delivery times. The panel shows the table next to the answer so the user can see the data at a glance.',
    inputSchema: {
      type: 'object',
      properties: {
        columns: { type: 'array', items: { type: 'string' }, description: 'Column headers, e.g. ["Shop", "Price", "Shipping", "Total"]' },
        rows: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: 'One row per item, each row an array of cell strings in column order' }
      },
      required: ['columns', 'rows'],
      additionalProperties: false
    }
  }
];

export const TOOL_NAMES = SCOUTFOX_TOOLS.map(t => t.name);
export const TOOL_MAP = new Map(SCOUTFOX_TOOLS.map(t => [t.name, t]));