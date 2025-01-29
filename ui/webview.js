const Card = require("./Card");

const React = require("react");
const { useState, useEffect } = React;
const ReactDOM = require("react-dom/client");

const vscode = window.acquireVsCodeApi();


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
    <>
        <h1 className="text-4xl sm:text-6xl font-bold text-center mb-12 bg-gradient-to-r from-orange-600 via-orange-500 to-orange-400 text-transparent bg-clip-text">
          Welcome to your representation
        </h1>

        <div className="bg-white rounded-lg shadow-lg p-6">
          {response.length > 0 ? (
            <div className="space-y-8">
              <h2 className="text-2xl font-semibold text-gray-800 border-b pb-3">
                Flow Charts
              </h2>
              <div className="grid gap-6">
                {response.map((res, index) => (
                  MermaidComponent ? (
                    <div key={index} className="transform transition-all duration-300 hover:scale-[1.01]">
                      <Card vscode={vscode} res={res} component={MermaidComponent}/>
                    </div>
                  ) : (
                    <div key={index} className="animate-pulse bg-gray-100 rounded-lg p-4">
                      <p className="text-gray-500">Loading chart...</p>
                    </div>
                  )
                ))}
              </div>
            </div>
          ) : (
            <div className="text-center py-12">
              <p className="text-gray-500 text-lg">
                Waiting for response...
              </p>
              <div className="mt-4 animate-spin h-8 w-8 border-4 border-orange-500 border-t-transparent rounded-full mx-auto"></div>
            </div>
          )}
        </div>
    </>
  );
};


const rootElement = document.getElementById("root");
const root = ReactDOM.createRoot(rootElement);
root.render(<MistralResponsePanel />);

module.exports = MistralResponsePanel;