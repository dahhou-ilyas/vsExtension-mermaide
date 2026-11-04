'use strict';

const assert = require('assert');
const { locateFunctions, findFunctionAt } = require('../../src/core/functionLocator');

const SOURCE = `import x from 'y';

export function top(a) {
    return [1, 2].map((n) => n * a);
}

const arrow = async () => {
    await top(1);
};

class Service {
    run() {
        const inner = function () { return 1; };
        return inner();
    }
    handler = (e) => { this.run(); };
}

const api = { load() { return 1; }, save: () => { return 2; } };
`;

describe('locateFunctions', () => {
    const functions = locateFunctions(SOURCE, 'javascript');
    const byName = (name) => functions.find((f) => f.name === name);

    it('finds declarations, arrows, methods and properties', () => {
        for (const name of ['top', 'arrow', 'run', 'inner', 'handler', 'load', 'save']) {
            assert.ok(byName(name), `missing ${name}`);
        }
    });

    it('includes the export keyword in the range of exported functions', () => {
        const top = byName('top');
        assert.ok(SOURCE.slice(top.start, top.end).startsWith('export function top'));
    });

    it('uses the whole declaration for arrow functions assigned to a variable', () => {
        const arrow = byName('arrow');
        assert.ok(SOURCE.slice(arrow.start, arrow.end).startsWith('const arrow = async'));
    });

    it('marks class members so they are parsed as such', () => {
        assert.strictEqual(byName('run').preferClassMember, true);
        assert.strictEqual(byName('handler').preferClassMember, true);
    });

    it('marks anonymous callbacks and expression-bodied arrows', () => {
        const callback = functions.find((f) => !f.named);
        assert.ok(callback && callback.trivial);
    });

    it('returns an empty list for invalid code', () => {
        assert.deepStrictEqual(locateFunctions('function (', 'javascript'), []);
    });
});

describe('findFunctionAt', () => {
    const functions = locateFunctions(SOURCE, 'javascript');

    it('returns the innermost named function', () => {
        const offset = SOURCE.indexOf('return 1; };');
        assert.strictEqual(findFunctionAt(functions, offset).name, 'inner');
        assert.strictEqual(findFunctionAt(functions, SOURCE.indexOf('return inner()')).name, 'run');
    });

    it('prefers the named function over an anonymous callback', () => {
        assert.strictEqual(findFunctionAt(functions, SOURCE.indexOf('n * a')).name, 'top');
    });

    it('returns undefined outside of any function', () => {
        assert.strictEqual(findFunctionAt(functions, 0), undefined);
    });
});
