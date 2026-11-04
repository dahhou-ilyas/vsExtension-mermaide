# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [2.0.0] - 2026-11-04

A complete rewrite of the extension.

### Added
- TypeScript, JSX and TSX support, plus `.mjs` / `.cjs` files.
- Flowchart of the function under the cursor (no selection needed), CodeLens above every function, editor title button and the <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>G</kbd> shortcut.
- **Generate Flowchart for Entire File**, **Show Flowchart Panel** and **Clear Flowchart History** commands.
- Full control-flow support: `else if`, `switch` with fall-through, `for…of` / `for…in` / `do…while`, labeled `break` / `continue`, `throw`, `try / catch / finally`, nested functions, classes and object methods.
- Detection of unreachable code.
- Clicking a node opens the matching source range, and the node under the editor cursor is highlighted live.
- Metrics: cyclomatic and cognitive complexity, lines, parameters, nesting depth and statement counts, with a per-function table.
- Insights with links to the code: unreachable code, empty `catch`, `await` in loops, deep nesting, high complexity and more.
- Export to SVG, PNG and Markdown, plus copying the Mermaid definition.
- Zoom, fit to width, drag to pan, filtering, regeneration and per-workspace history that survives reloads.
- Settings for direction, theme, label length, statement grouping, CodeLens and history size.
- Unit and integration tests, CI workflow and automated Marketplace / Open VSX release.

### Fixed
- The first flowchart never appeared because the panel was sent data before it was ready.
- Diagrams broke on the `end` node, a reserved word in Mermaid.
- Function bodies were not connected to the end of the flow, and `return` did not stop the flow.
- Labels containing quotes, `<`, `>` or backticks broke rendering.
- Non-ASCII characters were corrupted (base64 decoding with `atob`).
- Flowcharts were not saved, and duplicates piled up.
- The extension shipped its whole `node_modules` folder and required a network connection (Tailwind CDN).

### Removed
- The unused Hugging Face / GPT-2 experiment and its dependencies (`@huggingface/inference`, `dotenv`, `chart.js`, `path`).

## [1.0.2]

- Initial public release.
