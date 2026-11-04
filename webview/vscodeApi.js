/* global acquireVsCodeApi */

/**
 * Thin wrapper around the VS Code webview API. Falls back to a no-op
 * implementation so the UI can also be opened in a regular browser.
 */
const api = typeof acquireVsCodeApi === 'function'
    ? acquireVsCodeApi()
    : {
        postMessage: (message) => console.log('[vscode.postMessage]', message),
        getState: () => undefined,
        setState: () => undefined
    };

export function post(type, payload = {}) {
    api.postMessage({ type, ...payload });
}

export function getState() {
    return api.getState() || {};
}

export function setState(patch) {
    api.setState({ ...getState(), ...patch });
}
