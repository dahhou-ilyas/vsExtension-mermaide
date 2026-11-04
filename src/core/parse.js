'use strict';

const babelParser = require('@babel/parser');

/** Name of the synthetic class used to parse a selection made of class members. */
const WRAPPER_CLASS = '__FlowchartSelection__';

class FlowchartParseError extends Error {
    /**
     * @param {string} message
     * @param {{ line: number, column: number } | undefined} loc 1-based line, 0-based column, relative to the parsed code
     */
    constructor(message, loc) {
        super(message);
        this.name = 'FlowchartParseError';
        this.loc = loc;
    }
}

/**
 * @param {string} language VS Code language id or a file extension
 */
function pluginsFor(language) {
    const lang = String(language || 'javascript').toLowerCase();
    const isTs = /^(typescript|typescriptreact|ts|tsx|mts|cts)$/.test(lang);
    const isTsx = /^(typescriptreact|tsx)$/.test(lang);
    if (isTs) {
        return isTsx ? ['typescript', 'jsx', 'decorators-legacy'] : ['typescript', 'decorators-legacy'];
    }
    return ['jsx', 'decorators-legacy'];
}

function parseOnce(code, plugins) {
    return babelParser.parse(code, {
        sourceType: 'module',
        allowReturnOutsideFunction: true,
        allowAwaitOutsideFunction: true,
        allowImportExportEverywhere: true,
        allowSuperOutsideMethod: true,
        allowUndeclaredExports: true,
        allowNewTargetOutsideFunction: true,
        errorRecovery: false,
        plugins
    });
}

/**
 * Parses a (possibly partial) piece of JavaScript / TypeScript.
 *
 * Selections are not always valid programs on their own, so several strategies
 * are tried in order:
 *   1. the code as a module,
 *   2. the code wrapped in a class body (selected methods / class members),
 *   3. the code wrapped in parentheses (an anonymous function expression).
 *
 * @param {string} code
 * @param {{ language?: string, preferClassMember?: boolean }} [options]
 * @returns {{ ast: any, text: string, offset: number, wrapper: 'none' | 'class' | 'paren' }}
 *   `offset` is the number of characters added before the user code. Subtract it
 *   from AST positions to get positions relative to `code`.
 */
function parseCode(code, options = {}) {
    const plugins = pluginsFor(options.language);
    const classPrefix = `class ${WRAPPER_CLASS} {\n`;
    const attempts = [
        { wrapper: 'none', prefix: '', suffix: '' },
        { wrapper: 'class', prefix: classPrefix, suffix: '\n}' },
        { wrapper: 'paren', prefix: '(', suffix: '\n)' }
    ];
    if (options.preferClassMember) {
        attempts.unshift(attempts.splice(1, 1)[0]);
    } else if (/^\s*(async\s+)?function\b/.test(code)) {
        // An anonymous `function () {}` would otherwise parse as a class method named "function".
        attempts.push(attempts.splice(1, 1)[0]);
    }

    let firstError;
    for (const attempt of attempts) {
        try {
            const text = attempt.prefix + code + attempt.suffix;
            const ast = parseOnce(text, plugins);
            return { ast, text, offset: attempt.prefix.length, wrapper: attempt.wrapper };
        } catch (error) {
            if (!firstError || attempt.wrapper === 'none') {
                firstError = error;
            }
        }
    }

    const loc = firstError && firstError.loc
        ? { line: firstError.loc.line, column: firstError.loc.column }
        : undefined;
    const message = String(firstError && firstError.message ? firstError.message : 'Unknown syntax error')
        .replace(/\s*\(\d+:\d+\)\s*$/, '');
    throw new FlowchartParseError(message, loc);
}

module.exports = { parseCode, pluginsFor, FlowchartParseError, WRAPPER_CLASS };
