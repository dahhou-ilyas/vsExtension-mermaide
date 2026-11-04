'use strict';

/**
 * Code metrics and insights for one flow unit (function or top-level block).
 *
 * Cognitive Complexity follows the SonarSource specification (v1.2):
 *  - +1 for if / else if / else, ternaries, switch, loops, catch,
 *    each sequence of mixed logical operators, labeled break/continue and recursion;
 *  - structures that nest add the current nesting level on top of their increment
 *    (if, ternary, switch, loops, catch);
 *  - nested lambdas increase the nesting level.
 */

/**
 * @typedef {Object} UnitMetrics
 * @property {number} cyclomatic
 * @property {number} cognitive
 * @property {number} loc            Non-blank lines
 * @property {number} params
 * @property {number} maxNesting
 * @property {number} branches
 * @property {number} loops
 * @property {number} returns
 * @property {number} throws
 * @property {number} awaits
 * @property {number} calls
 *
 * @typedef {Object} Insight
 * @property {'warning' | 'info'} severity
 * @property {string} code           Stable identifier, e.g. "empty-catch"
 * @property {string} message
 * @property {number} [start]        Offset in the parsed text
 * @property {number} [end]
 */

const THRESHOLDS = Object.freeze({
    cyclomatic: 10,
    cognitive: 15,
    nesting: 4,
    params: 4,
    loc: 60
});

const FUNCTION_TYPES = new Set(['FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod', 'ClassMethod', 'ClassPrivateMethod']);
const LOOP_TYPES = new Set(['ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement']);
const SKIP_KEYS = new Set(['loc', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'typeAnnotation', 'returnType', 'typeParameters']);

function children(node) {
    const result = [];
    for (const key of Object.keys(node)) {
        if (SKIP_KEYS.has(key)) continue;
        const value = node[key];
        if (Array.isArray(value)) {
            for (const child of value) if (child && typeof child.type === 'string') result.push(child);
        } else if (value && typeof value.type === 'string') {
            result.push(value);
        }
    }
    return result;
}

/** Operators of a chain of logical expressions, in source order. */
function logicalOperators(node, out = []) {
    if (node.type === 'LogicalExpression') {
        logicalOperators(node.left, out);
        out.push(node.operator);
        logicalOperators(node.right, out);
    }
    return out;
}

function logicalOperands(node, out = []) {
    if (node.type === 'LogicalExpression') {
        logicalOperands(node.left, out);
        logicalOperands(node.right, out);
    } else {
        out.push(node);
    }
    return out;
}

/**
 * @param {Object} unit
 * @param {any} unit.body          AST node(s) to analyze: function body or a Program-like node
 * @param {any[]} [unit.params]
 * @param {string} [unit.name]     Function name, for recursion detection
 * @param {string} unit.source     Source text of the unit (for LOC)
 * @param {number} unit.cyclomatic Cyclomatic complexity computed by the builder
 * @returns {{ metrics: UnitMetrics, insights: Insight[] }}
 */
