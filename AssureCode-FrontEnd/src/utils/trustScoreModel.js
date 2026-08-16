/**
 * AssureCode Deterministic Trust Score Engine
 * Interpretable Linear Model & Settlement Oracle Gating Rules
 */

export const SETTLEMENT_SCORE_THRESHOLD = 85;

/**
 * Calculate deterministic trust score from CI/CD and telemetry factors
 */
export function calculateTrustScore({
  totalTests = 24,
  passedTests = 24,
  maintainabilityIndex = 88.5, // SEI MI (0 - 100 scale)
  cyclomaticComplexity = 4.2,  // McCabe avg complexity (optimal < 10)
  halsteadVolume = 1240,       // Halstead volume
  securityVulnerabilities = { critical: 0, high: 0, medium: 0, low: 1 },
  scopeComplianceRate = 0.96   // Percentage of interactions in-scope (0.0 - 1.0)
}) {
  // 1. Test Pass Factor (Weight: 35%)
  const testPassRate = totalTests > 0 ? (passedTests / totalTests) * 100 : 0;
  const testScore = Math.min(100, Math.max(0, testPassRate));

  // 2. AST Code Maintainability Factor (Weight: 25%)
  // High SEI MI is good (85+ is green). McCabe > 10 incurs penalty.
  let astScore = maintainabilityIndex;
  if (cyclomaticComplexity > 10) {
    astScore -= (cyclomaticComplexity - 10) * 4;
  }
  astScore = Math.min(100, Math.max(0, astScore));

  // 3. Dual-Layer OWASP Security Factor (Weight: 25%)
  // Base 100 with deductions: Critical (-40), High (-20), Medium (-8), Low (-2)
  let securityScore = 100;
  securityScore -= (securityVulnerabilities.critical || 0) * 40;
  securityScore -= (securityVulnerabilities.high || 0) * 20;
  securityScore -= (securityVulnerabilities.medium || 0) * 8;
  securityScore -= (securityVulnerabilities.low || 0) * 2;
  securityScore = Math.min(100, Math.max(0, securityScore));

  // 4. Scope Adherence Factor (Weight: 15%)
  const scopeScore = Math.min(100, Math.max(0, scopeComplianceRate * 100));

  // Deterministic Linear Combination
  const weights = {
    test: 0.35,
    ast: 0.25,
    security: 0.25,
    scope: 0.15
  };

  const rawFinalScore = (
    testScore * weights.test +
    astScore * weights.ast +
    securityScore * weights.security +
    scopeScore * weights.scope
  );

  const finalScore = Math.round(rawFinalScore * 10) / 10;

  // Evaluate Oracle Settlement Rules
  const criticalCount = securityVulnerabilities.critical || 0;
  const highCount = securityVulnerabilities.high || 0;
  const isApproved = finalScore >= SETTLEMENT_SCORE_THRESHOLD && criticalCount === 0;

  const blockers = [];
  if (finalScore < SETTLEMENT_SCORE_THRESHOLD) {
    blockers.push(`Trust score ${finalScore} is below mandatory threshold of ${SETTLEMENT_SCORE_THRESHOLD}.`);
  }
  if (criticalCount > 0) {
    blockers.push(`${criticalCount} Critical OWASP vulnerability detected (Requires immediate remediation).`);
  }
  if (highCount > 1) {
    blockers.push(`Multiple High-severity security issues detected (${highCount}). Recommended resolution before settlement.`);
  }
  if (passedTests < totalTests) {
    blockers.push(`${totalTests - passedTests} hidden CI test cases are failing.`);
  }

  return {
    score: finalScore,
    isApproved,
    threshold: SETTLEMENT_SCORE_THRESHOLD,
    blockers,
    components: {
      tests: {
        score: Math.round(testScore),
        weight: weights.test,
        weightedContribution: Math.round(testScore * weights.test * 10) / 10,
        passedTests,
        totalTests,
        passRate: testPassRate
      },
      maintainability: {
        score: Math.round(astScore),
        weight: weights.ast,
        weightedContribution: Math.round(astScore * weights.ast * 10) / 10,
        seiIndex: maintainabilityIndex,
        cyclomaticComplexity,
        halsteadVolume
      },
      security: {
        score: Math.round(securityScore),
        weight: weights.security,
        weightedContribution: Math.round(securityScore * weights.security * 10) / 10,
        vulnerabilities: securityVulnerabilities,
        criticalCount
      },
      scope: {
        score: Math.round(scopeScore),
        weight: weights.scope,
        weightedContribution: Math.round(scopeScore * weights.scope * 10) / 10,
        complianceRate: scopeComplianceRate
      }
    },
    formula: `Score = 0.35(Tests) + 0.25(AST_MI) + 0.25(OWASP_Sec) + 0.15(Scope_Adherence)`
  };
}
