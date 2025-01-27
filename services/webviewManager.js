const getWebviewContent = require("./getWebView");
const vscode = require('vscode');

class WebviewManager {
    constructor(context){
        this.currentPanel = undefined;
        this.context = context;
        this.diagrames = context.workspaceState.get('diagrames', {});
    }

    createOrUpdatePanel(data, columnToShowIn) {
        if (this.currentPanel) {
            this.updateExistingPanel(data, columnToShowIn);
        } else {
            this.createNewPanel();
        }
    }

    updateExistingPanel(data, columnToShowIn) {
        this.currentPanel.webview.postMessage({
            command: 'mistralResponse',
            text: JSON.stringify(data)
        });
        this.currentPanel.reveal(columnToShowIn);
    }

    createNewPanel() {
        const keysString = this.getExistingDiagramKeys();
        
        this.currentPanel = vscode.window.createWebviewPanel(
            'mistralPanel',
            'Mistral AI Response',
            vscode.ViewColumn.One,
            { 
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        this.currentPanel.webview.postMessage({
            command: 'mistralResponse',
            text: keysString || ""
        });

        this.currentPanel.webview.html = getWebviewContent(this.currentPanel, this.context);
        
        this.setupPanelDisposal();
    }

    getExistingDiagramKeys() {
        return Object.keys(this.diagrames).length !== 0 
            ? Object.keys(this.diagrames).join(",") 
            : "";
    }

    setupPanelDisposal() {
        this.currentPanel.onDidDispose(() => {
            this.currentPanel = undefined;
        });
    }

    addDiagram(data) {
        this.diagrames[data.mermaidBase64] = data;
    }

}

module.exports = WebviewManager