function analyzeUnit({ body, params = [], name, source, cyclomatic, lambdaInsights = true }) {
    const metrics = {
        cyclomatic,
        cognitive: 0,
        loc: source.split(/\r?\n/).filter((line) => line.trim()).length,
        params: params.length,
        maxNesting: 0,
        branches: 0,
        loops: 0,
        returns: 0,
        throws: 0,
        awaits: 0,
        calls: 0
    };
    /** @type {Insight[]} */
    const collected = [];
    let lambdaDepth = 0;
    // Insights found inside lambdas are reported by the lambda's own flow when callbacks are expanded.
    const insights = { push: (insight) => { if (lambdaInsights || lambdaDepth === 0) collected.push(insight); } };
    const once = new Set();
    const shortName = name ? String(name).split(/[.›\s]+/).pop() : undefined;

    const depth = (nesting) => {
        metrics.maxNesting = Math.max(metrics.maxNesting, nesting + 1);
    };

    const visit = (node, nesting, inLoop) => {
        if (!node || typeof node.type !== 'string') return;
        const visitAll = (list, n = nesting, loop = inLoop) => list.forEach((child) => visit(child, n, loop));

        switch (node.type) {
            case 'IfStatement':
                visitIf(node, nesting, inLoop, false);
                return;
            case 'ConditionalExpression':
                metrics.cognitive += 1 + nesting;
                metrics.branches++;
                depth(nesting);
                visit(node.test, nesting, inLoop);
                visit(node.consequent, nesting + 1, inLoop);
                visit(node.alternate, nesting + 1, inLoop);
                return;
            case 'SwitchStatement': {
                metrics.cognitive += 1 + nesting;
                metrics.branches += node.cases.filter((c) => c.test).length;
                depth(nesting);
                visit(node.discriminant, nesting, inLoop);
                if (!node.cases.some((c) => !c.test) && node.cases.length > 0) {
                    insights.push({
                        severity: 'info',
                        code: 'switch-no-default',
                        message: 'switch statement has no default case.',
                        start: node.start,
                        end: node.discriminant.end + 1
                    });
                }
                node.cases.forEach((c) => visitAll(c.consequent, nesting + 1));
                return;
            }
            case 'TryStatement':
                visit(node.block, nesting, inLoop);
                if (node.handler) {
                    metrics.cognitive += 1 + nesting;
                    depth(nesting);
                    if (node.handler.body.body.length === 0) {
                        insights.push({
                            severity: 'warning',
                            code: 'empty-catch',
                            message: 'Empty catch block silently swallows errors.',
                            start: node.handler.start,
                            end: node.handler.end
                        });
                    }
                    visit(node.handler.body, nesting + 1, inLoop);
                }
                if (node.finalizer) visit(node.finalizer, nesting, inLoop);
                return;
            case 'LogicalExpression': {
                const operators = logicalOperators(node);
                let sequences = operators.length ? 1 : 0;
                for (let i = 1; i < operators.length; i++) if (operators[i] !== operators[i - 1]) sequences++;
                metrics.cognitive += sequences;
                visitAll(logicalOperands(node));
                return;
            }
            case 'BreakStatement':
            case 'ContinueStatement':
                if (node.label) metrics.cognitive += 1;
                return;
            case 'ReturnStatement':
                metrics.returns++;
                visitAll(children(node));
                return;
            case 'ThrowStatement':
                metrics.throws++;
                visitAll(children(node));
                return;
            case 'AwaitExpression':
                metrics.awaits++;
                if (inLoop && !once.has('await-in-loop')) {
                    once.add('await-in-loop');
                    insights.push({
                        severity: 'info',
                        code: 'await-in-loop',
                        message: 'await inside a loop runs the iterations sequentially. Consider Promise.all() if they are independent.',
                        start: node.start,
                        end: node.end
                    });
                }
                visitAll(children(node));
                return;
            case 'CallExpression':
            case 'OptionalCallExpression':
                metrics.calls++;
                if (shortName && node.callee && node.callee.type === 'Identifier' && node.callee.name === shortName) {
                    metrics.cognitive += 1;
                    if (!once.has('recursion')) {
                        once.add('recursion');
                        insights.push({
                            severity: 'info',
                            code: 'recursion',
                            message: `${shortName}() is recursive. Make sure the base case is always reached.`,
                            start: node.start,
                            end: node.end
                        });
                    }
                }
                visitAll(children(node));
                return;
            case 'DebuggerStatement':
                insights.push({ severity: 'warning', code: 'debugger', message: 'debugger statement left in the code.', start: node.start, end: node.end });
                return;
            case 'FunctionDeclaration':
                // Rendered and analyzed as its own flow.
                return;
            default:
                break;
        }

        if (LOOP_TYPES.has(node.type)) {
            metrics.cognitive += 1 + nesting;
            metrics.loops++;
            depth(nesting);
            const isForAwait = node.type === 'ForOfStatement' && node.await;
            for (const key of ['init', 'test', 'update', 'left', 'right']) {
                if (node[key]) visit(node[key], nesting, inLoop);
            }
            visit(node.body, nesting + 1, !isForAwait);
            return;
        }

        if (FUNCTION_TYPES.has(node.type)) {
            // Lambdas / nested function expressions increase nesting (they are not loops).
            lambdaDepth++;
            visit(node.body, nesting + 1, false);
            lambdaDepth--;
            return;
        }

        visitAll(children(node));
    };

    const visitIf = (node, nesting, inLoop, isElseIf) => {
        metrics.cognitive += isElseIf ? 1 : 1 + nesting;
        metrics.branches++;
        depth(nesting);
        visit(node.test, nesting, inLoop);
        visit(node.consequent, nesting + 1, inLoop);
        if (node.alternate) {
            if (node.alternate.type === 'IfStatement') {
                visitIf(node.alternate, nesting, inLoop, true);
            } else {
                metrics.cognitive += 1;
                visit(node.alternate, nesting + 1, inLoop);
            }
        }
    };

    if (Array.isArray(body)) body.forEach((n) => visit(n, 0, false));
    else visit(body, 0, false);

    if (metrics.cyclomatic > THRESHOLDS.cyclomatic) {
        insights.push({
            severity: 'warning',
            code: 'high-cyclomatic',
            message: `Cyclomatic complexity is ${metrics.cyclomatic} (recommended ≤ ${THRESHOLDS.cyclomatic}): many independent paths to test. Consider splitting this function.`
        });
    }
    if (metrics.cognitive > THRESHOLDS.cognitive) {
        insights.push({
            severity: 'warning',
            code: 'high-cognitive',
            message: `Cognitive complexity is ${metrics.cognitive} (recommended ≤ ${THRESHOLDS.cognitive}): this code is hard to read. Extract nested logic into helpers.`
        });
    }
    if (metrics.maxNesting >= THRESHOLDS.nesting) {
        insights.push({
            severity: 'warning',
            code: 'deep-nesting',
            message: `Control structures are nested ${metrics.maxNesting} levels deep. Guard clauses (early returns) usually flatten this.`
        });
    }
    if (metrics.params > THRESHOLDS.params) {
        insights.push({
            severity: 'info',
            code: 'many-params',
            message: `${metrics.params} parameters. Consider grouping them into an options object.`
        });
    }
    if (metrics.loc > THRESHOLDS.loc) {
        insights.push({
            severity: 'info',
            code: 'long-function',
            message: `${metrics.loc} lines of code (recommended ≤ ${THRESHOLDS.loc}). Long functions are harder to understand and test.`
        });
    }

    return { metrics, insights: collected };
}

module.exports = { analyzeUnit, THRESHOLDS };
