const React = require('react');
const { useState, useEffect } = React;
const ReactDOM = require('react-dom/client');

const MistralResponsePanel = () => {
  const [response, setResponse] = useState([]);

  useEffect(() => {
    const handleMessage = (event) => {
      const message = event.data;
      if (message.command === 'mistralResponse') {
        const decodedString = atob(message.text);
        
        setResponse((prev) => [...prev, decodedString]);
      }
    };

    window.addEventListener('message', handleMessage);

    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, []);

  return (
    <div className="p-4">
      <h1 className="text-6xl font-bold bg-gradient-to-r from-orange-500 via-orange-400 to-orange-300 text-transparent bg-clip-text w-full text-center">
        Welcome to your representation
      </h1>

      {response.length > 0 ? (
        <div>
          <h2 className="text-xl font-bold mb-2">Mistral AI Response:</h2>
          {response.map((res, index) => (
            <pre key={index} className="text-gray-700 whitespace-pre-wrap">{res}</pre>
          ))}
        </div>
      ) : (
        <p className="text-gray-500">Waiting for Mistral AI response...</p>
      )}
    </div>
  );
};

const rootElement = document.getElementById('root');
const root = ReactDOM.createRoot(rootElement);
root.render(<MistralResponsePanel />);

module.exports = MistralResponsePanel;