# Flowchart Generator

```text
   ╭───────╮     ███████╗██╗      ██████╗ ██╗    ██╗ ██████╗██╗  ██╗ █████╗ ██████╗ ████████╗
   ╰───┬───╯     ██╔════╝██║     ██╔═══██╗██║    ██║██╔════╝██║  ██║██╔══██╗██╔══██╗╚══██╔══╝
  ┌────◆────┐    █████╗  ██║     ██║   ██║██║ █╗ ██║██║     ███████║███████║██████╔╝   ██║
 ┌┴─┐     ┌─┴┐   ██╔══╝  ██║     ██║   ██║██║███╗██║██║     ██╔══██║██╔══██║██╔══██╗   ██║
 └┬─┘     └─┬┘   ██║     ███████╗╚██████╔╝╚███╔███╔╝╚██████╗██║  ██║██║  ██║██║  ██║   ██║
  └────┬────┘    ╚═╝     ╚══════╝ ╚═════╝  ╚══╝╚══╝  ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝
       ●          G E N E R A T O R   ·   code ⇄ flowchart for VS Code
```

**Turn JavaScript and TypeScript into interactive flowcharts, and flowcharts back into code, right inside VS Code.**

Flowchart Generator parses your code, builds its real control-flow graph and draws it with its **own rendering engine**: a layered layout made for control flow, classic flowchart symbols, smooth curved arrows, focus mode and minimap. Click any node to jump to the code. The panel also shows complexity metrics and actionable insights.

It also works in the other direction: **edit the chart and the code is regenerated live**. You can then apply it to your source after reviewing a diff, design a function from scratch, or convert any Mermaid flowchart into code.

![Flowchart Generator: classic flowchart of a function with nested loops](media/loops.jpg)

## Features

### Rendering engine

Flowcharts are drawn by a purpose-built engine (no Mermaid, no layout library):

- **Classic flowchart symbols (ISO 5807).** Terminators for start / end / return, rectangles for statements, diamonds for conditions, the "preparation" hexagon for loops, and the "predefined process" symbol (side bars) for `try` / `catch` / `finally` and nested function definitions. Colours follow the VS Code light or dark theme.
- **A straight main path.** Each node picks the child that leads to the longest continuation and is aligned on it (the vertical-alignment idea of Brandes & Köpf, used by dagre), so the main flow is a straight line. Secondary branches leave a condition from its side vertices, as in hand-drawn flowcharts.
- **Smooth curved arrows** with short `Yes` / `No` labels next to the branch.
- **Layered layout made for control flow.** It uses the Sugiyama method (cycle removal, layering, crossing reduction), with coordinates computed by exact least-squares overlap removal (isotonic regression). Following the VEIL study of CFG readability, loops run in a gutter on the right and enter their loop from the side; exceptional flow runs in a gutter on the left.
- **Calm by default.** Exception, `finally` and callback links are drawn faintly and highlighted when you hover a node. Line numbers and full code are in the tooltip.
- **Fluid interaction.** Animated zoom around the pointer (<kbd>Ctrl</kbd>/<kbd>⌘</kbd> + wheel or pinch), drag to pan, double-click to fit, and a minimap. Hovering a node dims everything else and shows a tooltip with its highlighted code. In the editor, nodes glide to their new place and arrows morph.
- **Light and fast.** The panel bundle is about 11× smaller than with Mermaid, and laying out a function takes 0.4 ms on average.
- **Self-contained exports.** SVG and PNG exports embed their resolved colours. Mermaid text is still available (copy / Markdown) for documentation.
- **Optional `cyberpunk` style.** Neon panels, circuit-board traces and animated flow on a dark grid.

| Focus mode & tooltip | Dark theme, exceptions | `cyberpunk` style |
| --- | --- | --- |
| ![Focus mode](media/focus.jpg) | ![Dark theme](media/exceptions.jpg) | ![Cyberpunk style](media/cyberpunk.jpg) |

### Code → flowchart

