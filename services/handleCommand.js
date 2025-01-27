const vscode = require('vscode');

async function handleCommande_genreteFlowDiagrame(webviewManager,generateMermaidFlow,CodeValidator,MESSAGES) {
    if (!generateMermaidFlow) {
        vscode.window.showErrorMessage(MESSAGES.MODULE_NOT_LOADED);
        return;
    }

    const editor = vscode.window.activeTextEditor;
    const validation = CodeValidator.validateEditorState(editor);
    
    if (!validation.isValid) {
        if (validation.error) {
            vscode.window.showInformationMessage(validation.error);
        }
        return;
    }

    const mermaidBase64 = Buffer.from(
        generateMermaidFlow(validation.selectedText)
    ).toString('base64');
    
    webviewManager.addDiagram(mermaidBase64);
    webviewManager.createOrUpdatePanel(
        mermaidBase64, 
        editor.viewColumn
    );
}

module.exports = {handleCommande_genreteFlowDiagrame}