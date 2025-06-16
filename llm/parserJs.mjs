import * as acorn from "acorn"
import * as walk from "acorn-walk"

class EnhancedJSFlowParser {
    constructor(code) {
        this.code = code;
        this.ast = null;
        this.nodeCounter = 0;
        this.flowGraph = {
            nodes: new Map(),
            edges: [],
            variables: new Map(),
            functions: new Map(),
            imports: [],
            exports: [],
            scopes: new Map(),
            loops: [],
            conditions: [],
            asyncOperations: []
        };
        this.currentScope = 'global';
        this.functionStack = [];
        this.lastMainNode = null;
    }

    parse() {
        try {
            this.ast = acorn.parse(this.code, {
                ecmaVersion: 2022,
                sourceType: 'module',
                locations: true
            });
            
            this._addNode('start', 'Start', 'start');
            this._extractModuleInfo();
            this._buildDetailedFlowGraph();
            
            // Connecter le dernier nœud principal à end s'il existe
            if (this.lastMainNode && this.lastMainNode !== 'end') {
                this._addEdge(this.lastMainNode, 'end', 'Program End');
            }
            
            this._addNode('end', 'End', 'end');
            
            return this._generateEnhancedMermaidDiagram();
        } catch (error) {
            return `Parsing Error: ${error.message}`;
        }
    }

    _addNode(id, label, type = 'process', details = {}) {
        const nodeId = id || `node_${this.nodeCounter++}`;
        this.flowGraph.nodes.set(nodeId, {
            id: nodeId,
            label: label,
            type: type,
            scope: this.currentScope,
            ...details
        });
        return nodeId;
    }

    _addEdge(from, to, label = '', condition = '') {
        // Vérifier que les nœuds existent avant d'ajouter l'arête
        if (this.flowGraph.nodes.has(from) && (this.flowGraph.nodes.has(to) || to === 'end')) {
            this.flowGraph.edges.push({
                from: from,
                to: to,
                label: label,
                condition: condition
            });
        }
    }

    _extractModuleInfo() {
        // Cette méthode reste la même mais on ne connecte plus directement à start
        walk.simple(this.ast, {
            ImportDeclaration: (node) => {
                const importInfo = {
                    source: node.source.value,
                    specifiers: node.specifiers.map(spec => ({
                        type: spec.type,
                        imported: spec.imported ? spec.imported.name : null,
                        local: spec.local.name
                    }))
                };
                this.flowGraph.imports.push(importInfo);
            },

            ExportNamedDeclaration: (node) => {
                const exportInfo = this._extractExportInfo(node);
                this.flowGraph.exports.push(exportInfo);
            },

            ExportDefaultDeclaration: (node) => {
                const exportInfo = { name: 'default', type: 'default' };
                this.flowGraph.exports.push(exportInfo);
            }
        });
    }
    

    _buildDetailedFlowGraph() {
        let currentNode = 'start';
        
        // Parcourir les déclarations de niveau supérieur
        for (const node of this.ast.body) {
            currentNode = this._processTopLevelNode(node, currentNode);
        }
        
        this.lastMainNode = currentNode;
    }

    _processTopLevelNode(node, lastNode) {
        switch(node.type) {
            case 'FunctionDeclaration':
                return this._processFunctionDeclaration(node, lastNode);
            case 'VariableDeclaration':
                return this._processVariableDeclaration(node, lastNode);
            default:
                return lastNode;
        }
    }

