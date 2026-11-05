'use strict';

const { parseCode, FlowchartParseError, WRAPPER_CLASS } = require('./parse');
const { analyzeUnit } = require('./metrics');
const { GRAPH_VERSION, collapse, toMermaid } = require('./graph');
const { annotateSource } = require('./codegen');

/**
 * @typedef {Object} BuildOptions
 * @property {string} [language]                  VS Code language id (javascript, typescriptreact, ...)
 * @property {'TD' | 'LR'} [direction]            Diagram layout direction
 * @property {'wrap' | 'truncate'} [labelMode]   How long labels are shortened for display
 * @property {number} [lineWidth]                 Characters per line (wrap mode)
 * @property {number} [maxLines]                  Lines per statement (wrap mode)
 * @property {number} [maxLabelLength]            Characters per label (truncate mode)
 * @property {'detailed' | 'summary'} [exceptionEdges] detailed: an edge from every statement that may throw to its handler
 * @property {boolean} [expandCallbacks]          Draw inline callbacks (forEach, then, onClick, ...) as their own flows
 * @property {number} [maxCallbackDepth]          How deep nested callbacks are expanded
 * @property {boolean} [mergeSequentialStatements] Group consecutive simple statements into one block
 * @property {number} [maxStatementsPerBlock]     Max statements per merged block
 * @property {boolean} [preferClassMember]        Try parsing the code as class members first
 * @property {string} [nameHint]                  Name to use for an anonymous function
 *
 * @typedef {Object} FlowchartUnit
 * @property {string} name
 * @property {number} complexity  Cyclomatic complexity
 * @property {number} cognitive   Cognitive complexity (SonarSource)
 * @property {import('./metrics').UnitMetrics} metrics
 * @property {number} start       Offset of the unit in the source code
 * @property {number} end
 *
 * @typedef {Object} FlowchartResult
 * @property {import('./graph').Graph} graph Graph model (source of truth for display and code generation)
 * @property {string} mermaid                 Mermaid flowchart definition
 * @property {string} title                   Human readable title
 * @property {FlowchartUnit[]} units          One entry per function / top-level block
 * @property {number} complexity              Highest cyclomatic complexity among units
 * @property {number} cognitive               Highest cognitive complexity among units
 * @property {Array<import('./metrics').Insight & { unit: string }>} insights
 * @property {Record<string, {start: number, end: number}>} nodes  Source offsets of each node
 * @property {{ nodes: number, edges: number, unreachable: number }} stats
 */

const DEFAULT_OPTIONS = {
    language: 'javascript',
    direction: 'TD',
    labelMode: 'wrap',
    lineWidth: 40,
    maxLines: 4,
    maxLabelLength: 60,
    exceptionEdges: 'detailed',
    expandCallbacks: true,
    maxCallbackDepth: 3,
    mergeSequentialStatements: true,
    maxStatementsPerBlock: 4,
    preferClassMember: false,
    nameHint: undefined
};

const FUNCTION_TYPES = new Set([
    'FunctionDeclaration',
    'FunctionExpression',
    'ArrowFunctionExpression',
    'ObjectMethod',
    'ClassMethod',
    'ClassPrivateMethod'
]);

/** Statements that never produce a node in the control flow. */
const NON_EXECUTABLE = new Set([
    'EmptyStatement',
    'ImportDeclaration',
    'ExportAllDeclaration',
    'TSInterfaceDeclaration',
    'TSTypeAliasDeclaration',
    'TSDeclareFunction',
    'TSModuleDeclaration',
    'TSImportEqualsDeclaration',
    'TSExportAssignment',
    'TSNamespaceExportDeclaration',
    'DeclareFunction',
    'DeclareVariable',
    'TypeAlias',
    'InterfaceDeclaration'
]);

