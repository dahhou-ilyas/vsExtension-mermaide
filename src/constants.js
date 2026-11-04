'use strict';

const EXTENSION_ID = 'flowchartGenerator';

const COMMANDS = Object.freeze({
    GENERATE: `${EXTENSION_ID}.generate`,
    GENERATE_FILE: `${EXTENSION_ID}.generateFile`,
    SHOW_PANEL: `${EXTENSION_ID}.showPanel`,
    CLEAR_HISTORY: `${EXTENSION_ID}.clearHistory`,
    NEW_FLOWCHART: `${EXTENSION_ID}.newFlowchart`,
    CODE_FROM_MERMAID: `${EXTENSION_ID}.codeFromMermaid`
});

const VIEW_TYPE = `${EXTENSION_ID}.panel`;

const STORAGE_KEY = `${EXTENSION_ID}.diagrams.v2`;

const SUPPORTED_LANGUAGES = Object.freeze(['javascript', 'javascriptreact', 'typescript', 'typescriptreact']);

/** File extensions accepted when the language id is not one of the above (e.g. plain text editors). */
const SUPPORTED_EXTENSIONS = Object.freeze(['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx']);

const MESSAGES = Object.freeze({
    UNSUPPORTED_LANGUAGE: 'Flowchart Generator supports JavaScript and TypeScript files (.js, .jsx, .mjs, .cjs, .ts, .tsx).',
    NO_EDITOR: 'Open a JavaScript or TypeScript file to generate a flowchart.',
    NO_FUNCTION: 'Select some code or place the cursor inside a function to generate a flowchart.',
    WHOLE_FILE: 'Use Entire File',
    CLEAR_CONFIRM: 'Remove all flowcharts from this workspace?',
    CLEAR: 'Clear',
    COPIED: 'Mermaid definition copied to the clipboard.',
    SOURCE_MISSING: 'The source file for this flowchart could not be opened. It may have been moved or deleted.',
    SOURCE_CHANGED: 'The source code changed since this flowchart was generated. Regenerate the flowchart, or open the generated code in a new editor.',
    APPLY_CONFIRM: 'Replace the original code with the code generated from the flowchart? Review the differences in the diff editor.',
    REPLACE: 'Replace',
    OPEN_NEW: 'Open in New Editor',
    NO_TARGET_EDITOR: 'Open a file and place the cursor where the code should be inserted.'
});

module.exports = { EXTENSION_ID, COMMANDS, VIEW_TYPE, STORAGE_KEY, SUPPORTED_LANGUAGES, SUPPORTED_EXTENSIONS, MESSAGES };
