// =============================================================================
// AssureCode — Neo4j matchmaking seed
//
// Applied by `tools/seed-neo4j.ts` (npm run seed:neo4j). Every statement is
// MERGE-based, so re-running is idempotent and safe against a populated graph.
//
// The freelancer set here mirrors tools/seed-users.py, which is the dataset the
// running system actually matches against (deps.py selects PostgresGraphRepo).
// Keeping the two in step matters because Neo4jGraphRepo._query_freelancers
// reads these exact property names:
//
//   f.id, f.name, f.XAI_Trust_Score, f.deliveries, f.avgAST, f.hourlyRateCents
//   (f)-[:HAS_SKILL]->(:Skill {name})
//
// Skill names are stored lowercase because that adapter lowercases them on read
// (toLower(s.name)); storing them any other way would produce two spellings of
// the same skill depending on which backend answered.
// =============================================================================

CREATE CONSTRAINT freelancer_id IF NOT EXISTS FOR (f:Freelancer) REQUIRE f.id IS UNIQUE;

CREATE CONSTRAINT client_id IF NOT EXISTS FOR (c:Client) REQUIRE c.id IS UNIQUE;

CREATE CONSTRAINT skill_name IF NOT EXISTS FOR (s:Skill) REQUIRE s.name IS UNIQUE;

CREATE CONSTRAINT project_id IF NOT EXISTS FOR (p:Project) REQUIRE p.id IS UNIQUE;

// Freelancers and their skills, in one idempotent pass.
UNWIND [
  {id: 'freelancer-priya',  name: 'Priya Sharma',   email: 'priya@assurecode.io',  trust: 0.92, deliveries: 18, avgAst: 87.0, rate: 8500,
   skills: ['react', 'typescript', 'node.js', 'fastify', 'postgresql', 'docker']},
  {id: 'freelancer-marcus', name: 'Marcus Lindgren', email: 'marcus@assurecode.io', trust: 0.81, deliveries: 11, avgAst: 79.0, rate: 7200,
   skills: ['python', 'fastapi', 'postgresql', 'docker', 'aws', 'redis']},
  {id: 'freelancer-aisha',  name: 'Aisha Okafor',   email: 'aisha@assurecode.io',  trust: 0.76, deliveries: 7,  avgAst: 83.0, rate: 6000,
   skills: ['react', 'typescript', 'cypress', 'jest', 'tailwind']},
  {id: 'freelancer-tomas',  name: 'Tomás Rivera',   email: 'tomas@assurecode.io',  trust: 0.64, deliveries: 4,  avgAst: 71.0, rate: 4500,
   skills: ['react', 'node.js', 'postgresql', 'docker']},
  {id: 'freelancer-elena',  name: 'Elena Rostova',  email: 'elena@assurecode.io',  trust: 0.95, deliveries: 22, avgAst: 91.0, rate: 9500,
   skills: ['python', 'security', 'owasp', 'docker', 'rust', 'go', 'postgresql']},
  {id: 'freelancer-chen',   name: 'Wei Chen',       email: 'chen@assurecode.io',   trust: 0.88, deliveries: 14, avgAst: 84.0, rate: 9000,
   skills: ['solidity', 'ethereum', 'web3', 'hardhat', 'typescript', 'react']},
  {id: 'freelancer-alex',   name: 'Alex Mercer',    email: 'alex@assurecode.io',   trust: 0.89, deliveries: 16, avgAst: 88.0, rate: 8800,
   skills: ['python', 'pytorch', 'fastapi', 'rag', 'langchain', 'vector.db']},
  {id: 'freelancer-sarah',  name: 'Sarah Jenkins',  email: 'sarah@assurecode.io',  trust: 0.83, deliveries: 12, avgAst: 82.0, rate: 7800,
   skills: ['docker', 'kubernetes', 'terraform', 'aws', 'prometheus', 'ci/cd']},
  {id: 'freelancer-david',  name: 'David Kim',      email: 'david@assurecode.io',  trust: 0.79, deliveries: 9,  avgAst: 78.0, rate: 6800,
   skills: ['react.native', 'flutter', 'typescript', 'ios', 'android']},
  {id: 'freelancer-maya',   name: 'Maya Patel',     email: 'maya@assurecode.io',   trust: 0.91, deliveries: 19, avgAst: 89.0, rate: 8900,
   skills: ['postgresql', 'neo4j', 'redis', 'kafka', 'snowflake', 'sql']},
  {id: 'freelancer-omar',   name: 'Omar Farooq',    email: 'omar@assurecode.io',   trust: 0.85, deliveries: 13, avgAst: 85.0, rate: 8200,
   skills: ['go', 'rust', 'grpc', 'microservices', 'kubernetes', 'postgresql']},
  {id: 'freelancer-maria',  name: 'Maria Garcia',   email: 'maria@assurecode.io',  trust: 0.87, deliveries: 15, avgAst: 86.0, rate: 7500,
   skills: ['vue.js', 'next.js', 'tailwind', 'typescript', 'graphql']}
] AS row
MERGE (f:Freelancer {id: row.id})
SET f.name = row.name,
    f.email = row.email,
    f.XAI_Trust_Score = row.trust,
    f.deliveries = row.deliveries,
    f.avgAST = row.avgAst,
    f.hourlyRateCents = row.rate
WITH f, row
UNWIND row.skills AS skillName
MERGE (s:Skill {name: skillName})
MERGE (f)-[:HAS_SKILL]->(s);

// Clients, mirroring the same three seeded in tools/seed-users.py.
UNWIND [
  {id: 'client-acme',   name: 'Acme Corp',          email: 'client@acme.com'},
  {id: 'client-globex', name: 'Globex Inc',         email: 'client@globex.com'},
  {id: 'legacy-client', name: 'Legacy Demo Client', email: 'legacy@assurecode.io'}
] AS row
MERGE (c:Client {id: row.id})
SET c.name = row.name,
    c.email = row.email;

// Projects, with the skills each one requires. Nothing ranks on these today —
// the matchmaker scores skill overlap, trust and delivery count — but they are
// what makes the graph a graph rather than a property table, and they are the
// join the POSTED_BY / REQUIRES traversal in a future graph-native matcher
// would walk.
UNWIND [
  {id: 'project-payments-api', title: 'Payments API hardening',    client: 'client-acme',
   skills: ['python', 'fastapi', 'postgresql', 'security']},
  {id: 'project-web3-escrow',  title: 'On-chain escrow contract',  client: 'client-globex',
   skills: ['solidity', 'ethereum', 'web3', 'typescript']},
  {id: 'project-dashboard',    title: 'Trust dashboard frontend',  client: 'legacy-client',
   skills: ['react', 'typescript', 'tailwind']}
] AS row
MERGE (p:Project {id: row.id})
SET p.title = row.title
WITH p, row
MATCH (c:Client {id: row.client})
MERGE (p)-[:POSTED_BY]->(c)
WITH p, row
UNWIND row.skills AS skillName
MERGE (s:Skill {name: skillName})
MERGE (p)-[:REQUIRES]->(s);

// Delivery history: which freelancer completed which project. Mirrors the
// `deliveries` counter above rather than replacing it — the counter is what the
// matchmaker reads, this is the auditable detail behind it.
UNWIND [
  {freelancer: 'freelancer-marcus', project: 'project-payments-api'},
  {freelancer: 'freelancer-chen',   project: 'project-web3-escrow'},
  {freelancer: 'freelancer-priya',  project: 'project-dashboard'}
] AS row
MATCH (f:Freelancer {id: row.freelancer})
MATCH (p:Project {id: row.project})
MERGE (f)-[:COMPLETED]->(p);