/** Statements printed back verbatim when their flow is unchanged. */
const COMPOUND_TYPES = new Set(['IfStatement', 'WhileStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'DoWhileStatement', 'SwitchStatement', 'TryStatement', 'LabeledStatement']);

const LOOP_TYPES = new Set(['WhileStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'DoWhileStatement']);

function isFunctionNode(node) {
    return !!node && FUNCTION_TYPES.has(node.type);
}

function isAlwaysTruthy(test) {
    if (!test) return true;
    if (test.type === 'BooleanLiteral') return test.value === true;
    if (test.type === 'NumericLiteral') return test.value !== 0;
    return false;
}

/** Visits every AST node below `root`, without entering nested functions. */
function walkShallow(root, visit) {
    const stack = [root];
    while (stack.length) {
        const node = stack.pop();
        if (!node || typeof node.type !== 'string') continue;
        if (node !== root && isFunctionNode(node)) {
            visit(node, true);
            continue;
        }
        if (visit(node, false) === false) continue;
        for (const key of Object.keys(node)) {
            if (key === 'loc' || key === 'extra' || key.endsWith('Comments')) continue;
            const value = node[key];
            if (Array.isArray(value)) {
                for (let i = value.length - 1; i >= 0; i--) if (value[i] && typeof value[i].type === 'string') stack.push(value[i]);
            } else if (value && typeof value.type === 'string') {
                stack.push(value);
            }
        }
    }
}

const THROWING_TYPES = new Set([
    'CallExpression', 'OptionalCallExpression', 'NewExpression', 'AwaitExpression',
    'YieldExpression', 'TaggedTemplateExpression', 'ThrowStatement', 'ImportExpression'
]);

/**
 * Whether evaluating `node` may raise an exception that a surrounding `catch`
 * would see. Like Soot's ExceptionalUnitGraph, only instructions that can throw
 * get an edge to the handler: calls, `new`, `await`, `yield`, tagged templates
 * and `throw`. Code inside nested functions does not run here and is ignored.
 */
function mayThrow(node) {
    let found = false;
    walkShallow(node, (n, isFunction) => {
        if (found || isFunction) return false;
        if (THROWING_TYPES.has(n.type)) {
            found = true;
            return false;
        }
        return true;
    });
    return found;
}

/** Whether a block declares block-scoped names (let / const / class / function). */
function declaresInBlock(block) {
    return block.body.some((s) => (s.type === 'VariableDeclaration' && s.kind !== 'var')
        || s.type === 'ClassDeclaration' || s.type === 'FunctionDeclaration');
}

/** Cyclomatic complexity of a function body (nested functions excluded). */
/**
 * Whether a statement contains `break label` / `continue label` for a label
 * defined outside of it: printed as written, it would depend on code around it.
 */
function jumpsOutOfLabels(stmt) {
    let free = false;
    const visit = (node, labels) => {
        if (free || !node || typeof node.type !== 'string') return;
        if (FUNCTION_TYPES.has(node.type) || node.type === 'ArrowFunctionExpression') return;
        if ((node.type === 'BreakStatement' || node.type === 'ContinueStatement') && node.label && !labels.has(node.label.name)) {
            free = true;
            return;
        }
        const inner = node.type === 'LabeledStatement' ? new Set([...labels, node.label.name]) : labels;
        for (const key of Object.keys(node)) {
            if (key === 'loc' || key === 'extra' || key.endsWith('Comments')) continue;
            const value = node[key];
            if (Array.isArray(value)) value.forEach((v) => visit(v, inner));
            else if (value && typeof value.type === 'string') visit(value, inner);
        }
    };
    visit(stmt, new Set());
    return free;
}

function computeComplexity(root) {
    let complexity = 1;
    const visit = (node) => {
        if (!node || typeof node.type !== 'string') return;
        switch (node.type) {
            case 'IfStatement':
            case 'ConditionalExpression':
            case 'ForStatement':
            case 'ForInStatement':
            case 'ForOfStatement':
            case 'WhileStatement':
            case 'DoWhileStatement':
            case 'CatchClause':
                complexity++;
                break;
            case 'SwitchCase':
                if (node.test) complexity++;
                break;
            case 'LogicalExpression':
                complexity++;
                break;
            default:
                break;
        }
        for (const key of Object.keys(node)) {
            if (key === 'loc' || key === 'extra' || key.endsWith('Comments')) continue;
            const value = node[key];
            if (Array.isArray(value)) {
                for (const child of value) {
                    if (child && typeof child.type === 'string' && !isFunctionNode(child)) visit(child);
                }
            } else if (value && typeof value.type === 'string' && !isFunctionNode(value)) {
                visit(value);
            }
        }
    };
    visit(root);
    return complexity;
}

/* ------------------------------------------------------------------------- */
/* Builder                                                                    */
/* ------------------------------------------------------------------------- */

class FlowchartBuilder {
    /**
     * @param {string} text   Parsed text (user code, possibly wrapped)
     * @param {number} offset Characters added before the user code
     * @param {BuildOptions} options
     */
    constructor(text, offset, options) {
        this.text = text;
        this.offset = offset;
        this.options = options;
        this.counter = 0;
        /** @type {Array<any>} */
        this.nodes = [];
        /** @type {Map<string, any>} */
        this.nodeById = new Map();
        /** @type {Array<{from: string, to: string, label: string}>} */
        this.edges = [];
        /** @type {Array<any>} */
        this.units = [];
        this.unreachable = false;
        this.unitIndex = -1;
        this.pendingNested = [];
        this.pendingCallbacks = [];
        this.pendingExits = [];
        this.scopeStack = [];
        /** Lexical scopes (blocks, loop heads, catch clauses, switch bodies) around the current node. */
        this.lexStack = [];
        this.lexCounter = 0;
        this.scopeCounter = 0;
        /** @type {Map<string, number>} */
        this.callbackNames = new Map();
        /** Comments around each statement of a statement list (see collectTrivia). */
        this.trivia = new Map();
        /** Comments of statements that produce no node (break, continue): they go to the next one. */
        this.pendingTrivia = null;
        /** Where the last simple statement was merged: { id, line }. */
        this.lastPlacement = null;
    }

    /* ---------- source helpers ---------- */

    src(node) {
        return this.text.slice(node.start, node.end);
    }

    rel(pos) {
        return Math.max(0, pos - this.offset);
    }

    /* ---------- graph primitives ---------- */

    /**
     * @param {string} kind
     * @param {string[]} code   Raw code of the node
     * @param {{start: number, end: number}} [astNode]  Source range
     * @param {Object} [meta]
     */
    addNode(kind, code, astNode, meta = {}) {
        const id = `n${this.counter++}`;
        const node = {
            id,
            kind,
            code,
            meta,
            start: astNode ? this.rel(astNode.start) : undefined,
            end: astNode ? this.rel(astNode.end) : undefined,
            unit: this.unitIndex,
            unreachable: this.unreachable,
            ...(this.scopeStack.length ? { scope: [...this.scopeStack] } : {}),
            ...(this.lexStack.length ? { lex: [...this.lexStack] } : {}),
            mergeable: kind === 'process',
            async: false
        };
        this.nodes.push(node);
        this.nodeById.set(id, node);
        return id;
    }

    addEdge(from, to, label = '', code = undefined, kind = undefined) {
        const edge = { from, to, label };
        if (code !== undefined) edge.code = code;
        if (kind) edge.kind = kind;
        this.edges.push(edge);
        return edge;
    }

    /* ---------- exceptions ---------- */

    /** Innermost handler that receives an exception: a catch, or a finally that runs before propagating. */
    exceptionTarget(ctx) {
        const handler = ctx.handlers[ctx.handlers.length - 1];
        if (!handler) return null;
        if (handler.catchId) return { id: handler.catchId, handler, viaFinally: false };
        return { id: handler.finallyId, handler, viaFinally: true };
    }

    /**
     * Adds an exception edge from `nodeId` to the innermost handler when the
     * code of `astNode` may throw (detailed mode only).
     */
    linkException(nodeId, astNode, ctx) {
        if (this.options.exceptionEdges !== 'detailed' || !astNode || !ctx || !ctx.handlers.length) return;
        if (!mayThrow(astNode)) return;
        const target = this.exceptionTarget(ctx);
        if (!target) return;
        if (this.edges.some((e) => e.from === nodeId && e.to === target.id && e.kind === 'exception')) return;
        this.addEdge(nodeId, target.id, 'error', undefined, 'exception');
        target.handler.detailed = true;
        if (target.viaFinally) target.handler.abrupt.add('throw');
    }

    /* ---------- callbacks ---------- */

    /** Readable name of a callee, with nested call arguments folded: `fetch(…).then`. */
    calleeLabel(callee) {
        if (!callee) return 'callback';
        switch (callee.type) {
            case 'Identifier':
            case 'ThisExpression':
            case 'Super':
                return this.src(callee);
            case 'MemberExpression':
            case 'OptionalMemberExpression': {
                const object = this.calleeLabel(callee.object);
                const property = callee.computed ? `[${collapse(this.src(callee.property))}]` : `.${this.src(callee.property)}`;
                return `${object}${callee.optional ? '?' : ''}${property}`;
            }
            case 'CallExpression':
            case 'OptionalCallExpression':
            case 'NewExpression':
                return `${callee.type === 'NewExpression' ? 'new ' : ''}${this.calleeLabel(callee.callee)}(…)`;
            default:
                return collapse(this.src(callee)).slice(0, 30);
        }
    }

    /** Whether a callback is worth its own flow (it has some control flow or several statements). */
    isInterestingCallback(fn) {
        if (fn.body.type === 'BlockStatement') return fn.body.body.length > 0;
        let interesting = false;
        walkShallow(fn.body, (n, isFunction) => {
            if (isFunction) return false;
            if (n.type === 'ConditionalExpression' || n.type === 'LogicalExpression') interesting = true;
            return !interesting;
        });
        return interesting;
    }

    /**
     * Finds inline callbacks in the code of a node (`items.forEach(x => {…})`,
     * `promise.then(…)`, `onClick={() => {…}}`, IIFEs) and schedules them as
     * their own flows, linked to the node with a "callback" edge.
     */
    collectCallbacks(nodeId, astNode, ctx) {
        if (!this.options.expandCallbacks || !astNode || typeof astNode.type !== 'string') return;
        if ((ctx.callbackDepth || 0) >= this.options.maxCallbackDepth) return;
        const parents = new Map();
        walkShallow(astNode, (n, isFunction) => {
            if (isFunction) return false;
            for (const key of Object.keys(n)) {
                const value = n[key];
                const children = Array.isArray(value) ? value : [value];
                for (const child of children) if (child && typeof child.type === 'string') parents.set(child, n);
            }
            return true;
        });
        const found = [];
        for (const [child, parent] of parents) {
            if (child.type !== 'ArrowFunctionExpression' && child.type !== 'FunctionExpression') continue;
            if (!this.isInterestingCallback(child)) continue;
            let callee;
            let jsxAttribute = false;
            if ((parent.type === 'CallExpression' || parent.type === 'OptionalCallExpression' || parent.type === 'NewExpression')) {
                if (parent.callee === child) callee = 'IIFE';
                else if (parent.arguments.includes(child)) callee = this.calleeLabel(parent.type === 'NewExpression' ? { type: 'NewExpression', callee: parent.callee } : parent.callee).replace(/\(…\)$/, '');
            } else if (parent.type === 'JSXExpressionContainer') {
                const attribute = parents.get(parent);
                if (attribute && attribute.type === 'JSXAttribute') {
                    callee = this.src(attribute.name);
                    jsxAttribute = true;
                }
            }
            if (!callee) continue;
            if (parent.type === 'NewExpression') callee = `new ${this.calleeLabel(parent.callee)}`;
            found.push({ fn: child, callee, jsxAttribute });
        }
        found.sort((a, b) => a.fn.start - b.fn.start);
        for (const item of found) {
            const base = `${ctx.unitName} › ${item.callee}`;
            const count = (this.callbackNames.get(base) || 0) + 1;
            this.callbackNames.set(base, count);
            this.pendingCallbacks.push({
                ...item,
                sourceNodeId: nodeId,
                name: count > 1 ? `${base} #${count}` : base,
                depth: (ctx.callbackDepth || 0) + 1
            });
            this.addFold(nodeId, astNode, item.fn);
        }
    }

    /**
     * Records the body of a function drawn as its own flow, relative to the
     * code of the node, so labels show it folded (`=> {…}`).
     */
    addFold(nodeId, astNode, fn) {
        const node = this.nodeById.get(nodeId);
        if (!node || fn.body.type !== 'BlockStatement' || node.code.length !== 1) return;
        const range = this.hostRange(node, fn);
        if (!range || range.field !== 'code') return;
        node.meta.folds = [...(node.meta.folds || []), range.range];
    }

    /**
     * Where the body of an embedded function lies in the code of the node that
     * holds it: `{ field: 'code' | 'header', line, range: [start, end] }`, the
     * range being relative to that text. Found by position when the text is a
     * slice of the source, by search otherwise.
     */
    hostRange(node, fn) {
        let start = fn.body.start;
        let end = fn.body.end;
        // `x => ({ … })`: the parentheses belong to the body.
        if (fn.body.extra && fn.body.extra.parenthesized) {
            start = fn.body.extra.parenStart;
            const close = this.text.indexOf(')', end);
            if (close >= 0) end = close + 1;
        }
        const body = this.text.slice(start, end);
        const texts = (node.code || []).map((text, line) => ({ field: 'code', line, text }));
        if (node.meta && node.meta.header) texts.push({ field: 'header', line: 0, text: node.meta.header });
        const expression = fn.body.type !== 'BlockStatement';
        // The whole function (`async (a, b) => …`): replaced when its parameters are edited.
        const whole = this.text.slice(fn.start, fn.end);
        for (const candidate of texts) {
            const at = this.text.indexOf(candidate.text, Math.max(0, start - candidate.text.length));
            // The text is the slice of the source that contains the body.
            if (at >= 0 && at <= start && at + candidate.text.length >= end) {
                const fnRange = fn.start >= at && fn.end <= at + candidate.text.length ? [fn.start - at, fn.end - at] : undefined;
                return { field: candidate.field, line: candidate.line, range: [start - at, end - at], expression, ...(fnRange ? { fn: fnRange } : {}) };
            }
        }
        // Synthetic text (`return <expression body>`): the body appears once in it.
        for (const candidate of texts) {
            const at = candidate.text.indexOf(body);
            if (at >= 0 && candidate.text.indexOf(body, at + 1) < 0) {
                const fnAt = candidate.text.indexOf(whole);
                const fnRange = fnAt >= 0 && candidate.text.indexOf(whole, fnAt + 1) < 0 ? [fnAt, fnAt + whole.length] : undefined;
                return { field: candidate.field, line: candidate.line, range: [at, at + body.length], expression, ...(fnRange ? { fn: fnRange } : {}) };
            }
        }
        return null;
    }

    /** Host of an embedded flow: the node (and the range in its code) that holds the function body. */
    hostOf(nodeId, fn) {
        const node = this.nodeById.get(nodeId);
        const range = node && this.hostRange(node, fn);
        return range ? { nodeId, ...range } : undefined;
    }

    /** Whether a statement contains a callback that will be drawn as its own flow. */
    hasCallback(stmt) {
        let found = false;
        walkShallow(stmt, (n, isFunction) => {
            if (found) return false;
            if (isFunction) {
                if ((n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression') && this.isInterestingCallback(n)) found = true;
                return false;
            }
            return true;
        });
        return found;
    }

    /** Exceptions and callbacks of the code represented by a node. */
    annotate(nodeId, astNode, ctx) {
        this.linkException(nodeId, astNode, ctx);
        this.collectCallbacks(nodeId, astNode, ctx);
    }

    connect(frontier, to) {
        for (const item of frontier) {
            this.addEdge(item.id, to, item.label || '', item.code);
        }
        return [{ id: to }];
    }

    seal(frontier) {
        for (const item of frontier) {
            const node = this.nodeById.get(item.id);
            if (node) node.mergeable = false;
        }
        return frontier;
    }

    /* ---------- unit discovery ---------- */

    functionName(node, fallback) {
        if (node.id && node.id.name) return node.id.name;
        if (node.key) {
            if (node.computed) return `[${collapse(this.src(node.key))}]`;
            if (node.key.type === 'PrivateName') return `#${node.key.id.name}`;
            if (node.key.type === 'Identifier') return node.key.name;
            if (node.key.type === 'StringLiteral' || node.key.type === 'NumericLiteral') return String(node.key.value);
        }
        return fallback || this.options.nameHint || 'anonymous';
    }

    /** Everything needed to display and re-generate a function header. */
    startMeta(unit) {
        if (unit.kind === 'main') return { isMain: true };
        if (unit.kind === 'block') return { blockName: unit.name };
        const fn = unit.fn;
        const context = unit.context || {};
        const params = fn.params && fn.params.length
            ? this.text.slice(fn.params[0].start, fn.params[fn.params.length - 1].end)
            : '';
        const owner = context.member || fn;
        let fnKind = context.fnKind;
        if (!fnKind) {
            if (fn.type === 'FunctionDeclaration') fnKind = 'function';
            else if (/^(ClassMethod|ClassPrivateMethod|ObjectMethod)$/.test(fn.type)) fnKind = 'method';
            else fnKind = 'expression';
        }
        return {
            fnKind,
            callee: context.callee,
            jsxAttribute: context.jsxAttribute || undefined,
            name: context.shortName || this.functionName(fn),
            ownName: fn.id && fn.id.name ? fn.id.name : false,
            displayName: unit.name,
            params,
            async: !!fn.async,
            generator: !!fn.generator,
            static: !!owner.static,
            accessor: fn.kind === 'get' || fn.kind === 'set' ? fn.kind : undefined,
            isArrow: fn.type === 'ArrowFunctionExpression',
            returnType: fn.returnType ? this.src(fn.returnType) : '',
            typeParameters: fn.typeParameters ? this.src(fn.typeParameters) : '',
            declKind: context.declKind,
            target: context.target,
            exported: !!context.exported,
            exportDefault: !!context.exportDefault
        };
    }

    addFunctionUnit(fn, name, rangeNode, context = {}) {
        this.units.push({ kind: 'function', name, fn, rangeNode: rangeNode || fn, context });
    }

    /** Source form of a class member key (`name`, `#name`, `[expr]`, `'str'`). */
    memberKey(member) {
        const key = this.src(member.key);
        return member.computed ? `[${key}]` : key;
    }

    collectClass(classNode, className) {
        const isWrapper = className === WRAPPER_CLASS;
        for (const member of classNode.body.body) {
            const memberName = this.functionName(member, 'member');
            const fullName = isWrapper ? memberName : `${className}.${memberName}`;
            if (member.type === 'ClassMethod' || member.type === 'ClassPrivateMethod') {
                if (member.body) this.addFunctionUnit(member, fullName, member, { fnKind: 'method', shortName: this.memberKey(member) });
            } else if ((member.type === 'ClassProperty' || member.type === 'ClassPrivateProperty' || member.type === 'ClassAccessorProperty')
                && isFunctionNode(member.value)) {
                this.addFunctionUnit(member.value, fullName, member, { fnKind: 'field', shortName: this.memberKey(member), member });
            } else if (member.type === 'StaticBlock') {
                this.units.push({ kind: 'block', name: `${isWrapper ? '' : `${className} `}static {}`, statements: member.body, rangeNode: member });
            }
        }
    }

    /**
     * Splits the program into "units": functions get their own flow, the rest
     * of the top-level statements form the main flow.
     */
    collectUnits(program) {
        const main = [];
        const exportParents = new Map();
        const exportedBy = (decl) => {
            const parent = exportParents.get(decl);
            if (!parent) return false;
            return true;
        };
        const visit = (stmt) => {
            switch (stmt.type) {
                case 'FunctionDeclaration':
                    this.addFunctionUnit(stmt, this.functionName(stmt), exportParents.get(stmt) || stmt, { fnKind: 'function', exported: exportedBy(stmt) });
                    return;
                case 'ClassDeclaration':
                    this.collectClass(stmt, stmt.id ? stmt.id.name : 'AnonymousClass');
                    return;
                case 'ExportNamedDeclaration':
                    if (stmt.declaration) {
                        exportParents.set(stmt.declaration, stmt);
                        visit(stmt.declaration);
                    }
                    return;
                case 'ExportDefaultDeclaration': {
                    const decl = stmt.declaration;
                    if (isFunctionNode(decl)) {
                        this.addFunctionUnit(decl, decl.id ? decl.id.name : 'default', stmt, {
                            fnKind: decl.type === 'FunctionDeclaration' ? 'function' : 'expression',
                            exportDefault: true
                        });
                    } else if (decl.type === 'ClassDeclaration' || decl.type === 'ClassExpression') {
                        this.collectClass(decl, decl.id ? decl.id.name : 'default');
                    } else {
                        main.push(stmt);
                    }
                    return;
                }
                case 'VariableDeclaration': {
                    const fnDecls = stmt.declarations.filter((d) => isFunctionNode(d.init) || (d.init && d.init.type === 'ClassExpression'));
                    for (const d of fnDecls) {
                        const name = d.id && d.id.name ? d.id.name : 'anonymous';
                        if (d.init.type === 'ClassExpression') {
                            this.collectClass(d.init, name);
                        } else {
                            const single = stmt.declarations.length === 1;
                            const exportNode = exportParents.get(stmt);
                            this.addFunctionUnit(d.init, name, single ? (exportNode || stmt) : d, {
                                fnKind: 'variable',
                                shortName: name,
                                declKind: stmt.kind,
                                exported: !!exportNode
                            });
                        }
                    }
                    if (fnDecls.length !== stmt.declarations.length) main.push(stmt);
                    return;
                }
                case 'ExpressionStatement': {
                    const expr = stmt.expression;
                    if (isFunctionNode(expr)) {
                        this.addFunctionUnit(expr, this.functionName(expr), stmt, { fnKind: 'expression' });
                        return;
                    }
                    if (expr.type === 'ClassExpression') {
                        this.collectClass(expr, expr.id ? expr.id.name : 'AnonymousClass');
                        return;
                    }
                    if (expr.type === 'AssignmentExpression' && isFunctionNode(expr.right)) {
                        const target = collapse(this.src(expr.left));
                        this.addFunctionUnit(expr.right, target, stmt, { fnKind: 'assignment', target });
                        return;
                    }
                    main.push(stmt);
                    return;
                }
                default:
                    if (!NON_EXECUTABLE.has(stmt.type)) main.push(stmt);
            }
        };
        program.body.forEach(visit);

        if (main.length) {
            const name = this.units.length ? 'Top-level code' : 'Selection';
            this.units.unshift({ kind: 'main', name, statements: main, rangeNode: { start: main[0].start, end: main[main.length - 1].end } });
        }
    }

    /* ---------- comments (trivia) ---------- */

    /**
     * Assigns every comment that lies *between* statements to a statement, the
     * way Roslyn attaches trivia to tokens: comments on the lines above a
     * statement lead it, a comment on the same line as its end trails it, and
     * comments after the last statement of a block follow that statement.
     * Comments inside a statement are already part of its code.
     * @param {any} root
     * @param {any[]} comments
     */
    collectTrivia(root, comments) {
        const list = (comments || []).filter((c) => c.start >= this.offset).sort((a, b) => a.start - b.start);
        const between = (from, to) => {
            // comments in [from, to): binary search for the first one.
            let lo = 0;
            let hi = list.length;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (list[mid].start < from) lo = mid + 1;
                else hi = mid;
            }
            const found = [];
            for (let i = lo; i < list.length && list[i].end <= to; i++) found.push(list[i]);
            return found;
        };
        const text = this.text;
        const sameLine = (from, to) => !/\n/.test(text.slice(from, to));
        const blankBetween = (from, to) => /\n[ \t]*\r?\n/.test(text.slice(from, to));
        const raw = (c) => text.slice(c.start, c.end);

        const visitList = (statements, containerStart, containerEnd) => {
            statements.forEach((stmt, i) => {
                const prev = statements[i - 1];
                const gapStart = prev ? prev.end : containerStart;
                const found = between(gapStart, stmt.start);
                const entry = this.triviaOf(stmt);
                let rest = found;
                if (prev && found.length && sameLine(prev.end, found[0].start)) {
                    const prevEntry = this.triviaOf(prev);
                    prevEntry.tail = raw(found[0]);
                    prevEntry.tailEnd = found[0].end;
                    rest = found.slice(1);
                }
                if (rest.length) entry.lead = rest.map(raw);
                const from = prev ? (this.trivia.get(prev).tailEnd || prev.end) : null;
                if (from !== null && blankBetween(from, rest.length ? rest[0].start : stmt.start)) entry.blank = true;
            });
            const last = statements[statements.length - 1];
            if (last && containerEnd > last.end) {
                const found = between(last.end, containerEnd);
                const entry = this.triviaOf(last);
                let rest = found;
                if (found.length && sameLine(last.end, found[0].start)) {
                    entry.tail = raw(found[0]);
                    rest = found.slice(1);
                }
                if (rest.length) entry.after = rest.map(raw);
            }
        };

        const walk = (node) => {
            if (!node || typeof node.type !== 'string') return;
            if (node.type === 'BlockStatement' || node.type === 'StaticBlock') {
                visitList(node.body, node.start + 1, node.end - 1);
            } else if (node.type === 'SwitchStatement') {
                node.cases.forEach((c, i) => {
                    const colon = text.indexOf(':', c.test ? c.test.end : c.start);
                    const end = i + 1 < node.cases.length ? node.cases[i + 1].start : node.end - 1;
                    visitList(c.consequent, colon + 1, end);
                });
            } else if (node.type === 'Program') {
                visitList(node.body, this.offset, text.length);
            }
            for (const key of Object.keys(node)) {
                if (key === 'loc' || key === 'extra' || key.endsWith('Comments')) continue;
                const value = node[key];
                if (Array.isArray(value)) value.forEach(walk);
                else if (value && typeof value.type === 'string') walk(value);
            }
        };
        walk(root);
    }

    triviaOf(stmt) {
        if (!this.trivia.has(stmt)) this.trivia.set(stmt, {});
        return this.trivia.get(stmt);
    }

    /** The node a statement starts with, or the line of the node it was merged into. */
    headOf(stmt, before) {
        // A merged statement creates no node; a compound one may merge statements of its own body.
        if (this.counter === before) return this.lastPlacement;
        {
            const id = `n${before}`;
            const node = this.nodeById.get(id);
            // Compound statements remember their source span: unchanged, they are printed as written.
            if (node && COMPOUND_TYPES.has(stmt.type) && !jumpsOutOfLabels(stmt)) {
                node.meta.span = [this.rel(stmt.start), this.rel(stmt.end)];
                node.meta.ids = [before, this.counter];
            }
            return { id, line: 0 };
        }
    }

    /** Stores the comments of `stmt` on the node (and line) that represents it. */
    placeTrivia(stmt, place) {
        const entry = this.trivia.get(stmt);
        let notes = entry ? { ...entry } : null;
        if (notes) delete notes.tailEnd;
        if (this.pendingTrivia) {
            notes = notes || {};
            const pending = this.pendingTrivia;
            notes.lead = [...(pending.lead || []), ...(pending.tail ? [pending.tail] : []), ...(pending.after || []), ...(notes.lead || [])];
            if (pending.blank) notes.blank = true;
            this.pendingTrivia = null;
        }
        if (!notes || !Object.keys(notes).length) return;
        const node = place && this.nodeById.get(place.id);
        if (!node) {
            this.pendingTrivia = notes;
            return;
        }
        node.comments = node.comments || {};
        const current = node.comments[place.line] || {};
        node.comments[place.line] = {
            ...current,
            ...notes,
            ...(current.lead || notes.lead ? { lead: [...(current.lead || []), ...(notes.lead || [])] } : {})
        };
    }

    /** Runs `fn` inside a new lexical scope when `declares` is true. */
    withLex(declares, fn) {
        if (!declares) return fn();
        this.lexStack.push(`l${this.lexCounter++}`);
        try {
            return fn();
        } finally {
            this.lexStack.pop();
        }
    }

    /* ---------- statement processing ---------- */

    processList(statements, frontier, ctx) {
        const savedUnreachable = this.unreachable;
        let lastPlace = null;
        for (const stmt of statements) {
            if (stmt.type === 'FunctionDeclaration') {
                // The declaration stays in the parent's code (a definition node); its body is drawn
                // as its own flow. Declarations are hoisted, so they are never "unreachable".
                const savedFlag = this.unreachable;
                this.unreachable = false;
                const id = this.addNode('process', [this.src(stmt)], stmt, {
                    declaration: this.functionName(stmt),
                    hoisted: frontier.length === 0,
                    folds: [[stmt.body.start - stmt.start, stmt.body.end - stmt.start]]
                });
                this.unreachable = savedFlag;
                this.seal([{ id }]);
                if (frontier.length) frontier = this.seal(this.connect(frontier, id));
                this.pendingNested.push({ fn: stmt, name: `${ctx.unitName} › ${this.functionName(stmt)}`, sourceNodeId: id });
                this.placeTrivia(stmt, { id, line: 0 });
                lastPlace = { id, line: 0 };
                continue;
            }
            if (NON_EXECUTABLE.has(stmt.type)) continue;
            if (frontier.length === 0) this.unreachable = true;
            const before = this.counter;
            this.lastPlacement = null;
            if (stmt.type === 'BlockStatement' && declaresInBlock(stmt)) {
                // A block that only limits the scope of its declarations: keep it for code generation.
                this.scopeStack.push(`b${this.scopeCounter++}`);
                this.seal(frontier);
                // Comments of the block lead its first statement.
                this.placeTrivia(stmt, null);
                frontier = this.seal(this.withLex(true, () => this.processList(stmt.body, frontier, ctx)));
                this.scopeStack.pop();
                continue;
            }
            frontier = this.processStatement(stmt, frontier, ctx);
            const place = this.headOf(stmt, before);
            this.placeTrivia(stmt, place);
            if (place) lastPlace = place;
        }
        // Comments of a trailing break / continue follow the last statement of the list.
        if (this.pendingTrivia && lastPlace) {
            const node = this.nodeById.get(lastPlace.id);
            const notes = this.pendingTrivia;
            this.pendingTrivia = null;
            node.comments = node.comments || {};
            const entry = node.comments[lastPlace.line] || (node.comments[lastPlace.line] = {});
            entry.after = [...(entry.after || []), ...(notes.lead || []), ...(notes.tail ? [notes.tail] : []), ...(notes.after || [])];
        }
        this.unreachable = savedUnreachable;
        return frontier;
    }

    processStatement(stmt, frontier, ctx, labels = []) {
        switch (stmt.type) {
            case 'BlockStatement':
                return this.withLex(declaresInBlock(stmt), () => this.processList(stmt.body, frontier, ctx));
            case 'IfStatement':
                return this.seal(this.processIf(stmt, frontier, ctx));
            case 'WhileStatement':
            case 'ForStatement':
            case 'ForInStatement':
            case 'ForOfStatement': {
                const head = stmt.init || stmt.left;
                const lexical = !!head && head.type === 'VariableDeclaration' && head.kind !== 'var';
                return this.seal(this.withLex(lexical, () => this.processLoop(stmt, frontier, ctx, labels)));
            }
            case 'DoWhileStatement':
                return this.seal(this.processDoWhile(stmt, frontier, ctx, labels));
            case 'SwitchStatement': {
                const lexical = stmt.cases.some((c) => declaresInBlock({ body: c.consequent }));
                return this.seal(this.withLex(lexical, () => this.processSwitch(stmt, frontier, ctx, labels)));
            }
            case 'TryStatement':
                return this.seal(this.processTry(stmt, frontier, ctx));
            case 'LabeledStatement':
                return this.seal(this.processLabeled(stmt, frontier, ctx));
            case 'ReturnStatement':
                return this.processReturn(stmt, frontier, ctx);
            case 'ThrowStatement':
                return this.processThrow(stmt, frontier, ctx);
            case 'BreakStatement':
                return this.processBreak(stmt, frontier, ctx);
            case 'ContinueStatement':
                return this.processContinue(stmt, frontier, ctx);
            case 'ExportNamedDeclaration':
            case 'ExportDefaultDeclaration':
                if (stmt.declaration && stmt.declaration.type && /Statement|Declaration$/.test(stmt.declaration.type)) {
                    return this.processStatement(stmt.declaration, frontier, ctx);
                }
                return this.processSimple(stmt, frontier, ctx);
            default:
                return this.processSimple(stmt, frontier, ctx);
        }
    }

    processSimple(stmt, frontier, ctx) {
        const code = this.src(stmt);
        const isAsync = /\bawait\b/.test(this.src(stmt));
        const { mergeSequentialStatements, maxStatementsPerBlock } = this.options;

        // A statement holding an inline callback gets its own node, so the callback link starts from it.
        const holdsCallback = this.options.expandCallbacks && this.options.maxCallbackDepth > (ctx.callbackDepth || 0) && this.hasCallback(stmt);
        if (mergeSequentialStatements && !holdsCallback && frontier.length === 1 && !frontier[0].label) {
            const prev = this.nodeById.get(frontier[0].id);
            if (prev && prev.kind === 'process' && prev.mergeable
                && prev.unreachable === this.unreachable
                && prev.code.length < maxStatementsPerBlock) {
                prev.code.push(code);
                prev.end = this.rel(stmt.end);
                this.lastPlacement = { id: prev.id, line: prev.code.length - 1 };
                prev.async = prev.async || isAsync;
                this.annotate(prev.id, stmt, ctx);
                return frontier;
            }
        }

        const id = this.addNode('process', [code], stmt);
        this.nodeById.get(id).async = isAsync;
        const out = this.connect(frontier, id);
        this.annotate(id, stmt, ctx);
        return holdsCallback ? this.seal(out) : out;
    }

    processIf(stmt, frontier, ctx) {
        const id = this.addNode('decision', [this.src(stmt.test)], stmt.test, {
            subtype: 'if',
            // `if (…)` as written, reused while the condition is unchanged.
            head: [this.rel(stmt.start), this.rel(stmt.consequent.start)]
        });
        this.connect(frontier, id);
        this.annotate(id, stmt.test, ctx);
        const thenOut = this.processStatement(stmt.consequent, [{ id, label: 'yes' }], ctx);
        // `if (c) { …; continue; }` without else: written as a guard, the rest of the code follows the if.
        if (!stmt.alternate && thenOut.length === 0) this.nodeById.get(id).meta.guard = true;
        const elseOut = stmt.alternate
            ? this.processStatement(stmt.alternate, [{ id, label: 'no' }], ctx)
            : [{ id, label: 'no' }];
        return [...thenOut, ...elseOut];
    }

    processLoop(stmt, frontier, ctx, labels) {
        const subtype = { WhileStatement: 'while', ForStatement: 'for', ForInStatement: 'forin', ForOfStatement: 'forof' }[stmt.type];
        const header = this.addNode('loop', [stmt.test ? this.src(stmt.test) : ''], { start: stmt.start, end: stmt.body.start }, {
            subtype,
            header: this.text.slice(stmt.start, stmt.body.start).trim(),
            ...(labels.length ? { labels } : {})
        });
        this.connect(frontier, header);
        for (const part of [stmt.init, stmt.test, stmt.update, stmt.right]) if (part) this.annotate(header, part, ctx);

        const isIteration = stmt.type === 'ForInStatement' || stmt.type === 'ForOfStatement';
        const [enterLabel, exitLabel] = isIteration ? ['next', 'done'] : ['yes', 'no'];

        const jump = { type: 'loop', labels, continueTarget: header, breaks: [] };
        const bodyCtx = { ...ctx, jumps: [...ctx.jumps, jump] };
        const bodyOut = this.processStatement(stmt.body, [{ id: header, label: enterLabel }], bodyCtx);
        this.connect(bodyOut, header);

        const infinite = !isIteration && isAlwaysTruthy(stmt.test);
        return this.recordExit(header, infinite ? jump.breaks : [{ id: header, label: exitLabel }, ...jump.breaks]);
    }

    processDoWhile(stmt, frontier, ctx, labels) {
        const entry = this.addNode('junction', [], { start: stmt.start, end: stmt.body.start }, { subtype: 'do', ...(labels.length ? { labels } : {}) });
        this.connect(frontier, entry);
        const test = this.addNode('loop', [this.src(stmt.test)], stmt.test, { subtype: 'dowhile' });
        this.annotate(test, stmt.test, ctx);

        const jump = { type: 'loop', labels, continueTarget: test, breaks: [] };
        const bodyOut = this.processStatement(stmt.body, [{ id: entry }], { ...ctx, jumps: [...ctx.jumps, jump] });
        this.connect(bodyOut, test);
        this.addEdge(test, entry, 'yes');

        return this.recordExit(entry, isAlwaysTruthy(stmt.test) ? jump.breaks : [{ id: test, label: 'no' }, ...jump.breaks]);
    }

    processSwitch(stmt, frontier, ctx, labels) {
        const id = this.addNode('decision', [this.src(stmt.discriminant)], stmt.discriminant, {
            subtype: 'switch',
            // Source order of the cases (null = default): the order in which they are tested.
            caseOrder: stmt.cases.map((c) => (c.test ? this.src(c.test) : null)),
            ...(labels.length ? { labels } : {})
        });
        this.connect(frontier, id);
        this.annotate(id, stmt.discriminant, ctx);

        const jump = { type: 'switch', labels, breaks: [] };
        const caseCtx = { ...ctx, jumps: [...ctx.jumps, jump] };
        let fallthrough = [];
        let hasDefault = false;

        for (const switchCase of stmt.cases) {
            if (!switchCase.test) hasDefault = true;
            const entry = [
                switchCase.test ? { id, label: 'case', code: this.src(switchCase.test) } : { id, label: 'default' },
                ...fallthrough
            ];
            fallthrough = this.processList(switchCase.consequent, entry, caseCtx);
        }

        const out = [...fallthrough, ...jump.breaks];
        if (!hasDefault) out.push({ id, label: 'no match' });
        return this.recordExit(id, out);
    }

    /**
     * try / catch / finally with precise exceptional flow:
     *  - every statement of the try block that may throw gets an "error" edge
     *    to the catch (or to the finally when there is no catch);
     *  - statements of the catch block that may throw go to the finally;
     *  - return / throw that leave through a finally go to the finally first,
     *    and the finally continues with "then return" / "rethrow" edges, which
     *    is what compilers do when they duplicate finally blocks per exit path.
     */
    processTry(stmt, frontier, ctx) {
        const tryId = this.addNode('try', [], { start: stmt.start, end: stmt.block.start + 1 }, {
            // Source spans of the protected regions (used by the state machine fallback).
            stmt: [this.rel(stmt.start), this.rel(stmt.end)],
            block: [this.rel(stmt.block.start), this.rel(stmt.block.end)],
            ...(stmt.handler ? { handlerBody: [this.rel(stmt.handler.body.start), this.rel(stmt.handler.body.end)] } : {})
        });
        const tryMeta = this.nodeById.get(tryId).meta;
        this.connect(frontier, tryId);

        let catchId = null;
        // The catch clause is a scope: its parameter and the declarations of its body.
        const catchLex = stmt.handler ? `l${this.lexCounter++}` : null;
        if (stmt.handler) {
            this.lexStack.push(catchLex);
            catchId = this.addNode('catch', stmt.handler.param ? [this.src(stmt.handler.param)] : [], { start: stmt.handler.start, end: stmt.handler.body.start + 1 });
            tryMeta.catchId = catchId;
            this.lexStack.pop();
        }
        let finallyId = null;
        if (stmt.finalizer) {
            finallyId = this.addNode('finally', [], { start: stmt.finalizer.start, end: stmt.finalizer.start + 1 });
            tryMeta.finallyId = finallyId;
        }

        const abrupt = new Set();
        const tryHandler = { catchId, finallyId, abrupt, detailed: false };
        const tryOut = this.processList(stmt.block.body, [{ id: tryId }], { ...ctx, handlers: [...ctx.handlers, tryHandler] });

        if (catchId) {
            // The exception can happen before any statement of the try block runs:
            // keep a summary edge when no statement got a precise one.
            if (!tryHandler.detailed) this.addEdge(tryId, catchId, 'error', undefined, 'exception');
        }

        const catchCtx = finallyId
            ? { ...ctx, handlers: [...ctx.handlers, { catchId: null, finallyId, abrupt, detailed: false }] }
            : ctx;
        let catchOut = [];
        if (catchId) {
            this.lexStack.push(catchLex);
            catchOut = this.processList(stmt.handler.body.body, [{ id: catchId }], catchCtx);
            this.lexStack.pop();
        }

        if (!finallyId) return [...tryOut, ...catchOut];

        this.connect([...tryOut, ...catchOut], finallyId);
        this.seal([{ id: finallyId }]);
        const bodyOut = this.processList(stmt.finalizer.body, [{ id: finallyId }], ctx);
        if (bodyOut.length === 0) return [];

        // An explicit end of the finally block: code generation closes the block there,
        // and the interrupted return / throw continues from it.
        const endId = this.addNode('junction', [], { start: stmt.finalizer.end - 1, end: stmt.finalizer.end }, { subtype: 'finallyEnd', finallyId });
        this.connect(bodyOut, endId);
        this.nodeById.get(finallyId).meta.endId = endId;
        for (const type of abrupt) {
            const target = type === 'return' ? this.returnTarget(ctx) : this.throwTarget(ctx);
            this.addEdge(endId, target.id, type === 'return' ? 'then return' : 'rethrow', undefined, 'abrupt');
        }
        return [{ id: endId }];
    }

    /**
     * Remembers the frontier leaving a loop / switch: once it is connected to the
     * next node, that node is stored as `meta.exitId`, a structural hint for code
     * generation (it tells a `break` exit from a `return` exit).
     */
    recordExit(nodeId, out) {
        this.pendingExits.push({ nodeId, items: out.map((f) => ({ id: f.id, label: f.label || '' })) });
        return out;
    }

    resolveExits() {
        for (const { nodeId, items } of this.pendingExits) {
            const targets = new Set();
            for (const item of items) {
                const edge = this.edges.find((e) => e.from === item.id && (e.label || '') === item.label && !e.kind);
                if (edge) targets.add(edge.to);
            }
            if (targets.size === 1) this.nodeById.get(nodeId).meta.exitId = [...targets][0];
        }
        this.pendingExits = [];
    }

    /** Where a `return` goes: the innermost enclosing finally, else the end of the function. */
    returnTarget(ctx) {
        for (let i = ctx.handlers.length - 1; i >= 0; i--) {
            const handler = ctx.handlers[i];
            if (handler.finallyId) {
                handler.abrupt.add('return');
                return { id: handler.finallyId, viaFinally: true };
            }
        }
        return { id: ctx.exitId, viaFinally: false };
    }

    /** Where a `throw` goes: the innermost catch or finally, else out of the function. */
    throwTarget(ctx) {
        const target = this.exceptionTarget(ctx);
        if (!target) return { id: ctx.exitId, viaFinally: false, uncaught: true };
        if (target.viaFinally) target.handler.abrupt.add('throw');
        return target;
    }

    processLabeled(stmt, frontier, ctx) {
        const labels = [];
        let body = stmt;
        while (body.type === 'LabeledStatement') {
            labels.push(body.label.name);
            body = body.body;
        }
        if (LOOP_TYPES.has(body.type) || body.type === 'SwitchStatement') {
            return this.processStatement(body, frontier, ctx, labels);
        }
        const jump = { type: 'block', labels, breaks: [] };
        const out = this.processStatement(body, frontier, { ...ctx, jumps: [...ctx.jumps, jump] });
        return [...out, ...jump.breaks];
    }

    processReturn(stmt, frontier, ctx) {
        const id = this.addNode('return', [this.src(stmt)], stmt);
        this.connect(frontier, id);
        if (stmt.argument) this.annotate(id, stmt.argument, ctx);
        const target = this.returnTarget(ctx);
        if (target.viaFinally) this.addEdge(id, target.id, 'return', undefined, 'abrupt');
        else this.addEdge(id, target.id);
        return [];
    }

    processThrow(stmt, frontier, ctx) {
        const id = this.addNode('throw', [this.src(stmt)], stmt);
        this.connect(frontier, id);
        this.collectCallbacks(id, stmt.argument, ctx);
        const target = this.throwTarget(ctx);
        const label = target.uncaught ? 'throws' : (target.viaFinally ? 'throws' : 'caught');
        this.addEdge(id, target.id, label, undefined, 'exception');
        return [];
    }

    findJump(ctx, label, predicate) {
        for (let i = ctx.jumps.length - 1; i >= 0; i--) {
            const jump = ctx.jumps[i];
            if (label ? jump.labels.includes(label) : predicate(jump)) return jump;
        }
        return undefined;
    }

    processBreak(stmt, frontier, ctx) {
        const target = this.findJump(ctx, stmt.label && stmt.label.name, (j) => j.type === 'loop' || j.type === 'switch');
        if (!target) return frontier;
        for (const item of frontier) {
            target.breaks.push({ id: item.id, label: item.label || 'break', code: item.code });
        }
        return [];
    }

    processContinue(stmt, frontier, ctx) {
        const target = this.findJump(ctx, stmt.label && stmt.label.name, (j) => j.type === 'loop');
        if (!target) return frontier;
        for (const item of frontier) {
            this.addEdge(item.id, target.continueTarget, item.label || 'continue', item.code);
        }
        return [];
    }

    /* ---------- units ---------- */

    buildUnit(unit) {
        this.unitIndex = this.units.indexOf(unit);
        this.unreachable = false;
        this.pendingNested = [];

        const isFunction = unit.kind === 'function' || unit.kind === 'callback' || unit.kind === 'nested';
        const startRange = isFunction
            ? { start: unit.rangeNode.start, end: unit.fn.body.start }
            : unit.rangeNode;

        const startId = this.addNode('start', [], startRange, this.startMeta(unit));
        const endId = this.addNode('end', [], isFunction ? { start: unit.fn.end - 1, end: unit.fn.end } : undefined);
        unit.startId = startId;
        unit.endId = endId;
        const ctx = { jumps: [], handlers: [], exitId: endId, unitName: unit.name, callbackDepth: unit.callbackDepth || 0 };
        this.pendingCallbacks = [];
        if (unit.sourceNodeId) this.addEdge(unit.sourceNodeId, startId, unit.kind === 'nested' ? 'defines' : 'callback', undefined, 'callback');

        let out;
        if (isFunction && unit.fn.body.type !== 'BlockStatement') {
            const id = this.addNode('return', [`return ${this.src(unit.fn.body)}`], unit.fn.body);
            this.addEdge(startId, id);
            this.collectCallbacks(id, unit.fn.body, ctx);
            out = [{ id }];
        } else {
            const statements = isFunction ? unit.fn.body.body : unit.statements;
            out = this.processList(statements, [{ id: startId }], ctx);
        }
        this.connect(out, endId);
        this.resolveExits();

        unit.complexity = computeComplexity(isFunction ? unit.fn.body : { type: 'Program', body: unit.statements });
        unit.start = this.rel(unit.rangeNode.start);
        unit.end = this.rel(unit.rangeNode.end);

        const { metrics, insights } = analyzeUnit({
            body: isFunction ? unit.fn.body : unit.statements,
            params: isFunction ? unit.fn.params : [],
            name: isFunction && unit.kind !== 'callback' ? unit.name : undefined,
            source: this.text.slice(unit.rangeNode.start, unit.rangeNode.end),
            cyclomatic: unit.complexity,
            // Callbacks shown as their own flows report their own insights.
            lambdaInsights: !this.options.expandCallbacks
        });
        unit.metrics = metrics;
        unit.insights = insights.map((insight) => ({
            ...insight,
            unit: unit.name,
            start: insight.start !== undefined ? this.rel(insight.start) : unit.start,
            end: insight.end !== undefined ? this.rel(insight.end) : Math.min(unit.end, unit.start + 1)
        }));
        this.addUnreachableInsights(unit);

        // Inline callbacks and nested function declarations become their own flows, right after their parent.
        const position = this.units.indexOf(unit) + 1;
        const followers = [
            ...this.pendingCallbacks.map((c) => ({
                kind: 'callback',
                name: c.name,
                fn: c.fn,
                rangeNode: c.fn,
                sourceNodeId: c.sourceNodeId,
                host: this.hostOf(c.sourceNodeId, c.fn),
                callbackDepth: c.depth,
                context: { fnKind: 'callback', callee: c.callee, jsxAttribute: c.jsxAttribute }
            })),
            ...this.pendingNested.map((n) => ({
                kind: 'nested', name: n.name, fn: n.fn, rangeNode: n.fn, sourceNodeId: n.sourceNodeId, host: this.hostOf(n.sourceNodeId, n.fn), context: { fnKind: 'function' }
            }))
        ];
        this.units.splice(position, 0, ...followers);
    }

    /** One insight per block of unreachable code (its first node). */
    addUnreachableInsights(unit) {
        const index = this.units.indexOf(unit);
        const targets = new Set(this.edges.map((e) => e.to));
        for (const node of this.nodes) {
            if (node.unit !== index || !node.unreachable || targets.has(node.id) || node.start === undefined) continue;
            unit.insights.push({
                severity: 'warning',
                code: 'unreachable',
                message: 'Unreachable code: it can never run because a previous statement always returns, throws, breaks or continues.',
                unit: unit.name,
                start: node.start,
                end: node.end
            });
        }
    }

    build(program, comments) {
        this.collectTrivia(program, comments);
        this.collectUnits(program);
        if (this.units.length === 0) {
            throw new FlowchartParseError('No executable code found in the selection.');
        }
        // Units may grow while building (nested functions), so iterate by index.
        for (let i = 0; i < this.units.length; i++) {
            this.buildUnit(this.units[i]);
        }
    }

    /* ---------- output ---------- */

    /** @returns {import('./graph').Graph} */
    toGraph() {
        return {
            version: GRAPH_VERSION,
            direction: this.options.direction === 'LR' ? 'LR' : 'TD',
            units: this.units.map((u) => ({
                name: u.name,
                kind: u.kind,
                startId: u.startId,
                endId: u.endId,
                ...(u.host ? { host: u.host } : {}),
                ...(u.rangeNode ? { span: [this.rel(u.rangeNode.start), this.rel(u.rangeNode.end)] } : {})
            })),
            nodes: this.nodes.map((n) => {
                const node = { id: n.id, kind: n.kind, unit: n.unit, code: n.code, meta: n.meta };
                if (n.unreachable) node.unreachable = true;
                if (n.async) node.async = true;
                if (n.scope) node.scope = n.scope;
                if (n.lex) node.lex = n.lex;
                if (n.comments) node.comments = n.comments;
                if (n.start !== undefined) {
                    node.start = n.start;
                    node.end = n.end;
                }
                return node;
            }),
            edges: this.edges.map((e) => ({ ...e })),
            // The original code: unchanged parts of the flow are printed back as written.
            ...(typeof this.source === 'string' ? { source: this.source, indent: detectIndent(this.source) } : {})
        };
    }

    result() {
        const nodes = {};
        for (const node of this.nodes) {
            if (node.start !== undefined) nodes[node.id] = { start: node.start, end: node.end };
        }
        const units = this.units.map((u) => ({
            name: u.name,
            complexity: u.complexity,
            cognitive: u.metrics.cognitive,
            metrics: u.metrics,
            start: u.start,
            end: u.end
        }));
        const insights = this.units.flatMap((u) => u.insights)
            .sort((a, b) => (a.severity === b.severity ? a.start - b.start : a.severity === 'warning' ? -1 : 1));
        const embedded = (u) => u.kind === 'callback' || u.kind === 'nested';
        const named = units.filter((u, i) => this.units[i].kind !== 'main' && !embedded(this.units[i])).map((u) => u.name);
        const primary = this.units.filter((u) => !embedded(u));
        let title;
        if (primary.length === 1) {
            title = primary[0].name;
        } else if (units.length === 1) {
            title = units[0].name;
        } else if (named.length === 0) {
            title = 'Selection';
        } else {
            title = named.slice(0, 2).join(', ') + (primary.length > 2 ? ` +${primary.length - 2}` : '');
        }
        const graph = annotateSource(this.toGraph());
        return {
            graph,
            mermaid: toMermaid(graph, this.options),
            title,
            units,
            complexity: Math.max(...units.map((u) => u.complexity)),
            cognitive: Math.max(...units.map((u) => u.cognitive)),
            insights,
            nodes,
            stats: {
                nodes: this.nodes.length,
                edges: this.edges.length,
                unreachable: this.nodes.filter((n) => n.unreachable).length
            }
        };
    }
}

/**
 * Indentation unit of a piece of code: a tab, or the most common difference
 * between the indentation of consecutive lines (2, 4, ... spaces).
 * @param {string} code
 * @returns {string | undefined}
 */
function detectIndent(code) {
    const lines = String(code).split(/\r?\n/).filter((l) => l.trim());
    let tabs = 0;
    const steps = new Map();
    let previous = 0;
    for (const line of lines) {
        const indent = line.match(/^[ \t]*/)[0];
        if (indent.startsWith('\t')) {
            tabs++;
            continue;
        }
        const width = indent.length;
        const step = width - previous;
        if (step > 0 && step <= 8) steps.set(step, (steps.get(step) || 0) + 1);
        previous = width;
    }
    const best = [...steps].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
    if (tabs > (best ? best[1] : 0)) return '\t';
    return best ? ' '.repeat(best[0]) : undefined;
}

/**
 * Builds a Mermaid flowchart describing the control flow of the given code.
 *
 * @param {string} code
 * @param {BuildOptions} [options]
 * @returns {FlowchartResult}
 * @throws {FlowchartParseError} when the code cannot be parsed
 */
function buildFlowchart(code, options = {}) {
    const opts = { ...DEFAULT_OPTIONS, ...stripUndefined(options) };
    if (!code || !code.trim()) {
        throw new FlowchartParseError('The selection is empty.');
    }
    const { ast, text, offset } = parseCode(code, opts);
    const builder = new FlowchartBuilder(text, offset, opts);
    builder.source = code;
    builder.build(ast.program, ast.comments);
    return builder.result();
}

function stripUndefined(object) {
    return Object.fromEntries(Object.entries(object).filter(([, v]) => v !== undefined));
}

module.exports = { buildFlowchart, computeComplexity, detectIndent, FlowchartParseError, DEFAULT_OPTIONS };
