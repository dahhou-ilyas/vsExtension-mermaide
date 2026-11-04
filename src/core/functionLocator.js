'use strict';

const { parseCode } = require('./parse');

/**
 * @typedef {Object} FunctionLocation
 * @property {string} name
 * @property {number} start            Offset of the code to generate a flowchart for
 * @property {number} end
 * @property {number} nameOffset       Offset where the CodeLens should be anchored
 * @property {boolean} named           false for anonymous callbacks
 * @property {boolean} trivial         true for expression-bodied arrow functions
 * @property {boolean} preferClassMember  The range is a class / object member
 * @property {string} [nameHint]       Name to use when the range is an anonymous function
 */

function keyName(key, computed) {
    if (!key) return undefined;
    if (computed) return undefined;
    if (key.type === 'Identifier') return key.name;
    if (key.type === 'PrivateName') return `#${key.id.name}`;
    if (key.type === 'StringLiteral' || key.type === 'NumericLiteral') return String(key.value);
    return undefined;
}

function walk(node, parents, visit) {
    if (!node || typeof node.type !== 'string') return;
    visit(node, parents);
    parents.push(node);
    for (const key of Object.keys(node)) {
        if (key === 'loc' || key === 'extra' || key.endsWith('Comments')) continue;
        const value = node[key];
        if (Array.isArray(value)) {
            for (const child of value) walk(child, parents, visit);
        } else if (value && typeof value.type === 'string') {
            walk(value, parents, visit);
        }
    }
    parents.pop();
}

/**
 * Finds every function-like construct in a source file.
 *
 * @param {string} code
 * @param {string} language
 * @returns {FunctionLocation[]}
 */
function locateFunctions(code, language) {
    let ast;
    try {
        ({ ast } = parseCode(code, { language }));
    } catch {
        return [];
    }

    /** @type {FunctionLocation[]} */
    const found = [];
    walk(ast.program, [], (node, parents) => {
        const parent = parents[parents.length - 1];
        const grand = parents[parents.length - 2];
        const exportWrap = (n, p) => (p && /^Export(Named|Default)Declaration$/.test(p.type) ? p : n);
        const base = { trivial: false, preferClassMember: false, named: true, nameOffset: node.start };

        switch (node.type) {
            case 'FunctionDeclaration': {
                const range = exportWrap(node, parent);
                found.push({ ...base, name: node.id ? node.id.name : 'default', start: range.start, end: range.end, nameOffset: range.start });
                return;
            }
            case 'ClassMethod':
            case 'ClassPrivateMethod':
            case 'ObjectMethod': {
                if (!node.body) return;
                const name = keyName(node.key, node.computed) || 'method';
                found.push({ ...base, name, start: node.start, end: node.end, preferClassMember: true });
                return;
            }
            case 'ArrowFunctionExpression':
            case 'FunctionExpression': {
                const trivial = node.body.type !== 'BlockStatement';
                if (parent && parent.type === 'VariableDeclarator' && parent.init === node && parent.id.type === 'Identifier') {
                    const single = grand && grand.type === 'VariableDeclaration' && grand.declarations.length === 1;
                    const range = single ? exportWrap(grand, parents[parents.length - 3]) : node;
                    found.push({ ...base, name: parent.id.name, start: range.start, end: range.end, nameOffset: range.start, trivial, nameHint: parent.id.name });
                    return;
                }
                if (parent && parent.type === 'AssignmentExpression' && parent.right === node) {
                    const name = code.slice(parent.left.start, parent.left.end).replace(/\s+/g, '');
                    const range = grand && grand.type === 'ExpressionStatement' ? grand : node;
                    found.push({ ...base, name, start: range.start, end: range.end, nameOffset: range.start, trivial, nameHint: name });
                    return;
                }
                if (parent && /^Class(Private)?Property$|^ClassAccessorProperty$/.test(parent.type) && parent.value === node) {
                    const name = keyName(parent.key, parent.computed) || 'property';
                    found.push({ ...base, name, start: parent.start, end: parent.end, nameOffset: parent.start, trivial, preferClassMember: true });
                    return;
                }
                if (parent && parent.type === 'ObjectProperty' && parent.value === node) {
                    const name = keyName(parent.key, parent.computed) || 'property';
                    found.push({ ...base, name, start: node.start, end: node.end, nameOffset: parent.start, trivial, nameHint: name });
                    return;
                }
                if (parent && parent.type === 'ExportDefaultDeclaration') {
                    found.push({ ...base, name: 'default', start: parent.start, end: parent.end, nameOffset: parent.start, trivial });
                    return;
                }
                const name = node.id ? node.id.name : 'anonymous';
                found.push({ ...base, name, start: node.start, end: node.end, trivial, named: !!node.id, nameHint: name });
                return;
            }
            default:
                return;
        }
    });

    return found;
}

/**
 * Returns the innermost named function containing `offset`, falling back to
 * the innermost anonymous one.
 *
 * @param {FunctionLocation[]} functions
 * @param {number} offset
 * @returns {FunctionLocation | undefined}
 */
function findFunctionAt(functions, offset) {
    const containing = functions
        .filter((f) => f.start <= offset && offset <= f.end)
        .sort((a, b) => (a.end - a.start) - (b.end - b.start));
    return containing.find((f) => f.named) || containing[0];
}

module.exports = { locateFunctions, findFunctionAt };
