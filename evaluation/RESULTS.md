# Actual CPU recommendation results

Measured 2026-10-18T17:04:13.982777+00:00. This is a diagnostic comparison on five fictional catalog offers, not production acceptance or competitive superiority. Queries and labels are assistant-authored and **not human reviewed**. Model selection used these results.

This report predates the subsequent no-match diagnostic/UI repair. Its source hashes identify the measured snapshot; timings have not been remeasured after that repair. Model weights, ranking objectives and frozen evaluation labels are unchanged. Current behavioral checks are recorded separately in Aarya_changes.md.

| Method | Raw relevant Top1 | nDCG@3 | Warm native p50 | Warm native p95 | Unsupported abstentions |
| --- | --- | --- | --- | --- | --- |
| keyword_server_documents | 14/16 | 0.9142 | 0.058 ms | 0.084 ms | 3/4 |
| minilm | 13/16 | 0.9308 | 2.609 ms | 4.615 ms | 0/4 |
| bge | 15/16 | 0.9769 | 4.650 ms | 6.769 ms | 0/4 |
| bge_with_instruction | 16/16 | 1.0000 | 7.156 ms | 9.243 ms | 0/4 |

Each native distribution contains 150 actual forward/rank measurements: 30 queries x 5 passes. Query vectors were never cached. One complete query pass warmed each model first. Models run sequentially in one process; initial runtime-import costs are not controlled cold-start comparisons. Timing includes tokenization, actual inference, catalog-cache access and sorting; it excludes HTTP/database/browser work.

The deployed BGE + instruction group route measured **p50 26.439 ms / p95 37.277 ms** across 40 warm authenticated requests (eight synthetic groups of 2-4 members x 5 passes). The first route request took 257.985 ms with a fresh encoder but already imported runtime libraries. The test client includes auth/session, CSRF, temporarySQLite reads, actual model execution, state revalidation and JSON parsing. It excludes network transport, browser rendering, downloads and concurrent load.

The route used the user-selected **compromise** default. Every temporary database table was unchanged by recommendation requests; provider calls: 0. This benchmark never loads .env or the active application database.

## Material failures and tradeoffs

- Raw 16/16 BGE + instruction only covers the 16 answerable query labels. The production exclusion guard declines 5 of these 16, leaving 11/16 coverage and overall Top1 on answerable 11/16; the 11 answered cases were relevant in this diagnostic set. Do not call deployed-workflow accuracy 100%.
- All semantic variants answered all four unsupported queries. Keyword search abstained on three. There is no reliable OOD detection.
- MiniLM raw Top1 was worse than the lexical baseline here. The dataset is small; raw higher-ranked relevance does not establish superiority across real requests.
- In all eight group diagnostics, compromise tied average cosine on **worst labeled regret**: 0 better / 8 equal / 0 worse. BGE + instruction compromise reduced the mean labeled grade in 3 of 8 groups. It reduces its defined model-proxy objective; that did not establish better human group outcomes.
- For the constructed majority-space group, compromise picked drama with labels [0,0,3], while average picked sci-fi with [3,3,0]. Both have worst labeled regret 3. The interface labels disagreement and exposes the alternative objective.
- Exclusion detection is a conservative English heuristic, not a complete negation, allergy, accessibility or safety constraint parser. Some answerable negatives are deliberately declined.
- Model selection followed inspection of this comparison. The original split is frozen, but these results are diagnostic/model-selection evidence rather than an untouched acceptance test.
- There is no browser-WASM, rendered desktop/mobile, real-user satisfaction, network-load, live-payment or PostgreSQL runtime claim.

## Evidence and reproduction

Environment: Python 3.10.11; Windows-10-10.0.26200-SP0; CPU AMD64 Family 25 Model 80 Stepping 0, AuthenticAMD; 12 logical CPUs. ONNX CPU only, one intra-op and one inter-op thread. Exact package versions, artifact hashes/bytes, all raw synthetic rankings, per-query timing observations, group labels/tradeoffs, route timings and source hashes are in [cpu-comparison.json](results/cpu-comparison.json).

Query fixture SHA256: `caaadeb5d23632cb458b0f95e7b2771fe57d9fe257030f7fc1e479fe87390caf`.
Group fixture SHA256: `25cb4fb383e95050772cc2ec1f95a9493fd21ea7075b217b9a627f12e9ad8417`.
Raw report SHA256: `993ba9cafe2280122380a7e937c9da2d27dda090064326ca93d0bdc9e3e7a43a`.

```powershell
..\.venv\Scripts\python.exe -m pip install -r requirements-ai.txt
..\.venv\Scripts\python.exe -B -m app.recommendations.assets prepare --model minilm
..\.venv\Scripts\python.exe -B -m app.recommendations.assets prepare --model bge
..\.venv\Scripts\python.exe -B -m evaluation.benchmark_recommendations --model all --repeats 5 --http
```

Results depend on hardware. No numeric latency budget was supplied; these are observed results, not a universal SLO. A separate team member should independently review labels and gather consented user judgments before making a quality claim. See [protocol](README.md) and [design/research](../docs/RECOMMENDATION_DESIGN.md).
