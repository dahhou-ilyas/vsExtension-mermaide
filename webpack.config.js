const path = require('path');

module.exports = {
  target: 'web',
  entry: './ui/webview.js',
  output: {
    filename: 'webview.js',
    path: path.resolve(__dirname, 'dist'),
  },
  resolve: {
    extensions: ['.js', '.mjs', '.jsx'], // Support des fichiers .js, .mjs et .jsx
    fullySpecified: false, // Corrige les problèmes liés aux modules ESM
  },
  module: {
    rules: [
      {
        test: /\.js$|\.jsx$|\.mjs$/, // Gère les fichiers .js, .jsx et .mjs
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: [
              '@babel/preset-env', // Support des dernières versions JavaScript
              '@babel/preset-react', // Support de React
            ],
          },
        },
      },
      {
        test: /\.css$/, // Gère les fichiers CSS
        use: ['style-loader', 'css-loader'],
      },
    ],
  },
};
