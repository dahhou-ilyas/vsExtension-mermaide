'use strict';

const { parseCode, FlowchartParseError, WRAPPER_CLASS } = require('./parse');
const { analyzeUnit } = require('./metrics');

/**
 * @typedef {Object} BuildOptions
 * @property {string} [language]                  VS Code language id (javascript, typescriptreact, ...)
 * @property {'TD' | 'LR'} [direction]            Diagram layout direction
 * @property {number} [maxLabelLength]            Truncate node labels after this many characters
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
    maxLabelLength: 60,
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

const LOOP_TYPES = new Set(['WhileStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'DoWhileStatement']);

const SHAPES = {
    start: ['([', '])'],
    end: ['([', '])'],
    process: ['[', ']'],
    decision: ['{', '}'],
    loop: ['{{', '}}'],
    return: ['(', ')'],
    throw: ['>', ']'],
    try: ['[[', ']]'],
    catch: ['[[', ']]'],
    finally: ['[[', ']]'],
    junction: ['((', '))']
};

const CLASS_BY_KIND = {
    start: 'cfStart',
    end: 'cfEnd',
    decision: 'cfDecision',
    loop: 'cfLoop',
    return: 'cfReturn',
    throw: 'cfThrow',
    try: 'cfTry',
    catch: 'cfTry',
    finally: 'cfTry',
    junction: 'cfJunction'
};

const CLASS_DEFS = [
    'classDef cfStart fill:#2e7d32,stroke:#1b5e20,color:#ffffff,stroke-width:2px',
    'classDef cfEnd fill:#455a64,stroke:#263238,color:#ffffff,stroke-width:2px',
    'classDef cfDecision fill:#ffca28,stroke:#f57f17,color:#1a1a1a',
    'classDef cfLoop fill:#7e57c2,stroke:#4527a0,color:#ffffff',
    'classDef cfReturn fill:#1e88e5,stroke:#0d47a1,color:#ffffff',
    'classDef cfThrow fill:#e53935,stroke:#b71c1c,color:#ffffff',
    'classDef cfTry fill:#fb8c00,stroke:#e65100,color:#ffffff',
    'classDef cfJunction fill:#90a4ae,stroke:#546e7a,color:#1a1a1a',
    'classDef cfAsync stroke:#00acc1,stroke-width:3px',
    'classDef cfUnreachable fill:#bdbdbd,stroke:#757575,color:#424242,stroke-dasharray:5 4'
];

/* ------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* ------------------------------------------------------------------------- */

function collapse(text) {
    return String(text).replace(/\s+/g, ' ').trim();
}

function truncate(text, max) {
    return text.length > max ? `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…` : text;
}

/**
 * Escapes a label so it can be used inside a quoted Mermaid string rendered as SVG text.
 *
 * Only `#lt;`, `#gt;` and `#amp;` are reliably decoded by Mermaid in SVG-text mode,
 * so double quotes (which would close the string) are rendered as single quotes,
 * `#word;` sequences are broken with a zero-width space so they are not read as
 * entities, and a leading backtick is guarded so it is not parsed as a Markdown string.
 */
