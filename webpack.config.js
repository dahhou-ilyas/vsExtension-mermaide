const path = require('path');

module.exports = {
    target: 'web',
    entry: './ui/webview.js',
    output: {
      filename: 'webview.js',
      path: path.resolve(__dirname, 'dist')
    },
    resolve: {
      extensions: ['.js']
    },
    module: {
      rules: [
        {
          test: /\.js$/,
          use: 'babel-loader',
          exclude: /node_modules/
        }
      ]
    }
};