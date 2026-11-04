'use strict';

const assert = require('assert');
const vscode = require('vscode');

const EXTENSION_ID = 'GeneratedFlowChart.flowchartgenerator';

async function api() {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, 'extension is installed');
    return extension.activate();
}

describe('Flowchart Generator (integration)', function () {
    this.timeout(30000);

    afterEach(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    it('registers its commands', async () => {
        await api();
        const commands = await vscode.commands.getCommands(true);
        for (const id of ['flowchartGenerator.generate', 'flowchartGenerator.generateFile', 'flowchartGenerator.showPanel', 'flowchartGenerator.clearHistory']) {
            assert.ok(commands.includes(id), `missing command ${id}`);
        }
    });

    it('generates a flowchart for the function under the cursor', async () => {
        await api();
        const document = await vscode.workspace.openTextDocument({
            language: 'javascript',
            content: 'function check(n) {\n  if (n > 0) {\n    return "positive";\n  }\n  return "other";\n}\n'
        });
        const editor = await vscode.window.showTextDocument(document);
        editor.selection = new vscode.Selection(2, 4, 2, 4);

        const record = await vscode.commands.executeCommand('flowchartGenerator.generate');
        assert.ok(record, 'a diagram record is returned');
        assert.strictEqual(record.title, 'check');
        assert.match(record.mermaid, /^flowchart TD/);
        assert.strictEqual(record.range.start.line, 0);
        assert.ok(Object.keys(record.nodes).length > 0, 'nodes are mapped to source ranges');
    });

    it('generates a flowchart from a selection', async () => {
        const { store } = await api();
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript',
            content: 'const total: number = items.reduce((a, b) => a + b, 0);\nif (total > 10) { notify(total); }\n'
        });
        const editor = await vscode.window.showTextDocument(document);
        editor.selection = new vscode.Selection(0, 0, 1, 34);

        const record = await vscode.commands.executeCommand('flowchartGenerator.generate');
        assert.ok(record);
        assert.strictEqual(record.title, 'Selection');
        assert.ok(store.get(record.id), 'the diagram is persisted');
    });

    it('generates a flowchart from a CodeLens payload', async () => {
        await api();
        const document = await vscode.workspace.openTextDocument({ language: 'javascript', content: 'class A {\n  run() { while (x) { step(); } }\n}\n' });
        await vscode.window.showTextDocument(document);
        const record = await vscode.commands.executeCommand('flowchartGenerator.generate', {
            uri: document.uri.toString(),
            range: { start: { line: 1, character: 2 }, end: { line: 1, character: 34 } },
            preferClassMember: true
        });
        assert.ok(record);
        assert.strictEqual(record.title, 'run');
    });
});