    _processFunctionDeclaration(node, lastNode) {
        const funcName = node.id ? node.id.name : 'Anonymous';
        const params = node.params.map(p => p.name).join(', ');
        const funcType = node.async ? 'Async Function' : 'Function';
        
        const funcInfo = {
            name: funcName,
            params: node.params.map(p => p.name),
            isAsync: node.async,
            isGenerator: node.generator,
            paramCount: node.params.length
        };
        
        this.flowGraph.functions.set(funcName, funcInfo);
        
        const funcStartId = this._addNode(
            null, 
            `${funcType}: ${funcName}(${params})`, 
            'function_start',
            funcInfo
        );
        
        this._addEdge(lastNode, funcStartId, 'Define Function');
        
        // Traiter le corps de la fonction
        this.functionStack.push(funcName);
        this.currentScope = funcName;
        
        let bodyLastNode = funcStartId;
        if (node.body && node.body.body) {
            for (const stmt of node.body.body) {
                bodyLastNode = this._processStatement(stmt, bodyLastNode);
            }
        }
        
        this.functionStack.pop();
        this.currentScope = this.functionStack[this.functionStack.length - 1] || 'global';
        
        return funcStartId;
    }

    _processVariableDeclaration(node, lastNode) {
        for (const decl of node.declarations) {
            if (decl.id && decl.id. name) {
                const varInfo = this._analyzeVariable(decl, node);
                this.flowGraph.variables.set(decl.id.name, varInfo);
                
                const nodeId = this._addNode(
                    null, 
                    `${node.kind} ${decl.id.name}`, 
                    'variable',
                    varInfo
                );
                
                this._addEdge(lastNode, nodeId, 'Declare Variable');
                lastNode = nodeId;
            }
        }
        return lastNode;
    }

    _processStatement(stmt, lastNode) {
        switch(stmt.type) {
            case 'IfStatement':
                return this._processConditionalNode(stmt, lastNode);
            case 'WhileStatement':
            case 'ForStatement':
            case 'DoWhileStatement':
                return this._processLoopNode(stmt, lastNode);
            case 'ReturnStatement':
                return this._processReturnStatement(stmt, lastNode);
            case 'VariableDeclaration':
                return this._processVariableDeclaration(stmt, lastNode);
            case 'ExpressionStatement':
                return this._processExpressionStatement(stmt, lastNode);
            case 'BlockStatement':
                return this._processBlockStatement(stmt, lastNode);
            default:
                return lastNode;
        }
    }

    _processConditionalNode(node, lastNode) {
        const condition = this._extractConditionText(node.test);
        const conditionNodeId = this._addNode(
            null, 
            `If: ${condition}`, 
            'decision',
            { condition: condition }
        );
        
        this._addEdge(lastNode, conditionNodeId, 'Check Condition');
        
        // Traiter la branche if
        let ifEndNode = conditionNodeId;
        if (node.consequent) {
            const ifBranchId = this._addNode(null, 'Then', 'process');
            this._addEdge(conditionNodeId, ifBranchId, 'True');
            ifEndNode = this._processStatement(node.consequent, ifBranchId);
        }
        
        // Traiter la branche else
        let elseEndNode = conditionNodeId;
        if (node.alternate) {
            const elseBranchId = this._addNode(null, 'Else', 'process');
            this._addEdge(conditionNodeId, elseBranchId, 'False');
            elseEndNode = this._processStatement(node.alternate, elseBranchId);
        }
        
        // Point de convergence
        const mergeNodeId = this._addNode(null, 'Continue', 'merge');
        
        if (ifEndNode !== conditionNodeId) {
            this._addEdge(ifEndNode, mergeNodeId, 'Continue');
        }
        if (elseEndNode !== conditionNodeId) {
            this._addEdge(elseEndNode, mergeNodeId, 'Continue');
        }
        if (!node.alternate) {
            this._addEdge(conditionNodeId, mergeNodeId, 'False');
        }
        
        return mergeNodeId;
    }

