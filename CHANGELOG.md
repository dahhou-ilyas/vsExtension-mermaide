# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [3.0.0] - 2026-11-04

### Added
- **Own rendering engine** replacing Mermaid in the panel:
  - a layered (Sugiyama) layout made for control flow: DFS cycle removal, longest-path layering, barycenter crossing reduction and exact overlap removal by isotonic regression;
  - loops in a right gutter and exceptional flow in a left gutter (VEIL), with edges to the same target sharing one lane;
  - callback / nested function flows laid out as a tree to the right of their parent;
  - SVG renderer with a **cyberpunk** style (neon chamfered panels, PCB-like traces with 45° bends, HUD tags and brackets, animated flow packets, scanlines) and a **minimal** style that follows the VS Code theme;
  - animated zoom around the pointer, drag to pan, double-click to fit, minimap, focus mode on hover, HUD tooltip with highlighted code, selection reticle, cursor-sync highlight, gliding nodes and morphing traces while editing;
  - self-contained SVG / PNG export.
- `flowchartGenerator.style` and `flowchartGenerator.animations` settings.
- Layout tests that check invariants (no overlap, attached and orthogonal edges, nodes inside their frame) on hundreds of real-world functions.

### Changed
- The panel bundle went from 3.6 MB to 324 KB.
- Mermaid is only used for text export (copy / Markdown); flowcharts saved by older versions are converted automatically.

### Removed
- `flowchartGenerator.theme` (Mermaid themes), replaced by `flowchartGenerator.style`.

## [2.2.0] - 2026-11-04

### Added
- **Inline callbacks as their own flows**: callbacks passed to calls (`forEach`, `map`, `then`, `setTimeout`, …), JSX event handlers, `new Promise(…)` executors and IIFEs are drawn as separate flows linked to their statement, with nested callbacks up to `flowchartGenerator.callbacks.maxDepth`. Statements show the callback body folded (`=> {…}`).
- **Nested function declarations** stay in their parent's code (a definition node) and their body is drawn as a linked flow.
- **Precise exceptional flow**: an `error` edge from every statement of a `try` block that may throw to its `catch` (or `finally`). `return` / `throw` go through `finally`, and an explicit "end finally" node continues with `then return` / `rethrow`. A `flowchartGenerator.exceptions: summary` setting restores the single edge.
- **Long labels are no longer cut**: they wrap on several lines, very long code folds nested brackets innermost first, every node has a tooltip with its full code, and a **full labels** toggle shows everything in the nodes. New `labels.mode`, `labels.lineWidth` and `labels.maxLines` settings.
- Legend entries for exception, `finally` and callback edges.
- Mermaid import understands subgraphs (one flow per function / callback), dashed exception / `finally` / callback edges, and rebuilds folded bodies from their linked flows.

### Fixed
Found by running the generator on 11,345 real-world functions:
- `{ … }` blocks that only scope `let` / `const` were flattened, which redeclared variables.
- `case` bodies declaring variables are wrapped in a block.
- `switch` cases were sometimes regenerated in a different order.
- Infinite loops left only through `return`, and loops with both `break` and `return`, fell back to a state machine.
- Merge points located after an enclosing `case` / loop boundary produced unstructured code.
- The end of a `finally` block containing conditions could not be found.
- Anonymous function expressions were regenerated with an invalid name.
- Multi-line statements were indented 4 extra spaces.
- In labels: comments swallowed the rest of an expression, and double quotes and HTML entities in strings did not survive a Mermaid round trip.

## [2.1.0] - 2026-11-04

### Added
- **Flowchart → code**: edit a chart visually (edit nodes, insert steps / conditions / loops / returns / throws, delete, rename the function) with a live preview of the generated code and undo / redo.
- **Apply to source** with a diff preview. The original indentation is kept, and the change is refused if the source changed since the chart was generated.
- **Flowchart: New Flowchart** command to design a function from scratch, with **Insert at cursor** and **Open as new file**.
- **Flowchart: Generate Code from Mermaid Flowchart** command, which imports any Mermaid flowchart (Markdown blocks included) and generates its code.
- Structured code generation (if / else if, loops, switch with fall-through, try / catch / finally, labeled break / continue only when needed) with an equivalent state-machine fallback for unstructured charts.
- Round-trip tests that execute the original and the regenerated code and compare their results.

### Changed
- Flowcharts are now stored as an editable graph that keeps the full source of every node. Labels are only truncated for display.

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
