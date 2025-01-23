const path = require('path');
const vscode = require('vscode');

function activate(context) {
	context.subscriptions.push(
		vscode.commands.registerCommand('real-time-performance-profiler.helloWorld', () => {
			const panel = vscode.window.createWebviewPanel(
				'extensionPanel',
				'Extension Panel',
				vscode.ViewColumn.One,
				{ enableScripts: true }
			);
			panel.webview.html = getWebviewContent(panel,context)
			panel.webview.onDidReceiveMessage(
				message => {
				  switch (message.command) {
					case 'alertMessage':
					  vscode.window.showInformationMessage(message.text); // Afficher un message dans VS Code
					  break;
				  }
				},
				undefined,
				context.subscriptions
			  );
		})
	);
}

function deactivate() {}

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

module.exports = {
	activate,
	deactivate
};
