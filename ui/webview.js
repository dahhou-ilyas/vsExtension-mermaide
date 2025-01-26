const Mermaid = require('./Mermaid');
const React = require('react');
const { useState, useEffect } = React;
const ReactDOM = require('react-dom/client');
require("./styles.css");


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

      <Mermaid chart={`
classDiagram
class GeoPointType {
 <<enumeration>>
  BROWNFIELD
  OGWELL
  CELL_TOWER
  NUCLEAR_REACTOR
  SUPERFUND
}
class GeoPoint {
  -UUID id
  +GeoPointType type
  +GeographyPoint location
  -UUID metadata references metadata(id)
  +Datetime createdAt
}
class GeographyPoint {
  <<interface>>
  +GeoJSON geojson
  +Int srid
  +Float longitude
  +Float latitude
}
class NearbyPoint {
 <<Interface>>
  -UUID id references GeoPoint(id)
  +GeoPointType GeoPoint::type
  +GeographyPoint GeoPoint::location
  +UUID GeoPoint::metadata
  +Float distance
}
class NearbyPoints {
<<Service>>
  +GeoJSON origin
  +Float radiusMi
  +Int first
  +Int last
  +Int offset
  +Cursor before
  +Cursor after
}
class Hotel {
 -UUID id
+String name
-Int objectid 
}
GeoPoint *-- GeoPointType: Composition
GeoPoint *-- GeographyPoint: Composition
GeoPoint "1" <|-- "1" NearbyPoint: Implements
NearbyPoints "1" -- "0..n"NearbyPoint: Contains
Hotel "1" -- "1" GeoPoint: May Contain
    
    `} />
      {response.length > 0 ? (
        <div>
          <h2 className="text-xl font-bold mb-2">Mistral AI Response:</h2>
          {response.map((res, index) => (
            <Mermaid chart={`
classDiagram
class GeoPointType {
 <<enumeration>>
  BROWNFIELD
  OGWELL
  CELL_TOWER
  NUCLEAR_REACTOR
  SUPERFUND
}
class GeoPoint {
  -UUID id
  +GeoPointType type
  +GeographyPoint location
  -UUID metadata references metadata(id)
  +Datetime createdAt
}
class GeographyPoint {
  <<interface>>
  +GeoJSON geojson
  +Int srid
  +Float longitude
  +Float latitude
}
class NearbyPoint {
 <<Interface>>
  -UUID id references GeoPoint(id)
  +GeoPointType GeoPoint::type
  +GeographyPoint GeoPoint::location
  +UUID GeoPoint::metadata
  +Float distance
}
class NearbyPoints {
<<Service>>
  +GeoJSON origin
  +Float radiusMi
  +Int first
  +Int last
  +Int offset
  +Cursor before
  +Cursor after
}
class Hotel {
 -UUID id
+String name
-Int objectid 
}
GeoPoint *-- GeoPointType: Composition
GeoPoint *-- GeographyPoint: Composition
GeoPoint "1" <|-- "1" NearbyPoint: Implements
NearbyPoints "1" -- "0..n"NearbyPoint: Contains
Hotel "1" -- "1" GeoPoint: May Contain
    
    `} />
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