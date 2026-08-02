/**
 * AST Cyclomatic Complexity & Maintainability Analyzer for TS/JS
 */

export interface ASTAnalysisResult {
  cyclomaticComplexity: number;
  maintainabilityIndex: number;
  lineCount: number;
  functionCount: number;
}

export function analyzeAST(codeString: string): ASTAnalysisResult {
  const lines = codeString.split('\n');
  const lineCount = lines.length;

  // Simple AST complexity metric calculation based on decision points
  let decisionPoints = 1;
  const decisionKeywords = ['if', 'else if', 'for', 'while', 'catch', 'case', '&&', '||', '?'];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;

    for (const keyword of decisionKeywords) {
      const regex = new RegExp(`\\b${keyword.replace('?', '\\?')}\\b|\\${keyword}`, 'g');
      const matches = trimmed.match(regex);
      if (matches) {
        decisionPoints += matches.length;
      }
    }
  }

  const functions = codeString.match(/function\s+|=>|\bdef\s+/g) || [];
  const functionCount = Math.max(1, functions.length);

  const averageComplexity = decisionPoints / functionCount;
  // Scaled Maintainability Index (0 - 100)
  const baseScore = 100 - averageComplexity * 10 - lineCount * 0.5;
  const maintainabilityIndex = Math.max(10, Math.min(100, Math.round(baseScore)));

  return {
    cyclomaticComplexity: decisionPoints,
    maintainabilityIndex,
    lineCount,
    functionCount,
  };
}
