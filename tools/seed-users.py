#!/usr/bin/env python3
"""
Seed script for AssureCode Users and Freelancer Profiles.

Populates 3 Client accounts and 12 Freelancer profiles with precomputed
vector(384) embeddings into PostgreSQL.
"""

import sys
import os
from pathlib import Path

# Add apps/ai-service to sys.path
root_dir = Path(__file__).resolve().parent.parent
ai_service_dir = root_dir / "apps" / "ai-service"
sys.path.insert(0, str(ai_service_dir))

from app.ports.embedder import FakeEmbedder, SentenceTransformerEmbedder

# Simple argon2id hash or fallback demo hash for 'demo1234'
# $argon2id$v=19$m=65536,t=3,p=4$...
DEMO_PASSWORD_HASH = "$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$p3aXlT+qL1mZ9O0aR18XJg"

CLIENTS = [
    {
        "user_id": "client-acme",
        "email": "client@acme.com",
        "display_name": "Acme Corp",
        "role": "client",
    },
    {
        "user_id": "client-globex",
        "email": "client@globex.com",
        "display_name": "Globex Inc",
        "role": "client",
    },
    {
        "user_id": "legacy-client",
        "email": "legacy@assurecode.io",
        "display_name": "Legacy Demo Client",
        "role": "client",
    },
]

FREELANCERS = [
    {
        "id": "freelancer-priya",
        "email": "priya@assurecode.io",
        "name": "Priya Sharma",
        "trust_score": 0.92,
        "skills": ["react", "typescript", "node.js", "fastify", "postgresql", "docker"],
        "deliveries": 18,
        "avg_ast": 87.0,
        "hourly_rate_cents": 8500,
    },
    {
        "id": "freelancer-marcus",
        "email": "marcus@assurecode.io",
        "name": "Marcus Lindgren",
        "trust_score": 0.81,
        "skills": ["python", "fastapi", "postgresql", "docker", "aws", "redis"],
        "deliveries": 11,
        "avg_ast": 79.0,
        "hourly_rate_cents": 7200,
    },
    {
        "id": "freelancer-aisha",
        "email": "aisha@assurecode.io",
        "name": "Aisha Okafor",
        "trust_score": 0.76,
        "skills": ["react", "typescript", "cypress", "jest", "tailwind"],
        "deliveries": 7,
        "avg_ast": 83.0,
        "hourly_rate_cents": 6000,
    },
    {
        "id": "freelancer-tomas",
        "email": "tomas@assurecode.io",
        "name": "Tomás Rivera",
        "trust_score": 0.64,
        "skills": ["react", "node.js", "postgresql", "docker"],
        "deliveries": 4,
        "avg_ast": 71.0,
        "hourly_rate_cents": 4500,
    },
    {
        "id": "freelancer-elena",
        "email": "elena@assurecode.io",
        "name": "Elena Rostova",
        "trust_score": 0.95,
        "skills": ["python", "security", "owasp", "docker", "rust", "go", "postgresql"],
        "deliveries": 22,
        "avg_ast": 91.0,
        "hourly_rate_cents": 9500,
    },
    {
        "id": "freelancer-chen",
        "email": "chen@assurecode.io",
        "name": "Wei Chen",
        "trust_score": 0.88,
        "skills": ["solidity", "ethereum", "web3", "hardhat", "typescript", "react"],
        "deliveries": 14,
        "avg_ast": 84.0,
        "hourly_rate_cents": 9000,
    },
    {
        "id": "freelancer-alex",
        "email": "alex@assurecode.io",
        "name": "Alex Mercer",
        "trust_score": 0.89,
        "skills": ["python", "pytorch", "fastapi", "rag", "langchain", "vector.db"],
        "deliveries": 16,
        "avg_ast": 88.0,
        "hourly_rate_cents": 8800,
    },
    {
        "id": "freelancer-sarah",
        "email": "sarah@assurecode.io",
        "name": "Sarah Jenkins",
        "trust_score": 0.83,
        "skills": ["docker", "kubernetes", "terraform", "aws", "prometheus", "ci/cd"],
        "deliveries": 12,
        "avg_ast": 82.0,
        "hourly_rate_cents": 7800,
    },
    {
        "id": "freelancer-david",
        "email": "david@assurecode.io",
        "name": "David Kim",
        "trust_score": 0.79,
        "skills": ["react.native", "flutter", "typescript", "ios", "android"],
        "deliveries": 9,
        "avg_ast": 78.0,
        "hourly_rate_cents": 6800,
    },
    {
        "id": "freelancer-maya",
        "email": "maya@assurecode.io",
        "name": "Maya Patel",
        "trust_score": 0.91,
        "skills": ["postgresql", "neo4j", "redis", "kafka", "snowflake", "sql"],
        "deliveries": 19,
        "avg_ast": 89.0,
        "hourly_rate_cents": 8900,
    },
    {
        "id": "freelancer-omar",
        "email": "omar@assurecode.io",
        "name": "Omar Farooq",
        "trust_score": 0.85,
        "skills": ["go", "rust", "grpc", "microservices", "kubernetes", "postgresql"],
        "deliveries": 13,
        "avg_ast": 85.0,
        "hourly_rate_cents": 8200,
    },
    {
        "id": "freelancer-maria",
        "email": "maria@assurecode.io",
        "name": "Maria Garcia",
        "trust_score": 0.87,
        "skills": ["vue.js", "next.js", "tailwind", "typescript", "graphql"],
        "deliveries": 15,
        "avg_ast": 86.0,
        "hourly_rate_cents": 7500,
    },
]

