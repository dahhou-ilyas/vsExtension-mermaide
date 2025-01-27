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
        const values = this.getExistingDiagramValues();
        
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
            text: JSON.stringify(values) || ""
        });

        this.currentPanel.webview.html = getWebviewContent(this.currentPanel, this.context);
        
        this.clickEventReferenceListenner();
        this.setupPanelDisposal();
    }

    getExistingDiagramValues() {
        return Object.values(this.diagrames).length !== 0
          ? Object.values(this.diagrames)
          : "";
    }

    setupPanelDisposal() {
        this.currentPanel.onDidDispose(() => {
            this.currentPanel = undefined;
        });
    }

    // il faut teste si le diagrame déja existe

    addDiagram(data) {
        
        this.diagrames[data.mermaidBase64] = data;
    }

    clickEventReferenceListenner() {
        if (this.currentPanel) {
            this.currentPanel.webview.onDidReceiveMessage((message)=>{
                console.log('Message reçu du WebView:', message);
            })
        }
    }

}

module.exports = WebviewManager