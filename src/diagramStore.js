'use strict';

const vscode = require('vscode');
const { STORAGE_KEY } = require('./constants');

/**
 * @typedef {{ line: number, character: number }} Pos
 * @typedef {{ start: Pos, end: Pos }} Span
 *
 * @typedef {Object} DiagramRecord
 * @property {string} id
 * @property {string} title
 * @property {string} mermaid
 * @property {string} uri            Source document URI
 * @property {string} fileName       Workspace relative path, for display
 * @property {string} languageId
 * @property {Span} range            Range the flowchart was generated from
 * @property {Record<string, Span>} nodes  Source range of every node
 * @property {Array<{name: string, complexity: number, cognitive: number, metrics: object, range: Span}>} units
 * @property {number} complexity     Highest cyclomatic complexity
 * @property {number} cognitive      Highest cognitive complexity
 * @property {Array<{severity: 'warning' | 'info', code: string, message: string, unit: string, range: Span}>} insights
 * @property {{nodes: number, edges: number, unreachable: number}} stats
 * @property {{ preferClassMember: boolean, nameHint?: string, wholeFile: boolean }} [generation]  How to regenerate it
 * @property {import('./core/graph').Graph} [graph]  Graph model, editable in the panel
 * @property {'code' | 'designer' | 'mermaid'} [origin]
 * @property {string} [sourceHash]  Hash of the source the flowchart was generated from
 * @property {boolean} [edited]     The graph was edited in the panel
 * @property {number} createdAt
 */

/**
 * Persists generated flowcharts per workspace, most recent first.
 */
class DiagramStore {
    /**
     * @param {vscode.Memento} memento
     * @param {() => number} getLimit
     */
    constructor(memento, getLimit) {
        this.memento = memento;
        this.getLimit = getLimit;
        this.emitter = new vscode.EventEmitter();
        /** Fired whenever the list of diagrams changes. */
        this.onDidChange = this.emitter.event;
        /** @type {DiagramRecord[]} */
        const stored = memento.get(STORAGE_KEY, []);
        this.diagrams = Array.isArray(stored) ? stored.filter((d) => d && d.id && d.mermaid) : [];
    }

    /** @returns {DiagramRecord[]} */
    all() {
        return this.diagrams;
    }

    /** @param {string} id */
    get(id) {
        return this.diagrams.find((d) => d.id === id);
    }

    /**
     * Adds a diagram, replacing any diagram generated from the same source range.
     * @param {DiagramRecord} diagram
     */
    async upsert(diagram) {
        const sameSource = (d) => !!diagram.uri && d.uri === diagram.uri
            && d.range.start.line === diagram.range.start.line
            && d.range.start.character === diagram.range.start.character
            && d.range.end.line === diagram.range.end.line
            && d.range.end.character === diagram.range.end.character;
        const previous = this.diagrams.find(sameSource);
        if (previous) diagram.id = previous.id;
        this.diagrams = [diagram, ...this.diagrams.filter((d) => !sameSource(d))].slice(0, this.getLimit());
        await this.persist();
        return diagram;
    }

    /**
     * Replaces a diagram in place (same position in the list).
     * @param {DiagramRecord} diagram
     */
    async replace(diagram) {
        const index = this.diagrams.findIndex((d) => d.id === diagram.id);
        if (index < 0) return this.upsert(diagram);
        this.diagrams = [...this.diagrams.slice(0, index), diagram, ...this.diagrams.slice(index + 1)];
        await this.persist();
        return diagram;
    }

    /** @param {string} id */
    async remove(id) {
        this.diagrams = this.diagrams.filter((d) => d.id !== id);
        await this.persist();
    }

    async clear() {
        this.diagrams = [];
        await this.persist();
    }

    async persist() {
        await this.memento.update(STORAGE_KEY, this.diagrams);
        this.emitter.fire(this.diagrams);
    }

    dispose() {
        this.emitter.dispose();
    }
}

module.exports = { DiagramStore };
