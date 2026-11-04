'use strict';

const path = require('path');
const webpack = require('webpack');

/** Extension host bundle (Node.js). */
const extensionConfig = (env, argv) => ({
    name: 'extension',
    target: 'node',
    mode: argv.mode || 'none',
    entry: './src/extension.js',
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: 'extension.js',
        libraryTarget: 'commonjs2'
    },
    externals: {
        vscode: 'commonjs vscode'
    },
    resolve: { extensions: ['.js'] },
    devtool: argv.mode === 'production' ? false : 'nosources-source-map',
    infrastructureLogging: { level: 'log' }
});

/** Webview bundle (browser). Everything is emitted as a single file so it works under a strict CSP. */
const webviewConfig = (env, argv) => ({
    name: 'webview',
    target: 'web',
    mode: argv.mode || 'none',
    entry: './webview/index.jsx',
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: 'webview.js'
    },
    resolve: {
        extensions: ['.js', '.jsx', '.mjs'],
        fullySpecified: false
    },
    module: {
        rules: [
            {
                test: /\.(js|jsx|mjs)$/,
                exclude: /node_modules/,
                use: {
                    loader: 'babel-loader',
                    options: {
                        presets: [
                            ['@babel/preset-env', { targets: { chrome: '120' } }],
                            ['@babel/preset-react', { runtime: 'classic' }]
                        ]
                    }
                }
            },
            {
                test: /\.m?js$/,
                include: /node_modules/,
                resolve: { fullySpecified: false }
            },
            {
                test: /\.css$/,
                use: ['style-loader', 'css-loader']
            }
        ]
    },
    plugins: [
        new webpack.optimize.LimitChunkCountPlugin({ maxChunks: 1 })
    ],
    performance: { hints: false },
    devtool: argv.mode === 'production' ? false : 'nosources-source-map'
});

module.exports = [extensionConfig, webviewConfig];
