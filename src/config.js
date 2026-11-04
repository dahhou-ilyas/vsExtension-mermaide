'use strict';

const vscode = require('vscode');
const { EXTENSION_ID } = require('./constants');

/**
 * @typedef {Object} FlowchartSettings
 * @property {'TD' | 'LR'} direction
 * @property {'classic' | 'cyberpunk'} style
 * @property {boolean} animations
 * @property {number} maxLabelLength
 * @property {boolean} mergeSequentialStatements
 * @property {number} maxStatementsPerBlock
 * @property {boolean} codeLensEnabled
 * @property {boolean} openBeside
 * @property {number} historyLimit
 * @property {'wrap' | 'truncate'} labelMode
 * @property {number} lineWidth
 * @property {number} maxLines
 * @property {'detailed' | 'summary'} exceptionEdges
 * @property {boolean} expandCallbacks
 * @property {number} maxCallbackDepth
 */

/** @returns {FlowchartSettings} */
function getSettings() {
    const config = vscode.workspace.getConfiguration(EXTENSION_ID);
    return {
        direction: config.get('direction', 'TD') === 'LR' ? 'LR' : 'TD',
        style: config.get('style', 'classic') === 'cyberpunk' ? 'cyberpunk' : 'classic',
        animations: config.get('animations', true) !== false,
        maxLabelLength: clamp(config.get('maxLabelLength', 60), 10, 300),
        mergeSequentialStatements: config.get('mergeSequentialStatements', true),
        maxStatementsPerBlock: clamp(config.get('maxStatementsPerBlock', 4), 1, 20),
        codeLensEnabled: config.get('codeLens.enabled', true),
        openBeside: config.get('openBeside', true),
        historyLimit: clamp(config.get('historyLimit', 30), 1, 200),
        labelMode: config.get('labels.mode', 'wrap') === 'truncate' ? 'truncate' : 'wrap',
        lineWidth: clamp(config.get('labels.lineWidth', 40), 15, 120),
        maxLines: clamp(config.get('labels.maxLines', 4), 1, 30),
        exceptionEdges: config.get('exceptions', 'detailed') === 'summary' ? 'summary' : 'detailed',
        expandCallbacks: config.get('callbacks.expand', true),
        maxCallbackDepth: clamp(config.get('callbacks.maxDepth', 3), 1, 10)
    };
}

/** Options that control how labels are displayed (shared by the extension and the webview). */
function labelSettings(settings = getSettings()) {
    return {
        labelMode: settings.labelMode,
        lineWidth: settings.lineWidth,
        maxLines: settings.maxLines,
        maxLabelLength: settings.maxLabelLength
    };
}

function clamp(value, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return min;
    return Math.min(max, Math.max(min, Math.round(number)));
}

module.exports = { getSettings, labelSettings };
