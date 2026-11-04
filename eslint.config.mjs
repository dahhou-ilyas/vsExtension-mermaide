import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';

export default [
    {
        ignores: ['dist/**', 'out/**', 'node_modules/**', '.vscode-test/**', '*.vsix']
    },
    js.configs.recommended,
    {
        files: ['src/**/*.js', 'test/**/*.js', 'webpack.config.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: { ...globals.node, ...globals.mocha }
        },
        rules: {
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
            'prefer-const': 'warn',
            eqeqeq: ['error', 'smart']
        }
    },
    {
        files: ['webview/**/*.{js,jsx}'],
        plugins: { react },
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            parserOptions: { ecmaFeatures: { jsx: true } },
            globals: { ...globals.browser }
        },
        settings: { react: { version: 'detect' } },
        rules: {
            ...react.configs.recommended.rules,
            'react/prop-types': 'off',
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
            eqeqeq: ['error', 'smart']
        }
    },
    {
        files: ['*.mjs', '.vscode-test.mjs'],
        languageOptions: { sourceType: 'module', globals: { ...globals.node } }
    }
];
