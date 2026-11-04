import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
    files: 'test/suite/**/*.test.js',
    version: 'stable',
    mocha: { ui: 'bdd', timeout: 30000 }
});
