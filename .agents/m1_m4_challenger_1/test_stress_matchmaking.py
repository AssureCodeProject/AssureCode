import sys
import time
import random
from pathlib import Path

# Add apps/ai-service to sys.path
root_dir = Path("C:/Users/hp/AssureCode")
ai_service_dir = root_dir / "apps" / "ai-service"
sys.path.insert(0, str(ai_service_dir))

from app.ports.embedder import FakeEmbedder
from app.ports.graph_repo import FreelancerProfile, InMemoryGraphRepo
from app.services.matchmaker import Matchmaker

def run_stress_test():
    print("=== Matchmaker Empirical Stress Test ===")
    
    # 1. Test 100 freelancers sorting integrity (strict descending)
    tools_dir = root_dir / "tools"
    sys.path.insert(0, str(tools_dir))
    import test_100_freelancers_matchmaking as tf
    
    freelancers_100 = tf.generate_100_freelancers()
    graph = InMemoryGraphRepo()
    graph._freelancers = {f.id: f for f in freelancers_100}
    embedder = FakeEmbedder()
    matchmaker = Matchmaker(embedder=embedder, graph=graph)
    
    # Test queries
    queries = [
        "Need React TypeScript Node developer",
        "Python PyTorch RAG LLM pipeline",
        "OWASP security audit Docker",
        "Solidity smart contract web3",
        "Kubernetes Terraform AWS DevOps",
        "Flutter Dart mobile iOS",
        "Kafka Spark Airflow PostgreSQL",
        "Next.js Tailwind Svelte",
        "Go Rust microservices gRPC",
        "Snowflake Neo4j BigQuery SQL"
    ]
    
    latencies = []
    sorting_passed = True
    
    for q in queries:
        t0 = time.perf_counter()
        results = matchmaker.match(q, top_k=100) # return all 100 candidates to verify full list sort
        t1 = time.perf_counter()
        lat_ms = (t1 - t0) * 1000.0
        latencies.append(lat_ms)
        
        # Verify strict descending order for all 100 candidates
        scores = [r.score for r in results]
        is_sorted = all(scores[i] >= scores[i+1] for i in range(len(scores)-1))
        if not is_sorted:
            print(f"FAILED sorting for query: {q}")
            sorting_passed = False
            
    avg_lat = sum(latencies) / len(latencies)
    p95_lat = sorted(latencies)[int(len(latencies) * 0.95)]
    
    print(f"100 Candidate queries evaluated: {len(queries)}")
    print(f"Average Latency: {avg_lat:.2f} ms")
    print(f"P95 Latency: {p95_lat:.2f} ms")
    print(f"Sorting Integrity (100 candidates descending): {'PASS' if sorting_passed else 'FAIL'}")
    print(f"Sub-10ms requirement: {'PASS' if avg_lat < 10.0 else 'FAIL'}")
    
    # 2. Edge Case Tests
    print("\n--- Edge Case Testing ---")
    
    # Edge case 1: Empty requirements
    res_empty = matchmaker.match("", top_k=5)
    print(f"Empty requirement string returned {len(res_empty)} results, Top Score: {res_empty[0].score if res_empty else 'N/A'}")
    
    # Edge case 2: Empty graph
    empty_graph = InMemoryGraphRepo()
    empty_matchmaker = Matchmaker(embedder=embedder, graph=empty_graph)
    res_no_free = empty_matchmaker.match("Python", top_k=5)
    print(f"Empty graph returned {len(res_no_free)} results")
    
    # Edge case 3: 1,000 Freelancers Scale Test
    freelancers_1000 = []
    for i in range(1000):
        freelancers_1000.append(
            FreelancerProfile(
                id=f"f-{i}",
                name=f"User {i}",
                trust_score=round(random.uniform(0.5, 1.0), 2),
                skills=("python", "docker", "react", "aws"),
                deliveries=random.randint(0, 100),
                avg_ast=80.0,
                hourly_rate_cents=5000
            )
        )
    g1000 = InMemoryGraphRepo()
    g1000._freelancers = {f.id: f for f in freelancers_1000}
    m1000 = Matchmaker(embedder=embedder, graph=g1000)
    
    t0 = time.perf_counter()
    res1000 = m1000.match("Python docker security", top_k=10)
    t1 = time.perf_counter()
    lat1000 = (t1 - t0) * 1000.0
    print(f"1,000 Freelancers match latency: {lat1000:.2f} ms")

if __name__ == "__main__":
    run_stress_test()
