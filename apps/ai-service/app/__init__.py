"""AssureCode AI service package.

FastAPI application exposing the matchmaker, the embedding port, RAG ingest and
retrieval, LLM test generation, the OWASP static/LLM security scan, and the XAI
trust-score judge. See app/main.py for the route surface and app/deps.py for how
each port's adapter is selected.
"""
