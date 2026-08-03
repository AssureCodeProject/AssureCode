/**
 * Static complexity analysis for JavaScript and TypeScript sources.
 *
 * Implements three published metrics over a real Babel AST:
 *
 *   - Cyclomatic complexity — McCabe, "A Complexity Measure", IEEE TSE SE-2(4),
 *     1976. Computed as decisions + 1. For structured programs this is the
 *     decision-point equivalent of M = E - N + 2P; we count branch points
 *     rather than building a control-flow graph, and the paper should say so
 *     rather than claim a CFG.
 *
 *   - Halstead volume — Halstead, "Elements of Software Science", 1977.
 *     V = N log2(n), for N = N1 + N2 and n = n1 + n2.
 *
 *   - Maintainability Index — the SEI three-metric variant.
 *     MI = max(0, (171 - 5.2 ln V - 0.23 M - 16.2 ln L) * 100 / 171)
 *     (Oman & Hagemeister 1992; Coleman et al. 1994.)
 *
 * The operator/operand split for Halstead is a judgement call in any AST-based
 * implementation, because Halstead defined it over tokens. The mapping used
 * here is documented at `HALSTEAD OPERATOR/OPERAND MAPPING` below so the
 * numbers are reproducible by inspection.
 */
import { parse } from '@babel/parser';
import * as babelTraverse from '@babel/traverse';
import type { NodePath, TraverseOptions } from '@babel/traverse';
import type * as t from '@babel/types';

/**
 * @babel/traverse is CommonJS with a default export. Under NodeNext, TypeScript
 * resolves the import to the module namespace while the runtime hands back
 * either the function or an interop wrapper around it. Neither the namespace
 * type nor the default type describes both, so pin the one call signature this
 * module uses and resolve the binding at load time.
 */
type TraverseFn = (parent: t.Node, opts: TraverseOptions) => void;

const traverse: TraverseFn = (() => {
  // The number of `default` wrappers differs by runtime. Plain Node ESM
  // importing this CJS package yields namespace.default === module.exports,
  // which is itself `{ default: fn }` because Babel compiles its own sources
  // ESM-to-CJS — so the function sits two levels down. Vite normalizes to one.
  // Unwrap until a callable turns up rather than hard-coding either depth.
  let candidate: unknown = babelTraverse;
  for (let depth = 0; depth < 4; depth++) {
    if (typeof candidate === 'function') return candidate as TraverseFn;
    if (candidate && typeof candidate === 'object' && 'default' in candidate) {
      candidate = (candidate as { default: unknown }).default;
      continue;
    }
    break;
  }
  throw new Error('@babel/traverse did not resolve to a callable export');
})();

export interface HalsteadMetrics {
  distinctOperators: number;
  totalOperators: number;
  distinctOperands: number;
  totalOperands: number;
  vocabulary: number;
  length: number;
  volume: number;
}

export interface FunctionComplexity {
  name: string;
  line: number;
  cyclomaticComplexity: number;
}

export interface ASTAnalysisResult {
  /** Module-level McCabe complexity: every decision in the file, plus one. */
  cyclomaticComplexity: number;
  /** SEI maintainability index in [0, 100]. */
  maintainabilityIndex: number;
  /** Source lines of code — blank and comment-only lines excluded. */
  lineCount: number;
  /** Raw line count including blanks and comments. */
  physicalLines: number;
  functionCount: number;
  halstead: HalsteadMetrics;
  functions: FunctionComplexity[];
  averageComplexity: number;
  maxComplexity: number;
  /** False when the source could not be parsed; metrics are then meaningless. */
  parsed: boolean;
  parseError?: string;
}

const EMPTY_HALSTEAD: HalsteadMetrics = {
  distinctOperators: 0,
  totalOperators: 0,
  distinctOperands: 0,
  totalOperands: 0,
  vocabulary: 0,
  length: 0,
  volume: 0,
};

/**
 * Node types that introduce a branch in the control flow.
 *
 * `SwitchCase` is counted only when it has a test — `default:` is the
 * fall-through path, not a decision. `LogicalExpression` counts only for
 * short-circuiting operators. `ConditionalExpression` is the ternary.
 */
