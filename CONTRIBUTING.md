# Contributing to ScoutFox AI Browser Agent

Thank you for your interest in contributing to **ScoutFox AI Browser Agent**!

## How to Contribute

### 1. Reporting Bugs
* Check existing GitHub Issues to see if the bug has already been reported.
* Open a new issue with detailed steps to reproduce, expected behavior, browser logs, and system details.

### 2. Suggesting Features
* Open an issue with the tag `enhancement`.
* Clearly describe the proposed feature and why it would be beneficial to users.

### 3. Pull Requests
1. Fork the repository: `https://github.com/preetdhanani/ScoutFox_browser_agent.git`
2. Create your feature branch: `git checkout -b feature/amazing-feature`
3. Commit your changes: `git commit -m 'Add amazing feature'`
4. Push to the branch: `git push origin feature/amazing-feature`
5. Open a Pull Request on GitHub.

## Development Setup

See **Quick Setup** in [README.md](README.md) to load the unpacked extension.
Run `npm run build` after each code change, and load the `dist/` folder in Chrome, not the repository folder.
Once it's loaded, open any webpage, open the ScoutFox Side Panel, and test your changes there before opening a PR.

## Code Guidelines
* Keep DOM distillation light (<2,500 tokens).
* Run `npm run check` (syntax of the plain JS files) and `npm run typecheck` (the TypeScript files) before submitting PRs.
* Follow standard ES6 module imports, and write every relative import with the file's extension (`./parse.ts`).
  Node runs the TypeScript files without a build step, so it cannot guess an extension.
  `tests/importSpecifiers.test.ts` fails on an import that names a file that is not there exactly as written.
* Run `npm test` before submitting a PR (see [DEVELOPMENT.md](DEVELOPMENT.md) for details).
* For bug-fix PRs specifically, it is recommended practice (not a hard requirement for every PR - a new feature test does not need this) to write a regression test, then briefly `git stash` the fix and confirm the new test actually fails, before finalizing.

## Next version (planned, decided 2026-09-28)

A LangGraph + TypeScript + Vite rework of the agent is underway.
It is decided.
Phases P0 through P6 (including Long-Horizon Worker, Risk Gate backend, and SidePanel UI overhaul) are built (see section 3 of [PRD.md](PRD.md) for roadmap details).
Today the shared core, provider integration, input dispatcher, and graph engine in `src/` are TypeScript (phases P1-P5d), with their tests.
The legacy engine, content scripts, and side panel are still plain JavaScript ES modules, and the extension is built with Vite (`npm run build`).
The background worker supports switching between legacy `AgentEngine` and graph `AgentRunner` behind `settings.engine`.
During the rework, put new agent logic into graph nodes.
Do not grow `background/agentEngine.js` with new logic.
The `node --check` guideline above will change once the rest of the code is TypeScript.
See section 3 of [PRD.md](PRD.md) for the full plan.