- **Accurate control flow**: `if / else if / else`, `switch` (with fall-through), `for`, `for…of`, `for…in`, `while`, `do…while`, `break` / `continue` (including labels), `return`, `throw`, `try / catch / finally`, `async` / `await`.
- **Inline callbacks as their own flows**: `items.forEach(x => {…})`, `promise.then(…)`, `onClick={() => {…}}`, IIFEs and nested functions are drawn as separate, linked flows (nested callbacks up to a configurable depth). The statement shows the body folded (`=> {…}`), so it is not repeated.
- **Precise exceptions**: like Soot's exceptional CFG, only statements that can throw (calls, `new`, `await`, `throw`, …) get an `error` edge to their `catch`. `return` and `throw` go through `finally`, and an explicit "end finally" node continues with `then return` / `rethrow`.
- **Readable long code**: labels wrap on several lines instead of being cut, and very long code folds nested brackets innermost first (`fetch(url, { headers: {…}, retry: 3 })`). The full code is in every node's tooltip, and the **full labels** toggle shows it in the nodes.
- **JavaScript, TypeScript, JSX and TSX**: functions, arrow functions, class methods, getters/setters, object methods, CommonJS exports and loose statements.
- **Smart targeting**: select code, or just put the cursor inside a function. You can also click the **Flowchart** CodeLens above any function.
- **Click to navigate**: every node is linked to its source range. Click a node to open and select the matching code.
- **Live cursor sync**: moving the cursor in the editor highlights the matching node in the diagram.
- **Code metrics**: cyclomatic complexity (McCabe), cognitive complexity (SonarSource), lines, parameters, nesting depth, branches, loops, returns, throws, awaits and calls.
- **Insights**: unreachable code, empty `catch` blocks, `await` inside loops, deep nesting, high complexity, long functions, too many parameters, recursion, missing `default` cases and leftover `debugger` statements. Each insight links to its line.
- **Multiple functions at once**: each function is drawn in its own titled group, with a per-function metrics table.
- **Export**: SVG and high-resolution PNG (rendered by the engine), Markdown (a `mermaid` code block, which renders on GitHub and GitLab) or the Mermaid definition copied to the clipboard.
- **Comfortable viewer**: zoom (buttons or <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + wheel), fit to width, drag to pan, filtering and keyboard navigation.
- **Two styles**: `classic` (default; follows the VS Code light / dark theme) or `cyberpunk`.
- **History**: flowcharts are kept per workspace and survive reloads. Use **Regenerate** to refresh one after editing the code.
- **Private by design**: all analysis runs locally. No network access and no telemetry, and the webview runs under a strict Content Security Policy.

### Flowchart → code

![Editing a flowchart with live code generation](media/editor.jpg)

- **Visual editor**: click **Edit** (pencil) on any chart, select a node and change its code, condition, loop header or return value, or rename the function and edit its parameters.
- **Insert and delete**: add a step, condition, loop, `return` or `throw` after any node or on any branch. Deleting a condition keeps its "yes" branch, and deleting a loop keeps the code after it.
- **Live code preview**: the code is regenerated on every change, next to the chart.
- **Undo / redo**: <kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Y</kbd>, with up to 100 steps.
- **Apply to source**: a diff editor shows *original ↔ generated* code. Nothing changes until you confirm, and the original indentation is preserved. The extension refuses to apply if the source changed since the chart was generated.
- **Design from scratch**: **Flowchart: New Flowchart** creates an empty function to design visually, then inserts the generated code at your cursor or opens it in a new file.
- **Mermaid → code**: **Flowchart: Generate Code from Mermaid Flowchart** converts any `flowchart` / `graph` diagram, for example one from a Markdown file. It understands node shapes (`{condition}`, `{{loop}}`, `(return …)`, …) and yes/no edge labels in English or French, and it recognizes loops.
- **Your code stays your code**: statements you did not touch are printed back exactly as written (formatting, comments, blank lines, multi-line conditions, original label names). Editing one node changes one line of the diff, not the whole function.
- **Edit callbacks and nested functions too**: the flows of inline callbacks (`forEach`, `then`, event handlers…) and nested functions are editable; the new body is written back into the statement that contains it, and `(x) => expression` stays concise when it can.
- **Correct by construction**: the generator rebuilds structured code (`if / else if / else`, loops, `switch` with fall-through, `try / catch / finally`, labeled `break` / `continue` only when needed). If a hand-drawn chart has no structured equivalent, it falls back to an equivalent state machine and tells you so.

