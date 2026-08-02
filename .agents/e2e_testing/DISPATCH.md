## 2026-07-28T22:50:11Z
<USER_REQUEST>
You are the E2E Testing Specialist subagent for AssureCode frontend upgrade.
Your metadata directory is: `C:\Users\hp\AssureCode\.agents\e2e_testing`
Target project root: `C:\Users\hp\AssureCode`

Requirements to read: `C:\Users\hp\AssureCode\.agents\ORIGINAL_REQUEST.md` and `C:\Users\hp\AssureCode\PROJECT.md`.

Your Task:
1. Design and write an opaque-box E2E validation script / runner for the frontend upgrade.
2. The verification test suite must verify:
   - Tier 1: `npm run build:web` execution and exit code.
   - Tier 2: Zero `.ts` / `.tsx` files in `apps/web/src`.
   - Tier 3: JSX component structure and exports for Phase 1, Phase 2, Phase 3 (XAI Trust Score), Phase 4 (Escrow Settlement), and mobile responsive navigation elements.
   - Tier 4: Real-world application scenarios (routing through all 4 phases, state persistence across tabs).
3. Create `C:\Users\hp\AssureCode\TEST_INFRA.md` describing the test suite architecture.
4. Create `C:\Users\hp\AssureCode\TEST_READY.md` summarizing test tiers and command to run the verification suite (e.g. `node scripts/verify-web.js` or `npm run build:web`).
5. You may create `scripts/verify-web.js` at project root if needed for running automated checks.
6. Write `progress.md` and `handoff.md` in `C:\Users\hp\AssureCode\.agents\e2e_testing`.
7. Send a message to parent when `TEST_READY.md` is published.
</USER_REQUEST>
