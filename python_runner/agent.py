#!/usr/bin/env python3
"""
ScoutFox Standalone AI Agentic Browser (Python + Playwright)
Runs web browser automation directly from terminal using local Ollama (8B/9B/14B/27B) or Cloud LLMs.
No Chrome Extension or $5 developer account required!
"""

import sys
import json
import time
import re
import os
import argparse
import urllib.request
import urllib.parse
try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sync_playwright = None

SYSTEM_PROMPT = """You are an autonomous web browsing AI agent.
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

### Output Format Rules:
- First, output your reasoning inside <thought>...</thought>.
- Second, output your exact single action inside a valid JSON block inside ```json ... ```.
- ONLY select element_id numbers that exist in the provided Interactive Elements list.
"""

# Mirrors normalizeNvidiaBaseUrl in src/background/llm/settings.ts.
# Strips /chat/completions, /models, and /v1; maps build.nvidia.com to integrate.api.nvidia.com.
def clean_base_url(url: str) -> str:
    url = url.strip().rstrip('/')
    if "build.nvidia.com" in url:
        url = "https://integrate.api.nvidia.com"
    for suffix in ['/chat/completions', '/models', '/v1']:
        if url.endswith(suffix):
            url = url[:-len(suffix)].rstrip('/')
    return url

def list_available_models(provider, base_url, api_key="", timeout=30):
    """Dynamically fetch available models from provider API"""
    base_url = clean_base_url(base_url)
    api_key = (api_key or "").strip()
    if api_key.lower().startswith("bearer "):
        api_key = api_key[7:].strip()
    api_key = api_key.strip('"\'')
    try:
        if provider == "ollama":
            url = f"{base_url}/api/tags"
            with urllib.request.urlopen(url, timeout=timeout) as resp:
                data = json.loads(resp.read().decode('utf-8'))
                return [m['name'] for m in data.get('models', [])]
        elif provider in ["openai", "openai_compatible", "nvidia"]:
            url = f"{base_url}/v1/models"
            headers = {}
            if api_key:
                headers['Authorization'] = f"Bearer {api_key}"
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = json.loads(resp.read().decode('utf-8'))
                raw_models = [m['id'] for m in data.get('data', []) if isinstance(m, dict) and isinstance(m.get('id'), str)]
                if provider == "nvidia":
                    non_chat = re.compile(r'embed|rerank|guard|safety|clip', re.IGNORECASE)
                    raw_models = [m for m in raw_models if not non_chat.search(m)]
                return sorted(raw_models)
    except Exception as e:
        print(f"⚠️ Could not fetch dynamic models: {e}")
        return []
    return []

def extract_dom_elements(page, max_elements=120):
    """
    Extract visible interactive elements from page and assign numerical IDs [1], [2], [3]
    """
    js_script = """
    (maxElements) => {
      const selectors = [
        'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea',
        '[role="button"]', '[role="link"]', '[role="checkbox"]', '[tabindex="0"]'
      ];
      const candidates = Array.from(document.querySelectorAll(selectors.join(',')));
      const elements = [];
      let count = 0;

      const oldContainer = document.getElementById('scoutfox-py-badges');
      if (oldContainer) oldContainer.remove();

      const badgeContainer = document.createElement('div');
      badgeContainer.id = 'scoutfox-py-badges';
      badgeContainer.style.position = 'absolute';
      badgeContainer.style.top = '0';
      badgeContainer.style.left = '0';
      badgeContainer.style.width = '100%';
      badgeContainer.style.height = '100%';
      badgeContainer.style.pointerEvents = 'none';
      badgeContainer.style.zIndex = '2147483647';
      document.body.appendChild(badgeContainer);

      for (const el of candidates) {
        if (count >= maxElements) break;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;

        count++;
        const id = count;
        el.setAttribute('data-agent-id', id);

        const tagName = el.tagName.toLowerCase();
        const type = el.getAttribute('type') || '';
        let label = (
          el.getAttribute('aria-label') ||
          el.getAttribute('placeholder') ||
          el.getAttribute('title') ||
          el.innerText ||
          el.textContent ||
          ''
        ).replace(/\\s+/g, ' ').trim();

        if (label.length > 50) label = label.substring(0, 47) + '...';

        let valStr = '';
        if (el.value) {
          valStr = ` value="${el.value.length > 30 ? el.value.substring(0, 27) + '...' : el.value}"`;
        }

        let tagDesc = tagName;
        if (type) tagDesc += `:${type}`;

        const formatted = `[${id}] ${tagDesc}${label ? ` "${label}"` : ''}${valStr}`;
        elements.push({ id, formatted, selector: `[data-agent-id="${id}"]` });

        const badge = document.createElement('div');
        badge.textContent = id;
        badge.style.position = 'absolute';
        badge.style.top = `${rect.top + window.scrollY}px`;
        badge.style.left = `${rect.left + window.scrollX}px`;
        badge.style.backgroundColor = '#ec4899';
        badge.style.color = '#ffffff';
        badge.style.fontFamily = 'monospace';
        badge.style.fontSize = '11px';
        badge.style.fontWeight = 'bold';
        badge.style.padding = '1px 5px';
        badge.style.borderRadius = '4px';
        badge.style.transform = 'translate(-40%, -40%)';
        badgeContainer.appendChild(badge);
      }

      return {
        title: document.title,
        url: window.location.href,
        elements
      };
    }
    """
    return page.evaluate(js_script, max_elements)

