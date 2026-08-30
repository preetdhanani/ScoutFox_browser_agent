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

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer Mode** (top-right toggle).
3. Click **Load unpacked** and select this directory.
4. Open any webpage (e.g. `https://google.com`), open the ScoutFox Side Panel, and test your changes!

## Code Guidelines
* Keep DOM distillation light (<2,500 tokens).
* Run `node --check` across JS files before submitting PRs.
* Follow standard ES6 module imports.
