const path = require('path');

module.exports = {
  target: 'web',
  entry: './ui/webview.js',
  output: {
    filename: 'webview.js',
    path: path.resolve(__dirname, 'dist'),
  },
  resolve: {
    extensions: ['.js', '.jsx'], // Ajoutez .jsx pour prendre en charge les fichiers React
  },
  module: {
    rules: [
      {
        test: /\.js$|\.jsx$/, // Appliquez cette règle aux fichiers .js et .jsx
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: ['@babel/preset-env', '@babel/preset-react'], // Ajoutez les presets pour ES6 et React
          },
        },
      },
    ],
  },
};