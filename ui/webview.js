import React from 'react';
import ReactDOM from 'react-dom/client'; // Utilisez 'react-dom/client' pour React 18+

const YourPanel = () => {
    return (
        <div className="flex flex-col items-center justify-center h-full space-y-4">
            <h1 className="text-3xl font-bold text-blue-600">Votre UI avec Tailwind CSS</h1>
            <p className="text-gray-700">Bienvenue dans votre chat personnalisé !</p>
            <input 
                type="text" 
                className="border border-gray-300 p-2 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Tapez votre message"
            />
            <button className="bg-blue-500 text-white p-2 rounded-lg hover:bg-blue-600">
                Envoyer
            </button>
        </div>
    );
};

// Obtenez l'élément racine
const rootElement = document.getElementById('root');

// Créez un "root" et rendez l'application React
const root = ReactDOM.createRoot(rootElement);
root.render(<YourPanel />);