    _processLoopNode(node, lastNode) {
        let loopCondition = '';
        let loopType = '';
        
        if (node.type === 'ForStatement') {
            loopType = 'For';
            if (node.test) {
                loopCondition = this._extractConditionText(node.test);
            }
        } else if (node.type === 'WhileStatement') {
            loopType = 'While';
            loopCondition = this._extractConditionText(node.test);
        }
        
        const loopStartId = this._addNode(
            null, 
            `${loopType} Loop: ${loopCondition}`, 
            'loop_start'
        );
        
        const loopEndId = this._addNode(null, 'End Loop', 'loop_end');
        
        this._addEdge(lastNode, loopStartId, 'Enter Loop');
        this._addEdge(loopStartId, loopEndId, 'Exit Loop');
        
        // Traiter le corps de la boucle
        if (node.body) {
            const bodyStartId = this._addNode(null, 'Loop Body', 'process');
            this._addEdge(loopStartId, bodyStartId, 'Loop Iteration');
            
            const bodyEndNode = this._processStatement(node.body, bodyStartId);
            this._addEdge(bodyEndNode, loopStartId, 'Continue Loop');
        }
        
        return loopEndId;
    }

    _processReturnStatement(node, lastNode) {
        const returnValue = node.argument ? this._extractSimpleValue(node.argument) : 'void';
        const returnNodeId = this._addNode(
            null, 
            `Return: ${returnValue}`, 
            'return'
        );
        
        this._addEdge(lastNode, returnNodeId, 'Return');
        return returnNodeId;
    }

    _processExpressionStatement(node, lastNode) {
        if (node.expression.type === 'AssignmentExpression') {
            const left = this._extractSimpleValue(node.expression.left);
            const right = this._extractSimpleValue(node.expression.right);
            
            const assignId = this._addNode(
                null,
                `${left} = ${right}`,
                'assignment'
            );
            
            this._addEdge(lastNode, assignId, 'Assignment');
            return assignId;
        }
        return lastNode;
    }

    _processBlockStatement(block, lastNode) {
        if (!block || !block.body) return lastNode;
        
        let currentNode = lastNode;
        for (const stmt of block.body) {
            currentNode = this._processStatement(stmt, currentNode);
        }
        return currentNode;
    }

    _analyzeVariable(decl, parent) {
        return {
            name: decl.id.name,
            kind: parent.kind,
            type: this._inferSimpleType(decl.init),
            scope: this.currentScope,
            initialized: !!decl.init
        };
    }

    _inferSimpleType(node) {
        if (!node) return 'undefined';
        
        switch(node.type) {
            case 'Literal':
                return typeof node.value;
            case 'Identifier':
                return 'variable';
            case 'BinaryExpression':
                return 'expression';
            case 'CallExpression':
                return 'function call';
            default:
                return 'unknown';
        }
    }

    _extractSimpleValue(node) {
        if (!node) return 'undefined';
        
        switch(node.type) {
            case 'Literal':
                return String(node.value);
            case 'Identifier':
                return node.name;
            case 'BinaryExpression':
                return 'expression';
            case 'TemplateLiteral':
                return 'template';
            default:
                return 'value';
        }
    }

    _extractConditionText(node) {
        if (!node) return '';
        
        switch(node.type) {
            case 'BinaryExpression':
                const left = this._extractSimpleValue(node.left);
                const right = this._extractSimpleValue(node.right);
                return `${left} ${node.operator} ${right}`;
            case 'Identifier':
                return node.name;
            case 'Literal':
                return String(node.value);
            default:
                return 'condition';
        }
    }

    _extractExportInfo(node) {
        if (node.declaration) {
            if (node.declaration.type === 'FunctionDeclaration') {
                return { name: node.declaration.id.name, type: 'function' };
            }
            if (node.declaration.type === 'VariableDeclaration') {
                return { name: node.declaration.declarations[0].id.name, type: 'variable' };
            }
        }
        return { name: 'Unknown', type: 'unknown' };
    }

