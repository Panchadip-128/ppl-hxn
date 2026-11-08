# GroupPay: guided collaborative booking UI

## Current `dev/aarya` review: 8 November 2026

Start at **http://localhost:8000**. The home page offers three clear paths: create or join a saved group booking, rehearse the fictional journey in **Solo demo lab**, or open **Splits** to track an expense you already paid. Cinema/Outdoor are visitor-chosen filters. Group recommendations run only after each member confirms budget, timing and optional likes. The organizer picks a plan and places, reviews exact server shares and holds them. Each member approves only their own PayPal Sandbox order; all required verified completed captures unlock tickets.

The lab compares three fictional friends' confirmed budgets and descriptive words, shows eligible plans, lets the visitor select one, then simulates each authorization and capture. Its keyword preview teaches the flow; the saved room uses server-local BGE for semantic comparison. **Solo workshops** are a separate one-buyer PayPal checkout and sample lesson.

Splits is an owner-private manual ledger with a first-run readiness path: add your host name, add at least one person, then scan or enter a bill and review every exact share. People can be searched and reused; each saved person has a direct **Split with…** action. A successful save opens Activity for reminders and manual settlement, while History retains every record. Subscription reminders preserve host, amount, billing day and participants, then preselect matching saved people when logging the next month. Receipt scanning can use server-local Qwen or operator-configured Ollama Cloud. UPI IDs and PayPal emails are unverified receiving handles only; this tab does not schedule, authorize or confirm payment. A saved contact does not authenticate a group member; invite acceptance in that member's own browser profile does.

Revision 8 adds contact and receiving-handle snapshots after the published revision 7 without rewriting it. Existing name-only splits remain readable. No buyer login credentials are stored. PayPal Sandbox configuration, live buyer approvals, rendered browser acceptance and managed PostgreSQL remain verification gates. Receipt scanning falls back to manual entry when its selected server provider is unavailable.

Built on Panchadip-128's `slice/3-collaborative-booking-and-equal-payments` at `41ec3d7`. The latest user-authorized redesign gives his collaborative booking a light workspace, illustrated discovery, guided steps, private planning, shared conversation, adjacent-place selection and individual approval. Workshops and the isolated solo lab remain. This is a review candidate for `Aruisop/PayPal-Hackathon` on `dev/aarya`, not an accepted release. It includes earlier Slice 3/backend integration repairs; the complete change is not frontend-only. The group recommender has real server-local CPU inference and synthetic diagnostic evidence. Rendered-browser acceptance, real payments and human-rated group quality remain unverified.

Read [Aarya_changes.md](Aarya_changes.md) for changes and evidence, the [adversarial feature audit](docs/FEATURE_AUDIT.md) for current findings and release gates, [the showcase guide](HACKATHON_SHOWCASE.md) for a walkthrough, and [the original product proposal](docs/COLLABORATIVE_BOOKING_PRD.md) for context.

**Release candidate:** this branch combines guided group planning, merchant group checkout, expense splitting, and optional local receipt vision. It remains a review candidate; mocked or temporary-environment evidence does not establish browser, live-payment, or hosted-database acceptance.

## Run on this workspace

