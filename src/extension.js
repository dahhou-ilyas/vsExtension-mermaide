'use strict';

const vscode = require('vscode');
const { COMMANDS, VIEW_TYPE, SUPPORTED_LANGUAGES, MESSAGES, EXTENSION_ID } = require('./constants');
const { getSettings } = require('./config');
const { DiagramStore } = require('./diagramStore');
const { FlowchartService } = require('./flowchartService');
const { FlowchartPanel } = require('./flowchartPanel');
const { FlowchartCodeLensProvider } = require('./codeLensProvider');

/**
 * Normalizes the optional argument of the generate command. It can be:
 *  - undefined (keyboard shortcut / command palette),
 *  - a vscode.Uri (editor title / context menu),
 *  - a CodeLens payload { uri, range, preferClassMember, nameHint }.
 *
 * @param {any} arg
 */
async function editorAndTarget(arg) {
    if (arg && typeof arg === 'object' && arg.range && arg.uri) {
        const uri = vscode.Uri.parse(String(arg.uri));
        const document = await vscode.workspace.openTextDocument(uri);
        const visible = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString());
        const editor = visible || await vscode.window.showTextDocument(document);
        const { start, end } = arg.range;
        return {
            editor,
            target: {
                range: new vscode.Range(start.line, start.character, end.line, end.character),
                preferClassMember: !!arg.preferClassMember,
                nameHint: arg.nameHint
            }
        };
    }
    const editor = vscode.window.activeTextEditor;
    if (arg instanceof vscode.Uri && editor && editor.document.uri.toString() !== arg.toString()) {
        const document = await vscode.workspace.openTextDocument(arg);
        return { editor: await vscode.window.showTextDocument(document), target: {} };
    }
    return { editor, target: {} };
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    const output = vscode.window.createOutputChannel('Flowchart Generator');
    const store = new DiagramStore(context.workspaceState, () => getSettings().historyLimit);
    const service = new FlowchartService(store, output);
    const panel = new FlowchartPanel(context, store, service);
    const codeLens = new FlowchartCodeLensProvider();

    const generate = async (arg, wholeFile = false) => {
        const { editor, target } = await editorAndTarget(arg);
        if (!editor) {
            vscode.window.showInformationMessage(MESSAGES.NO_EDITOR);
            return undefined;
        }
        const record = await service.generate(editor, { ...target, wholeFile });
        if (record) panel.show(record.id);
        return record;
    };

    context.subscriptions.push(
        output,
        store,
        panel,
        codeLens,
        vscode.commands.registerCommand(COMMANDS.GENERATE, (arg) => generate(arg)),
        vscode.commands.registerCommand(COMMANDS.GENERATE_FILE, (arg) => generate(arg, true)),
        vscode.commands.registerCommand(COMMANDS.SHOW_PANEL, () => panel.show()),
        vscode.commands.registerCommand(COMMANDS.CLEAR_HISTORY, async () => {
            if (store.all().length === 0) return;
            const choice = await vscode.window.showWarningMessage(MESSAGES.CLEAR_CONFIRM, { modal: true }, MESSAGES.CLEAR);
            if (choice === MESSAGES.CLEAR) await store.clear();
        }),
        vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
            deserializeWebviewPanel: async (webviewPanel) => panel.restore(webviewPanel)
        }),
        vscode.languages.registerCodeLensProvider(
            SUPPORTED_LANGUAGES.map((language) => ({ language })),
            codeLens
        ),
        vscode.window.onDidChangeTextEditorSelection(debounce((event) => panel.syncCursor(event.textEditor), 120)),
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (!event.affectsConfiguration(EXTENSION_ID)) return;
            codeLens.refresh();
            panel.refresh();
        })
    );

    // Exposed for integration tests and other extensions.
    return { generate, store };
}

function debounce(fn, wait) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), wait);
    };
}

function deactivate() {}

module.exports = { activate, deactivate };