function decisionCountFor(node: t.Node): number {
  switch (node.type) {
    case 'IfStatement':
    case 'ConditionalExpression':
    case 'ForStatement':
    case 'ForInStatement':
    case 'ForOfStatement':
    case 'WhileStatement':
    case 'DoWhileStatement':
    case 'CatchClause':
      return 1;
    case 'SwitchCase':
      return node.test ? 1 : 0;
    case 'LogicalExpression':
      return node.operator === '&&' || node.operator === '||' || node.operator === '??' ? 1 : 0;
    default:
      return 0;
  }
}

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ObjectMethod',
  'ClassMethod',
  'ClassPrivateMethod',
]);

/** Best-effort readable name for a function node, for the per-function report. */
function functionName(path: NodePath): string {
  const node = path.node as t.Node & { id?: t.Identifier | null; key?: t.Node };

  if (node.id && node.id.type === 'Identifier') return node.id.name;

  if (node.key) {
    if (node.key.type === 'Identifier') return node.key.name;
    if (node.key.type === 'StringLiteral') return node.key.value;
  }

  // `const f = () => {}` and `f = function () {}` carry their name on the parent.
  const parent = path.parent as t.Node | undefined;
  if (parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier') return parent.id.name;
  if (parent?.type === 'AssignmentExpression' && parent.left.type === 'Identifier') return parent.left.name;
  if (parent?.type === 'ObjectProperty' && parent.key.type === 'Identifier') return parent.key.name;

  return '<anonymous>';
}

/**
 * HALSTEAD OPERATOR/OPERAND MAPPING
 *
 * Operands are the things operated on: identifier names and literal values.
 * Operators are everything that acts on them — arithmetic and logical symbols,
 * assignment, control-flow keywords, and the structural operators for call,
 * member access, object and array construction.
 *
 * Operators are keyed by symbol or node type so that, e.g., every `+` in the
 * file is one distinct operator, and every `if` is one distinct operator.
 */
function collectHalstead(ast: t.File): HalsteadMetrics {
  const operators = new Map<string, number>();
  const operands = new Map<string, number>();

  const addOperator = (key: string) => operators.set(key, (operators.get(key) ?? 0) + 1);
  const addOperand = (key: string) => operands.set(key, (operands.get(key) ?? 0) + 1);

  traverse(ast, {
    enter(path: NodePath) {
      const node = path.node as t.Node & Record<string, unknown>;

      switch (node.type) {
        // ── operands ────────────────────────────────────────────────
        case 'Identifier':
          addOperand((node as unknown as t.Identifier).name);
          break;
        case 'PrivateName':
          addOperand(`#${(node as unknown as t.PrivateName).id.name}`);
          break;
        case 'NumericLiteral':
        case 'StringLiteral':
        case 'BooleanLiteral':
          addOperand(String((node as unknown as { value: unknown }).value));
          break;
        case 'BigIntLiteral':
        case 'RegExpLiteral':
          addOperand(String((node as unknown as { pattern?: string; value?: string }).pattern ?? node.value));
          break;
        case 'NullLiteral':
          addOperand('null');
          break;
        case 'ThisExpression':
          addOperand('this');
          break;
        case 'Super':
          addOperand('super');
          break;

        // ── symbolic operators ──────────────────────────────────────
        case 'BinaryExpression':
        case 'LogicalExpression':
        case 'AssignmentExpression':
        case 'UnaryExpression':
        case 'UpdateExpression':
											        addOperator(String((node as unknown as { operator: string }).operator));
          break;

        // ── declaration and structural operators ────────────────────
        case 'VariableDeclaration':
          addOperator(String((node as unknown as t.VariableDeclaration).kind)); // const | let | var
          break;
        case 'VariableDeclarator':
          // `const x = value` initialises through a declarator, not an
          // AssignmentExpression, so the `=` has no node of its own. Count it
          // here or initialisation would be invisible to the operator tally.
          if ((node as unknown as t.VariableDeclarator).init) addOperator('=');
          break;
        case 'CallExpression':
        case 'OptionalCallExpression':
        case 'NewExpression':
          addOperator('()');
          break;
        case 'MemberExpression':
        case 'OptionalMemberExpression':
          addOperator((node as unknown as t.MemberExpression).computed ? '[]' : '.');
          break;
        case 'ObjectExpression':
          addOperator('{}');
          break;
        case 'ArrayExpression':
          addOperator('[]');
          break;
        case 'TemplateLiteral':
          addOperator('``');
          break;
        case 'SpreadElement':
        case 'RestElement':
          addOperator('...');
          break;

        // ── control-flow and keyword operators ──────────────────────
        case 'IfStatement':
          addOperator('if');
          if ((node as unknown as t.IfStatement).alternate) addOperator('else');
          break;
        case 'ConditionalExpression':
          addOperator('?:');
          break;
        case 'ForStatement':
          addOperator('for');
          break;
        case 'ForInStatement':
          addOperator('for-in');
          break;
        case 'ForOfStatement':
          addOperator('for-of');
          break;
        case 'WhileStatement':
          addOperator('while');
          break;
        case 'DoWhileStatement':
          addOperator('do-while');
          break;
        case 'SwitchStatement':
          addOperator('switch');
          break;
        case 'SwitchCase':
          addOperator((node as unknown as t.SwitchCase).test ? 'case' : 'default');
          break;
        case 'TryStatement':
          addOperator('try');
          break;
        case 'CatchClause':
          addOperator('catch');
          break;
        case 'ThrowStatement':
          addOperator('throw');
          break;
        case 'ReturnStatement':
          addOperator('return');
          break;
        case 'BreakStatement':
          addOperator('break');
          break;
        case 'ContinueStatement':
          addOperator('continue');
          break;
        case 'AwaitExpression':
          addOperator('await');
          break;
        case 'YieldExpression':
          addOperator('yield');
          break;
        case 'FunctionDeclaration':
        case 'FunctionExpression':
          addOperator('function');
          break;
        case 'ArrowFunctionExpression':
          addOperator('=>');
          break;
        case 'ClassDeclaration':
        case 'ClassExpression':
          addOperator('class');
          break;
        default:
          break;
      }
    },
  });

  const n1 = operators.size;
  const n2 = operands.size;
  const N1 = [...operators.values()].reduce((a, b) => a + b, 0);
  const N2 = [...operands.values()].reduce((a, b) => a + b, 0);

  const vocabulary = n1 + n2;
  const length = N1 + N2;
  const volume = vocabulary > 0 ? length * Math.log2(vocabulary) : 0;

  return {
    distinctOperators: n1,
    totalOperators: N1,
    distinctOperands: n2,
    totalOperands: N2,
    vocabulary,
    length,
    volume,
  };
}

/**
 * Source lines of code: physical lines that carry a statement.
 *
 * Blank lines and comment-only lines are excluded, which is what the SEI
 * formula's L term means. Comment bodies are stripped using the ranges Babel
 * already recorded, so a `//` inside a string literal is not mistaken for one.
 */
function countSourceLines(code: string, comments: readonly t.Comment[]): number {
  if (code.trim() === '') return 0;

  const lines = code.split('\n');
  const commentOnly = new Set<number>();

  for (const comment of comments) {
    if (!comment.loc) continue;
    for (let line = comment.loc.start.line; line <= comment.loc.end.line; line++) {
      commentOnly.add(line);
    }
  }

  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const text = lines[i].trim();
    if (text === '') continue;
    // A line inside a comment range still counts if it holds code too, e.g.
    // `foo(); // trailing`. Re-check by stripping nothing and testing whether
    // the line begins the comment.
    if (commentOnly.has(lineNumber)) {
      const startsComment = text.startsWith('//') || text.startsWith('/*') || text.startsWith('*');
      if (startsComment) continue;
    }
    count++;
  }
  return count;
}

