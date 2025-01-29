const React = require('react');

const Card = ({ vscode, res, component: Component }) => {
    const handleClick = () => {
        if (res.reference) {
            vscode.postMessage({
                command: 'reference',
                text: JSON.stringify(res.reference)
            });
        } else {
            console.error('No reference found in res');
        }
    }

    return (
        <div className="rounded-lg border border-gray-200 bg-white shadow-sm hover:shadow-md transition-shadow duration-200">
            <div className="p-4 border-b border-gray-100 flex justify-between items-center">
                <h2 className="text-lg font-semibold text-gray-800">Card Title</h2>
                <button 
                    onClick={handleClick} 
                    className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 bg-gray-50 hover:bg-gray-100 rounded-md transition-colors duration-200 group"
                    aria-label="Show Reference"
                >
                    <span>Show</span>
                </button>
            </div>
            <div className="p-4">
                {Component ? <Component chart={res.mermaid} /> : <p className="text-gray-500">Loading...</p>}
            </div>
        </div>
    );
};

module.exports = Card;