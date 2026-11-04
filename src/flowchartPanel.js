'use strict';

const vscode = require('vscode');
const crypto = require('crypto');
const { VIEW_TYPE, MESSAGES } = require('./constants');
const { ToWebview, FromWebview } = require('./shared/protocol');
const { getSettings, labelSettings } = require('./config');

/**
 * Owns the single flowchart webview panel and its message protocol.
 */
class FlowchartPanel {
    /**
     * @param {vscode.ExtensionContext} context
     * @param {import('./diagramStore').DiagramStore} store
     * @param {import('./flowchartService').FlowchartService} service
     * @param {import('./codeActions').CodeActions} codeActions
     * @param {() => vscode.TextEditor | undefined} lastEditor  Last focused text editor
     */
    constructor(context, store, service, codeActions, lastEditor) {
        this.context = context;
        this.store = store;
        this.service = service;
        this.codeActions = codeActions;
        this.lastEditor = lastEditor;
        /** @type {string | undefined} */
        this.editId = undefined;
        /** @type {vscode.WebviewPanel | undefined} */
        this.panel = undefined;
        this.ready = false;
        /** @type {string | undefined} */
        this.focusId = undefined;
        this.disposables = [];

        this.disposables.push(store.onDidChange(() => this.postState()));
    }

    /**
     * Shows the panel, optionally scrolling to a diagram (and opening its editor).
     * @param {string} [focusId]
     * @param {{ edit?: boolean }} [options]
     */
    show(focusId, options = {}) {
        this.focusId = focusId;
        this.editId = options.edit ? focusId : undefined;
        const column = getSettings().openBeside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
        if (this.panel) {
            this.panel.reveal(column, true);
            this.postState();
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            VIEW_TYPE,
            'Flowcharts',
            { viewColumn: column, preserveFocus: true },
            this.webviewOptions()
        );
        this.attach(panel);
    }

    /**
     * Restores a panel after VS Code reloads (see WebviewPanelSerializer).
     * @param {vscode.WebviewPanel} panel
     */
    restore(panel) {
        panel.webview.options = this.webviewOptions();
        this.attach(panel);
    }

    webviewOptions() {
        return {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')]
        };
    }

    /** @param {vscode.WebviewPanel} panel */
    attach(panel) {
        this.panel = panel;
        this.ready = false;
        panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'icon.png');
        panel.webview.html = this.html(panel.webview);

