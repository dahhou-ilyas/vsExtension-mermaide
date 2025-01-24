import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom/client';

const MistralResponsePanel = () => {
  const [response, setResponse] = useState([]);

  useEffect(() => {
    // Listen for messages from VS Code extension
    const handleMessage = (event) => {
      const message = event.data;
      if (message.command === 'mistralResponse') {
        setResponse(pre=>[...pre,message.text]);
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

      {response ? (
        <div>
          <h2 className="text-xl font-bold mb-2">Mistral AI Response:</h2>
          <p className="text-gray-700">{response}</p>
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

export default MistralResponsePanel;