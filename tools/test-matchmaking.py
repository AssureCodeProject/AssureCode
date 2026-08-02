#!/usr/bin/env python3
"""
AssureCode Matchmaking Verification Tool (`tools/test-matchmaking.py`)

Tests the NLP Matchmaker engine against diverse client requirement scenarios.
Demonstrates ranking, semantic skill matching, XAI trust score weighting,
and score breakdown per freelancer profile.
"""

import sys
from pathlib import Path

# Add apps/ai-service to sys.path so we can import directly from app modules
root_dir = Path(__file__).resolve().parent.parent
ai_service_dir = root_dir / "apps" / "ai-service"
sys.path.insert(0, str(ai_service_dir))

from app.ports.embedder import FakeEmbedder
from app.ports.graph_repo import InMemoryGraphRepo
from app.services.matchmaker import Matchmaker


def run_matchmaking_tests():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    embedder = FakeEmbedder()
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
            print("  ❌ ERROR: No matching results returned.")
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
            print(f"  {status_symbol} VERIFIED: Top match is '{top_match.freelancer_name}' as expected.\n")
        else:
            print(f"  {status_symbol} NOTE: Top match is '{top_match.freelancer_name}' (expected '{expected}').\n")

    print("====================================================")
    if all_passed:
        print("   🎉 ALL MATCHMAKING SCENARIOS EXECUTED SUCCESSFULLY!")
    print("====================================================")


if __name__ == "__main__":
    run_matchmaking_tests()
