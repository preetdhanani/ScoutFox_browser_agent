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
    case 'type': what = `Typing "${short(args.text, 60)}" into ${element(args.element_id)}${args.submit ? ' and submitting' : ''}`; break;
    case 'scroll': what = `Scrolling ${args.direction || 'down'}`; break;
    case 'get_page_text': what = 'Reading the page text'; break;
    case 'read_page_text': what = 'Scrolling down and reading more of the page'; break;
    case 'get_page_elements': what = 'Listing the elements on the page it can act on'; break;
    case 'find': what = `Searching the page for "${short(args.query, 60)}"`; break;
    case 'take_screenshot': what = 'Taking a screenshot to look at the page'; break;
    case 'wait': what = `Waiting ${Number(args.amount) || 0} s for the page`; break;
    case 'go_back': what = 'Going back to the previous page'; break;
    case 'go_forward': what = 'Going forward'; break;
    case 'update_plan': {
      const steps = Array.isArray(args.plan) ? args.plan.length : 0;
      what = `Planning the work in ${steps} step${steps === 1 ? '' : 's'}`;
      break;
    }
    case 'render_table': what = `Building a table of ${Array.isArray(args.rows) ? args.rows.length : 0} rows`; break;
    case 'finish': what = 'Finishing with the answer'; break;
    default: what = `Calling ${tool}`;
  }
  const reason = short(args.reason, 140);
  return reason ? `${what} - ${reason}` : what;
}
