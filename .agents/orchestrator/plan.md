# Orchestration Plan — AssureCode Frontend Upgrade

## Objective
Upgrade `apps/web` to meet requirements R1 (Premium UI/UX & 375px responsive), R2 (TypeScript .tsx migration & modularity), R3 (XAI Trust Score & Escrow Status views), and pass acceptance criteria (`npm run build:web`, `npx tsc --noEmit`, 375px responsive check, router integration).

## Workflow Steps
1. **Survey Phase (Step 0)**:
   - Dispatch 3 parallel `teamwork_preview_explorer` agents to audit `apps/web` structure, dependencies, routing, components, styling framework, and existing JS/JSX/TS files.
2. **Decomposition & PROJECT.md (Step 1)**:
   - Consolidate survey reports into `PROJECT.md` at root.
   - Decomposing work items into milestones.
3. **Execution Phase (Step 2)**:
   - Run Explorer -> Worker -> Reviewer -> Challenger -> Auditor iteration loops for each milestone.
4. **Final Verification & Handoff (Step 3)**:
   - Final audit check and notify Sentinel when complete.
