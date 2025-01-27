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

    const referece = getFunctionReference(editor)

    const mermaidBase64 = Buffer.from(
        generateMermaidFlow(validation.selectedText)
    ).toString('base64');

    const data = {
        mermaidBase64:mermaidBase64,
        ...referece
    }
    webviewManager.addDiagram(data);
    webviewManager.createOrUpdatePanel(
        data, 
        editor.viewColumn
    );
    webviewManager.clickEventReferenceListenner();

}


function getFunctionReference(editor){
    const documentUri = editor.document.uri;
    
    const selection = editor.selection;

    const range = new vscode.Range(selection.start, selection.end);

    return {
        uri: documentUri.toString(),
        range
    };
}

module.exports = {handleCommande_genreteFlowDiagrame}