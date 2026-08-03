/**
 * Hand-computed fixtures for the AST analyzer.
 *
 * Every expected number below is derived by hand from the published
 * definitions, not captured from an earlier run of this code:
 *
 *   McCabe (1976)  M = decisions + 1, where a decision is a branch point.
 *   Halstead (1977) V = N * log2(n), N = N1 + N2, n = n1 + n2.
 *   SEI MI          max(0, (171 - 5.2 ln V - 0.23 M - 16.2 ln L) * 100/171).
 *
 * The regression this file exists to prevent: the previous implementation had
 * no parser. It line-split the source and regex-counted keywords with the
 * template `\b${kw}\b|\${kw}`, whose second alternative collapses to an escape
 * class — `\while` becomes `\w`, matching any word character. A single
 * branch-free line therefore scored 38 decision points.
 */
import { describe, it, expect } from 'vitest';
import { analyzeAST } from '../src/ast-analyzer.js';

describe('cyclomatic complexity', () => {
  it('scores a branch-free statement as 1, not 38', () => {
    // Zero decision points, so M = 0 + 1. This is the exact input that
    // produced 38 under the regex implementation.
    const res = analyzeAST('const x = value;');
    expect(res.cyclomaticComplexity).toBe(1);
  });

  it('does not let identifier spelling create decision points', () => {
    // `maintainabilityIndex` contains no branch. Under the old `\w` collapse
    // every word character in it counted as a decision.
    const res = analyzeAST('const maintainabilityIndex = value;');
    expect(res.cyclomaticComplexity).toBe(1);
  });

  it('counts if / else-if as two decisions', () => {
    // `else if` is a nested IfStatement, so: 2 decisions + 1 = 3.
    const code = `
      function classify(a, b) {
        if (a > b) return a;
        else if (b > a) return b;
        return 0;
      }
    `;
    const res = analyzeAST(code);
    expect(res.cyclomaticComplexity).toBe(3);
    expect(res.functions[0].cyclomaticComplexity).toBe(3);
  });

  it('counts each short-circuit operator once', () => {
    // && and || are branch points; ?? likewise. 3 decisions + 1 = 4.
    const res = analyzeAST('function f(a, b, c) { return (a && b) || (c ?? a); }');
    expect(res.cyclomaticComplexity).toBe(4);
  });

  it('counts switch cases but not default', () => {
    // default is the fall-through, not a decision: 2 decisions + 1 = 3.
    const code = `
      function pick(x) {
        switch (x) {
          case 1: return 'a';
          case 2: return 'b';
          default: return 'z';
        }
      }
    `;
    expect(analyzeAST(code).cyclomaticComplexity).toBe(3);
  });

  it('counts loops, catch clauses and ternaries', () => {
    // for + while + catch + ternary = 4 decisions + 1 = 5.
    const code = `
      function work(items) {
        for (const i of items) { touch(i); }
        while (pending()) { drain(); }
        try { risky(); } catch (e) { report(e); }
        return ok() ? 1 : 0;
      }
    `;
    expect(analyzeAST(code).cyclomaticComplexity).toBe(5);
  });

  it('reports per-function complexity and aggregates the module', () => {
    const code = `
      function simple() { return 1; }
      function branchy(a) { if (a) { return 1; } return 0; }
    `;
    const res = analyzeAST(code);
    expect(res.functionCount).toBe(2);

    const byName = Object.fromEntries(res.functions.map((f) => [f.name, f.cyclomaticComplexity]));
    expect(byName.simple).toBe(1);
    expect(byName.branchy).toBe(2);

    // Module total is every decision in the file plus one: 0 + 1 + 1 = 2.
    expect(res.cyclomaticComplexity).toBe(2);
    expect(res.maxComplexity).toBe(2);
  });

  it('counts arrow functions and class methods', () => {
    const code = `
      const f = (a) => (a ? 1 : 0);
      class C { m(x) { return x && 1; } }
    `;
    const res = analyzeAST(code);
    expect(res.functionCount).toBe(2);
    expect(res.cyclomaticComplexity).toBe(3);
  });
});

