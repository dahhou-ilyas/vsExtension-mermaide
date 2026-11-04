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
    flowchartBuilder.js  AST → control-flow graph → Mermaid definition
    metrics.js           Cyclomatic / cognitive complexity and insights
    functionLocator.js   Finds functions (CodeLens, function under cursor)
  shared/protocol.js     Message types shared by the extension and the webview
  extension.js           Activation and command registration
  flowchartService.js    Editor → flowchart record (positions, metadata)
  diagramStore.js        Per-workspace persistence
  flowchartPanel.js      Webview panel, CSP and message handling
  codeLensProvider.js    "Flowchart" CodeLens
webview/                 React UI, bundled into dist/webview.js
test/unit/               Mocha tests for src/core
test/suite/              Integration tests run inside VS Code
```

Two bundles are produced by webpack: `dist/extension.js` (Node) and `dist/webview.js` (browser).

## Adding support for a new statement

1. Handle it in `FlowchartBuilder.processStatement` (`src/core/flowchartBuilder.js`).
2. Update `computeComplexity` and `analyzeUnit` if it affects complexity.
3. Add a test in `test/unit/flowchartBuilder.test.js`. The `assertWellFormed` helper checks that every edge points to a declared node.

## Releasing

1. Update `CHANGELOG.md` and the `version` in `package.json`.
2. Create a GitHub release. The **Release** workflow publishes to the Visual Studio Marketplace (`AZURE_TOKEN` secret) and to Open VSX (optional `OVSX_PAT` secret).