def call_ollama(base_url, model, messages, timeout=120):
    url = f"{base_url.rstrip('/')}/api/chat"
    payload = {
        "model": model,
        "messages": messages,
        "stream": False,
        "options": {"temperature": 0.1}
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode('utf-8'),
        headers={'Content-Type': 'application/json'}
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            return data.get('message', {}).get('content', '')
    except Exception as e:
        print(f"❌ Error connecting to Ollama: {e}")
        sys.exit(1)

def call_openai_compatible(base_url, api_key, model, messages, timeout=120):
    url = f"{clean_base_url(base_url)}/v1/chat/completions"
    payload = {
        "model": model,
        "messages": messages,
        "temperature": 0.1
    }
    headers = {'Content-Type': 'application/json'}
    if api_key:
        headers['Authorization'] = f"Bearer {api_key}"

    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode('utf-8'),
        headers=headers
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            return data['choices'][0]['message']['content']
    except Exception as e:
        print(f"❌ Error connecting to API: {e}")
        sys.exit(1)

def parse_action(text):
    thought = ""
    thought_match = re.search(r'<thought>([\s\S]*?)</thought>', text, re.IGNORECASE)
    if thought_match:
        thought = thought_match.group(1).strip()

    json_str = ""
    code_match = re.search(r'```(?:json)?\s*([\s\S]*?)\s*```', text, re.IGNORECASE)
    if code_match:
        json_str = code_match.group(1).strip()
    else:
        brace_match = re.search(r'\{[\s\S]*"action"[\s\S]*\}', text, re.IGNORECASE)
        if brace_match:
            json_str = brace_match.group(0).strip()

    if not json_str:
        return thought, None, "No JSON block found"

    try:
        action_obj = json.loads(json_str)
        return thought, action_obj, None
    except Exception as e:
        return thought, None, f"JSON parse error: {e}"

def run_agent(goal, start_url, provider, base_url, api_key, model, max_steps, headless, timeout=None):
    if sync_playwright is None:
        print("❌ Playwright is not installed. Install it with: pip install playwright && playwright install chromium")
        sys.exit(1)

    print(f"\n🦊 Launching ScoutFox Standalone Agent...")
    print(f"🎯 Goal: {goal}")
    print(f"🌐 Start URL: {start_url}")
    print(f"🦙 Provider: {provider} | Model: {model}\n")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless)
        page = browser.new_page()
        page.goto(start_url)
        page.wait_for_load_state('domcontentloaded')

        messages = [{"role": "system", "content": SYSTEM_PROMPT}]

        for step in range(1, max_steps + 1):
            print(f"\n--- 📍 Step {step}/{max_steps} ---")

            snapshot = extract_dom_elements(page)
            elements_text = "\n".join([e['formatted'] for e in snapshot['elements']])

            step_msg = f"""Goal: {goal}
Current Page Title: "{snapshot['title']}"
Current URL: {snapshot['url']}

Interactive Elements:
{elements_text or '(No elements found)'}

Choose your next action:"""

            current_messages = messages + [{"role": "user", "content": step_msg}]

            effective_timeout = timeout if timeout is not None else (300 if provider == "nvidia" else 120)
            if provider == "ollama":
                response_text = call_ollama(base_url, model, current_messages, timeout=effective_timeout)
            else:
                response_text = call_openai_compatible(base_url, api_key, model, current_messages, timeout=effective_timeout)

            thought, action, err = parse_action(response_text)

            if thought:
                print(f"💭 Thought: {thought}")

            if err or not action:
                print(f"⚠️ Action parse error: {err}. Retrying...")
                messages.append({"role": "assistant", "content": response_text})
                messages.append({"role": "user", "content": f"Failed to parse action: {err}. Please output valid JSON format."})
                continue

            print(f"⚡ Action: {json.dumps(action)}")

            act_type = action.get("action")

            if act_type == "finish":
                print(f"\n🎉 Task Completed!")
                print(f"💡 Final Answer: {action.get('answer', action.get('reason'))}\n")
                time.sleep(3)
                browser.close()
                return

            if act_type == "click":
                el_id = action.get("element_id")
                page.locator(f'[data-agent-id="{el_id}"]').click()
                page.wait_for_timeout(1000)

            elif act_type == "type":
                el_id = action.get("element_id")
                txt = action.get("text", "")
                submit = action.get("submit", False)
                loc = page.locator(f'[data-agent-id="{el_id}"]')
                loc.fill(txt)
                if submit:
                    loc.press("Enter")
                page.wait_for_timeout(1000)

            elif act_type == "scroll":
                direction = action.get("direction", "down")
                amount = action.get("amount", 500)
                delta = amount if direction == "down" else -amount
                page.mouse.wheel(0, delta)
                page.wait_for_timeout(500)

            elif act_type == "navigate":
                url = action.get("url")
                page.goto(url)
                page.wait_for_load_state('domcontentloaded')

            elif act_type == "go_back":
                page.go_back()

            messages.append({"role": "assistant", "content": response_text})
            messages.append({"role": "user", "content": f"Action {act_type} executed successfully."})
            time.sleep(1)

        print("\n⚠️ Reached maximum step limit.")
        browser.close()

