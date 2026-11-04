'use strict';

const assert = require('assert');
const vm = require('vm');
const { buildFlowchart } = require('../../src/core/flowchartBuilder');
const { generateCode } = require('../../src/core/codegen');

/** Runs `fnName(...args)` defined in `code`, capturing result, error and console output. */
function run(code, fnName, args) {
    const logs = [];
    const sandbox = { console: { log: (...a) => logs.push(a.join(' ')) }, result: undefined, args };
    vm.createContext(sandbox);
    try {
        vm.runInContext(`${code}\nresult = { value: ${fnName}(...args) };`, sandbox, { timeout: 1000 });
        return { value: JSON.stringify(sandbox.result.value), logs };
    } catch (error) {
        return { error: String(error && error.message), logs };
    }
}

/** Generates code back from the flowchart of `code` and checks both behave identically. */
function assertRoundTrip(code, fnName, inputs, options = {}) {
    const result = buildFlowchart(code, { mergeSequentialStatements: true, ...options });
    const generated = generateCode(result.graph);
    for (const unit of generated.units) {
        assert.strictEqual(unit.mode, options.expectMode || 'structured', `${unit.name} should be ${options.expectMode || 'structured'}:\n${generated.code}`);
    }
    for (const args of inputs) {
        const expected = run(code, fnName, args);
        const actual = run(generated.code, fnName, args);
        assert.deepStrictEqual(actual, expected, `different behaviour for ${JSON.stringify(args)}\n--- generated ---\n${generated.code}`);
    }
    return generated;
}