#### How the code generation works

1. The chart is stored as a graph whose nodes keep the original, untruncated code.
2. Merge points are found with immediate post-dominators, which is the same approach compilers use to emit structured code (Relooper / Stackifier).
3. Loops are identified from their back edges. `break` and `continue` come from jumps to a loop's exit or header, and labels are added only when a jump crosses several loops or a `switch`.
4. **Fidelity, in the spirit of Recast and Roslyn trivia**: when the chart is built, every compound statement records a signature of the code it produces, and comments are attached to the statement they describe (above it, at the end of its line, or after the last statement of a block). At generation time, a statement whose signature is unchanged is reprinted from the original text, re-indented exactly; only edited parts are regenerated. Lines inside template literals are never re-indented.
5. If a part of the chart cannot be expressed this way (jumping into the middle of a loop, for example), the function is generated as a state machine (`switch (state)` in a loop). The Böhm–Jacopini theorem guarantees this is always possible. Every construct is supported: declarations are hoisted (destructuring included), `for` loops get init / update states, `for…of` drives the iterator by hand and closes it when left early, `for…in` iterates over a snapshot of the keys, and `try / catch / finally` use a table of protected states — like the exception tables of compiled code — with a `finally` that resumes the interrupted `return`, `throw` or jump. Generated names never clash with your variables.

The test suite checks this end to end. Each sample function goes code → chart → code (and code → Mermaid text → code), and the original and regenerated versions are executed on the same inputs and must return the same results.

#### Verified on real-world code

The generator is run on **13,325 functions** from webpack, ESLint, Mocha, Babel and Acorn:

| Check | Result |
| --- | --- |
| Flowchart built without error | 13,325 / 13,325 |
| Unchanged chart → code identical to the original, byte for byte | 99.9 % (100 % ignoring whitespace) |
| Comments kept | 99.9 % |
| One statement edited → valid code | 5,242 / 5,242 |
| One statement edited → lines changed in the diff | median 1, 90th percentile 3 |
| One statement edited → code → chart again: same flow as the edited chart | 99.8 % (the rest are equivalent forms, e.g. an implicit vs explicit `default:`) |
| State machine forced on every function → converted / valid code | 13,325 / 13,324 |
| Rebuilt as structured code (not a state machine) | 99.99 % |
| Mermaid export accepted by Mermaid | 400 / 400 sampled diagrams |
| Layout: overlapping nodes / detached or non-orthogonal edges / nodes outside their frame | 0 on 12,969 functions (139,537 nodes) |
| Layout time | 0.4 ms on average, 136 ms for the largest (410 nodes) |
| code → Mermaid *text* → import → valid code | 3,127 / 3,147 (99.4 %) |

![Editing a callback flow: only the edited line changes, comments and formatting are kept](media/graph-to-code-callback-edit.jpg)

## Requirements

VS Code 1.96 or newer. No other dependency: everything is bundled.

## Known limitations

- "May throw" is decided syntactically (calls, `new`, `await`, `yield`, tagged templates, `throw`). Property access on `null` is not considered, which keeps diagrams readable.
- `break` / `continue` that leave a `try` block with a `finally` are drawn going directly to their target.
- The parameters of an inline callback are edited in the statement that contains it, not in the callback flow.
- In state-machine mode, block-scoped variables with the same name share one variable (you get a warning), and closures created in a loop share the loop variable.
- Charts imported from Mermaid text have no original code to reuse: they are regenerated in full, and their callback flows stay read-only.

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
