/**
 * Security Auditor - Scans code for OWASP security vulnerabilities & performs prompt/code sanitization
 */

export interface SecurityScanResult {
  vulnerabilities: Array<{
    type: string;
    severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    message: string;
    line?: number;
  }>;
  passed: boolean;
  score: number;
}

export function performSecurityScan(codeString: string): SecurityScanResult {
  const vulnerabilities: SecurityScanResult['vulnerabilities'] = [];
  const lines = codeString.split('\n');

  lines.forEach((line, idx) => {
    const lineNumber = idx + 1;

    // Hardcoded secrets scan
    if (/api[_-]?key\s*[:=]\s*['"][a-zA-Z0-9_\-]{8,}['"]/i.test(line) || /secret\s*[:=]\s*['"][a-zA-Z0-9_\-]{8,}['"]/i.test(line)) {
      vulnerabilities.push({
        type: 'HARDCODED_SECRET',
        severity: 'HIGH',
        message: 'Potential hardcoded secret or API key detected',
        line: lineNumber,
      });
    }

    // Dangerous eval / Function calls
    if (/\beval\s*\(/i.test(line) || /new\s+Function\s*\(/i.test(line)) {
      vulnerabilities.push({
        type: 'DYNAMIC_CODE_EXECUTION',
        severity: 'CRITICAL',
        message: 'Dangerous code execution via eval() or Function constructor',
        line: lineNumber,
      });
    }

    // SQL Injection patterns
    if (/SELECT\s+.*\s+FROM\s+.*WHERE\s+.*\$\{/i.test(line) || /SELECT\s+.*\+\s*['"]/i.test(line)) {
      vulnerabilities.push({
        type: 'SQL_INJECTION',
        severity: 'CRITICAL',
        message: 'Possible unescaped SQL string concatenation',
        line: lineNumber,
      });
    }

    // Insecure Command Execution
    if (/child_process\.(exec|execSync)\s*\(/i.test(line)) {
      vulnerabilities.push({
        type: 'COMMAND_INJECTION',
        severity: 'HIGH',
        message: 'Use of shell command execution (child_process.exec)',
        line: lineNumber,
      });
    }
  });

  const criticalCount = vulnerabilities.filter((v) => v.severity === 'CRITICAL').length;
  const highCount = vulnerabilities.filter((v) => v.severity === 'HIGH').length;

  const passed = criticalCount === 0 && highCount === 0;
  const score = Math.max(0, 100 - criticalCount * 40 - highCount * 20 - vulnerabilities.length * 5);

  return {
    vulnerabilities,
    passed,
    score,
  };
}
