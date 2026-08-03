/**
 * Backwards-compatible entrypoint.
 *
 * The implementation moved to src/sandbox/, which selects between the Docker
 * and Node-permission adapters at runtime. Existing importers keep working.
 */
export {
  runInSandbox,
  selectSandboxRunner,
  parseTestOutput,
  DockerSandbox,
  NodePermissionSandbox,
} from './sandbox/index.js';
export type {
  SandboxExecutionResult,
  SandboxOptions,
  SandboxRunner,
  ThreatModel,
} from './sandbox/index.js';
