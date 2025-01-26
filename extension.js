const path = require('path');
const vscode = require('vscode');
let generateMermaidFlow;
async function loadModule() {
    const module = await import('./llm/parserJs.mjs');
    generateMermaidFlow = module.generateMermaidFlow;
}

function activate(context) {
	loadModule().catch(err => {
        console.error('Failed to load llm module:', err);
    });
    context.subscriptions.push(
        vscode.commands.registerCommand('real-time-performance-profiler.helloWorld', async () => {
			if (!generateMermaidFlow) {
                vscode.window.showErrorMessage(
                    'Le module n\'est pas encore chargé. Réessayez dans un instant.'
                );
                return;
            }
            if (!vscode.window.activeTextEditor) {
                return; // no editor open
            }

            const editor = vscode.window.activeTextEditor;

			const filePath = editor.document.fileName;

    		const fileExtension = filePath.split('.').pop();

            const selectedText = vscode.window.activeTextEditor.document.getText(editor.selection);
            
			if (!selectedText) {
				vscode.window.showInformationMessage('You need to select a function');
				return
			}

			if (fileExtension != "js"){
				vscode.window.showInformationMessage('The code must be JavaScript');
				return
			}
			
			const mermaide_base64 = Buffer.from(generateMermaidFlow(selectedText)).toString('base64');
			console.log(mermaide_base64);
			
			const panel = vscode.window.createWebviewPanel(
				'mistralPanel',
				'Mistral AI Response',
				vscode.ViewColumn.One,
				{ enableScripts: true }
			);
			panel.webview.postMessage({
				command: 'mistralResponse',
				text: mermaide_base64
			});

			panel.webview.html=getWebviewContent(panel,context)
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

	console.log(scriptUri);

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

