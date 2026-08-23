# AssureCode-FrontEnd — mock-only prototype, not the application

**This directory is not part of the running system. Do not read it as
documentation of how AssureCode works.**

The shipped web application is `apps/web`. This tree is a separate, earlier
React app kept for its UI ideas.

## What that means concretely

- **Nothing here talks to the backend.** Not one file in `src/` calls `fetch`,
  `axios`, or the shared `apiRequest` helper. Every screen renders from
  `src/context/AppContext.jsx`, which imports `MOCK_CONTRACTS`,
  `MOCK_FREELANCERS`, `MOCK_LEDGER_BLOCKS` and `MOCK_AST_METRICS`.
- **Nothing builds it.** It is not in the `workspaces` array in the root
  `package.json`, not in any Dockerfile, and not in `infra/docker-compose.yml`
  or `infra/k8s/`. `npm run build` at the repo root does not touch it.
- **It contains parallel implementations of server-side logic**, and these are
  the most misleading files in the repository:

  | File | Reimplements | The real one |
  |---|---|---|
  | `src/utils/trustScoreModel.js` | the XAI trust score | `apps/ai-service/app/routes/xai.py` |
  | `src/utils/scopeGuardEngine.js` | scope decisions | `apps/scope-guard/` + `ai-service` retrieval |
  | `src/utils/cryptoUtils.js` | ledger hashing | `packages/ledger-client/src/` |

  These are prototypes written to make the UI move. They are **not** the
  algorithms the system runs, they have never agreed with them, and a change to
  the real implementation will not be reflected here.

## Why it is still in the repository

Several components have no counterpart in `apps/web` and represent real gaps —
the gateway exposes `GET /api/contracts/:contractId`, `/verify` and
`/root` with no UI caller at all, and the freelancer role in `apps/web` is a
placeholder panel:

- `src/components/ledger/LedgerExplorer.jsx`
- `src/components/ledger/MerkleTreeVisualizer.jsx`
- `src/components/ledger/CryptographicProofModal.jsx`
- `src/views/FreelancerDashboard.jsx`
- `src/components/contracts/ContractWizard.jsx`

Porting any of these means rewriting its data source against the real endpoints,
not copying the file. The mock shapes here do not match the API responses.

## If you are looking for the real thing

| You want | Go to |
|---|---|
| The web application | `apps/web/` |
| How the system actually fits together | `ARCHITECTURE.md` |
| Running it | `RUNBOOK.md` |
