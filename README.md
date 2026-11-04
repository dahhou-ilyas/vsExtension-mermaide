# Flowchart Generator

**Turn JavaScript and TypeScript functions into interactive flowcharts, right inside VS Code.**

Flowchart Generator parses your code, builds its real control-flow graph and renders it with Mermaid. Click any node to jump to the code. The panel also shows complexity metrics and actionable insights, and you can export diagrams to SVG, PNG or Markdown.

![Flowchart Generator panel](media/screenshot.png)

## Features

- **Accurate control flow**: `if / else if / else`, `switch` (with fall-through), `for`, `for…of`, `for…in`, `while`, `do…while`, `break` / `continue` (including labels), `return`, `throw`, `try / catch / finally`, `async` / `await`.
- **JavaScript, TypeScript, JSX and TSX**: functions, arrow functions, class methods, getters/setters, object methods, CommonJS exports and loose statements.
- **Smart targeting**: select code, or just put the cursor inside a function. You can also click the **Flowchart** CodeLens above any function.
- **Click to navigate**: every node is linked to its source range. Click a node to open and select the matching code.
- **Live cursor sync**: moving the cursor in the editor highlights the matching node in the diagram.
- **Code metrics**: cyclomatic complexity (McCabe), cognitive complexity (SonarSource), lines, parameters, nesting depth, branches, loops, returns, throws, awaits and calls.
- **Insights**: unreachable code, empty `catch` blocks, `await` inside loops, deep nesting, high complexity, long functions, too many parameters, recursion, missing `default` cases and leftover `debugger` statements. Each insight links to its line.
- **Multiple functions at once**: each function is drawn in its own titled group, with a per-function metrics table.
- **Export**: SVG, high-resolution PNG, Markdown (a `mermaid` code block, which renders on GitHub and GitLab) or the raw Mermaid definition copied to the clipboard.
- **Comfortable viewer**: zoom (buttons or <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + wheel), fit to width, drag to pan, filtering and keyboard navigation.
- **Theme aware**: follows the light, dark and high-contrast VS Code themes, or uses a Mermaid theme of your choice.
- **History**: flowcharts are kept per workspace and survive reloads. Use **Regenerate** to refresh one after editing the code.
- **Private by design**: all analysis runs locally. No network access and no telemetry, and the webview runs under a strict Content Security Policy.

## Usage

| Action | How |
| --- | --- |
| Flowchart of the function under the cursor | <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>G</kbd> (<kbd>⌘</kbd>+<kbd>⌥</kbd>+<kbd>G</kbd> on macOS) |
| Flowchart of the selection | Select code, then use the same shortcut or right-click → **Generate Flowchart** |
| Flowchart of a specific function | Click the **Flowchart** CodeLens above it |
| Flowchart of the entire file | Command Palette → **Flowchart: Generate Flowchart for Entire File** |
| Reopen the panel | Command Palette → **Flowchart: Show Flowchart Panel** |
| Delete all flowcharts | Command Palette → **Flowchart: Clear Flowchart History** |

### Reading the diagram

| Shape | Meaning |
| --- | --- |
| Green stadium | Function entry |
| Grey stadium | End of the function |
| Rectangle | Statements (consecutive simple statements are grouped) |
| Yellow diamond | `if` / `switch` condition |
| Purple hexagon | Loop header |
| Blue rounded box | `return` |
| Red flag | `throw` |
| Orange box | `try` / `catch` / `finally` |
| Cyan border | Contains `await` |
| Dashed grey box | Unreachable code |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `flowchartGenerator.direction` | `TD` | Layout direction: `TD` (top to bottom) or `LR` (left to right). |
| `flowchartGenerator.theme` | `auto` | `auto` follows VS Code; or `default`, `dark`, `forest`, `neutral`. |
| `flowchartGenerator.maxLabelLength` | `60` | Characters shown in a node before truncation. |
| `flowchartGenerator.mergeSequentialStatements` | `true` | Group consecutive simple statements into one block. |
| `flowchartGenerator.maxStatementsPerBlock` | `4` | Maximum statements per grouped block. |
| `flowchartGenerator.codeLens.enabled` | `true` | Show the **Flowchart** CodeLens above functions. |
| `flowchartGenerator.showEditorTitleButton` | `true` | Show the generate button in the editor title bar. |
| `flowchartGenerator.openBeside` | `true` | Open the panel beside the editor. |
| `flowchartGenerator.historyLimit` | `30` | Number of flowcharts kept per workspace. |

## Requirements

VS Code 1.96 or newer. No other dependency: everything is bundled.

## Known limitations

- Exceptional control flow is simplified: any statement inside `try` may jump to `catch`, which is drawn as a single `error` edge from `try`.
- Callbacks passed inline (for example `items.forEach(x => …)`) appear as a single statement. Generate a flowchart for the callback itself to see its flow.
- Comments are not shown in the diagram.

## Development

```bash
npm install
npm run watch        # rebuild on change, then press F5 to launch the Extension Development Host
npm run lint
npm run test:unit    # fast parser tests (Node)
npm test             # unit + integration tests (downloads VS Code)
npm run vsix         # build a .vsix package
```

The architecture is described in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE.md)
