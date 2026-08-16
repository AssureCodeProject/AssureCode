#!/usr/bin/env python3
"""
Seed profile embeddings and the vector index into Neo4j.

Why this exists
---------------
`infra/seed/neo4j/V001__seed_matchmaking.cypher` builds the whole graph — 12
Freelancers, 3 Clients, 3 Projects, 42 Skills and ~85 relationships — but stores
no vectors and creates no index. That, not the adapter, is why
`Neo4jGraphRepo.retrieve_by_embedding` was a stub returning similarity 0.0 for
everyone. This script closes that gap: it creates a 384-dimension cosine vector
index and writes an `embedding` property onto each `:Freelancer`.

Why Python and not tools/seed-neo4j.ts
-------------------------------------
The embeddings must come from the same sentence-transformers model the
matchmaker embeds queries with. The TypeScript seeder cannot produce them, and a
vector produced by any other model puts profiles and queries in different spaces
— which does not error, it just ranks badly.

Why it imports from seed-users.py instead of copying
----------------------------------------------------
The roster and the `profile_text` formula MUST match what went into Postgres,
or the two backends are not comparable and the parity test is meaningless. A
forked copy of a 12-entry list is a copy that drifts — `InMemoryGraphRepo`
already proves it, having sat at 8 entries with one freelancer's name reversed
and his skills swapped. Importing means there is exactly one roster.

Run order:
    npm run seed:neo4j                  # graph structure (TypeScript)
    python tools/seed-neo4j-vectors.py  # embeddings + index (this file)
"""
from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "apps" / "ai-service"))

VECTOR_INDEX = "freelancer_embeddings"
EMBED_DIM = 384


def _load_seed_users():
    """Import tools/seed-users.py, whose filename is not a valid module name.

    Guarded by `if __name__ == "__main__"` on its side, so importing it defines
    the roster and helpers without seeding Postgres as a side effect.
    """
    path = ROOT / "tools" / "seed-users.py"
    spec = importlib.util.spec_from_file_location("seed_users", path)
    if spec is None or spec.loader is None:  # pragma: no cover
        raise RuntimeError(f"could not load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def profile_text_for(freelancer: dict) -> str:
    """The exact string seed-users.py embeds. Kept in one place on purpose.

    If this ever diverges from tools/seed-users.py:248, Postgres and Neo4j hold
    embeddings of different text and every cross-backend comparison silently
    measures the difference between the two formulas rather than between the two
    indexes.
    """
    return f"{freelancer['name']} {' '.join(freelancer['skills'])}"


def main() -> int:
    # Same guard as seed-users.py. This writes demo data; it must never run
    # against a production graph.
    if os.environ.get("NODE_ENV") == "production":
        print("[seed-vectors] Refusing to seed demo embeddings: NODE_ENV=production.")
        return 1

    try:
        from neo4j import GraphDatabase
    except ImportError:
        print(
            "[seed-vectors] The neo4j driver is not installed. "
            "Install the ai-service 'full' extra:  pip install -e 'apps/ai-service[full]'"
        )
        return 1

    seed_users = _load_seed_users()
    freelancers = seed_users.FREELANCERS
    embedder = seed_users.get_embedder()

    uri = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
    user = os.environ.get("NEO4J_USER", "neo4j")
    password = os.environ.get("NEO4J_PASSWORD", "assurecode_local_dev")

    print(f"[seed-vectors] Connecting to {uri}")
    driver = GraphDatabase.driver(uri, auth=(user, password))

    try:
        driver.verify_connectivity()
    except Exception as err:
        print(f"[seed-vectors] Could not reach Neo4j at {uri}: {err}")
        driver.close()
        return 1

    try:
        # The index must exist before the properties are set, and creating it is
        # idempotent. `vector.similarity_function: 'cosine'` is what makes
        # db.index.vector.queryNodes return the (1+cos)/2 rescaled score that
        # Neo4jGraphRepo.neo4j_score_to_cosine inverts — if this is ever changed
        # to 'euclidean', that inversion becomes wrong and rankings silently
        # diverge from Postgres.
        driver.execute_query(
            f"""
            CREATE VECTOR INDEX {VECTOR_INDEX} IF NOT EXISTS
            FOR (f:Freelancer) ON f.embedding
            OPTIONS {{indexConfig: {{
                `vector.dimensions`: {EMBED_DIM},
                `vector.similarity_function`: 'cosine'
            }}}}
            """
        )
        print(f"[seed-vectors] Vector index '{VECTOR_INDEX}' ready ({EMBED_DIM}-d, cosine)")

        written = 0
        missing: list[str] = []

        for f in freelancers:
            text = profile_text_for(f)
            vector = embedder.embed(text)
            values = [float(x) for x in (vector.tolist() if hasattr(vector, "tolist") else vector)]

            if len(values) != EMBED_DIM:
                print(
                    f"[seed-vectors] Refusing to write a {len(values)}-d vector into a "
                    f"{EMBED_DIM}-d index for {f['id']}. Check EMBED_DIM / the model."
                )
                return 1

            records, _, _ = driver.execute_query(
                """
                MATCH (f:Freelancer {id: $id})
                SET f.embedding = $vec, f.profileText = $text
                RETURN f.id AS id
                """,
                id=f["id"],
                vec=values,
                text=text,
            )
            if records:
                written += 1
            else:
                # The node does not exist, which means the structural seed has
                # not run. Collected rather than raised so the report names
                # every missing id at once.
                missing.append(f["id"])

        if missing:
            print(
                f"[seed-vectors] {len(missing)} freelancer node(s) not found: "
                f"{', '.join(missing)}\n"
                "[seed-vectors] Run `npm run seed:neo4j` first — this script only "
                "adds vectors to nodes the structural seed created."
            )
            return 1

        # Verify through the index rather than by counting properties: a
        # populated property with an index that never picked it up would still
        # return nothing at query time, which is the failure that matters.
        probe = embedder.embed(profile_text_for(freelancers[0]))
        probe_values = [float(x) for x in (probe.tolist() if hasattr(probe, "tolist") else probe)]
        records, _, _ = driver.execute_query(
            f"""
            CALL db.index.vector.queryNodes('{VECTOR_INDEX}', 3, $vec)
            YIELD node, score
            RETURN node.id AS id, score
            ORDER BY score DESC
            """,
            vec=probe_values,
        )

        if not records:
            print(
                "[seed-vectors] Wrote vectors but the index returned nothing. "
                "Neo4j populates vector indexes asynchronously — re-run this "
                "script, or query again shortly."
            )
            return 1

        top = records[0]
        print(f"[seed-vectors] Wrote {written} embeddings.")
        print(
            f"[seed-vectors] Index probe: nearest to '{freelancers[0]['id']}' is "
            f"'{top['id']}' (raw score {top['score']:.4f})"
        )
        if top["id"] != freelancers[0]["id"]:
            # Not fatal — with a FakeEmbedder this is expected — but it is the
            # signal that the vectors are not meaningful.
            print(
                "[seed-vectors] WARNING: a profile is not its own nearest neighbour. "
                "That is expected under FakeEmbedder and a red flag under the real model."
            )
        return 0
    finally:
        driver.close()


if __name__ == "__main__":
    raise SystemExit(main())
