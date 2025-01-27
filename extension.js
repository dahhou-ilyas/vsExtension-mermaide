const CodeValidator = require('./services/codeValidator');
const { MESSAGES } = require('./services/constants');

const { handleCommande_genreteFlowDiagrame } = require('./services/handleCommand');

const ModuleLoader = require('./services/moduleLoader');

const WebviewManager = require('./services/webviewManager');

const path = require('path');
const vscode = require('vscode');


async function activate(context) {
	const webviewManager = new WebviewManager(context); 
	const generateMermaidFlow = await ModuleLoader.loadMermaidModule();
    context.subscriptions.push(
        vscode.commands.registerCommand('real-time-performance-profiler.helloWorld', () => handleCommande_genreteFlowDiagrame(webviewManager,generateMermaidFlow,CodeValidator,MESSAGES))
    );
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
};


