# Constraint-first semantic group recommendations

This candidate extends the UI-first commit fb07b49. Its product contribution is applying local semantic retrieval, exact booking checks, explicit ranking objectives and stale-result rejection to a small shared booking flow. Regret minimization, sentence embeddings and group aggregation are established ideas. We do not claim a new foundation model, academic priority or superiority over competitors.

## Concrete requirements and evidence

| Requirement | Implementation and verification |
| --- | --- |
| Normal web app, no special device | Existing Flask/vanilla JavaScript interface; optional local CPU model on the server; no GPU or paid inference key |
| Default requested by the user | Minimize the worst modeled compromise; retain average-fit and neutral comparison controls |
| Every member's hard constraints | Existing authoritative matcher before embedding: exact cent shares, each budget/timezone/date/window, available capacity and cinema adjacency |
| No invented money, inventory or consent | Rank only trusted eligible IDs; quote/freeze remain authoritative; explicit user choice and independent buyer approval remain required |
| Private processing | Encode only confirmed descriptive tags; no peer text, embeddings or per-member scores in responses; no private-query cache or provider inference request |
| Prevent stale recommendations | No DB connection during inference; reread ordered roster, canonical preferences, active reservation and trusted offer/resource/time state afterward; reject changes with 409 |
| Bounded computation | 2-4 members; at most 14 canonical taste tags each, deduplicated; up to64 short encoded texts per batch; catalog encoder bound 20; reject token overflow |
| Latency evidence | Actual one-thread CPU timing, separate startup/indexing/warm inference/authenticated-route measurements; no invented user-supplied SLO |
| Accuracy evidence | Fixed synthetic labels, keyword/MiniLM/BGE comparison, raw rankings and failure counts; actual model execution separate from mocked contract tests |
| No false engagement objective | Optimize explicit choice among eligible plans; no emotional profiling, covert reinforcement schedule, endless feed or time-spent objective |

No numeric latency target, supported device class, multilingual requirement or paid-model budget was specified. The implementation therefore retains a no-key CPU path and publishes actual measurements rather than asserting universal requirements.

## Algorithm

1. Authenticate membership; reject frozen/active purchases and unsupported group sizes. Require every member's canonical structured preferences to be confirmed.
2. Compute the feasible set E with the existing deterministic matcher. An empty set remains empty; one option does not need model inference.
3. Take only confirmed positive descriptive soft-preference tags. Trim/case-fold/deduplicate each member's tags. Empty tags contribute no semantic vote; disclose coverage. Encode every distinct tag separately, then normalize their mean per member. This avoids repeated-tag weighting and silent truncation of a long joined preference.
4. Embed trusted title, description, domain and genre for each eligible offer. Cache only these catalog vectors in a bounded content-keyed cache.
5. For each participating member i and offer o, compute normalized cosine similarity s_i(o). Define opportunity loss r_i(o) = max_{x in E} s_i(x) - s_i(o).
6. Under the default compromise objective, sort each offer's member losses descending and minimize that vector lexicographically. Break ties by larger mean similarity and then trusted schedule/ID order. Twelve-decimal rounding stabilizes floating point comparisons; no exact real-number Pareto theorem is claimed.
7. Average-fit mode sorts mean cosine instead. Compare mode keeps schedule order while labeling the best candidate under each lens. Both aggregate orderings are returned as catalog IDs, without private numerical utilities.
8. If top semantic matches do not intersect across supplied tastes, explicitly label the result a tradeoff to discuss. This is not a group vote, agreement percentage, confidence or satisfaction prediction.
9. Reread and compare the whole relevant planning snapshot after inference, including failure paths. Reject changed state. A returned ranking reserves nothing and may require another request after group edits.

The default protects modeled opportunity loss, not maximum minimum absolute cosine and not human utility. These objectives can disagree. Current synthetic group cases show ties in worst labeled regret versus mean fit and lower mean labeled grade in some cases. The interface leaves the objective visible because this tradeoff is material.

An empty feasible set returns `no_matches`, with per-offer `blockedOptions` from the same matcher checks: public title/start, the caller's exact share and confirmed timezone, only their own failure categories, available capacity and a coarse peer-constraint blocker. No peer limits or identities are returned. The UI exposes explicit own-field review, verified Plan Rescue previews and category switching. It never loosens constraints to make the model run. Confirmation is still a separate participant action; it can resume comparison after a preview. Roster changes invalidate displayed shares and rescue drafts.

## Model and latency decisions

Production group ranking uses q8 BGE-small-en-v1.5 with CLS pooling, normalized vectors and the documented query instruction. MiniLM-L6-v2 remains the smaller baseline with mask-aware mean pooling. Both run through optional ONNX Runtime CPU, with one intra-op and one inter-op thread, serialized per encoder. No GPU/PyTorch or runtime network is needed.

The initial public download is explicit and SHA-256 verified against pinned revisions; assets remain ignored under instance/ai-models. BGE assets total 34,730,130 bytes; MiniLM 23,685,692 bytes, excluding Python packages. Asset acquisition duration was not instrumented. First use verifies hashes and loads the session; warm catalog vectors are reused, private query vectors are not. Initialization failure is sticky until the encoder/server is recreated after repair.

BGE was selected after examining this diagnostic comparison, including its correct instructed retrieval configuration. The comparison is therefore model-selection evidence, not untouched held-out acceptance. MTEB/model-card numbers are not this application's accuracy. See the exact current [results](../evaluation/RESULTS.md) and full raw report.