def get_embedder():
    try:
        embedder = SentenceTransformerEmbedder("all-MiniLM-L6-v2", dim=384)
        embedder.embed("test")
        print("[seed] Using SentenceTransformerEmbedder (all-MiniLM-L6-v2)")
        return embedder
    except Exception as err:
        print(f"[seed] Falling back to FakeEmbedder: {err}")
        return FakeEmbedder(dim=384)

def vector_literal(values):
    return "[" + ",".join(f"{float(x):.7f}" for x in values) + "]"

def main():
    try:
        import psycopg2 as psycopg
    except ImportError:
        import psycopg

    db_url = os.environ.get("DATABASE_URL", "postgresql://assurecode:assurecode_local_dev@localhost:5432/assurecode")
    print(f"[seed] Connecting to PostgreSQL...")

    conn = psycopg.connect(db_url)
    embedder = get_embedder()

    with conn.cursor() as cur:
        # Seed Clients
        for c in CLIENTS:
            cur.execute(
                """
                INSERT INTO users (user_id, email, password_hash, role, display_name)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (user_id) DO UPDATE SET
                    email = EXCLUDED.email,
                    display_name = EXCLUDED.display_name
                """,
                (c["user_id"], c["email"], DEMO_PASSWORD_HASH, c["role"], c["display_name"]),
            )

        # Seed Freelancers
        for f in FREELANCERS:
            # 1. User account
            cur.execute(
                """
                INSERT INTO users (user_id, email, password_hash, role, display_name)
                VALUES (%s, %s, %s, 'freelancer', %s)
                ON CONFLICT (user_id) DO UPDATE SET
                    email = EXCLUDED.email,
                    display_name = EXCLUDED.display_name
                """,
                (f["id"], f["email"], DEMO_PASSWORD_HASH, f["name"]),
            )

            # 2. Profile embedding
            profile_text = f"{f['name']} {' '.join(f['skills'])}"
            embedding = embedder.embed(profile_text)
            vec_str = vector_literal(embedding.tolist())

            # 3. Freelancer profile
            cur.execute(
                """
                INSERT INTO freelancer_profiles (
                    freelancer_id, skills, trust_score, deliveries, avg_ast, hourly_rate_cents, profile_text, profile_embedding
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s::vector)
                ON CONFLICT (freelancer_id) DO UPDATE SET
                    skills = EXCLUDED.skills,
                    trust_score = EXCLUDED.trust_score,
                    deliveries = EXCLUDED.deliveries,
                    avg_ast = EXCLUDED.avg_ast,
                    hourly_rate_cents = EXCLUDED.hourly_rate_cents,
                    profile_text = EXCLUDED.profile_text,
                    profile_embedding = EXCLUDED.profile_embedding
                """,
                (
                    f["id"],
                    f["skills"],
                    f["trust_score"],
                    f["deliveries"],
                    f["avg_ast"],
                    f["hourly_rate_cents"],
                    profile_text,
                    vec_str,
                ),
            )

    conn.commit()
    conn.close()
    print("[seed] Seeded 3 clients and 12 freelancer profiles successfully.")

if __name__ == "__main__":
    main()