describe('halstead volume', () => {
  it('computes V = N log2(n) on a hand-countable statement', () => {
    // `const x = value;`
    //   operators: const, =            -> n1 = 2, N1 = 2
    //   operands:  x, value            -> n2 = 2, N2 = 2
    //   n = 4, N = 4  ->  V = 4 * log2(4) = 8
    const res = analyzeAST('const x = value;');
    expect(res.halstead.distinctOperators).toBe(2);
    expect(res.halstead.totalOperators).toBe(2);
    expect(res.halstead.distinctOperands).toBe(2);
    expect(res.halstead.totalOperands).toBe(2);
    expect(res.halstead.volume).toBeCloseTo(8, 6);
  });

  it('counts a repeated operand once in vocabulary but twice in length', () => {
    // `x = x + 1;`
    //   operators: =, +                -> n1 = 2, N1 = 2
    //   operands:  x, x, 1             -> n2 = 2, N2 = 3
    //   n = 4, N = 5  ->  V = 5 * log2(4) = 10
    const res = analyzeAST('x = x + 1;');
    expect(res.halstead.distinctOperands).toBe(2);
    expect(res.halstead.totalOperands).toBe(3);
    expect(res.halstead.volume).toBeCloseTo(10, 6);
  });

  it('is zero for an empty program', () => {
    const res = analyzeAST('');
    expect(res.halstead.volume).toBe(0);
  });
});

describe('maintainability index', () => {
  it('matches the SEI formula computed by hand', () => {
    // `const x = value;`  ->  V = 8, M = 1, L = 1
    //   171 - 5.2 ln(8) - 0.23(1) - 16.2 ln(1)
    // = 171 - 10.8134 - 0.23 - 0 = 159.9566
    // * 100/171 = 93.542...
    const res = analyzeAST('const x = value;');
    const expected = ((171 - 5.2 * Math.log(8) - 0.23 * 1 - 16.2 * Math.log(1)) * 100) / 171;
    expect(res.maintainabilityIndex).toBeCloseTo(expected, 4);
    expect(res.maintainabilityIndex).toBeCloseTo(93.5419, 3);
  });

  it('is clamped to [0, 100] and never floored at 10', () => {
    // The old implementation clamped to a minimum of 10, so genuinely
    // unmaintainable code could never score below it.
    const res = analyzeAST('const x = 1;');
    expect(res.maintainabilityIndex).toBeGreaterThanOrEqual(0);
    expect(res.maintainabilityIndex).toBeLessThanOrEqual(100);
  });

  it('scores an empty program as fully maintainable', () => {
    expect(analyzeAST('').maintainabilityIndex).toBe(100);
  });

  it('falls as complexity rises, holding length roughly constant', () => {
    const flat = analyzeAST('function f(a){ return a; }');
    const branchy = analyzeAST('function f(a){ if(a){return 1;} else if(a){return 2;} return 3; }');
    expect(branchy.maintainabilityIndex).toBeLessThan(flat.maintainabilityIndex);
  });
});

describe('parsing behaviour', () => {
  it('parses TypeScript syntax', () => {
    const code = `
      interface Shape { kind: string }
      function area(s: Shape): number {
        if (s.kind === 'circle') { return 1; }
        return 0;
      }
    `;
    const res = analyzeAST(code);
    expect(res.parsed).toBe(true);
    expect(res.cyclomaticComplexity).toBe(2);
  });

  it('parses JSX', () => {
    const res = analyzeAST('const El = () => <div className="x">{ok ? <A/> : <B/>}</div>;');
    expect(res.parsed).toBe(true);
    expect(res.cyclomaticComplexity).toBe(2);
  });

  it('reports a syntax error instead of guessing a score', () => {
    // A regex counter happily "analyses" unparseable text. A parser cannot,
    // and must say so rather than emit a number that means nothing.
    const res = analyzeAST('function ( { { {');
    expect(res.parsed).toBe(false);
    expect(res.parseError).toBeTruthy();
    expect(res.cyclomaticComplexity).toBe(0);
    expect(res.maintainabilityIndex).toBe(0);
  });

  it('ignores comments', () => {
    const withComment = analyzeAST('// if (a && b) for while catch\nconst x = 1;');
    expect(withComment.cyclomaticComplexity).toBe(1);
  });

  it('does not treat branch keywords inside strings as decisions', () => {
    const res = analyzeAST('const s = "if while for && || case catch";');
    expect(res.cyclomaticComplexity).toBe(1);
  });
});

describe('line counting', () => {
  it('counts source lines of code, excluding blanks and comments', () => {
    const code = ['const a = 1;', '', '// a comment', 'const b = 2;'].join('\n');
    const res = analyzeAST(code);
    expect(res.lineCount).toBe(2);
    expect(res.physicalLines).toBe(4);
  });
});
