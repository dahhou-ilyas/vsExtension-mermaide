'use strict';

const vscode = require('vscode');
const { COMMANDS, VIEW_TYPE, SUPPORTED_LANGUAGES, MESSAGES, EXTENSION_ID } = require('./constants');
const { getSettings } = require('./config');
const { DiagramStore } = require('./diagramStore');
const { FlowchartService } = require('./flowchartService');
const { FlowchartPanel } = require('./flowchartPanel');
const { FlowchartCodeLensProvider } = require('./codeLensProvider');
const { CodeActions, PreviewContentProvider, PREVIEW_SCHEME } = require('./codeActions');
const { newGraph } = require('./core/graphEdit');
const { importMermaid } = require('./core/mermaidImport');
const { generateCode } = require('./core/codegen');
const { toMermaid } = require('./core/graph');
const crypto = require('crypto');

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
    const previews = new PreviewContentProvider();
    const codeActions = new CodeActions(store, service, previews);
    let lastEditor = vscode.window.activeTextEditor;
    const panel = new FlowchartPanel(context, store, service, codeActions, () => lastEditor);
    const codeLens = new FlowchartCodeLensProvider();

    /** Creates a flowchart that is not attached to source code (designer / imported). */
    const addDetached = async (graph, origin, title, languageId = 'javascript') => {
        const record = {
            id: crypto.randomUUID(),
            title,
            mermaid: toMermaid(graph, { maxLabelLength: getSettings().maxLabelLength }),
            graph,
            origin,
            uri: '',
            fileName: origin === 'mermaid' ? 'Imported from Mermaid' : 'Flowchart designer',
            languageId,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            nodes: {},
            units: graph.units.map((u) => ({ name: u.name })),
            insights: [],
            createdAt: Date.now()
        };
        await store.upsert(record);
        panel.show(record.id, { edit: true });
        return record;
    };

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
        vscode.commands.registerCommand(COMMANDS.NEW_FLOWCHART, async () => {
            const name = await vscode.window.showInputBox({
                title: 'New Flowchart',
                prompt: 'Name of the function to design',
                value: 'myFunction',
                validateInput: (v) => (/^[A-Za-z_$][\w$]*$/.test(v.trim()) ? undefined : 'Enter a valid JavaScript identifier')
            });
            if (!name) return undefined;
            const params = await vscode.window.showInputBox({ title: 'New Flowchart', prompt: 'Parameters (optional)', placeHolder: 'a, b = 1, ...rest' });
            if (params === undefined) return undefined;
            return addDetached(newGraph({ name: name.trim(), params }), 'designer', name.trim());
        }),
        vscode.commands.registerCommand(COMMANDS.CODE_FROM_MERMAID, async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('Open a file containing a Mermaid flowchart (.mmd or Markdown).');
                return undefined;
            }
            const text = editor.selection.isEmpty ? mermaidAround(editor) : editor.document.getText(editor.selection);
            try {
                const graph = importMermaid(text);
                const { code, warnings } = generateCode(graph);
                warnings.forEach((w) => vscode.window.showWarningMessage(`Flowchart Generator: ${w}`));
                const document = await vscode.workspace.openTextDocument({ language: 'javascript', content: code });
                await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside, preview: false });
                return addDetached(graph, 'mermaid', graph.units[0].name);
            } catch (error) {
                service.reportError(error, new vscode.Position(0, 0));
                return undefined;
            }
        }),
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
        previews,
        vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, previews),
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor && editor.document.uri.scheme !== PREVIEW_SCHEME) lastEditor = editor;
        }),
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

/** The ```mermaid block around the cursor, or the whole document. */
function mermaidAround(editor) {
    const text = editor.document.getText();
    const offset = editor.document.offsetAt(editor.selection.active);
    const fence = /```mermaid[^\n]*\n([\s\S]*?)```/g;
    let match;
    while ((match = fence.exec(text))) {
        if (offset >= match.index && offset <= match.index + match[0].length) return match[1];
    }
    return text;
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