const SAMPLES = {
    sign: {
        code: `function sign(n) {
            if (n > 0) {
                return 1;
            } else if (n < 0) {
                return -1;
            }
            return 0;
        }`,
        inputs: [[5], [-3], [0]]
    },
    sumEven: {
        code: `function sumEven(list) {
            let total = 0;
            for (let i = 0; i < list.length; i++) {
                if (list[i] % 2) continue;
                if (list[i] > 100) break;
                total += list[i];
            }
            return total;
        }`,
        inputs: [[[1, 2, 3, 4]], [[2, 200, 4]], [[]]]
    },
    findPair: {
        code: `function findPair(m, target) {
            let found = null;
            outer: for (const row of m) {
                for (const cell of row) {
                    if (cell === target) { found = [row, cell]; break outer; }
                    if (cell < 0) continue outer;
                    console.log(cell);
                }
            }
            return found;
        }`,
        inputs: [[[[1, 2], [3, 4]], 3], [[[1, -1, 9], [5, 6]], 9], [[[0]], 7]]
    },
    classify: {
        code: `function classify(x) {
            let out = '';
            switch (typeof x) {
                case 'number':
                case 'bigint':
                    out = 'num';
                    break;
                case 'string':
                    out = 'str';
                case 'boolean':
                    out += '/bool';
                    break;
                default:
                    out = 'other';
            }
            return out;
        }`,
        inputs: [[1], ['s'], [true], [null]]
    },
    noDefault: {
        code: `function noDefault(x) {
            let r = 0;
            switch (x) { case 1: r = 10; break; case 2: return 20; }
            return r;
        }`,
        inputs: [[1], [2], [3]]
    },
    countdown: {
        code: `function countdown(n) {
            const seen = [];
            do {
                seen.push(n);
                n--;
                if (n === 2) continue;
            } while (n > 0);
            return seen;
        }`,
        inputs: [[3], [0], [5]]
    },
    whileTrue: {
        code: `function firstPow(limit) {
            let p = 1;
            while (true) {
                p *= 2;
                if (p > limit) break;
            }
            return p;
        }`,
        inputs: [[10], [1], [1000]]
    },
    safeParse: {
        code: `function safeParse(text) {
            let value;
            try {
                if (!text) throw new Error('empty');
                value = JSON.parse(text);
            } catch (e) {
                value = { error: e.message };
            } finally {
                console.log('done');
                console.log('really');
            }
            return value;
        }`,
        inputs: [['{"a":1}'], [''], ['{bad']]
    },
    tryNoCatch: {
        code: `function tryNoCatch(a) {
            let s = 'x';
            try { s += a; } finally { s += '!'; }
            return s;
        }`,
        inputs: [['b']]
    },
    nestedIfs: {
        code: `function grade(score, bonus) {
            let g;
            if (score >= 90) {
                g = 'A';
                if (bonus) { g += '+'; }
            } else {
                if (score >= 50) {
                    g = 'B';
                } else {
                    g = 'C';
                }
                console.log('not top');
            }
            console.log(g);
            return g;
        }`,
        inputs: [[95, true], [95, false], [60, false], [10, true]]
    },
    forIn: {
        code: `function keys(o) {
            const k = [];
            for (const key in o) {
                if (key.startsWith('_')) continue;
                k.push(key);
            }
            return k.join(',');
        }`,
        inputs: [[{ a: 1, _b: 2, c: 3 }]]
    },
    throws: {
        code: `function check(v) {
            if (typeof v !== 'number') {
                throw new TypeError('not a number: ' + v);
            }
            return v * 2;
        }`,
        inputs: [[2], ['x']]
    },
    arrow: {
        code: `const twice = (n) => n * 2;`,
        inputs: [[4]],
        fn: 'twice'
    },
    loopWithReturn: {
        code: `function indexOf(list, x) {
            for (let i = 0; i < list.length; i++) {
                if (list[i] === x) {
                    return i;
                }
            }
            return -1;
        }`,
        inputs: [[[1, 2, 3], 2], [[1], 9]]
    },
    whileElse: {
        code: `function collatz(n) {
            let steps = 0;
            while (n !== 1) {
                if (n % 2 === 0) {
                    n = n / 2;
                } else {
                    n = 3 * n + 1;
                }
                steps++;
            }
            return steps;
        }`,
        inputs: [[6], [1], [27]]
    },
    switchInLoop: {
        code: `function run(ops) {
            let acc = 0;
            for (const op of ops) {
                switch (op) {
                    case '+': acc++; break;
                    case '-': acc--; break;
                    case 'stop': return acc;
                    case 'skip': continue;
                    default: acc *= 2;
                }
                console.log(acc);
            }
            return acc;
        }`,
        inputs: [[['+', '+', '*', '-']], [['+', 'stop', '+']], [['skip', '+']]]
    },
    breakFromSwitchInLoop: {
        code: `function untilQuit(cmds) {
            let n = 0;
            loop: while (n < cmds.length) {
                switch (cmds[n]) {
                    case 'quit': break loop;
                    default: n++;
                }
            }
            return n;
        }`,
        inputs: [[['a', 'b', 'quit', 'c']], [['a']]]
    }
,
    // Patterns found by running the generator on 11,000+ real-world functions.
    scopeBlocks: {
        code: `function scopeBlocks(list) {
            const out = [];
            {
                const items = list.filter((x) => x > 0);
                out.push(items.length);
            }
            let items = list.length;
            out.push(items);
            return out.join(',');
        }`,
        inputs: [[[1, -2, 3]], [[]]]
    },
    caseBlocks: {
        code: `function caseBlocks(kind) {
            switch (kind) {
                case 'a': {
                    const value = 1;
                    return value;
                }
                case 'b': {
                    const value = 2;
                    return value;
                }
                default:
                    return 0;
            }
        }`,
        inputs: [['a'], ['b'], ['c']]
    },
    caseLexicalNoBraces: {
        code: `function caseLexicalNoBraces(kind) {
            let r;
            switch (kind) {
                case 1:
                    const raw = 'one';
                    r = raw;
                    break;
                default:
                    r = 'other';
            }
            return r;
        }`,
        inputs: [[1], [2]]
    },
    nestedFunctions: {
        code: `function nestedFunctions(n) {
            if (n < 0) return helper(-n);
            return helper(n) + twice(n);
            function helper(x) { return x * 10; }
            function twice(x) { return x * 2; }
        }`,
        inputs: [[3], [-2]]
    },
    loopReturnsOnly: {
        code: `function loopReturnsOnly(path) {
            let node = { next: { next: { value: 7 } } };
            for (let i = 0; ; i++) {
                if (i === path) return node.value ?? i;
                if (!node.next) return -1;
                node = node.next;
            }
        }`,
        inputs: [[0], [2], [5]]
    },
    loopBreakAndReturn: {
        code: `function loopBreakAndReturn(start) {
            for (let node = start; ; ) {
                const parent = node.parent;
                if (!parent) {
                    break;
                }
                if (parent.type === 'T' && node.id === parent.childId) {
                    return true;
                }
                node = parent;
            }
            return false;
        }`,
        inputs: [[{ parent: null }], [{ id: 2, parent: { type: 'T', childId: 2, parent: null } }], [{ id: 2, parent: { type: 'U', parent: null } }]]
    },
    breakInsideCaseThenFallThrough: {
        code: `function breakInsideCaseThenFallThrough(mode, same) {
            const log = [];
            switch (mode) {
                case 0:
                    log.push('init');
                    break;
                case 1:
                    if (same) {
                        log.push('same');
                        break;
                    }
                    log.push('upgrade');
                default:
                    log.push('map');
            }
            return log.join(',');
        }`,
        inputs: [[0, false], [1, true], [1, false], [2, false]]
    },
    emptyCaseBreakInLoop: {
        code: `function emptyCaseBreakInLoop(types) {
            let i = 0;
            let seen = 0;
            while (i < types.length) {
                switch (types[i]) {
                    case 'skip':
                        break;
                    case 'count':
                        if (seen > 1) {
                            return 'many';
                        }
                        seen++;
                        break;
                    default:
                        return 'stop at ' + i;
                }
                i++;
            }
            return 'seen ' + seen;
        }`,
        inputs: [[['skip', 'count', 'skip']], [['count', 'count', 'count']], [['skip', 'x']]]
    },
    finallyWithBranches: {
        code: `function finallyWithBranches(fail, verbose) {
            const log = [];
            const run = () => { if (fail) throw new Error('boom'); return 'ok'; };
            try {
                return run();
            } catch (e) {
                log.push(e.message);
            } finally {
                log.push('cleanup');
                if (verbose) {
                    log.push('verbose');
                }
                if (log.length > 5) {
                    log.length = 0;
                }
            }
            return log.join(',');
        }`,
        inputs: [[false, true], [true, true], [true, false]]
    }
};

