import acorn from "acorn"

import walk from "acorn-walk"

class UltimateJSFlowParser {
    constructor(code) {
        this.code = code;
        this.ast = null;
        this.flowGraph = {
            nodes: new Set(['[*]']),
            edges: []
        };
    }

    parse() {
        try {
            this.ast = acorn.parse(this.code, {
                ecmaVersion: 2022,
                sourceType: 'module'
            });
            this._buildFlowGraph();
            return this._generateMermaidDiagram();
        } catch (error) {
            return `Parsing Error: ${error.message}`;
        }
    }

    _buildFlowGraph() {
        const nodeTypes = {
            functionStart: 'Function Entry',
            conditionalBranch: 'Conditional Branch',
            loopStart: 'Loop Entry',
            asyncPoint: 'Async Operation',
            returnPoint: 'Return Point',
            errorHandling: 'Error Handling'
        };

        walk.simple(this.ast, {
            Function: (node) => {
                this.flowGraph.nodes.add('FunctionStart');
                this.flowGraph.edges.push({
                    from: '[*]', 
                    to: 'FunctionStart', 
                    label: nodeTypes.functionStart
                });
            },
            
            IfStatement: (node) => {
                this.flowGraph.nodes.add('Condition');
                this.flowGraph.nodes.add('TrueBranch');
                this.flowGraph.nodes.add('FalseBranch');
                
                this.flowGraph.edges.push(
                    { from: 'FunctionStart', to: 'Condition', label: 'Decision' },
                    { from: 'Condition', to: 'TrueBranch', label: 'Condition True' },
                    { from: 'Condition', to: 'FalseBranch', label: 'Condition False' }
                );
            },
            
            ForStatement: (node) => {
                this.flowGraph.nodes.add('LoopStart');
                this.flowGraph.nodes.add('LoopBody');
                
                this.flowGraph.edges.push(
                    { from: 'FunctionStart', to: 'LoopStart', label: nodeTypes.loopStart },
                    { from: 'LoopStart', to: 'LoopBody', label: 'Iteration' },
                    { from: 'LoopBody', to: 'LoopStart', label: 'Continue Loop' }
                );
            },
            
            TryStatement: (node) => {
                this.flowGraph.nodes.add('TryBlock');
                this.flowGraph.nodes.add('CatchBlock');
                
                this.flowGraph.edges.push(
                    { from: 'FunctionStart', to: 'TryBlock', label: 'Try Operation' },
                    { from: 'TryBlock', to: 'CatchBlock', label: nodeTypes.errorHandling }
                );
            },
            
            ReturnStatement: (node) => {
                this.flowGraph.nodes.add('ReturnPoint');
                
                this.flowGraph.edges.push(
                    { from: 'TrueBranch', to: 'ReturnPoint', label: nodeTypes.returnPoint },
                    { from: 'ReturnPoint', to: '[*]', label: 'Function Exit' }
                );
            },
            
            AwaitExpression: (node) => {
                this.flowGraph.nodes.add('AsyncOperation');
                
                this.flowGraph.edges.push(
                    { from: 'FunctionStart', to: 'AsyncOperation', label: nodeTypes.asyncPoint }
                );
            }
        });
    }

    _generateMermaidDiagram() {
        let diagram = "stateDiagram-v2\n";
        
        // Add nodes
        this.flowGraph.nodes.forEach(node => {
            diagram += `    ${node}\n`;
        });
        
        // Add edges
        this.flowGraph.edges.forEach(edge => {
            diagram += `    ${edge.from} --> ${edge.to} : ${edge.label}\n`;
        });
        
        return diagram;
    }
}

export function generateMermaidFlow(code) {
    const parser = new UltimateJSFlowParser(code);
    return parser.parse();
}