From this repository root, use the existing virtual environment:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -B -m app migrate
.\.venv\Scripts\python.exe -B -m app serve
```

Open **http://localhost:8000** and use **Ctrl+F5** after an update. Preserve the existing `.env`. For a fresh clone, create a virtual environment, copy `.env.example` only when `.env` does not exist, and install the pinned requirements.

For planning, each person creates/joins the same group using a separate browser profile, enters and explicitly confirms their own fields in **My preferences**, then moves to **Compare our plans**. Returning to preferences does not save edits. Once everyone confirms, compare verified options, then let the organizer review places and exact shares. The brief identifies whether rules or actual AI supplied the comparison.

If the catalog has no upcoming dates, it is not an AI error. A development operator can explicitly append new fictional dates with `..\.venv\Scripts\python.exe -B -m app prepare-demo`. It requires the existing revision 5 schema, is development-only, and preserves original records and all financial state. This write has **not** been run against the active database; user approval is pending. It never runs automatically on a page visit or server restart.

Configure `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` from the intended Business Sandbox app. Buyer credentials belong only in PayPal's approval window. The fictional suppliers use that app's one Sandbox merchant; `PAYPAL_MERCHANT_ID`, if set, validates the expected seller rather than routing money.

**Gemini is optional.** Without `GEMINI_API_KEY`, the local helper extracts editable preferences and matches the trusted catalog. With a key, `GEMINI_MODEL` defaults to `gemini-2.5-flash`; model failure is disclosed as local fallback. Neither mode can confirm preferences, authorize payments or set prices for the user.

## New: verified group recommendations with a local model

No Gemini key or hosted inference service is needed. The app uses a small CPU embedding model, prepared once on the server:

```powershell
..\.venv\Scripts\python.exe -m pip install -r requirements-ai.txt
..\.venv\Scripts\python.exe -B -m app.recommendations.assets prepare --model bge
..\.venv\Scripts\python.exe -B -m app serve
```

On this workspace the optional packages and checked model assets are already prepared; restart the server after upgrading code or repairing assets. Do not change your existing `.env` or reset a database. A missing model leaves verified rules-based matching available.

In a saved group, every member reviews and confirms their budget/time fields plus optional **What would make it your kind of experience?** likes. Click **Compare AI suggestions**. If no tastes are confirmed, use **Add or review my likes**, enter a short description, then **Confirm preferences & compare AI**; that confirmation continues the comparison automatically. The default, explicitly requested by the user, minimizes the worst modeled compromise; the selector also offers average fit and a neutral comparison in schedule order. Disagreement is labeled as a tradeoff to discuss. Rankings never select, reserve or pay automatically.

**No eligible plan to compare yet** means the hard constraints filtered out this category before AI runs. The cards show each plan, your exact share, its time in your confirmed timezone, your own blockers and whether another member also needs to review. Use **Review my budget & availability**, **Find changes I can make**, or explicitly check the other category. A tradeoff preview is unsaved; your confirmation continues the comparison. A peer-only blocker requires that member's decision. For example, a two-person $100 excursion costs $50 each; a confirmed $20 ceiling cannot cover it. These prices are USD. No API key or retry can change that constraint.

The server verifies all hard constraints before embedding confirmed taste tags. It computes each member's opportunity loss relative to their own best eligible option, then minimizes the descending loss vector lexicographically. It rereads roster, preferences and inventory after inference and rejects stale responses. Model requests neither download assets nor call an inference provider; private query vectors are not cached or returned.

When BGE actually runs, the room reports the number of eligible catalog documents and confirmed taste texts encoded, inference time, pinned model revision, and whether the semantic order differed from the rules/schedule order. `inferenceExecuted` is false for every rules-only, one-option, missing-taste or unavailable-model response. These are causal execution facts, not accuracy, confidence or satisfaction scores.

Real CPU tests compare keyword, MiniLM and BGE, with raw synthetic cases/results in [evaluation](evaluation/RESULTS.md). BGE with its documented instruction ranked a relevant item first in 16/16 answerable cases, but these labels are assistant-authored, not human-reviewed, and used in model selection. The exclusion guard declines five answerable cases; semantic retrieval did not reject unrelated requests. Group regret did not improve worst labeled regret over average fit in eight diagnostic groups. Do not describe these results as production accuracy or superiority over competitors.

See [the algorithm and requirements](docs/RECOMMENDATION_DESIGN.md) and [the walkthrough](HACKATHON_SHOWCASE.md). This algorithm combines established ideas for this application; it is not claimed as a new mathematical fairness result.

## Optional receipt scanning: server-local Qwen or operator-owned Ollama Cloud

The informal expense split form can suggest receipt fields with [Qwen3-VL-2B-Instruct](https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct), pinned to a specific model revision. Prepare its optional Python packages and weights explicitly on the app server:

```powershell
..\.venv\Scripts\python.exe -m pip install -r requirements-vision.txt
..\.venv\Scripts\python.exe -B -m app.expenses.vision_assets prepare
..\.venv\Scripts\python.exe -B -m app serve
```

The weights live under ignored `instance/receipt-vision/` and are several gigabytes. Inference uses a CUDA GPU when PyTorch detects one, otherwise CPU with substantially more memory and latency. The scan endpoint does not download anything during a request. `GET /api/expenses/scan-status` reports dependency and asset readiness; when unavailable, enter a split manually. A selected photo is sent to this app server for inference, not to a hosted model service. The response is an unsaved editable preview; review the merchant, date, currency, category and amount before saving. Receipt extraction has no authority over group quotes, inventory, tickets or payments. Receipt accuracy and real-model latency have not yet been measured on this workspace.

For a hosted deployment where installing a multi-gigabyte vision model is impractical, the application operator can instead configure direct [Ollama Cloud](https://docs.ollama.com/cloud) inference in the server's private `.env`:

```dotenv
RECEIPT_VISION_PROVIDER=ollama_cloud
OLLAMA_API_KEY=replace-with-an-operator-owned-key
OLLAMA_VISION_MODEL=replace-with-a-vision-capable-model
```

Restart the application after changing provider configuration. Direct Ollama Cloud access does not require Ollama on an end user's machine. The key stays server-side and is never returned by config/status routes. The browser sends the receipt only to this authenticated application; the server validates its declared type and file signature, then sends that image to Ollama for the single inference request. The UI discloses this cloud transfer. Do not add a browser field that writes user keys into `.env`: `.env` is process-wide configuration, while the current participant cookie is not a production account or secret vault. A future per-user bring-your-own-key design requires real account authentication, encrypted secret storage, rotation and deletion—not plaintext environment-file mutation.

## One group-planning AI feature, with a clear job

Discover uses straightforward keyword search over experience titles, descriptions and genres. It does not claim to understand a vibe or rank a group. The group room has the AI feature: after every member confirms, the server applies exact budget, date, time and capacity rules, then uses its prepared local BGE model to compare eligible catalog choices against members' confirmed positive likes. No Gemini key, browser model download or hosted inference call is required. If there is no eligible upcoming catalog option, ranking is disabled and the room says what needs to change; the model cannot invent activities or bypass a budget.

**Plan Rescue** is a verified what-if calculation, not another AI. It previews only changes to the current participant's budget or availability that could unlock an actual catalog option while every other confirmed member stays unchanged. Preview is unsaved; review the fields and explicitly confirm to save. This is available only when the catalog has future bookable sessions for the group.

## Try it alone first

Click **Walk me through** for the four-step explanation, then open **Solo demo lab**. Cinema, a fixed-price excursion and Chaos use isolated browser memory. Switch fictional Alice/Bob/Charlie or use the three-person teaching view. Confirm each budget, reserve local places, approve simulated shares and step through captures. The $100 example splits into $33.34 + $33.33 + $33.33.

Chaos leaves refunds and voids pending until each simulated recovery completes. Readiness uses an example amount you enter. Its local admission ledger rejects invalid and reused `SIM-` references. No lab action contacts the backend, changes session identity, reserves saved inventory or produces an application ticket. Reset/reload clears only the lab.

## Try the saved group workflow

1. Create a group and copy its invite. Each real member joins in a different browser profile or device; ordinary tabs share one identity.
2. Save your display name and privacy choice. Enter preferences in your private concierge, review/edit the actual extracted fields, then confirm. Blank fields mean flexible. All times are shown in the browser's timezone.
3. Use the separate saved group conversation to discuss a plan. Each member confirms independently. Readiness counts and next actions update every five seconds; private budgets and payment references stay private.
4. Open **Compare our plans** and use the single **Compare AI suggestions** action. The server checks confirmed limits first, then uses its prepared local BGE model when eligible choices and confirmed likes exist. If ranking cannot run, verified rules-based matches remain labeled honestly. The organizer reviews adjacent seats or excursion places, requests an exact server quote and holds the selection for 15 minutes.
5. Each member reviews their exact share and terms, checks consent, and approves their own Sandbox order in the actual PayPal window. Server authorization runs only after buyer approval. A hold does not issue a ticket.
6. After every authorization is verified, the organizer completes capture. Captures are sequential. Only validated completed captures for the whole frozen roster unlock each member's own fictional ticket and real QR encoding.
7. If an outcome is unknown or pending, recheck the saved approval or reconcile group recovery. Do not reset storage or create a replacement payment. Pending refunds/voids remain unresolved until confirmed.

The ticket checker compares only the current owner's confirmed ticket. It does not redeem real admission, validate a supplier signature or integrate with Apple/Google Wallet. Cookie identity has no account recovery; clearing it loses access to that identity.

## Merchant checkout demo: Pay together with PayPal

On a fictional catalog card, **Pay together with PayPal** opens a focused merchant checkout before any PayPal approval popup. A buyer can either pay alone or create a fixed 2–4 payer checkout, share its invite, then hold the merchant order after the intended roster joins. The server owns the catalog item, total, currency, payer count, selected inventory and exact-cent equal split. Each payer independently accepts and authorizes only their own amount through the ordinary PayPal popup. The order confirmation appears only after every capture is validated as completed.

This is an in-app merchant demonstration, not a public merchant SDK, hosted PayPal-window customization, webhook integration, or multi-merchant marketplace. The control is merchant UI placed before PayPal's controlled approval window. Unequal splits and AI allocation are not implemented: a future assistant may only propose an allocation that the server validates against the frozen total and each affected payer explicitly accepts.

See [the group-payment platform direction](docs/GROUP_PAYMENT_PLATFORM_DIRECTION.md) for the delivered merchant-demo boundary and the requirements for a future merchant integration.

## Storage and recovery

SQLite is local development storage. `.env` selects the active database; the restored original used a separate revision 3 file. Revisions 4 and 5 add durable payment operations/workflows and shared room messages; revision 6 additively records merchant-checkout mode, its trusted offer and fixed intended payer count. Applied revisions are never rewritten. Existing legacy purchases, IDs and tickets are preserved but require merchant review because their original synthetic or unvalidated state cannot establish payment.

The previous revision 5 application database remains separate. Do not mix or downgrade these databases. Hosted operation requires managed PostgreSQL, HTTPS and secure cookies; PostgreSQL runtime/concurrency is still unverified.

An authorized operator can run a bounded recovery pass:

```powershell
..\.venv\Scripts\python.exe -B -m app recover
```

This can query and mutate saved Sandbox recovery operations. GET polling performs no provider mutation. Repeated automatic progress needs an explicitly arranged operator schedule; there is no hidden worker.

## Validate

```powershell
..\.venv\Scripts\python.exe -B -m unittest discover -s tests
..\.venv\Scripts\python.exe -m pip check
node tests/test_frontend_contract.cjs
node tests/test_demo_contract.cjs
node tests/test_expenses_contract.cjs
git diff --check
```

The full 245-test Python suite passes with mocked payment providers and model unit doubles. Frontend contracts exercise search, walkthrough, saved room callbacks, an unsaved rescue preview, confirmation and payment callbacks using mocked DOM/HTTP/SDK. The Splits contract covers first-run readiness, task routing, exact-cent allocation and incomplete-draft states; the isolated demo has 14 contract checks. Separately, the native CPU smoke test and jsdom/live temporary API flow use real BGE weights. The DOM flow verifies taste onboarding, no-match diagnostics, explicit tradeoff confirmation, peer limits and roster invalidation; it does not render a browser. The browser model path was removed because it duplicated the group recommender and had no real-browser execution evidence. The integrated UX still needs rendered desktop/mobile and genuine multi-buyer Sandbox checkout acceptance.

The UI snapshot fb07b49 was published to [Aruisop/PayPal-Hackathon, dev/aarya](https://github.com/Aruisop/PayPal-Hackathon/tree/dev/aarya). This checkpoint extends it with the user-authorized local AI recommendation and no-match usability changes; see Aarya_changes.md for scope and evidence. Publication does not imply acceptance, merge or deployment. License selection and submission requirements still need team review.