function escapeLabel(text) {
    let label = String(text)
        .replace(/&/g, '#amp;')
        .replace(/</g, '#lt;')
        .replace(/>/g, '#gt;')
        .replace(/"/g, "'")
        .replace(/#(?!(?:amp|lt|gt);)(?=\w+;)/g, '#\u200B');
    if (label.startsWith('`')) label = `\u200B${label}`;
    return label;
}

function escapeEdgeLabel(text) {
    return escapeLabel(text).replace(/\|/g, '\u2223');
}

function isFunctionNode(node) {
    return !!node && FUNCTION_TYPES.has(node.type);
}

function isAlwaysTruthy(test) {
    if (!test) return true;
    if (test.type === 'BooleanLiteral') return test.value === true;
    if (test.type === 'NumericLiteral') return test.value !== 0;
    return false;
}

/** Cyclomatic complexity of a function body (nested functions excluded). */
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
    }

    /* ---------- source helpers ---------- */

    src(node) {
        return this.text.slice(node.start, node.end);
    }

    label(node) {
        return truncate(collapse(this.src(node)).replace(/;$/, ''), this.options.maxLabelLength);
    }

    rel(pos) {
        return Math.max(0, pos - this.offset);
    }

    /* ---------- graph primitives ---------- */

    addNode(kind, label, astNode) {
        const id = `n${this.counter++}`;
        const node = {
            id,
            kind,
            lines: [label],
            start: astNode ? this.rel(astNode.start) : undefined,
            end: astNode ? this.rel(astNode.end) : undefined,
            unit: this.unitIndex,
            unreachable: this.unreachable,
            mergeable: kind === 'process',
            async: false
        };
        this.nodes.push(node);
        this.nodeById.set(id, node);
        return id;
    }

    addEdge(from, to, label = '') {
        this.edges.push({ from, to, label });
    }

    connect(frontier, to) {
        for (const item of frontier) {
            this.addEdge(item.id, to, item.label || '');
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

    signature(fn, name) {
        const params = fn.params && fn.params.length
            ? collapse(this.text.slice(fn.params[0].start, fn.params[fn.params.length - 1].end))
            : '';
        const prefixes = [];
        if (fn.static) prefixes.push('static');
        if (fn.async) prefixes.push('async');
        if (fn.kind === 'get' || fn.kind === 'set') prefixes.push(fn.kind);
        const star = fn.generator ? '*' : '';
        const prefix = prefixes.length ? `${prefixes.join(' ')} ` : '';
        return truncate(`${prefix}${star}${name}(${params})`, Math.max(this.options.maxLabelLength, 40));
    }

    addFunctionUnit(fn, name, rangeNode) {
        this.units.push({ kind: 'function', name, fn, rangeNode: rangeNode || fn });
    }

    collectClass(classNode, className) {
        const isWrapper = className === WRAPPER_CLASS;
        for (const member of classNode.body.body) {
            const memberName = this.functionName(member, 'member');
            const fullName = isWrapper ? memberName : `${className}.${memberName}`;
            if (member.type === 'ClassMethod' || member.type === 'ClassPrivateMethod') {
                if (member.body) this.addFunctionUnit(member, fullName);
            } else if ((member.type === 'ClassProperty' || member.type === 'ClassPrivateProperty' || member.type === 'ClassAccessorProperty')
                && isFunctionNode(member.value)) {
                this.addFunctionUnit(member.value, fullName, member);
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
        const visit = (stmt) => {
            switch (stmt.type) {
                case 'FunctionDeclaration':
                    this.addFunctionUnit(stmt, this.functionName(stmt), stmt);
                    return;
                case 'ClassDeclaration':
                    this.collectClass(stmt, stmt.id ? stmt.id.name : 'AnonymousClass');
                    return;
                case 'ExportNamedDeclaration':
                    if (stmt.declaration) visit(stmt.declaration);
                    return;
                case 'ExportDefaultDeclaration': {
                    const decl = stmt.declaration;
                    if (isFunctionNode(decl)) {
                        this.addFunctionUnit(decl, decl.id ? decl.id.name : 'default', stmt);
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
                            this.addFunctionUnit(d.init, name, stmt.declarations.length === 1 ? stmt : d);
                        }
                    }
                    if (fnDecls.length !== stmt.declarations.length) main.push(stmt);
                    return;
                }
                case 'ExpressionStatement': {
                    const expr = stmt.expression;
                    if (isFunctionNode(expr)) {
                        this.addFunctionUnit(expr, this.functionName(expr), stmt);
                        return;
                    }
                    if (expr.type === 'ClassExpression') {
                        this.collectClass(expr, expr.id ? expr.id.name : 'AnonymousClass');
                        return;
                    }
                    if (expr.type === 'AssignmentExpression' && isFunctionNode(expr.right)) {
                        this.addFunctionUnit(expr.right, collapse(this.src(expr.left)), stmt);
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

    /* ---------- statement processing ---------- */

    processList(statements, frontier, ctx) {
        const savedUnreachable = this.unreachable;
        for (const stmt of statements) {
            if (stmt.type === 'FunctionDeclaration') {
                // Hoisted: rendered as its own flow, never "unreachable".
                this.pendingNested.push({ fn: stmt, name: `${ctx.unitName} › ${this.functionName(stmt)}` });
                continue;
            }
            if (NON_EXECUTABLE.has(stmt.type)) continue;
            if (frontier.length === 0) this.unreachable = true;
            frontier = this.processStatement(stmt, frontier, ctx);
        }
        this.unreachable = savedUnreachable;
        return frontier;
    }

    processStatement(stmt, frontier, ctx, labels = []) {
        switch (stmt.type) {
            case 'BlockStatement':
                return this.processList(stmt.body, frontier, ctx);
            case 'IfStatement':
                return this.seal(this.processIf(stmt, frontier, ctx));
            case 'WhileStatement':
            case 'ForStatement':
            case 'ForInStatement':
            case 'ForOfStatement':
                return this.seal(this.processLoop(stmt, frontier, ctx, labels));
            case 'DoWhileStatement':
                return this.seal(this.processDoWhile(stmt, frontier, ctx, labels));
            case 'SwitchStatement':
                return this.seal(this.processSwitch(stmt, frontier, ctx, labels));
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
                return this.processSimple(stmt, frontier);
            default:
                return this.processSimple(stmt, frontier);
        }
    }

    processSimple(stmt, frontier) {
        const label = this.label(stmt);
        const isAsync = /\bawait\b/.test(this.src(stmt));
        const { mergeSequentialStatements, maxStatementsPerBlock } = this.options;

        if (mergeSequentialStatements && frontier.length === 1 && !frontier[0].label) {
            const prev = this.nodeById.get(frontier[0].id);
            if (prev && prev.kind === 'process' && prev.mergeable
                && prev.unreachable === this.unreachable
                && prev.lines.length < maxStatementsPerBlock) {
                prev.lines.push(label);
                prev.end = this.rel(stmt.end);
                prev.async = prev.async || isAsync;
                return frontier;
            }
        }

        const id = this.addNode('process', label, stmt);
        this.nodeById.get(id).async = isAsync;
        return this.connect(frontier, id);
    }

    processIf(stmt, frontier, ctx) {
        const id = this.addNode('decision', truncate(`if (${collapse(this.src(stmt.test))})`, this.options.maxLabelLength), stmt.test);
        this.connect(frontier, id);
        const thenOut = this.processStatement(stmt.consequent, [{ id, label: 'yes' }], ctx);
        const elseOut = stmt.alternate
            ? this.processStatement(stmt.alternate, [{ id, label: 'no' }], ctx)
            : [{ id, label: 'no' }];
        return [...thenOut, ...elseOut];
    }

    loopHeaderLabel(stmt) {
        if (stmt.type === 'WhileStatement') return `while (${collapse(this.src(stmt.test))})`;
        return collapse(this.text.slice(stmt.start, stmt.body.start));
    }

    processLoop(stmt, frontier, ctx, labels) {
        const header = this.addNode('loop', truncate(this.loopHeaderLabel(stmt), this.options.maxLabelLength),
            { start: stmt.start, end: stmt.body.start });
        this.connect(frontier, header);

        const isIteration = stmt.type === 'ForInStatement' || stmt.type === 'ForOfStatement';
        const [enterLabel, exitLabel] = isIteration ? ['next', 'done'] : ['yes', 'no'];

        const jump = { type: 'loop', labels, continueTarget: header, breaks: [] };
        const bodyCtx = { ...ctx, jumps: [...ctx.jumps, jump] };
        const bodyOut = this.processStatement(stmt.body, [{ id: header, label: enterLabel }], bodyCtx);
        this.connect(bodyOut, header);

        const infinite = !isIteration && isAlwaysTruthy(stmt.test);
        return infinite ? jump.breaks : [{ id: header, label: exitLabel }, ...jump.breaks];
    }

    processDoWhile(stmt, frontier, ctx, labels) {
        const entry = this.addNode('junction', 'do', { start: stmt.start, end: stmt.body.start });
        this.connect(frontier, entry);
        const test = this.addNode('loop', truncate(`while (${collapse(this.src(stmt.test))})`, this.options.maxLabelLength), stmt.test);

        const jump = { type: 'loop', labels, continueTarget: test, breaks: [] };
        const bodyOut = this.processStatement(stmt.body, [{ id: entry }], { ...ctx, jumps: [...ctx.jumps, jump] });
        this.connect(bodyOut, test);
        this.addEdge(test, entry, 'yes');

        return isAlwaysTruthy(stmt.test) ? jump.breaks : [{ id: test, label: 'no' }, ...jump.breaks];
    }

    processSwitch(stmt, frontier, ctx, labels) {
        const id = this.addNode('decision', truncate(`switch (${collapse(this.src(stmt.discriminant))})`, this.options.maxLabelLength), stmt.discriminant);
        this.connect(frontier, id);

        const jump = { type: 'switch', labels, breaks: [] };
        const caseCtx = { ...ctx, jumps: [...ctx.jumps, jump] };
        let fallthrough = [];
        let hasDefault = false;

        for (const switchCase of stmt.cases) {
            if (!switchCase.test) hasDefault = true;
            const caseLabel = switchCase.test ? truncate(`case ${collapse(this.src(switchCase.test))}`, 30) : 'default';
            const entry = [{ id, label: caseLabel }, ...fallthrough];
            fallthrough = this.processList(switchCase.consequent, entry, caseCtx);
        }

        const out = [...fallthrough, ...jump.breaks];
        if (!hasDefault) out.push({ id, label: 'no match' });
        return out;
    }

    processTry(stmt, frontier, ctx) {
        const tryId = this.addNode('try', 'try', { start: stmt.start, end: stmt.block.start + 1 });
        this.connect(frontier, tryId);

        let catchId = null;
        if (stmt.handler) {
            const param = stmt.handler.param ? `catch (${collapse(this.src(stmt.handler.param))})` : 'catch';
            catchId = this.addNode('catch', truncate(param, this.options.maxLabelLength), { start: stmt.handler.start, end: stmt.handler.body.start + 1 });
            this.addEdge(tryId, catchId, 'error');
        }

        const tryCtx = catchId ? { ...ctx, catchTarget: catchId } : ctx;
        const tryOut = this.processList(stmt.block.body, [{ id: tryId }], tryCtx);
        const catchOut = catchId ? this.processList(stmt.handler.body.body, [{ id: catchId }], ctx) : [];

        if (stmt.finalizer) {
            const finallyId = this.addNode('finally', 'finally', { start: stmt.finalizer.start, end: stmt.finalizer.start + 1 });
            this.connect([...tryOut, ...catchOut], finallyId);
            return this.processList(stmt.finalizer.body, [{ id: finallyId }], ctx);
        }
        return [...tryOut, ...catchOut];
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
        const id = this.addNode('return', this.label(stmt), stmt);
        this.connect(frontier, id);
        this.addEdge(id, ctx.exitId);
        return [];
    }

    processThrow(stmt, frontier, ctx) {
        const id = this.addNode('throw', this.label(stmt), stmt);
        this.connect(frontier, id);
        if (ctx.catchTarget) {
            this.addEdge(id, ctx.catchTarget, 'caught');
        } else {
            this.addEdge(id, ctx.exitId, 'throws');
        }
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
            target.breaks.push({ id: item.id, label: item.label || 'break' });
        }
        return [];
    }

    processContinue(stmt, frontier, ctx) {
        const target = this.findJump(ctx, stmt.label && stmt.label.name, (j) => j.type === 'loop');
        if (!target) return frontier;
        for (const item of frontier) {
            this.addEdge(item.id, target.continueTarget, item.label || 'continue');
        }
        return [];
    }

    /* ---------- units ---------- */

    buildUnit(unit) {
        this.unitIndex = this.units.indexOf(unit);
        this.unreachable = false;
        this.pendingNested = [];

        const isFunction = unit.kind === 'function';
        const startLabel = isFunction ? this.signature(unit.fn, unit.name) : (unit.kind === 'block' ? unit.name : 'Start');
        const startRange = isFunction
            ? { start: unit.rangeNode.start, end: unit.fn.body.start }
            : unit.rangeNode;

        const startId = this.addNode('start', startLabel, startRange);
        const endId = this.addNode('end', 'End', isFunction ? { start: unit.fn.end - 1, end: unit.fn.end } : undefined);
        const ctx = { jumps: [], catchTarget: null, exitId: endId, unitName: unit.name };

        let out;
        if (isFunction && unit.fn.body.type !== 'BlockStatement') {
            const id = this.addNode('return', truncate(`return ${collapse(this.src(unit.fn.body))}`, this.options.maxLabelLength), unit.fn.body);
            this.addEdge(startId, id);
            out = [{ id }];
        } else {
            const statements = isFunction ? unit.fn.body.body : unit.statements;
            out = this.processList(statements, [{ id: startId }], ctx);
        }
        this.connect(out, endId);

        unit.complexity = computeComplexity(isFunction ? unit.fn.body : { type: 'Program', body: unit.statements });
        unit.start = this.rel(unit.rangeNode.start);
        unit.end = this.rel(unit.rangeNode.end);

        const { metrics, insights } = analyzeUnit({
            body: isFunction ? unit.fn.body : unit.statements,
            params: isFunction ? unit.fn.params : [],
            name: isFunction ? unit.name : undefined,
            source: this.text.slice(unit.rangeNode.start, unit.rangeNode.end),
            cyclomatic: unit.complexity
        });
        unit.metrics = metrics;
        unit.insights = insights.map((insight) => ({
            ...insight,
            unit: unit.name,
            start: insight.start !== undefined ? this.rel(insight.start) : unit.start,
            end: insight.end !== undefined ? this.rel(insight.end) : Math.min(unit.end, unit.start + 1)
        }));
        this.addUnreachableInsights(unit);

        // Nested function declarations become their own flows, right after their parent.
        const nested = this.pendingNested;
        const position = this.units.indexOf(unit) + 1;
        nested.forEach((n, i) => {
            this.units.splice(position + i, 0, { kind: 'function', name: n.name, fn: n.fn, rangeNode: n.fn });
        });
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

    build(program) {
        this.collectUnits(program);
        if (this.units.length === 0) {
            throw new FlowchartParseError('No executable code found in the selection.');
        }
        // Units may grow while building (nested functions), so iterate by index.
        for (let i = 0; i < this.units.length; i++) {
            this.buildUnit(this.units[i]);
        }
    }

    /* ---------- Mermaid output ---------- */

    nodeLine(node) {
        const [open, close] = SHAPES[node.kind] || SHAPES.process;
        const label = node.lines.map(escapeLabel).join('<br/>');
        return `${node.id}${open}"${label}"${close}`;
    }

    toMermaid() {
        const lines = [`flowchart ${this.options.direction === 'LR' ? 'LR' : 'TD'}`];
        const grouped = this.units.length > 1;

        this.units.forEach((unit, index) => {
            const unitNodes = this.nodes.filter((n) => n.unit === index);
            if (grouped) {
                lines.push(`    subgraph sg${index}["${escapeLabel(unit.name)}"]`);
                unitNodes.forEach((n) => lines.push(`        ${this.nodeLine(n)}`));
                lines.push('    end');
            } else {
                unitNodes.forEach((n) => lines.push(`    ${this.nodeLine(n)}`));
            }
        });

        if (grouped) {
            // Invisible links stack the subgraphs vertically instead of side by side.
            for (let i = 1; i < this.units.length; i++) {
                lines.push(`    sg${i - 1} ~~~ sg${i}`);
            }
        }

        for (const edge of this.edges) {
            const from = this.nodeById.get(edge.from);
            const arrow = from && from.unreachable ? '-.->' : '-->';
            const label = edge.label ? `|"${escapeEdgeLabel(edge.label)}"|` : '';
            lines.push(`    ${edge.from} ${arrow}${label} ${edge.to}`);
        }

        const byClass = new Map();
        const addClass = (cls, id) => {
            if (!byClass.has(cls)) byClass.set(cls, []);
            byClass.get(cls).push(id);
        };
        for (const node of this.nodes) {
            if (node.unreachable) {
                addClass('cfUnreachable', node.id);
                continue;
            }
            if (CLASS_BY_KIND[node.kind]) addClass(CLASS_BY_KIND[node.kind], node.id);
            if (node.async) addClass('cfAsync', node.id);
        }

        lines.push('');
        CLASS_DEFS.forEach((def) => lines.push(`    ${def}`));
        for (const [cls, ids] of byClass) {
            lines.push(`    class ${ids.join(',')} ${cls}`);
        }
        return `${lines.join('\n')}\n`;
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
        const named = units.filter((u, i) => this.units[i].kind !== 'main').map((u) => u.name);
        let title;
        if (units.length === 1) {
            title = units[0].name;
        } else if (named.length === 0) {
            title = 'Selection';
        } else {
            title = named.slice(0, 2).join(', ') + (units.length > 2 ? ` +${units.length - 2}` : '');
        }
        return {
            mermaid: this.toMermaid(),
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
    builder.build(ast.program);
    return builder.result();
}

function stripUndefined(object) {
    return Object.fromEntries(Object.entries(object).filter(([, v]) => v !== undefined));
}

module.exports = { buildFlowchart, computeComplexity, escapeLabel, FlowchartParseError, DEFAULT_OPTIONS };
