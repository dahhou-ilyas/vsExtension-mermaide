'use strict';

const vscode = require('vscode');
const crypto = require('crypto');
const { buildFlowchart, FlowchartParseError } = require('./core/flowchartBuilder');
const { GraphEditError } = require('./core/graphEdit');
const { MermaidImportError } = require('./core/mermaidImport');
const { locateFunctions, findFunctionAt } = require('./core/functionLocator');
const { SUPPORTED_LANGUAGES, SUPPORTED_EXTENSIONS, MESSAGES } = require('./constants');
const { getSettings } = require('./config');

/**
 * @typedef {import('./diagramStore').DiagramRecord} DiagramRecord
 *
 * @typedef {Object} GenerateTarget
 * @property {vscode.Range} [range]          Explicit range (e.g. from a CodeLens)
 * @property {boolean} [preferClassMember]
 * @property {string} [nameHint]
 * @property {boolean} [wholeFile]
 */

/**
 * @param {vscode.TextDocument} document
 */
function isSupportedDocument(document) {
    if (SUPPORTED_LANGUAGES.includes(document.languageId)) return true;
    const extension = document.fileName.split('.').pop().toLowerCase();
    return SUPPORTED_EXTENSIONS.includes(extension);
}

/**
 * Maps a document to the language id understood by the parser.
 * @param {vscode.TextDocument} document
 */
function parserLanguage(document) {
    if (SUPPORTED_LANGUAGES.includes(document.languageId)) return document.languageId;
    const extension = document.fileName.split('.').pop().toLowerCase();
    if (extension === 'tsx') return 'typescriptreact';
    if (['ts', 'mts', 'cts'].includes(extension)) return 'typescript';
    return 'javascriptreact';
}

/** Short stable hash, used to detect that the source changed. */
function hash(text) {
    return crypto.createHash('sha1').update(String(text).replace(/\r\n/g, '\n')).digest('hex').slice(0, 16);
}

/** @param {vscode.Position} p */
function toPos(p) {
    return { line: p.line, character: p.character };
}

/**
 * Generates flowcharts from editors and turns parser output into persisted records.
 */
class FlowchartService {
    /**
     * @param {import('./diagramStore').DiagramStore} store
     * @param {vscode.OutputChannel} output
     */
    constructor(store, output) {
        this.store = store;
        this.output = output;
    }

    /**
     * Resolves which part of the document should be turned into a flowchart.
     * Priority: explicit range > non-empty selection > function under cursor.
     *
     * @param {vscode.TextEditor} editor
     * @param {GenerateTarget} target
     * @returns {{ range: vscode.Range, preferClassMember?: boolean, nameHint?: string } | undefined}
     */
    resolveTarget(editor, target = {}) {
        const { document, selection } = editor;
        if (target.wholeFile) {
            const end = document.lineAt(document.lineCount - 1).range.end;
            return { range: new vscode.Range(new vscode.Position(0, 0), end) };
        }
        if (target.range) {
            return { range: target.range, preferClassMember: target.preferClassMember, nameHint: target.nameHint };
        }
        if (!selection.isEmpty) {
            return { range: new vscode.Range(selection.start, selection.end) };
        }
        const functions = locateFunctions(document.getText(), parserLanguage(document));
        const fn = findFunctionAt(functions, document.offsetAt(selection.active));
        if (!fn) return undefined;
        return {
            range: new vscode.Range(document.positionAt(fn.start), document.positionAt(fn.end)),
            preferClassMember: fn.preferClassMember,
            nameHint: fn.nameHint
        };
    }

    /**
     * @param {vscode.TextEditor} editor
     * @param {GenerateTarget} [target]
     * @returns {Promise<DiagramRecord | undefined>}
     */
    async generate(editor, target = {}) {
        const { document } = editor;
        if (!isSupportedDocument(document)) {
            vscode.window.showWarningMessage(MESSAGES.UNSUPPORTED_LANGUAGE);
            return undefined;
        }

        const resolved = this.resolveTarget(editor, target);
        if (!resolved) {
            const choice = await vscode.window.showInformationMessage(MESSAGES.NO_FUNCTION, MESSAGES.WHOLE_FILE);
            if (choice === MESSAGES.WHOLE_FILE) return this.generate(editor, { wholeFile: true });
            return undefined;
        }

        return this.generateForDocument(document, { ...resolved, wholeFile: target.wholeFile });
    }