/**
 * Analyse a JavaScript or TypeScript source string.
 *
 * On a parse failure this returns `parsed: false` with zeroed metrics. That is
 * deliberate: an unparseable file has no defined complexity, and emitting a
 * plausible-looking number for one is how the previous implementation came to
 * report 38 decision points for a single assignment.
 */
export function analyzeAST(codeString: string): ASTAnalysisResult {
  const physicalLines = codeString === '' ? 0 : codeString.split('\n').length;

  let ast: t.File;
  try {
    ast = parse(codeString, {
      sourceType: 'unambiguous',
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowSuperOutsideMethod: true,
      errorRecovery: false,
      plugins: ['typescript', 'jsx', 'decorators-legacy', 'classProperties', 'topLevelAwait'],
    });
  } catch (err) {
    return {
      cyclomaticComplexity: 0,
      maintainabilityIndex: 0,
      lineCount: 0,
      physicalLines,
      functionCount: 0,
      halstead: { ...EMPTY_HALSTEAD },
      functions: [],
      averageComplexity: 0,
      maxComplexity: 0,
      parsed: false,
      parseError: err instanceof Error ? err.message : String(err),
    };
  }

  // ── cyclomatic complexity ──────────────────────────────────────
  // One pass, attributing each decision both to the module total and to the
  // nearest enclosing function.
  let moduleDecisions = 0;
  const functions: FunctionComplexity[] = [];
  const decisionsByFunction = new Map<t.Node, number>();

  traverse(ast, {
    enter(path: NodePath) {
      const node = path.node;

      if (FUNCTION_TYPES.has(node.type)) {
        decisionsByFunction.set(node, decisionsByFunction.get(node) ?? 0);
        functions.push({
          name: functionName(path),
          line: node.loc?.start.line ?? 0,
          cyclomaticComplexity: 0, // filled in below
        });
      }

      const decisions = decisionCountFor(node);
      if (decisions === 0) return;

      moduleDecisions += decisions;

      const enclosing = path.getFunctionParent();
      if (enclosing) {
        const fn = enclosing.node;
        decisionsByFunction.set(fn, (decisionsByFunction.get(fn) ?? 0) + decisions);
      }
    },
  });

  // Re-walk the recorded function nodes in the same order they were pushed so
  // the per-function complexities line up with the names collected above.
  let index = 0;
  traverse(ast, {
    enter(path: NodePath) {
      if (!FUNCTION_TYPES.has(path.node.type)) return;
      const decisions = decisionsByFunction.get(path.node) ?? 0;
      functions[index].cyclomaticComplexity = decisions + 1;
      index++;
    },
  });

  const cyclomaticComplexity = moduleDecisions + 1;
  const perFunction = functions.map((f) => f.cyclomaticComplexity);
  const averageComplexity =
    perFunction.length > 0 ? perFunction.reduce((a, b) => a + b, 0) / perFunction.length : cyclomaticComplexity;
  const maxComplexity = perFunction.length > 0 ? Math.max(...perFunction) : cyclomaticComplexity;

  // ── halstead ───────────────────────────────────────────────────
  const halstead = collectHalstead(ast);

  // ── maintainability index ──────────────────────────────────────
  const lineCount = countSourceLines(codeString, ast.comments ?? []);
  const maintainabilityIndex = computeMaintainabilityIndex(
    halstead.volume,
    cyclomaticComplexity,
    lineCount,
  );

  return {
    cyclomaticComplexity,
    maintainabilityIndex,
    lineCount,
    physicalLines,
    functionCount: functions.length,
    halstead,
    functions,
    averageComplexity,
    maxComplexity,
    parsed: true,
  };
}

/**
 * SEI maintainability index, normalized to [0, 100].
 *
 *   MI = max(0, (171 - 5.2 ln V - 0.23 M - 16.2 ln L) * 100 / 171)
 *
 * An empty program has V = 0 and L = 0, where both logarithms diverge. That
 * is a degenerate input rather than unmaintainable code, so it scores 100.
 * Note there is no lower clamp above zero: the previous implementation floored
 * the result at 10, which meant genuinely unmaintainable code could not be
 * distinguished from merely bad code.
 */
export function computeMaintainabilityIndex(
  halsteadVolume: number,
  cyclomaticComplexity: number,
  sourceLines: number,
): number {
  if (halsteadVolume <= 0 || sourceLines <= 0) return 100;

  const raw =
    ((171 -
      5.2 * Math.log(halsteadVolume) -
      0.23 * cyclomaticComplexity -
      16.2 * Math.log(sourceLines)) *
      100) /
    171;

  return Math.max(0, Math.min(100, raw));
}
