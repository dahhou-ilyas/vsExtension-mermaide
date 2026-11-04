'use strict';

const vscode = require('vscode');
const { COMMANDS } = require('./constants');
const { locateFunctions } = require('./core/functionLocator');
const { getSettings } = require('./config');
const { parserLanguage } = require('./flowchartService');

/** Files larger than this are skipped to keep the editor responsive. */
const MAX_DOCUMENT_LENGTH = 500_000;

/**
 * Adds a "Flowchart" CodeLens above every named function.
 * @implements {vscode.CodeLensProvider}
 */
class FlowchartCodeLensProvider {
    constructor() {
        this.emitter = new vscode.EventEmitter();
        this.onDidChangeCodeLenses = this.emitter.event;
    }

    refresh() {
        this.emitter.fire();
    }

    /**
     * @param {vscode.TextDocument} document
     * @param {vscode.CancellationToken} token
     */
    provideCodeLenses(document, token) {
        if (!getSettings().codeLensEnabled) return [];
        const text = document.getText();
        if (text.length > MAX_DOCUMENT_LENGTH) return [];

        const functions = locateFunctions(text, parserLanguage(document));
        if (token.isCancellationRequested) return [];

        return functions
            .filter((fn) => fn.named && !fn.trivial)
            .map((fn) => {
                const anchor = document.positionAt(fn.nameOffset);
                const range = new vscode.Range(document.positionAt(fn.start), document.positionAt(fn.end));
                return new vscode.CodeLens(new vscode.Range(anchor, anchor), {
                    title: '$(type-hierarchy) Flowchart',
                    tooltip: `Generate a flowchart for ${fn.name}`,
                    command: COMMANDS.GENERATE,
                    arguments: [{
                        uri: document.uri.toString(),
                        range: { start: range.start, end: range.end },
                        preferClassMember: fn.preferClassMember,
                        nameHint: fn.nameHint
                    }]
                });
            });
    }

    dispose() {
        this.emitter.dispose();
    }
}

module.exports = { FlowchartCodeLensProvider };