def build_arg_parser():
    parser = argparse.ArgumentParser(description="ScoutFox Standalone AI Agentic Browser")
    parser.add_argument("--goal", type=str, default="Search Google for open source AI agents", help="User task goal")
    parser.add_argument("--url", type=str, default="https://google.com", help="Initial webpage URL")
    parser.add_argument("--provider", type=str, default="ollama", choices=["ollama", "openai", "nvidia"], help="LLM Provider")
    # No single default can be right for all providers. A fixed Ollama default meant
    # `--provider openai` sent the user's OpenAI key to http://localhost:11434, so the key
    # went to whatever was listening on that port and the error gave no hint why.
    parser.add_argument("--base-url", type=str, default=None,
                        help="API Base URL (defaults per provider: Ollama localhost, OpenAI api.openai.com, NVIDIA integrate.api.nvidia.com/v1)")
    parser.add_argument("--api-key", type=str, default=None,
                        help="API key. Defaults to $OPENAI_API_KEY or $NVIDIA_API_KEY so it need not appear in shell history.")
    parser.add_argument("--model", type=str, default=None,
                        help="Model name (defaults per provider: qwen3.5:9b for Ollama, gpt-5.4 for OpenAI, meta/llama-3.3-70b-instruct for NVIDIA)")
    parser.add_argument("--timeout", type=int, default=None,
                        help="LLM request timeout in seconds (default: 300 for nvidia, 120 for openai/others)")
    parser.add_argument("--list-models", action="store_true", help="List all available models dynamically from provider API")
    parser.add_argument("--max-steps", type=int, default=20, help="Max execution steps")
    parser.add_argument("--headless", action="store_true", help="Run browser in background headless mode")
    return parser

def resolve_args(args, environ=None):
    if environ is None:
        environ = os.environ

    if not args.api_key:
        if args.provider == "nvidia":
            args.api_key = environ.get("NVIDIA_API_KEY", "")
        elif args.provider == "openai":
            args.api_key = environ.get("OPENAI_API_KEY", "")
        else:
            args.api_key = ""

    PROVIDER_DEFAULT_BASE_URL = {
        "ollama": "http://localhost:11434",
        "openai": "https://api.openai.com/v1",
        "nvidia": "https://integrate.api.nvidia.com/v1",
    }
    PROVIDER_DEFAULT_MODEL = {
        "ollama": "qwen3.5:9b",
        "openai": "gpt-5.4",
        "nvidia": "meta/llama-3.3-70b-instruct",
    }
    PROVIDER_DEFAULT_TIMEOUT = {
        "nvidia": 300,
        "openai": 120,
        "ollama": 120,
    }
    if args.base_url is None:
        args.base_url = PROVIDER_DEFAULT_BASE_URL[args.provider]
    if args.model is None:
        args.model = PROVIDER_DEFAULT_MODEL[args.provider]
    if args.timeout is None:
        args.timeout = PROVIDER_DEFAULT_TIMEOUT.get(args.provider, 120)

    return args

def validate_args(args):
    if not args.list_models and args.provider != "ollama" and not args.api_key:
        env_var = "NVIDIA_API_KEY" if args.provider == "nvidia" else "OPENAI_API_KEY"
        raise ValueError(
            f"Provider '{args.provider}' requires an API key. "
            f"Pass --api-key or set ${env_var} in your environment."
        )

    if args.provider != "ollama" and args.api_key:
        host = urllib.parse.urlparse(args.base_url).hostname or ""
        if host in ("localhost", "127.0.0.1", "::1", "0.0.0.0"):
            raise ValueError(
                f"Refusing to send a {args.provider} API key to {args.base_url}. "
                f"Pass --base-url for your provider, or drop --api-key if you meant to use Ollama."
            )

if __name__ == "__main__":
    parser = build_arg_parser()
    args = parser.parse_args()
    args = resolve_args(args)

    try:
        validate_args(args)
    except ValueError as e:
        parser.error(str(e))

    if args.list_models:
        print(f"\n🔍 Fetching dynamic models from {args.provider} at {args.base_url}...")
        models = list_available_models(args.provider, args.base_url, args.api_key)
        if models:
            print("\n✅ Available Models:")
            for m in models:
                print(f"  - {m}")
        else:
            print("⚠️ No models returned or API endpoint unreachable.")
        sys.exit(0)

    run_agent(
        goal=args.goal,
        start_url=args.url,
        provider=args.provider,
        base_url=args.base_url,
        api_key=args.api_key,
        model=args.model,
        max_steps=args.max_steps,
        headless=args.headless,
        timeout=args.timeout
    )
