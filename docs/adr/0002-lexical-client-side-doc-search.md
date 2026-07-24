# build123d doc search is lexical and client-side, not embedding RAG or server FTS

**Status**: deprecated - `search_docs` and the docs corpus were dropped in the M1 pi-coding-agent pivot (PR #34, 2026-07-23); reintroduction requires fresh benchmarked value per issue #33.

`search_docs` runs MiniSearch in the browser over a static index generated at build time from the pinned build123d docs.
We rejected embeddings because the querier is an LLM that speaks the corpus's jargon and iterates reformulated queries against ranked results, the corpus is a few MB of API-name-dense text (lexical search's best case), and every embedding option costs heavily: a ~25-80 MB in-browser model, or a per-query network call that couples the provider-agnostic agent loop to provider capabilities.
We rejected server-side SQLite/FTS because the docs are a build-time asset, not runtime state, and the server's "no CAD logic" boundary is worth more than marginal ranking quality.
Chunk quality, a curated synonym table, and a committed retrieval eval set carry recall instead; embeddings can be added behind the same tool interface if that eval set ever shows misses lexical tuning cannot fix.
