import * as acorn from "acorn"

import * as walk from "acorn-walk"

class UltimateJSFlowParser {
    constructor(code) {
        this.code = code;
        this.ast = null;
        this.flowGraph = {
            nodes: new Set(['[*]']),
            edges: [],
            variables: new Map(),
            functions: [],
            imports: [],
            exports: []
        };
    }

    parse() {
        try {
            this.ast = acorn.parse(this.code, {
                ecmaVersion: 2022,
                sourceType: 'module'
            });
            this._extractModuleInfo();
            this._buildFlowGraph();
            return this._generateMermaidDiagram();
        } catch (error) {
            return `Parsing Error: ${error.message}`;
        }
    }

    _extractModuleInfo() {
        walk.simple(this.ast, {
            VariableDeclaration: (node) => {
                node.declarations.forEach(decl => {
                    const varName = decl.id.name;
                    const varType = this._inferVariableType(decl.init);
                    this.flowGraph.variables.set(varName, {
                        type: varType,
                        value: decl.init ? this._extractNodeValue(decl.init) : null
                    });
                });
            },
            
            FunctionDeclaration: (node) => {
                this.flowGraph.functions.push({
                    name: node.id ? node.id.name : 'Anonymous',
                    params: node.params.map(param => param.name),
                    isAsync: node.async,
                    isGenerator: node.generator
                });
            }
        });
    }

    _inferVariableType(node) {
        if (!node) return 'undefined';
        switch(node.type) {
            case 'Literal':
                return typeof node.value;
            case 'ArrayExpression':
                return 'array';
            case 'ObjectExpression':
                return 'object';
            case 'ArrowFunctionExpression':
            case 'FunctionExpression':
                return 'function';
            default:
                return 'unknown';
        }
    }

    _extractNodeValue(node) {
        if (!node) return null;
        switch(node.type) {
            case 'Literal':
                return node.value;
            case 'Identifier':
                return node.name;
            default:
                return null;
        }
    }

    _buildFlowGraph() {
        const nodeTypes = {
            functionStart: 'Function Entry',
            conditionalBranch: 'Conditional Branch',
            asyncPoint: 'Async Operation',
            returnPoint: 'Return Point',
            errorHandling: 'Error Handling'
        };

        walk.simple(this.ast, {
            Function: (node) => {
                const funcName = node.id ? node.id.name : 'ProcessData';
                const functionStartNode = `${funcName}Start`;
                
                this.flowGraph.nodes.add(functionStartNode);
                this.flowGraph.edges.push({
                    from: '[*]', 
                    to: functionStartNode, 
                    label: `${nodeTypes.functionStart}`
                });
            },
            
            IfStatement: (node) => {
                this.flowGraph.nodes.add('Condition');
                this.flowGraph.nodes.add('ErrorHandling');
                
                this.flowGraph.edges.push(
                    { from: 'ProcessDataStart', to: 'Condition', label: 'Check Input' },
                    { from: 'Condition', to: 'ErrorHandling', label: 'Invalid Input' }
                );
            },
            
            TryStatement: (node) => {
                this.flowGraph.nodes.add('TryBlock');
                this.flowGraph.nodes.add('CatchBlock');
                
                this.flowGraph.edges.push(
                    { from: 'ProcessDataStart', to: 'TryBlock', label: 'Try Operation' },
                    { from: 'TryBlock', to: 'CatchBlock', label: nodeTypes.errorHandling }
                );
            },
            
            ReturnStatement: (node) => {
                this.flowGraph.nodes.add('ReturnPoint');
                
                this.flowGraph.edges.push(
                    { from: 'TryBlock', to: 'ReturnPoint', label: nodeTypes.returnPoint },
                    { from: 'ReturnPoint', to: '[*]', label: 'Function Exit' }
                );
            },
            
            AwaitExpression: (node) => {
                this.flowGraph.nodes.add('AsyncOperation');
                
                this.flowGraph.edges.push(
                    { from: 'ProcessDataStart', to: 'AsyncOperation', label: nodeTypes.asyncPoint }
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