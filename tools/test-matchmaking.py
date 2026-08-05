#!/usr/bin/env python3
"""
AssureCode Matchmaking Verification Tool (`tools/test-matchmaking.py`)

A qualitative smoke test: five client scenarios against the 8-profile fixture,
with the score decomposition printed per candidate. Each scenario names an
expected top match, and the script exits non-zero if one does not come out on
top — it used to print "ALL SCENARIOS EXECUTED SUCCESSFULLY" regardless, since
`all_passed` only ever went false when the matcher returned nothing at all.

This uses the real SentenceTransformerEmbedder. It previously used
FakeEmbedder, whose vectors are sha256 buckets over whitespace tokens — so the
"5/5 domains verified" result recorded in .agents/ was measuring hash
collisions, not semantics, and told you nothing about the shipped path.

Loading the model costs a few seconds on first run. For quantitative numbers
(P@k, MRR, nDCG, the weight ablation, N=100 and N=1000) use
`tools/eval/matchmaking_eval.py` instead; this file is eight freelancers and is
not a benchmark.

Current result: 4/5, exit code 1. Scenario 3 (Web3) puts Priya Sharma above
Sarah Jenkins even though Sarah has the higher semantic skill score, because
w_trust=0.35 and w_history=0.15 outweigh the skill gap. That failure is left in
place deliberately — it is the same effect the ablation quantifies, visible in a
single case you can read by eye. Do not fix it by lowering the expectation.
"""

import sys
from pathlib import Path

# Add apps/ai-service to sys.path so we can import directly from app modules
root_dir = Path(__file__).resolve().parent.parent
ai_service_dir = root_dir / "apps" / "ai-service"
sys.path.insert(0, str(ai_service_dir))

from app.ports.embedder import SentenceTransformerEmbedder
from app.ports.graph_repo import InMemoryGraphRepo
from app.services.matchmaker import Matchmaker


def run_matchmaking_tests() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    embedder = SentenceTransformerEmbedder()
    graph = InMemoryGraphRepo()
    matchmaker = Matchmaker(embedder=embedder, graph=graph)

    test_scenarios = [
        {
            "category": "Security & Code Audit",
            "requirements": "Perform OWASP security audit and code vulnerability scan in Python and Docker environment",
            "expected_top": "Elena Rostova",
        },
        {
            "category": "AI / RAG & LLM Pipeline",
            "requirements": "Build a RAG pipeline with vector databases, PyTorch, and FastAPI LLM integration",
            "expected_top": "Chen Wei",
        },
        {
            "category": "Web3 & Smart Contracts",
            "requirements": "Build a Web3 decentralised application with Solidity smart contracts and React TypeScript frontend",
            "expected_top": "Sarah Jenkins",
        },
        {
            "category": "DevOps & Cloud Infrastructure",
            "requirements": "Provision Kubernetes cluster with Terraform, Docker, AWS, and Prometheus monitoring",
            "expected_top": "Devon Vance",
        },
        {
            "category": "Full-Stack Web Development",
            "requirements": "React TypeScript Node.js Fastify frontend and backend dashboard",
            "expected_top": "Priya Sharma",
        },
    ]

    print("====================================================")
    print("   AssureCode NLP Matchmaker Verification Suite     ")
    print("====================================================\n")

    print(f"Total Available Freelancers in Database: {len(graph.all_freelancers())}")
    for idx, f in enumerate(graph.all_freelancers(), 1):
        print(f"  {idx}. {f.name:<18} | Trust Score: {f.trust_score:.2f} | Hourly Rate: ${f.hourly_rate_cents/100:.2f} | Skills: {', '.join(f.skills)}")
    print("\n----------------------------------------------------\n")

    all_passed = True

    for i, sc in enumerate(test_scenarios, 1):
        req = sc["requirements"]
        category = sc["category"]
        expected = sc["expected_top"]

        print(f"--- Scenario {i}: {category} ---")
        print(f"Client Requirements: \"{req}\"")

        results = matchmaker.match(req, top_k=3)

        if not results:
            print("  X ERROR: No matching results returned.")
            all_passed = False
            continue

        top_match = results[0]
        is_expected = top_match.freelancer_name == expected
        status_symbol = "✓" if is_expected else "⚠"

        print(f"Match Results (Top {len(results)}):")
        for rank, res in enumerate(results, 1):
            exp = res.explanation
            mark = "★ TOP MATCH" if rank == 1 else "  "
            print(
                f"  Rank #{rank} [{mark}] {res.freelancer_name:<16} | Overall Score: {res.score:.4f} "
                f"(Skill: {exp.skill_score:.4f}, Trust: {exp.trust_score:.4f}, Hist: {exp.history_score:.4f}) | "
                f"Matched Skills: {list(exp.matched_skills)}"
            )

        if is_expected:
            print(f"  {status_symbol} PASS: Top match is '{top_match.freelancer_name}' as expected.\n")
        else:
            all_passed = False
            print(f"  {status_symbol} FAIL: Top match is '{top_match.freelancer_name}', "
                  f"expected '{expected}'.")
            # Say *why*, so the failure is evidence rather than a mystery. When
            # the expected candidate wins on the semantic term but loses overall,
            # the trust and history weights are what overturned the match — the
            # same effect tools/eval/matchmaking_eval.py measures across the
            # whole weight simplex.
            exp_res = next((r for r in results if r.freelancer_name == expected), None)
            if exp_res is not None and exp_res.explanation.skill_score > top_match.explanation.skill_score:
                print(f"    Cause: '{expected}' has the higher semantic skill score "
                      f"({exp_res.explanation.skill_score:.4f} vs "
                      f"{top_match.explanation.skill_score:.4f}) but loses on the "
                      f"trust term ({exp_res.explanation.trust_score:.2f} vs "
                      f"{top_match.explanation.trust_score:.2f}) and the history term "
                      f"({exp_res.explanation.history_score:.4f} vs "
                      f"{top_match.explanation.history_score:.4f}).")
                print(f"    w_trust=0.35 + w_history=0.15 outweigh a "
                      f"{exp_res.explanation.skill_score - top_match.explanation.skill_score:.4f} "
                      f"skill lead. This is a real property of the shipped weights, "
                      f"not a bug in this test.")
            elif exp_res is None:
                print(f"    '{expected}' did not appear in the top {len(results)} at all.")
            print()

    print("====================================================")
    if all_passed:
        print(f"   {len(test_scenarios)}/{len(test_scenarios)} scenarios matched the expected top candidate.")
    else:
        print("   One or more scenarios did not match the expected top candidate.")
    print("====================================================")
    return 0 if all_passed else 1


if __name__ == "__main__":
    raise SystemExit(run_matchmaking_tests())
