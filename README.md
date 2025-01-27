# Real-Time Performance Profiler

A VS Code extension that helps developers visualize code through flow diagrams.

## Features

- **Flow Chart Generation**: Automatically creates visual flow diagrams from your code
- **Interactive Visualization**: View and interact with generated diagrams in a dedicated webview panel
- **Code Integration**: Seamlessly integrates with your existing codebase

## Installation

1. Open VS Code
2. Go to Extensions (Ctrl+Shift+X)
3. Search for "Real-Time Performance Profiler"
4. Click Install

## Usage

1. Select the code you want to analyze
2. Right-click and select "Generate Flow Chart" or use the command palette
3. View the generated diagram in the side panel

## Requirements

- VS Code 1.96.0 or higher
- Node.js 18.x or higher
- An internet connection for certain features

## Extension Settings

This extension contributes the following settings:

* `real-time-performance-profiler.enable`: Enable/disable the extension
* `real-time-performance-profiler.diagramStyle`: Set the visual style of generated diagrams

## Development

To build and run this extension locally:

```bash
git clone https://github.com/yourusername/real-time-performance-profiler
cd real-time-performance-profiler
npm install
code .
```

Press F5 to launch the extension in development mode.

## Dependencies

- Mermaid.js for diagram generation
- Chart.js for performance visualization
- React for UI components
- Webpack for bundling

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Acknowledgments

- Thanks to the VS Code extension community
- Inspired by various code visualization tools
- Built with modern web technologies

## Support

For support, please open an issue in the GitHub repository or contact the maintainers.
