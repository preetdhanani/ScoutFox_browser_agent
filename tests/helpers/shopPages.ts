/**
 * shopPages - the pages and the replies a test needs to talk about a shop.
 *
 * These are the data parts of the old graph harness, kept because several tests still use them:
 * a two page shop (a list page with a link to the product page, and the product page with a link
 * back), a one site plan, and the replies the model gives. The rig that used them, graphRig, drove
 * the LangGraph orchestrator and worker that the MCP tool loop replaced, so it went with it.
 *
 * Example:
 *   import { act, shopPages, shopPlan } from './helpers/shopPages.ts';
 *
 *   const pages = shopPages();
 *   const plan = shopPlan();
 *   const reply = act.finish('Item 42 costs 99 USD.');
 */

import { link } from './fakeDom.ts';
import type { PageSpec } from './fakeDom.ts';

export const SHOP_LIST_URL = 'https://shop.test/items';
export const SHOP_PRODUCT_URL = 'https://shop.test/items/42';

/** The default site: a list page with a link to the product page (element 1), and the product page with a link back. */
export function shopPages(): PageSpec[] {
  return [
    {
      url: SHOP_LIST_URL,
      title: 'Items List',
      text: ['Item 42 available for 99 USD', 'Item 43 available for 120 USD'],
      elements: [link('Item 42 Details', SHOP_PRODUCT_URL)],
    },
    {
      url: SHOP_PRODUCT_URL,
      title: 'Item 42 Details',
      text: ['Price: 99 USD', 'In Stock'],
      elements: [link('Back', SHOP_LIST_URL)],
    },
  ];
}

/** A plan reply of one reference site. */
export function shopPlan(sites?: Array<Record<string, unknown>>): string {
  return JSON.stringify({
    taskKind: 'action',
    sites: sites ?? [{ id: 's1', name: 'shop.test', domain: 'shop.test', role: 'reference', kind: 'page', goal: 'Do task' }],
  });
}

/** The replies a model gives: one JSON string per action. */
export const act = {
  click: (elementId: number, reason = 'Open it'): string => JSON.stringify({ action: 'click', element_id: elementId, reason }),
  finish: (answer: string): string => JSON.stringify({ action: 'finish', answer }),
  subgoalDone: (summary: string, evidence = 'the text is on the page'): string => JSON.stringify({ action: 'subgoal_done', summary, evidence }),
  askUser: (question: string): string => JSON.stringify({ action: 'ask_user', question }),
  scroll: (direction: 'up' | 'down' = 'down', amount = 300): string => JSON.stringify({ action: 'scroll', direction, amount }),
  navigate: (url: string, reason = 'Navigate'): string => JSON.stringify({ action: 'navigate', url, reason }),
  goBack: (reason = 'Go back'): string => JSON.stringify({ action: 'go_back', reason }),
  goForward: (reason = 'Go forward'): string => JSON.stringify({ action: 'go_forward', reason }),
  type: (elementId: number, text: string, submit = false, reason = 'Type text'): string => JSON.stringify({ action: 'type', element_id: elementId, text, submit, reason }),
  pressKey: (key: string, reason = 'Press key'): string => JSON.stringify({ action: 'press_key', key, reason }),
  wait: (amount = 1, reason = 'Wait'): string => JSON.stringify({ action: 'wait', amount, reason }),
  readPageText: (reason = 'Read page text'): string => JSON.stringify({ action: 'read_page_text', reason }),
  executeJs: (code: string, reason = 'Run code'): string => JSON.stringify({ action: 'execute_js', code, reason }),
  openWindow: (url: string, reason = 'Open window'): string => JSON.stringify({ action: 'open_window', url, reason }),
  readNetworkRequests: (filter: Record<string, any> = {}, reason = 'Read requests'): string => JSON.stringify({ action: 'read_network_requests', filter, reason }),
  browserBatch: (steps: any[], reason = 'Run batch'): string => JSON.stringify({ action: 'browser_batch', steps, reason }),
};