    _generateEnhancedMermaidDiagram() {
        let diagram = "flowchart TD\n";
        
        // Ajouter les nœuds avec des formes appropriées
        this.flowGraph.nodes.forEach((nodeInfo, nodeId) => {
            const shape = this._getNodeShape(nodeInfo.type);
            const className = this._getNodeClass(nodeInfo.type);
            const cleanLabel = this._cleanLabel(nodeInfo.label);
            
            diagram += `    ${nodeId}${shape.start}"${cleanLabel}"${shape.end}\n`;
        });
        
        diagram += "\n";
        
        // Ajouter les arêtes
        this.flowGraph.edges.forEach(edge => {
            const cleanLabel = this._cleanLabel(edge.label);
            if (cleanLabel && cleanLabel.trim()) {
                diagram += `    ${edge.from} -->|"${cleanLabel}"| ${edge.to}\n`;
            } else {
                diagram += `    ${edge.from} --> ${edge.to}\n`;
            }
        });
        
        // Ajouter les classes CSS
        diagram += "\n";
        this.flowGraph.nodes.forEach((nodeInfo, nodeId) => {
            const className = this._getNodeClass(nodeInfo.type);
            if (className) {
                diagram += `    class ${nodeId} ${className}\n`;
            }
        });
        
        // Ajouter les styles
        diagram += `
    classDef start fill:#90EE90,stroke:#333,stroke-width:3px
    classDef end fill:#FFB6C1,stroke:#333,stroke-width:3px
    classDef function fill:#87CEEB,stroke:#333,stroke-width:2px
    classDef decision fill:#FFD700,stroke:#333,stroke-width:2px
    classDef loop fill:#DDA0DD,stroke:#333,stroke-width:2px
    classDef return fill:#FF6B6B,stroke:#333,stroke-width:2px
    classDef variable fill:#98FB98,stroke:#333,stroke-width:1px
    classDef process fill:#F0F8FF,stroke:#333,stroke-width:1px
`;
        
        return diagram;
    }

    _cleanLabel(label) {
        if (!label) return '';
        return label
            .replace(/"/g, '\\"')  // Échapper les guillemets
            .replace(/\n/g, " ")   // Remplacer les retours à la ligne
            .replace(/\r/g, "")    // Supprimer les retours chariot
            .trim();
    }

    _getNodeShape(type) {
        const shapes = {
            'start': { start: '([', end: '])' },
            'end': { start: '([', end: '])' },
            'decision': { start: '{', end: '}' },
            'function_start': { start: '[[', end: ']]' },
            'loop_start': { start: '([', end: '])' },
            'loop_end': { start: '([', end: '])' },
            'return': { start: '(', end: ')' },
            'variable': { start: '[', end: ']' },
            'assignment': { start: '[', end: ']' },
            'process': { start: '[', end: ']' },
            'merge': { start: '(', end: ')' }
        };
        return shapes[type] || { start: '[', end: ']' };
    }

    _getNodeClass(type) {
        const classes = {
            'start': 'start',
            'end': 'end',
            'function_start': 'function',
            'decision': 'decision',
            'loop_start': 'loop',
            'loop_end': 'loop',
            'return': 'return',
            'variable': 'variable',
            'process': 'process'
        };
        return classes[type];
    }

    getAnalysis() {
        return {
            variables: Object.fromEntries(this.flowGraph.variables),
            functions: Object.fromEntries(this.flowGraph.functions),
            imports: this.flowGraph.imports,
            exports: this.flowGraph.exports,
            nodeCount: this.flowGraph.nodes.size,
            edgeCount: this.flowGraph.edges.length,
            complexity: this._calculateComplexity()
        };
    }

    _calculateComplexity() {
        const decisions = Array.from(this.flowGraph.nodes.values())
            .filter(node => node.type === 'decision' || node.type === 'loop_start').length;
        return decisions + 1;
    }
}

// Fonctions d'export
export function generateEnhancedMermaidFlow(code, options = {}) {
    const parser = new EnhancedJSFlowParser(code);
    const diagram = parser.parse();
    
    if (options.includeAnalysis) {
        const analysis = parser.getAnalysis();
        return {
            diagram: diagram,
            analysis: analysis
        };
    }
    console.log(diagram);
    return diagram;
}

export function generateMermaidFlow(code) {
    return generateEnhancedMermaidFlow(code);
}