describe('generateCode (round trip: code → flowchart → code)', () => {
    for (const [name, sample] of Object.entries(SAMPLES)) {
        it(`preserves the behaviour of ${name}`, () => {
            assertRoundTrip(sample.code, sample.fn || /function (\w+)/.exec(sample.code)[1], sample.inputs, { mergeSequentialStatements: true });
            assertRoundTrip(sample.code, sample.fn || /function (\w+)/.exec(sample.code)[1], sample.inputs, { mergeSequentialStatements: false });
        });
    }

    it('also preserves behaviour through the state machine fallback', () => {
        for (const [name, sample] of Object.entries(SAMPLES)) {
            if (/for \(|try|switch/.test(sample.code)) continue;
            const fn = sample.fn || /function (\w+)/.exec(sample.code)[1];
            const generated = generateCode(buildFlowchart(sample.code).graph, { forceStateMachine: true });
            for (const args of sample.inputs) {
                assert.deepStrictEqual(run(generated.code, fn, args), run(sample.code, fn, args), `${name}\n${generated.code}`);
            }
        }
    });

    it('produces readable code', () => {
        const { code } = assertRoundTrip(SAMPLES.sign.code, 'sign', SAMPLES.sign.inputs);
        assert.strictEqual(code, [
            'function sign(n) {',
            '    if (n > 0) {',
            '        return 1;',
            '    }',
            '    if (n < 0) {',
            '        return -1;',
            '    }',
            '    return 0;',
            '}',
            ''
        ].join('\n'));
    });

    it('regenerates function headers', () => {
        const cases = [
            ['export async function load(url: string): Promise<void> { await fetch(url); }', /^export async function load\(url: string\): Promise<void> \{/],
            ['const add = (a, b) => { return a + b; };', /^const add = \(a, b\) => \{/],
            ['let f = async function* (x) { yield x; };', /^let f = async function\*\(x\) \{/],
            ['module.exports.run = function (a) { go(a); };', /^module\.exports\.run = function\(a\) \{/]
        ];
        for (const [source, expected] of cases) {
            const { code } = generateCode(buildFlowchart(source, { language: 'typescript' }).graph);
            assert.match(code, expected, code);
        }
        const method = generateCode(buildFlowchart('class A { static async save(item) { this.x = item; } }').graph).code;
        assert.match(method, /^static async save\(item\) \{/);
    });

    it('generates loose statements without a wrapper', () => {
        const { code } = generateCode(buildFlowchart('const a = 1;\nif (a) { log(a); }').graph);
        assert.strictEqual(code, 'const a = 1;\nif (a) {\n    log(a);\n}\n');
    });

    it('keeps multi-line statements intact', () => {
        const source = 'function f() {\n    const o = {\n        a: "x  y",\n        b: 2\n    };\n    return o;\n}';
        const { code } = generateCode(buildFlowchart(source).graph);
        assert.ok(code.includes('a: "x  y",'), code);
    });
});