## Failure modes and exclusions

Generic embedding models can confuse negation and antonyms. The existing structured validator still controls supported hard constraints. A conservative English regex detects some exclusion/requirement-like taste phrases and asks for clarification instead of ranking. It is not a universal safety or natural-language exclusion parser. It intentionally declines some answerable requests. Allergies, accessibility, medical or safety requirements cannot be enforced as semantic tastes.

The semantic models currently always rank the bounded catalog for unrelated requests; all four unsupported evaluation queries received a result. No reliable OOD detection is claimed. The feature compares eligible catalog plans, not arbitrary requests. For unfamiliar intent, users should review alternatives rather than infer that the top model result is suitable. Missing assets/dependencies, invalid vectors and inference errors produce clearly labeled rules-based matches, without modifying confirmed preferences.

Server-local inference retains the established server-trusted private-preference boundary. Group ordering reveals some preference information, especially in two-person groups; this is not differential privacy or protection from a compromised server. No peer raw text or numerical per-member utility is returned. Aggregate `preferenceScore` from the legacy matcher is stripped from the new recommendation endpoint.

## Reproduce and review

From ppl-hxn, install requirements-ai.txt and prepare the BGE model, then restart with `python -m app serve`. The ordinary application remains usable with base requirements only. Prepare MiniLM as well to reproduce both models:

```powershell
..\.venv\Scripts\python.exe -m pip install -r requirements-ai.txt
..\.venv\Scripts\python.exe -B -m app.recommendations.assets prepare --model bge
..\.venv\Scripts\python.exe -B -m app.recommendations.assets prepare --model minilm
..\.venv\Scripts\python.exe -B -m evaluation.benchmark_recommendations --model all --repeats 5 --http
```

The benchmark reads only synthetic fixtures and local model assets. It does not load dotenv or the active database. The HTTP section uses a temporary SQLite app, real session/CSRF routes and an adapter that forbids all financial provider access. Every temporary table is compared before/after recommendation calls.

Run the full Python suite and all three Node contracts. Unit embeddings/providers are mocked; the benchmark's model execution is real. On the actual browser, test positive tastes from separate profiles, partial coverage, both lenses, stale state, failed asset loading and existing quote/consent controls. Browser rendering, real network latency/concurrent load, real users, payment completion and PostgreSQL runtime remain separate outstanding evidence.

Before submission, a team member should review relevance labels without seeing model predictions, and a separate user group should assess tradeoff usefulness. Expand the five-offer catalog before claiming general retrieval quality. Do not retune on the current evaluation cases and call them unseen.

## Research and prior art

- Sentence embeddings and retrieval: [Sentence-BERT](https://aclanthology.org/D19-1410/) and the [MiniLM model card](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2). These support retrieval design, not booking authority.
- Model configuration and instructions: [BGE-small-en-v1.5](https://huggingface.co/BAAI/bge-small-en-v1.5). Model choice must be evaluated on the actual task.
- Benchmark breadth: [MTEB](https://aclanthology.org/2023.eacl-main.148/) reports different models have different strengths; a broad average does not establish product accuracy.
- Negation limitations: [SemAntoNeg](https://aclanthology.org/2022.blackboxnlp-1.20/) motivates keeping unsupported requirements out of semantic enforcement.
- Group aggregation tradeoffs: [Fair Sequential Group Recommendations](https://homepages.tuni.fi/konstantinos.stefanidis/docs/sac20.pdf) discusses individual/group satisfaction and aggregation. Our single-choice proxy does not inherit sequential guarantees.
- Regret precedents: [UTPREF](https://www.cs.toronto.edu/~cebly/Papers/BraziunasBoutilier_acmec10.pdf) uses regret-based preference elicitation. Our cosine-based opportunity loss differs from its uncertainty/utility model and does not inherit its guarantees.
- CPU optimization: [Sentence Transformers efficiency](https://www.sbert.net/docs/sentence_transformer/usage/efficiency.html) and [ONNX quantization guidance](https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html) require hardware-specific quality/latency evaluation; quantization is not inherently faster.

The defensible hackathon contribution is a transparent, measured integration of these ideas with private, independently confirmed collaborative booking. It does not prove an exploitative engagement theory or superiority over industrial recommenders.

## DOM regression for the reported empty-tastes workflow

Budget/schedule confirmation alone does not create a semantic taste. The comparison now offers an actionable review and continues only after explicit confirmation. For a test with the real HTML/controllers, live temporary HTTP and the prepared local BGE model, install jsdom as an isolated test dependency and use two terminals:

```powershell
npm install --prefix ../.local-archive/ui-dom-validation --no-audit --no-fund jsdom@26.1.0
..\.venv\Scripts\python.exe -B tests/serve_ai_ui_fixture.py
```

In the second terminal, from ppl-hxn:

```powershell
node tests/test_ai_dom.cjs ../.local-archive/ui-dom-validation/node_modules/jsdom
```

The fixture uses port8021, temporarySQLite and blocked financial access. It does not load .env or mutate the active application database. The dependency is optional for development and is not required by the web app. The test does not claim rendered layout, native browser behavior or PayPal popup verification. The fast mocked frontend contract also covers the missing-taste/confirmation continuation for CI.
