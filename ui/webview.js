const Card = require("./Card");

const React = require("react");
const { useState, useEffect } = React;
const ReactDOM = require("react-dom/client");

const MistralResponsePanel = () => {
  const [response, setResponse] = useState([]);
  const [MermaidComponent, setMermaidComponent] = useState(null); // Stocke le composant Mermaid importé dynamiquement

  useEffect(() => {
    // Importation dynamique de Mermaid lors du montage du composant
    const loadMermaid = async () => {
      const { default: Mermaid } = await import("./Mermaid.mjs");
      setMermaidComponent(() => Mermaid); // Stocker le composant dans l'état
    };

    loadMermaid();

    const handleMessage = (event) => {
      const message = event.data;
      if (message.command === "mistralResponse") {
        try {
          const parsedData = JSON.parse(message.text);
          
          const dataArray = Array.isArray(parsedData) ? parsedData : [parsedData];
          
          const processedData = dataArray.map(data => {
            if (!data.mermaidBase64) {
              console.warn("Donnée reçue sans mermaidBase64:", data);
              return null;
            }
    
            try {
              const decodedMermaid = atob(data.mermaidBase64);
              return {
                mermaid: decodedMermaid,
                reference: {
                  uri: data.uri,
                  range: data.range
                }
              };
            } catch (decodingError) {
              console.error("Erreur de décodage base64:", decodingError);
              return null;
            }
          }).filter(item => item !== null);

          setResponse(prev => [...prev, ...processedData]);
          
        } catch (error) {
          console.error("Erreur lors du traitement du message :", error);
        }
      }
    };

    window.addEventListener("message", handleMessage);

    return () => {
      window.removeEventListener("message", handleMessage);
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
            MermaidComponent ? <Card res={res} component={MermaidComponent}/> : <p key={index}>Loading chart...</p>
          ))}
        </div>
      ) : (
        <p className="text-gray-500">Waiting for Mistral AI response...</p>
      )}
      
    </div>
  );
};

const rootElement = document.getElementById("root");
const root = ReactDOM.createRoot(rootElement);
root.render(<MistralResponsePanel />);

module.exports = MistralResponsePanel;
