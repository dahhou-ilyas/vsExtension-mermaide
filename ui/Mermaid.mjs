import React from "react";
import mermaid from "mermaid";

class Mermaid extends React.Component {
  componentDidMount() {
    mermaid.initialize({
      startOnLoad: true,
      securityLevel: "loose",
      theme: "default",
      themeCSS: `
        g.classGroup rect {
          fill: #282a36;
          stroke: #6272a4;
        }
        g.classGroup text {
          fill: #f8f8f2;
        }
        /* Personnalisation supplémentaire */
      `,
      fontFamily: "Fira Code",
    });

    // Génération des graphiques après le montage du composant
    mermaid.contentLoaded();
  }

  render() {
    return <div className="mermaid">{this.props.chart}</div>;
  }
}

// Exporter la classe avec ES Modules
export default Mermaid;
