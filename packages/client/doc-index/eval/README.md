# Documentation retrieval evaluation

`cases.json` is a committed set of build123d queries and expected section IDs.
The client Vitest suite requires every expected section to appear in the top three results from the committed index.

Embeddings stay out of this retrieval path unless this set grows real misses that lexical ranking and synonym tuning cannot fix.
New cases should be seeded from privacy-safe logged `search_docs` queries in persisted conversations and traces, not synthetic benchmark inflation.
Any future embeddings implementation must preserve the `search_docs` tool interface and demonstrate that it fixes those documented lexical misses.