        const subscriptions = [
            panel.webview.onDidReceiveMessage((message) => this.onMessage(message)),
            panel.onDidDispose(() => {
                this.panel = undefined;
                this.ready = false;
                subscriptions.forEach((d) => d.dispose());
            })
        ];
    }

    /** Re-sends settings (e.g. after a configuration change). */
    refresh() {
        this.postState();
    }

    postState() {
        if (!this.panel || !this.ready) return;
        const settings = getSettings();
        this.panel.webview.postMessage({
            type: ToWebview.STATE,
            diagrams: this.store.all(),
            settings: { theme: settings.theme, labels: labelSettings(settings) },
            focusId: this.focusId,
            editId: this.editId
        });
        this.focusId = undefined;
        this.editId = undefined;
    }

    /** @param {any} message */
    async onMessage(message) {
        if (!message || typeof message.type !== 'string') return;
        try {
            switch (message.type) {
                case FromWebview.READY:
                    this.ready = true;
                    this.postState();
                    break;
                case FromWebview.REVEAL:
                    await this.revealSource(message.id, message.nodeId, message.insight, message.unit);
                    break;
                case FromWebview.REMOVE:
                    await this.store.remove(message.id);
                    break;
                case FromWebview.CLEAR:
                    await vscode.commands.executeCommand('flowchartGenerator.clearHistory');
                    break;
                case FromWebview.COPY:
                    await vscode.env.clipboard.writeText(String(message.text || ''));
                    vscode.window.setStatusBarMessage(`$(check) ${MESSAGES.COPIED}`, 3000);
                    break;
                case FromWebview.OPEN_MARKDOWN:
                    await this.openAsMarkdown(message.id);
                    break;
                case FromWebview.EXPORT:
                    await this.exportImage(message.id, message.format, message.data);
                    break;
                case FromWebview.REGENERATE: {
                    const record = await this.service.regenerate(message.id);
                    if (record) this.focusId = record.id;
                    break;
                }
                case FromWebview.SAVE_GRAPH:
                    await this.codeActions.saveGraph(message.id, message.graph);
                    break;
                case FromWebview.APPLY_CODE: {
                    const record = await this.codeActions.applyToSource(message.id, message.graph);
                    if (record) this.show(record.id);
                    break;
                }
                case FromWebview.OPEN_CODE:
                    await this.codeActions.openCode(message.id, message.graph);
                    break;
                case FromWebview.INSERT_CODE:
                    await this.codeActions.insertCode(message.id, message.graph, this.lastEditor());
                    break;
                case FromWebview.ERROR:
                    vscode.window.showErrorMessage(`Flowchart Generator: ${message.message}`);
                    break;
                default:
                    break;
            }
        } catch (error) {
            this.service.reportError(error, new vscode.Position(0, 0));
        }
    }

    /**
     * Opens the source of a diagram (or of a single node) in the editor.
     * @param {string} id
     * @param {string} [nodeId]
     * @param {number} [insightIndex]
     * @param {number} [unitIndex]
     */
    async revealSource(id, nodeId, insightIndex, unitIndex) {
        const diagram = this.store.get(id);
        if (!diagram) return;
        const insight = typeof insightIndex === 'number' && diagram.insights ? diagram.insights[insightIndex] : undefined;
        const unit = typeof unitIndex === 'number' && diagram.units ? diagram.units[unitIndex] : undefined;
        const span = (insight && insight.range) || (unit && unit.range) || (nodeId && diagram.nodes && diagram.nodes[nodeId]) || diagram.range;
        const uri = vscode.Uri.parse(diagram.uri);

        let document;
        try {
            document = await vscode.workspace.openTextDocument(uri);
        } catch {
            vscode.window.showWarningMessage(MESSAGES.SOURCE_MISSING);
            return;
        }

        const range = document.validateRange(new vscode.Range(
            span.start.line, span.start.character, span.end.line, span.end.character
        ));
        const visible = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === diagram.uri);
        const panelColumn = this.panel && this.panel.viewColumn;
        const viewColumn = visible && visible.viewColumn
            ? visible.viewColumn
            : (panelColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One);

        const editor = await vscode.window.showTextDocument(document, { viewColumn, selection: range, preserveFocus: false });
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }

    /**
     * Highlights, in every diagram generated from this document, the node under the cursor.
     * @param {vscode.TextEditor} editor
     */
    syncCursor(editor) {
        if (!this.panel || !this.ready || !this.panel.visible) return;
        const uri = editor.document.uri.toString();
        const position = editor.selection.active;
        const contains = (span) => {
            const start = new vscode.Position(span.start.line, span.start.character);
            const end = new vscode.Position(span.end.line, span.end.character);
            return !position.isBefore(start) && !position.isAfter(end);
        };
        const size = (span) => (span.end.line - span.start.line) * 10000 + (span.end.character - span.start.character);
        const highlights = {};
        for (const diagram of this.store.all()) {
            if (diagram.uri !== uri || !diagram.nodes) continue;
            let best;
            for (const [nodeId, span] of Object.entries(diagram.nodes)) {
                if (contains(span) && (!best || size(span) < size(best.span))) best = { nodeId, span };
            }
            highlights[diagram.id] = best ? best.nodeId : null;
        }
        this.panel.webview.postMessage({ type: ToWebview.HIGHLIGHT, highlights });
    }

    /** @param {string} id */
    async openAsMarkdown(id) {
        const diagram = this.store.get(id);
        if (!diagram) return;
        const content = [
            `# ${diagram.title}`,
            '',
            `Source: \`${diagram.fileName}:${diagram.range.start.line + 1}\` · Cyclomatic complexity: ${diagram.complexity} · Cognitive complexity: ${diagram.cognitive ?? '–'}`,
            '',
            '```mermaid',
            diagram.mermaid.trimEnd(),
            '```',
            ''
        ].join('\n');
        const document = await vscode.workspace.openTextDocument({ language: 'markdown', content });
        await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside });
    }

    /**
     * @param {string} id
     * @param {'svg' | 'png'} format
     * @param {string} data  SVG markup, or a base64 PNG data URL
     */
    async exportImage(id, format, data) {
        const diagram = this.store.get(id);
        if (!diagram || (format !== 'svg' && format !== 'png') || typeof data !== 'string') return;

        const safeName = diagram.title.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'flowchart';
        const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
        const defaultUri = folder
            ? vscode.Uri.joinPath(folder.uri, `${safeName}.${format}`)
            : vscode.Uri.file(`${safeName}.${format}`);

        const target = await vscode.window.showSaveDialog({
            defaultUri,
            filters: format === 'svg' ? { 'SVG image': ['svg'] } : { 'PNG image': ['png'] },
            saveLabel: 'Export Flowchart'
        });
        if (!target) return;

        const bytes = format === 'svg'
            ? Buffer.from(data, 'utf8')
            : Buffer.from(data.replace(/^data:image\/png;base64,/, ''), 'base64');
        await vscode.workspace.fs.writeFile(target, bytes);

        const open = 'Open';
        const choice = await vscode.window.showInformationMessage(`Flowchart exported to ${vscode.workspace.asRelativePath(target)}`, open);
        if (choice === open) await vscode.commands.executeCommand('vscode.open', target);
    }

    /** @param {vscode.Webview} webview */
    html(webview) {
        const nonce = crypto.randomBytes(16).toString('base64');
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'));
        const csp = [
            "default-src 'none'",
            `img-src ${webview.cspSource} data: blob:`,
            `style-src ${webview.cspSource} 'unsafe-inline'`,
            `font-src ${webview.cspSource} data:`,
            `script-src 'nonce-${nonce}'`
        ].join('; ');

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Flowcharts</title>
</head>
<body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }

    dispose() {
        if (this.panel) this.panel.dispose();
        this.disposables.forEach((d) => d.dispose());
    }
}

module.exports = { FlowchartPanel };
