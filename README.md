# ScoutFox AI Browser Agent

ScoutFox is an open-source Chrome extension that uses an AI model to work in your browser for you.
You write a task in plain words in the side panel, and ScoutFox opens the websites, reads them, clicks, types and scrolls until it has your answer.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## What it can do

- **Answer questions from the web.** Ask "What is the latest React version on npm?" and it finds the right site, reads the page and answers with its source.
- **Do multi-step tasks.** It plans the work as a checklist, visits several sites, compares what it finds and checks off each step.
- **Use the page like a person.** It clicks links and buttons, fills in fields, searches, scrolls, goes back, and handles cookie banners.
- **Look at the page.** With a model that can see pictures, it takes a screenshot when the text is not enough and can click what it sees.
- **Work with many AI models.** OpenRouter, AgentRouter, Google Gemini, OpenAI, Anthropic Claude, NVIDIA NIM, Groq and other OpenAI-compatible servers, local models through Ollama, or your own custom endpoint.

## How it works for you

- **One session per tab.** Each tab has its own task, history and Stop button, so two tabs can run different tasks at the same time.
- **Your tabs stay yours.** Tabs the agent works in go into an orange ScoutFox tab group, and tabs you open yourself are never touched.
- **You can watch every step.** The side panel shows each action as it happens, and you can pause, resume or stop the run at any time.
- **Honest results.** The final card says whether the task is done, unconfirmed, failed, or stopped by you, so a run that did not work never looks like a success.
- **History and logs.** You can reopen past runs, and the Logs tab shows every model call and step when you want to know what happened.

## Safety

- It never types passwords, card numbers or one-time codes.
- It never tries to solve a CAPTCHA or bot check: it stops and tells you that a person has to pass it.
- Password, card and code fields are hidden before a screenshot is sent to the model.

## License

ScoutFox is released under the [MIT License](LICENSE).
See [CONTRIBUTING.md](CONTRIBUTING.md) to help, and [DEVELOPMENT.md](DEVELOPMENT.md) for building and testing it.
