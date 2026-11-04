'use strict';

const vscode = require('vscode');
const { EXTENSION_ID } = require('./constants');

/**
 * @typedef {Object} FlowchartSettings
 * @property {'TD' | 'LR'} direction
 * @property {'auto' | 'default' | 'dark' | 'forest' | 'neutral'} theme
 * @property {number} maxLabelLength
 * @property {boolean} mergeSequentialStatements
 * @property {number} maxStatementsPerBlock
 * @property {boolean} codeLensEnabled
 * @property {boolean} openBeside
 * @property {number} historyLimit
 */

/** @returns {FlowchartSettings} */
function getSettings() {
    const config = vscode.workspace.getConfiguration(EXTENSION_ID);
    return {
        direction: config.get('direction', 'TD') === 'LR' ? 'LR' : 'TD',
        theme: config.get('theme', 'auto'),
        maxLabelLength: clamp(config.get('maxLabelLength', 60), 10, 300),
        mergeSequentialStatements: config.get('mergeSequentialStatements', true),
        maxStatementsPerBlock: clamp(config.get('maxStatementsPerBlock', 4), 1, 20),
        codeLensEnabled: config.get('codeLens.enabled', true),
        openBeside: config.get('openBeside', true),
        historyLimit: clamp(config.get('historyLimit', 30), 1, 200)
    };
}

function clamp(value, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return min;
    return Math.min(max, Math.max(min, Math.round(number)));
}

module.exports = { getSettings };
