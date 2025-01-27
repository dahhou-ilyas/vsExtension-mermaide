const React = require('react');

const Card = ({ res, component: Component }) => {
    const handleClick = () => {
        window.acquireVsCodeApi().postMessage({
            command: 'reference',
            text: JSON.stringify(res.reference)
        });
    }
    return (
        <div className="rounded-lg border border-gray-200 bg-white shadow-sm hover:shadow-md transition-shadow duration-200">
            <div className="p-4 border-b border-gray-100">
                <button onClick={handleClick} className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 bg-gray-50 hover:bg-gray-100 rounded-md transition-colors duration-200 group">
                    <span>Show</span>
                </button>
            </div>
            <div className="p-4">
                {Component && <Component chart={res.mermaid} />}
            </div>
        </div>
    );
};

module.exports = Card;