const path = require('path');
const vscode = require('vscode');
let generateMistralResponse;
async function loadModule() {
    const module = await import('./llm/llm.mjs');
    generateMistralResponse = module.generateMistralResponse;
}

function activate(context) {
	loadModule().catch(err => {
        console.error('Failed to load llm module:', err);
    });
    context.subscriptions.push(
        vscode.commands.registerCommand('real-time-performance-profiler.helloWorld', async () => {
			if (!generateMistralResponse) {
                vscode.window.showErrorMessage(
                    'Le module n\'est pas encore chargé. Réessayez dans un instant.'
                );
                return;
            }
            if (!vscode.window.activeTextEditor) {
                return; // no editor open
            }

            const { selection } = vscode.window.activeTextEditor;
            const selectedText = vscode.window.activeTextEditor.document.getText(selection);
            

            const response = await generateMistralResponse(selectedText);
           
        })
    );
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
};

function getWebviewContent(panel, context) {
	const scriptUri = panel.webview.asWebviewUri(
		vscode.Uri.file(path.join(context.extensionPath, 'dist', 'webview.js'))
	);

	return `
	  <!DOCTYPE html>
	  <html>
	  <head>
		<meta charset="UTF-8">
		<title>Extension Panel</title>
		<script src="https://cdn.tailwindcss.com"></script>
	  </head>
	  <body>
		<div id="root"></div>
		<script type="module" src="${scriptUri}"></script>
	  </body>
	  </html>
	`;
}

