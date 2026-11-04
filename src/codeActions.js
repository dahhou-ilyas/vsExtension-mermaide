'use strict';

const vscode = require('vscode');
const { generateCode } = require('./core/codegen');
const { toMermaid } = require('./core/graph');
const { MESSAGES } = require('./constants');
const { labelSettings } = require('./config');
const { hash } = require('./flowchartService');

const PREVIEW_SCHEME = 'flowchart-preview';

/**
 * Serves the read-only documents shown in the "original ↔ generated" diff editor.
 * @implements {vscode.TextDocumentContentProvider}
 */
class PreviewContentProvider {
    constructor() {
        this.contents = new Map();
        this.emitter = new vscode.EventEmitter();
        this.onDidChange = this.emitter.event;
    }

    /** @returns {vscode.Uri} */
    set(name, content, extension) {
        const uri = vscode.Uri.from({ scheme: PREVIEW_SCHEME, path: `/${name}.${extension}`, query: String(Date.now()) });
        this.contents.set(uri.toString(), content);
        this.emitter.fire(uri);
        return uri;
    }

    provideTextDocumentContent(uri) {
        return this.contents.get(uri.toString()) || '';
    }

    dispose() {
        this.emitter.dispose();
        this.contents.clear();
    }
}

const EXTENSION_BY_LANGUAGE = {
    typescript: 'ts',
    typescriptreact: 'tsx',
    javascriptreact: 'jsx',
    javascript: 'js'
};

/**
 * Indents every line but the first with the indentation of the line where the
 * replaced code starts, so a regenerated method stays aligned in its class.
 */
function indentLike(code, document, position) {
    const line = document.lineAt(position.line).text;
    const indent = line.slice(0, line.length - line.trimStart().length);
    const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const lines = code.replace(/\n$/, '').split('\n');
    return lines.map((l, i) => (i === 0 || !l ? l : indent + l)).join(eol);
}

/**
 * Chart → code actions triggered from the panel.
 */
class CodeActions {
    /**
     * @param {import('./diagramStore').DiagramStore} store
     * @param {import('./flowchartService').FlowchartService} service
     * @param {PreviewContentProvider} previews
     */
    constructor(store, service, previews) {
        this.store = store;
        this.service = service;
        this.previews = previews;
    }

    generate(graph) {
        const result = generateCode(graph);
        for (const warning of result.warnings) {
            vscode.window.showWarningMessage(`Flowchart Generator: ${warning}`);
        }
        return result;
    }

    /** Persists an edited graph and its Mermaid rendering. */
    async saveGraph(id, graph) {
        const diagram = this.store.get(id);
        if (!diagram) return undefined;
        const ids = new Set(graph.nodes.map((n) => n.id));
        const nodes = {};
        for (const [nodeId, span] of Object.entries(diagram.nodes || {})) {
            const node = graph.nodes.find((n) => n.id === nodeId);
            if (ids.has(nodeId) && node && node.start !== undefined) nodes[nodeId] = span;
        }
        return this.store.replace({
            ...diagram,
            graph,
            nodes,
            title: graph.units.length === 1 ? graph.units[0].name : diagram.title,
            mermaid: toMermaid(graph, labelSettings()),
            edited: true
        });
    }

    /** Opens the generated code in a new untitled editor. */
    async openCode(id, graph) {
        const diagram = this.store.get(id);
        const { code } = this.generate(graph || (diagram && diagram.graph));
        const language = diagram && diagram.languageId ? diagram.languageId : 'javascript';
        const document = await vscode.workspace.openTextDocument({ language, content: code });
        await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside });
    }

    /** Inserts the generated code at the cursor of the last active editor. */
    async insertCode(id, graph, editor) {
        if (!editor) {
            vscode.window.showInformationMessage(MESSAGES.NO_TARGET_EDITOR);
            return;
        }
        const { code } = this.generate(graph || this.store.get(id).graph);
        const position = editor.selection.active;
        await editor.edit((builder) => builder.replace(editor.selection, indentLike(code, editor.document, position)));
        await vscode.window.showTextDocument(editor.document, editor.viewColumn);
    }

    /**
     * Shows a diff between the source and the generated code, then replaces the
     * source if the user confirms. The flowchart is regenerated from the new code.
     */
    async applyToSource(id, graph) {
        const diagram = this.store.get(id);
        if (!diagram || !diagram.uri) return undefined;
        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(diagram.uri));
        const range = document.validateRange(new vscode.Range(
            diagram.range.start.line, diagram.range.start.character,
            diagram.range.end.line, diagram.range.end.character
        ));
        const original = document.getText(range);
        if (diagram.sourceHash && hash(original) !== diagram.sourceHash) {
            const choice = await vscode.window.showWarningMessage(MESSAGES.SOURCE_CHANGED, MESSAGES.OPEN_NEW);
            if (choice === MESSAGES.OPEN_NEW) await this.openCode(id, graph);
            return undefined;
        }

        const { code } = this.generate(graph);
        const replacement = indentLike(code, document, range.start);
        const extension = EXTENSION_BY_LANGUAGE[diagram.languageId] || 'js';
        const left = this.previews.set(`original-${diagram.title}`, original, extension);
        const right = this.previews.set(`generated-${diagram.title}`, replacement, extension);
        await vscode.commands.executeCommand('vscode.diff', left, right, `${diagram.title}: Original ↔ From flowchart`, { preview: true });

        const choice = await vscode.window.showInformationMessage(MESSAGES.APPLY_CONFIRM, { modal: true }, MESSAGES.REPLACE, MESSAGES.OPEN_NEW);
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        if (choice === MESSAGES.OPEN_NEW) {
            await this.openCode(id, graph);
            return undefined;
        }
        if (choice !== MESSAGES.REPLACE) return undefined;

        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, range, replacement);
        if (!(await vscode.workspace.applyEdit(edit))) {
            vscode.window.showErrorMessage('Flowchart Generator: the code could not be replaced.');
            return undefined;
        }
        const startOffset = document.offsetAt(range.start);
        const newRange = new vscode.Range(range.start, document.positionAt(startOffset + replacement.length));
        await vscode.window.showTextDocument(document, { selection: newRange, preserveFocus: false });

        const record = await this.service.generateForDocument(document, { ...(diagram.generation || {}), range: newRange });
        if (record && record.id !== id) await this.store.remove(id);
        return record;
    }
}

module.exports = { CodeActions, PreviewContentProvider, PREVIEW_SCHEME, indentLike };
