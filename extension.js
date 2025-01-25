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
            
			if (!selectedText) {
				return
			}
			console.log(selectedText);
			
			const prompt = `Generate Mermaid stateDiagram-v2 flowchart for code execution:

Rules:
- Use stateDiagram-v2 syntax
- Show key execution states
- Include start [*] and end [*]
- Highlight decision points
- Annotate critical transitions

Template:
stateDiagram-v2
    [*] --> FunctionStart
    FunctionStart --> InputValidation
    InputValidation --> Decision
    Decision --> ProcessLogic : Valid Inputs
    Decision --> ErrorHandling : Invalid Inputs
    ProcessLogic --> ComputeResult
    ComputeResult --> ReturnValue
    ReturnValue --> [*]
    ErrorHandling --> [*]

Code to analyze:
${selectedText}
`;

            const response = await generateMistralResponse(prompt);
			
			console.log("--------------------");
			console.log(response);
			console.log("--------------------");

			const mermidecode=extractCodeBlocks(response)

			
			const panel = vscode.window.createWebviewPanel(
				'mistralPanel',
				'Mistral AI Response',
				vscode.ViewColumn.One,
				{ enableScripts: true }
			);
			panel.webview.postMessage({
				command: 'mistralResponse',
				text: mermidecode
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

function extractCodeBlocks(input) {
	const regex = /```(\w*)\n([\s\S]*?)```/g;
	const match = regex.exec(input);
	return match ? match[2].trim() : '';
 }

