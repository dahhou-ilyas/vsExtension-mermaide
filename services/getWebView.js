const vscode = require('vscode');
const path = require('path');

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

module.exports = getWebviewContent;