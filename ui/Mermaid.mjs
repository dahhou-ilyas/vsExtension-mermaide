import React from "react";
import mermaid from "mermaid";

class Mermaid extends React.Component {
  componentDidMount() {
    mermaid.initialize({
      startOnLoad: true,
      securityLevel: "loose",
      theme: "dark",
      themeCSS: `
        /* Modern color palette */
        :root {
          --primary: #4F46E5;
          --secondary: #60A5FA;
          --background: #1E1E2E;
          --text: #F3F4F6;
          --border-radius: 8px;
        }

        /* Graph elements */
        g.classGroup rect {
          fill: var(--background);
          stroke: var(--primary);
          stroke-width: 2px;
          rx: var(--border-radius);
          filter: drop-shadow(0 4px 6px rgba(0, 0, 0, 0.1));
        }

        g.classGroup text {
          fill: var(--text);
          font-weight: 500;
          font-size: 14px;
        }

        /* Labels and text */
        .label {
          font-family: 'Inter', system-ui, sans-serif;
          color: var(--text);
          font-size: 14px;
          line-height: 1.5;
        }

        /* Clusters */
        .cluster rect {
          fill: rgba(79, 70, 229, 0.1);
          stroke: var(--primary);
          stroke-width: 1.5px;
          rx: var(--border-radius);
        }

        /* Connections */
        .edge-thickness-normal {
          stroke-width: 2px;
          transition: stroke-width 0.2s ease;
        }

        .edge-pattern-solid {
          stroke: var(--secondary);
        }

        .flowchart-link {
          stroke: var(--secondary);
          fill: none;
          transition: stroke 0.2s ease;
        }

        /* Hover effects */
        .edge-thickness-normal:hover {
          stroke-width: 3px;
        }

        .flowchart-link:hover {
          stroke: var(--primary);
        }
      `,
      fontFamily: "Inter, system-ui, sans-serif",
    });

    mermaid.contentLoaded();
  }

  render() {
    return (
      <div className="mermaid-wrapper">
        <div className="mermaid">{this.props.chart}</div>
        <style>{`
          .mermaid-wrapper {
            padding: 1.5rem;
            border-radius: 12px;
            background: #1E1E2E;
            box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
          }
        `}</style>
      </div>
    );
  }
}

export default Mermaid;
