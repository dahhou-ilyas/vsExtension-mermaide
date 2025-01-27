class ModuleLoader {
    static async loadMermaidModule() {
        try {
            const module = await import('../llm/parserJs.mjs');
            return module.generateMermaidFlow;
        } catch (err) {
            console.error('Failed to load llm module:', err);
            return null;
        }
    }
}

module.exports = ModuleLoader