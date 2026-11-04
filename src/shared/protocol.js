'use strict';

/**
 * Message types exchanged between the extension host and the webview.
 * Shared by both sides so a typo can never silently break the protocol.
 */
const ToWebview = Object.freeze({
    STATE: 'state',
    HIGHLIGHT: 'highlight'
});

const FromWebview = Object.freeze({
    READY: 'ready',
    REVEAL: 'reveal',
    REMOVE: 'remove',
    CLEAR: 'clear',
    COPY: 'copy',
    OPEN_MARKDOWN: 'openMarkdown',
    EXPORT: 'export',
    REGENERATE: 'regenerate',
    SAVE_GRAPH: 'saveGraph',
    APPLY_CODE: 'applyCode',
    OPEN_CODE: 'openCode',
    INSERT_CODE: 'insertCode',
    ERROR: 'error'
});

module.exports = { ToWebview, FromWebview };
