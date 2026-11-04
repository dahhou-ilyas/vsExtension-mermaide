/** A tiny JavaScript tokenizer for the tooltip (no dependency, good enough to colour code). */
const KEYWORDS = new Set(('await async break case catch class const continue debugger default delete do else export extends finally for '
    + 'function if import in instanceof let new of return static super switch this throw try typeof var void while with yield '
    + 'true false null undefined').split(' '));

export function tokenize(code) {
    const tokens = [];
    const re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b\d[\d_.]*\b)|([A-Za-z_$][\w$]*)|(\s+)|([^\w\s])/g;
    let m;
    while ((m = re.exec(code))) {
        if (m[1]) tokens.push({ t: 'comment', v: m[1] });
        else if (m[2]) tokens.push({ t: 'string', v: m[2] });
        else if (m[3]) tokens.push({ t: 'number', v: m[3] });
        else if (m[4]) tokens.push({ t: KEYWORDS.has(m[4]) ? 'keyword' : (/^[A-Z]/.test(m[4]) ? 'type' : 'ident'), v: m[4] });
        else if (m[5]) tokens.push({ t: 'space', v: m[5] });
        else tokens.push({ t: 'punct', v: m[6] });
    }
    return tokens;
}