    /**
     * @param {vscode.TextDocument} document
     * @param {{ range: vscode.Range, preferClassMember?: boolean, nameHint?: string, wholeFile?: boolean }} target
     * @returns {Promise<DiagramRecord | undefined>}
     */
    async generateForDocument(document, target) {
        const { range } = target;
        const code = document.getText(range);
        const baseOffset = document.offsetAt(range.start);
        const settings = getSettings();

        let result;
        try {
            result = buildFlowchart(code, {
                language: parserLanguage(document),
                direction: settings.direction,
                maxLabelLength: settings.maxLabelLength,
                mergeSequentialStatements: settings.mergeSequentialStatements,
                maxStatementsPerBlock: settings.maxStatementsPerBlock,
                labelMode: settings.labelMode,
                lineWidth: settings.lineWidth,
                maxLines: settings.maxLines,
                exceptionEdges: settings.exceptionEdges,
                expandCallbacks: settings.expandCallbacks,
                maxCallbackDepth: settings.maxCallbackDepth,
                preferClassMember: target.preferClassMember,
                nameHint: target.nameHint
            });
        } catch (error) {
            this.reportError(error, range.start);
            return undefined;
        }

        const span = (start, end) => ({
            start: toPos(document.positionAt(baseOffset + start)),
            end: toPos(document.positionAt(baseOffset + end))
        });
        const nodes = {};
        for (const [id, loc] of Object.entries(result.nodes)) {
            nodes[id] = span(loc.start, loc.end);
        }

        /** @type {DiagramRecord} */
        const record = {
            id: crypto.randomUUID(),
            title: target.wholeFile ? document.fileName.split(/[\\/]/).pop() : result.title,
            mermaid: result.mermaid,
            graph: result.graph,
            origin: 'code',
            sourceHash: hash(code),
            uri: document.uri.toString(),
            fileName: document.isUntitled ? document.fileName : vscode.workspace.asRelativePath(document.uri, false),
            languageId: document.languageId,
            range: { start: toPos(range.start), end: toPos(range.end) },
            nodes,
            units: result.units.map((u) => ({
                name: u.name,
                complexity: u.complexity,
                cognitive: u.cognitive,
                metrics: u.metrics,
                range: span(u.start, u.end)
            })),
            complexity: result.complexity,
            cognitive: result.cognitive,
            insights: result.insights.map((i) => ({
                severity: i.severity,
                code: i.code,
                message: i.message,
                unit: i.unit,
                range: span(i.start, i.end)
            })),
            stats: result.stats,
            generation: {
                preferClassMember: !!target.preferClassMember,
                nameHint: target.nameHint,
                wholeFile: !!target.wholeFile
            },
            createdAt: Date.now()
        };

        this.output.appendLine(`[${new Date().toISOString()}] Generated "${record.title}" from ${record.fileName}:${range.start.line + 1} (${result.stats.nodes} nodes, complexity ${result.complexity})`);
        return this.store.upsert(record);
    }

    /**
     * Regenerates a stored diagram from the current content of its source range.
     * @param {string} id
     */
    async regenerate(id) {
        const diagram = this.store.get(id);
        if (!diagram) return undefined;
        let document;
        try {
            document = await vscode.workspace.openTextDocument(vscode.Uri.parse(diagram.uri));
        } catch {
            vscode.window.showWarningMessage(MESSAGES.SOURCE_MISSING);
            return undefined;
        }
        const generation = diagram.generation || {};
        const range = generation.wholeFile
            ? new vscode.Range(new vscode.Position(0, 0), document.lineAt(document.lineCount - 1).range.end)
            : document.validateRange(new vscode.Range(
                diagram.range.start.line, diagram.range.start.character,
                diagram.range.end.line, diagram.range.end.character
            ));
        return this.generateForDocument(document, { ...generation, range });
    }

    /**
     * @param {unknown} error
     * @param {vscode.Position} origin  Position of the parsed code in the document
     */
    reportError(error, origin) {
        if (error instanceof GraphEditError || error instanceof MermaidImportError) {
            vscode.window.showErrorMessage(`Flowchart Generator: ${error.message}`);
            return;
        }
        if (error instanceof FlowchartParseError) {
            let where = '';
            if (error.loc) {
                const line = origin.line + error.loc.line;
                const column = error.loc.line === 1 ? origin.character + error.loc.column + 1 : error.loc.column + 1;
                where = ` (line ${line}, column ${column})`;
            }
            vscode.window.showErrorMessage(`Flowchart Generator: could not analyze the code${where}: ${error.message}`);
            this.output.appendLine(`Parse error${where}: ${error.message}`);
            return;
        }
        const message = error instanceof Error ? error.message : String(error);
        this.output.appendLine(`Unexpected error: ${error instanceof Error && error.stack ? error.stack : message}`);
        vscode.window.showErrorMessage(`Flowchart Generator: unexpected error — ${message}`, 'Show Log').then((choice) => {
            if (choice) this.output.show(true);
        });
    }
}

module.exports = { FlowchartService, isSupportedDocument, parserLanguage, hash };
