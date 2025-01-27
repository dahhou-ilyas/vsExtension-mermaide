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

	// on doit crée un refrence dans react page a fin de pointer vers les fonctionne qui sont dessiner donc pour faire :
	// pour chaque foit on extraire un functionn on extraire le path de fichier et le range de function (start position, end position)
	// par la suite on transferer ces params a react et pour chaque diagramme crée on crée avec cette diagramme un ref button 
	//lorsque on clik sur le buuton on transfere les parramétre a la vscode et dans vscode on on fait un rediriction avec le path et le range

	context.subscriptions.push(
        vscode.commands.registerCommand('real-time-performance-profiler.reference', () =>{
			const editor = vscode.window.activeTextEditor;
			if (editor) {
				// Obtenir l'URI du document actif
				const documentUri = editor.document.uri;
	
				// Récupérer la sélection actuelle
				const selection = editor.selection;
	
				// Construire une plage (Range) à partir de la sélection
				const range = new vscode.Range(selection.start, selection.end);
	
				// Créer une "référence" sous forme d'objet
				const reference = {
					uri: documentUri.toString(),
					range
				};
	
				// Afficher la référence et loguer
				vscode.window.showInformationMessage(
					`Référence sauvegardée : ${documentUri.toString()} (${range.start.line}:${range.start.character} - ${range.end.line}:${range.end.character})`
				);
	
				console.log('Référence sauvegardée :', reference);
			} else {
				vscode.window.showErrorMessage('Aucun éditeur actif trouvé.');
			}

		})
    );
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
};


