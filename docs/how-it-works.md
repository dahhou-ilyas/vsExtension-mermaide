# How Flowchart Generator works

This page explains the techniques behind the extension and how they are verified. For installation and usage, see the [README](../README.md).

## Code → flowchart

- The code is parsed with Babel (JavaScript, TypeScript, JSX, TSX). Partial selections (class members, an anonymous function) are parsed with small wrappers.
- The builder walks the syntax tree and produces a control-flow graph whose nodes keep the original, untruncated code and their source ranges.
- **Precise exceptions**: like Soot's exceptional CFG, only statements that can throw (calls, `new`, `await`, `throw`, …) get an `error` edge to their `catch`. `return` and `throw` go through `finally`, and an explicit "end finally" node continues with `then return` / `rethrow`.
- **Inline callbacks** (`forEach`, `then`, event handlers, IIFEs) and nested functions become their own linked flows; the statement that holds them shows the body folded (`=> {…}`).
- **Metrics**: cyclomatic complexity (McCabe) and cognitive complexity (SonarSource), plus insights (unreachable code, empty `catch`, `await` in loops, deep nesting…).

## Rendering engine

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

## Flowchart → code

1. The chart is stored as a graph whose nodes keep the original, untruncated code.
2. Merge points are found with immediate post-dominators, which is the same approach compilers use to emit structured code (Relooper / Stackifier).
3. Loops are identified from their back edges. `break` and `continue` come from jumps to a loop's exit or header, and labels are added only when a jump crosses several loops or a `switch`.
4. **Fidelity, in the spirit of Recast and Roslyn trivia**: when the chart is built, every compound statement records a signature of the code it produces, and comments are attached to the statement they describe (above it, at the end of its line, or after the last statement of a block). At generation time, a statement whose signature is unchanged is reprinted from the original text, re-indented exactly; only edited parts are regenerated. Lines inside template literals are never re-indented.
5. If a part of the chart cannot be expressed this way (jumping into the middle of a loop, for example), the function is generated as a state machine (`switch (state)` in a loop). The Böhm–Jacopini theorem guarantees this is always possible. Every construct is supported: declarations are hoisted (destructuring included), `for` loops get init / update states, `for…of` drives the iterator by hand and closes it when left early, `for…in` iterates over a snapshot of the keys, and `try / catch / finally` use a table of protected states — like the exception tables of compiled code — with a `finally` that resumes the interrupted `return`, `throw` or jump. Generated names never clash with your variables, and block-scoped variables that would collide once flattened (same name in two blocks, a block shadowing a parameter) are renamed in their block (`x` → `x2`), strings, properties and template literals excepted.

The test suite checks this end to end. Each sample function goes code → chart → code (and code → Mermaid text → code), and the original and regenerated versions are executed on the same inputs and must return the same results.

## Verification on real-world code

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
