# Contributing

Thanks for helping improve Flowchart Generator!

## Getting started

```bash
npm install
npm run watch
```

Press <kbd>F5</kbd> in VS Code to start an Extension Development Host with the extension loaded.

Before opening a pull request, run:

```bash
npm run lint
npm run test:unit
```

## Architecture

```
src/
  core/                  Pure JavaScript, no VS Code API (unit tested in Node)
    parse.js             Babel parsing of full files and partial selections
    flowchartBuilder.js  AST → graph (the pivot model)
    graph.js             Graph model, display labels, graph → Mermaid (text export)
    layout.js            Layout engine: layered layout + orthogonal routing (no dependency)
    codegen.js           Graph → structured code (with state-machine fallback)
    graphEdit.js         Pure editing operations used by the visual editor
    mermaidImport.js     Mermaid flowchart text → graph
    metrics.js           Cyclomatic / cognitive complexity and insights
    functionLocator.js   Finds functions (CodeLens, function under cursor)
  shared/protocol.js     Message types shared by the extension and the webview
  extension.js           Activation and command registration
  flowchartService.js    Editor → flowchart record (positions, metadata)
  diagramStore.js        Per-workspace persistence
  flowchartPanel.js      Webview panel, CSP and message handling
  codeActions.js         Save / apply to source (diff) / open / insert generated code
  codeLensProvider.js    "Flowchart" CodeLens
webview/                 React UI, bundled into dist/webview.js
  engine/                Native renderer: FlowCanvas (SVG, pan/zoom, minimap, tooltip),
                         geometry (shapes, PCB traces), palette (styles), measure, syntax
test/unit/               Mocha tests for src/core
test/suite/              Integration tests run inside VS Code
```

Two bundles are produced by webpack: `dist/extension.js` (Node) and `dist/webview.js` (browser).
The webview imports `graph.js`, `graphEdit.js` and `codegen.js` directly, so the live code preview and the extension always produce the same code.

```
code ──flowchartBuilder──▶ graph ──toMermaid──▶ diagram
                            ▲  │
          graphEdit (UI) ───┘  └──codegen──▶ code
mermaid text ──mermaidImport──▶ graph
```

## Adding support for a new statement

1. Handle it in `FlowchartBuilder.processStatement` (`src/core/flowchartBuilder.js`).
2. Update `computeComplexity` and `analyzeUnit` if it affects complexity.
3. Teach `codegen.js` to rebuild it, if it introduces a new kind of node.
4. Add a test in `test/unit/flowchartBuilder.test.js` (the `assertWellFormed` helper checks that every edge points to a declared node) and a round-trip sample in `test/unit/codegen.test.js`, which executes the original and the regenerated code and compares the results.

## Releasing

1. Update `CHANGELOG.md` and the `version` in `package.json`.
2. Create a GitHub release. The **Release** workflow publishes to the Visual Studio Marketplace (`AZURE_TOKEN` secret) and to Open VSX (optional `OVSX_PAT` secret).
