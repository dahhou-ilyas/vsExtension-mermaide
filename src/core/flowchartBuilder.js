'use strict';

const { parseCode, FlowchartParseError, WRAPPER_CLASS } = require('./parse');
const { analyzeUnit } = require('./metrics');
const { GRAPH_VERSION, collapse, toMermaid } = require('./graph');

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
            mergeable: kind === 'process',
            async: false
        };
        this.nodes.push(node);
        this.nodeById.set(id, node);
        return id;
    }

    addEdge(from, to, label = '', code = undefined) {
        const edge = { from, to, label };
        if (code !== undefined) edge.code = code;
        this.edges.push(edge);
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
            name: context.shortName || this.functionName(fn),
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
        const code = this.src(stmt);
        const isAsync = /\bawait\b/.test(this.src(stmt));
        const { mergeSequentialStatements, maxStatementsPerBlock } = this.options;

        if (mergeSequentialStatements && frontier.length === 1 && !frontier[0].label) {
            const prev = this.nodeById.get(frontier[0].id);
            if (prev && prev.kind === 'process' && prev.mergeable
                && prev.unreachable === this.unreachable
                && prev.code.length < maxStatementsPerBlock) {
                prev.code.push(code);
                prev.end = this.rel(stmt.end);
                prev.async = prev.async || isAsync;
                return frontier;
            }
        }

        const id = this.addNode('process', [code], stmt);
        this.nodeById.get(id).async = isAsync;
        return this.connect(frontier, id);
    }

    processIf(stmt, frontier, ctx) {
        const id = this.addNode('decision', [this.src(stmt.test)], stmt.test, { subtype: 'if' });
        this.connect(frontier, id);
        const thenOut = this.processStatement(stmt.consequent, [{ id, label: 'yes' }], ctx);
        const elseOut = stmt.alternate
            ? this.processStatement(stmt.alternate, [{ id, label: 'no' }], ctx)
            : [{ id, label: 'no' }];
        return [...thenOut, ...elseOut];
    }

    processLoop(stmt, frontier, ctx, labels) {
        const subtype = { WhileStatement: 'while', ForStatement: 'for', ForInStatement: 'forin', ForOfStatement: 'forof' }[stmt.type];
        const header = this.addNode('loop', [stmt.test ? this.src(stmt.test) : ''], { start: stmt.start, end: stmt.body.start }, {
            subtype,
            header: this.text.slice(stmt.start, stmt.body.start).trim()
        });
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
        const entry = this.addNode('junction', [], { start: stmt.start, end: stmt.body.start }, { subtype: 'do' });
        this.connect(frontier, entry);
        const test = this.addNode('loop', [this.src(stmt.test)], stmt.test, { subtype: 'dowhile' });

        const jump = { type: 'loop', labels, continueTarget: test, breaks: [] };
        const bodyOut = this.processStatement(stmt.body, [{ id: entry }], { ...ctx, jumps: [...ctx.jumps, jump] });
        this.connect(bodyOut, test);
        this.addEdge(test, entry, 'yes');

        return isAlwaysTruthy(stmt.test) ? jump.breaks : [{ id: test, label: 'no' }, ...jump.breaks];
    }

    processSwitch(stmt, frontier, ctx, labels) {
        const id = this.addNode('decision', [this.src(stmt.discriminant)], stmt.discriminant, { subtype: 'switch' });
        this.connect(frontier, id);

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
        return out;
    }

    processTry(stmt, frontier, ctx) {
        const tryId = this.addNode('try', [], { start: stmt.start, end: stmt.block.start + 1 }, {});
        const tryMeta = this.nodeById.get(tryId).meta;
        this.connect(frontier, tryId);

        let catchId = null;
        if (stmt.handler) {
            catchId = this.addNode('catch', stmt.handler.param ? [this.src(stmt.handler.param)] : [], { start: stmt.handler.start, end: stmt.handler.body.start + 1 });
            tryMeta.catchId = catchId;
            this.addEdge(tryId, catchId, 'error');
        }

        const tryCtx = catchId ? { ...ctx, catchTarget: catchId } : ctx;
        const tryOut = this.processList(stmt.block.body, [{ id: tryId }], tryCtx);
        const catchOut = catchId ? this.processList(stmt.handler.body.body, [{ id: catchId }], ctx) : [];

        if (stmt.finalizer) {
            const finallyId = this.addNode('finally', [], { start: stmt.finalizer.start, end: stmt.finalizer.start + 1 });
            tryMeta.finallyId = finallyId;
            this.connect([...tryOut, ...catchOut], finallyId);
            this.seal([{ id: finallyId }]);
            const out = this.seal(this.processList(stmt.finalizer.body, [{ id: finallyId }], ctx));
            // Where the finally block ends, so code generation can close it.
            this.nodeById.get(finallyId).meta.exits = out.map((f) => ({ id: f.id, label: f.label || '' }));
            return out;
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
        const id = this.addNode('return', [this.src(stmt)], stmt);
        this.connect(frontier, id);
        this.addEdge(id, ctx.exitId);
        return [];
    }

    processThrow(stmt, frontier, ctx) {
        const id = this.addNode('throw', [this.src(stmt)], stmt);
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

        const isFunction = unit.kind === 'function';
        const startRange = isFunction
            ? { start: unit.rangeNode.start, end: unit.fn.body.start }
            : unit.rangeNode;

        const startId = this.addNode('start', [], startRange, this.startMeta(unit));
        const endId = this.addNode('end', [], isFunction ? { start: unit.fn.end - 1, end: unit.fn.end } : undefined);
        unit.startId = startId;
        unit.endId = endId;
        const ctx = { jumps: [], catchTarget: null, exitId: endId, unitName: unit.name };

        let out;
        if (isFunction && unit.fn.body.type !== 'BlockStatement') {
            const id = this.addNode('return', [`return ${this.src(unit.fn.body)}`], unit.fn.body);
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
            this.units.splice(position + i, 0, { kind: 'function', name: n.name, fn: n.fn, rangeNode: n.fn, context: { fnKind: 'function' } });
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

    /* ---------- output ---------- */

    /** @returns {import('./graph').Graph} */
    toGraph() {
        return {
            version: GRAPH_VERSION,
            direction: this.options.direction === 'LR' ? 'LR' : 'TD',
            units: this.units.map((u) => ({ name: u.name, kind: u.kind, startId: u.startId, endId: u.endId })),
            nodes: this.nodes.map((n) => {
                const node = { id: n.id, kind: n.kind, unit: n.unit, code: n.code, meta: n.meta };
                if (n.unreachable) node.unreachable = true;
                if (n.async) node.async = true;
                if (n.start !== undefined) {
                    node.start = n.start;
                    node.end = n.end;
                }
                return node;
            }),
            edges: this.edges.map((e) => ({ ...e }))
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
        const named = units.filter((u, i) => this.units[i].kind !== 'main').map((u) => u.name);
        let title;
        if (units.length === 1) {
            title = units[0].name;
        } else if (named.length === 0) {
            title = 'Selection';
        } else {
            title = named.slice(0, 2).join(', ') + (units.length > 2 ? ` +${units.length - 2}` : '');
        }
        const graph = this.toGraph();
        return {
            graph,
            mermaid: toMermaid(graph, { maxLabelLength: this.options.maxLabelLength }),
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

module.exports = { buildFlowchart, computeComplexity, FlowchartParseError, DEFAULT_OPTIONS };
