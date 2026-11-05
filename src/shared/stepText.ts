/**
 * The sentence a person reads for one step of the agent: what it is doing and why.
 *
 * The log view shows it above the step's details ("Clicking [12] "In den Warenkorb" - to add the
 * laptop to the cart"), so a reader follows the run without opening any JSON. Built only from the
 * tool, its arguments, the model's own reason and the label of the element it targets.
 */

/** A value cut to a readable length for one sentence. */
function short(value: unknown, max = 80): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * @param tool    the tool the model called
 * @param args    its arguments
 * @param label   the element line the target id stands for, when known ("[12] button \"Buy\"")
 */
export function describeStep(tool: string, args: Record<string, any> = {}, label = ''): string {
  // "[12] button[button] \"Buy\"" reads as: button "Buy" (the id is said already, the type twice).
  const target = label ? short(label.replace(/^\s*\[\d+\]\s*/, '').replace(/^([a-z0-9-]+)\[[^\]]*\]/i, '$1'), 60) : '';
  const element = (id: unknown) => `element [${id}]${target ? ` ${target}` : ''}`;
  let what: string;
  switch (tool) {
    case 'navigate': what = `Opening ${short(args.url, 120)}`; break;
    case 'click':
      what = args.element_id !== undefined && args.element_id !== null
        ? `Clicking ${element(args.element_id)}`
        : `Clicking at (${args.x}, ${args.y}) on the screenshot`;
      break;
    case 'type': {
      const into = args.element_id !== undefined && args.element_id !== null ? element(args.element_id) : 'the focused element';
      what = `${args.mode === 'append' ? 'Appending' : 'Typing'} "${short(args.text, 60)}" ${args.mode === 'append' ? 'to' : 'into'} ${into}${args.submit ? ' and submitting' : ''}`;
      break;
    }
    case 'press_key': {
      const mods = Array.isArray(args.modifiers) ? args.modifiers.map((m: unknown) => String(m)) : [];
      const names: Record<string, string> = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Meta' };
      const key = args.key === 'select_all' ? 'select all' : String(args.key ?? '');
      what = `Pressing ${[...mods.map((m: string) => names[m] || m), key].join('+')}`;
      break;
    }
    case 'scroll':
      what = `Scrolling ${args.direction || 'down'}${args.element_id !== undefined && args.element_id !== null ? ` the area of ${element(args.element_id)}` : args.x !== undefined && args.y !== undefined ? ` at (${args.x}, ${args.y}) on the screenshot` : ''}`;
      break;
    case 'read_page': {
      const part = Number.isInteger(args.part) && args.part > 1 ? ` (part ${args.part})` : '';
      what = args.element_id !== undefined && args.element_id !== null ? `Reading the text of ${element(args.element_id)}${part}` : `Reading the page text${part}`;
      break;
    }
    case 'web_search': what = `Searching the web for "${short(args.query, 80)}"`; break;
    case 'fetch_url': {
      const part = Number.isInteger(args.part) && args.part > 1 ? ` (part ${args.part})` : '';
      const lines = typeof args.query === 'string' && args.query.trim() ? `, lines with "${short(args.query, 40)}"` : '';
      what = `Fetching ${short(args.url, 120)}${part}${lines}`;
      break;
    }
    case 'get_page_elements': what = 'Listing the elements on the page it can act on'; break;
    case 'find': what = `Searching the page for "${short(args.query, 60)}"`; break;
    case 'take_screenshot': what = 'Taking a screenshot to look at the page'; break;
    case 'wait': what = `Waiting ${Number(args.amount) || 0} s for the page`; break;
    case 'go_back': what = 'Going back to the previous page'; break;
    case 'go_forward': what = 'Going forward'; break;
    case 'update_plan': {
      const steps = Array.isArray(args.plan) ? args.plan.length : 0;
      const done = Array.isArray(args.done) ? args.done.length : 0;
      what = steps
        ? `Planning the work in ${steps} step${steps === 1 ? '' : 's'}`
        : `Marking ${done} plan step${done === 1 ? '' : 's'} done`;
      break;
    }
    case 'save_data': {
      const n = Array.isArray(args.records) ? args.records.length : 0;
      what = `Saving ${n} record${n === 1 ? '' : 's'}`;
      break;
    }
    case 'finish': what = 'Finishing with the answer'; break;
    default: what = `Calling ${tool}`;
  }
  const reason = short(args.reason, 140);
  return reason ? `${what} - ${reason}` : what;
}
