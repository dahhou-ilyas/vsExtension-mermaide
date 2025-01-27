const { MESSAGES } = require("./constants");

class CodeValidator {
    static validateEditorState(editor) {
        if (!editor) {
            return { isValid: false, error: null };
        }
        const selectedText = editor.document.getText(editor.selection);
        if (!selectedText) {
            return { 
                isValid: false, 
                error: MESSAGES.SELECT_FUNCTION 
            };
        }

        const fileExtension = editor.document.fileName.split('.').pop();
        if (fileExtension !== "js") {
            return { 
                isValid: false, 
                error: MESSAGES.JAVASCRIPT_ONLY 
            };
        }

        return { isValid: true, selectedText };
    }
}

module.exports = CodeValidator