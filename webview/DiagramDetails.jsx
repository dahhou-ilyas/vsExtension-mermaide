import React from 'react';
import { post } from './vscodeApi';

const METRICS = [
    { key: 'cyclomatic', label: 'Cyclomatic', hint: 'Number of independent paths through the code (McCabe). Recommended ≤ 10.', limit: 10 },
    { key: 'cognitive', label: 'Cognitive', hint: 'How hard the code is to understand (SonarSource). Nesting costs more. Recommended ≤ 15.', limit: 15 },
    { key: 'loc', label: 'Lines', hint: 'Non-blank lines of code. Recommended ≤ 60.', limit: 60 },
    { key: 'params', label: 'Params', hint: 'Number of parameters. Recommended ≤ 4.', limit: 4 },
    { key: 'maxNesting', label: 'Nesting', hint: 'Deepest level of nested control structures. Recommended < 4.', limit: 3 },
    { key: 'branches', label: 'Branches', hint: 'if / else if / ternary / switch cases.' },
    { key: 'loops', label: 'Loops', hint: 'for / for…of / for…in / while / do…while.' },
    { key: 'returns', label: 'Returns', hint: 'Exit points (return statements).' },
    { key: 'throws', label: 'Throws', hint: 'throw statements.' },
    { key: 'awaits', label: 'Awaits', hint: 'await expressions.' },
    { key: 'calls', label: 'Calls', hint: 'Function and method calls.' }
];

/** Aggregates the metrics of several units: max for complexity-like values, sum for counts. */
function aggregate(units) {
    const result = {};
    for (const { key } of METRICS) {
        const values = units.map((u) => (u.metrics ? u.metrics[key] || 0 : 0));
        result[key] = ['cyclomatic', 'cognitive', 'maxNesting', 'params'].includes(key)
            ? Math.max(0, ...values)
            : values.reduce((a, b) => a + b, 0);
    }
    return result;
}

export function MetricStrip({ diagram }) {
    const units = (diagram.units || []).filter((u) => u.metrics);
    if (!units.length) return null;
    const values = aggregate(units);
    return (
        <dl className="fc-metrics">
            {METRICS.map(({ key, label, hint, limit }) => (
                <div key={key} className={`fc-metric${limit !== undefined && values[key] > limit ? ' fc-metric-over' : ''}`} title={hint}>
                    <dt>{label}</dt>
                    <dd>{values[key]}</dd>
                </div>
            ))}
        </dl>
    );
}

export function Insights({ diagram }) {
    const insights = diagram.insights || [];
    if (!insights.length) {
        return <p className="fc-insights-empty">✓ No issues detected.</p>;
    }
    return (
        <ul className="fc-insights">
            {insights.map((insight, index) => (
                <li key={index} className={`fc-insight fc-insight-${insight.severity}`}>
                    <span className="fc-insight-icon" aria-label={insight.severity}>{insight.severity === 'warning' ? '⚠' : 'ℹ'}</span>
                    <span className="fc-insight-text">
                        {insight.message}
                        {diagram.units && diagram.units.length > 1 ? <span className="fc-muted"> — {insight.unit}</span> : null}
                    </span>
                    {insight.range ? (
                        <button type="button" className="fc-link" onClick={() => post('reveal', { id: diagram.id, insight: index })}>
                            line {insight.range.start.line + 1}
                        </button>
                    ) : null}
                </li>
            ))}
        </ul>
    );
}

export function UnitTable({ diagram }) {
    const units = (diagram.units || []).filter((u) => u.metrics);
    if (units.length < 2) return null;
    return (
        <table className="fc-table">
            <thead>
                <tr>
                    <th>Flow</th>
                    <th title="Cyclomatic complexity">CC</th>
                    <th title="Cognitive complexity">Cog.</th>
                    <th>Lines</th>
                    <th>Params</th>
                    <th>Nesting</th>
                    <th />
                </tr>
            </thead>
            <tbody>
                {units.map((unit, index) => (
                    <tr key={index}>
                        <td className="fc-mono">{unit.name}</td>
                        <td className={unit.metrics.cyclomatic > 10 ? 'fc-over' : ''}>{unit.metrics.cyclomatic}</td>
                        <td className={unit.metrics.cognitive > 15 ? 'fc-over' : ''}>{unit.metrics.cognitive}</td>
                        <td>{unit.metrics.loc}</td>
                        <td>{unit.metrics.params}</td>
                        <td>{unit.metrics.maxNesting}</td>
                        <td>
                            {unit.range ? (
                                <button type="button" className="fc-link" onClick={() => post('reveal', { id: diagram.id, unit: index })}>
                                    line {unit.range.start.line + 1}
                                </button>
                            ) : null}
                        </td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}
