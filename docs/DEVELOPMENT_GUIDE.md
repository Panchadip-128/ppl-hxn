# Slice 3 integration development guide

Start with the README, Aarya_changes.md, AGENTS.md and current Slice 3 review. Base is Panchadip's commit 41ec3d7. The user authorized repairing the original experience, then explicitly requested a guided UI redesign and key-free AI; historical Slice 1/2 proposals do not override the implemented code.

| Path | Responsibility |
| --- | --- |
| public/app.js | Navigation, create/join dialogs, sounds, architecture guide, lab entry and individual workshop CAPTURE checkout |
| public/room.js | Session-owned group room, private preference review, shared messages, progress, resource selection, quote, real AUTHORIZE SDK callbacks, explicit recovery and private ticket UI |
| public/merchant.js | Focused fictional merchant checkout before PayPal: direct or fixed-roster equal group payment; delegates all money state to the booking service |
| public/discovery.js, public/guide.js | Trusted catalog, keyword search, availability and four-step walkthrough |
| app/recommendations/ | Confirmed hard eligibility, local semantic comparison, recovery suggestions and optional CPU-only embeddings/assets |
| app/expenses/ocr.py, app/expenses/vision_assets.py | Unsaved receipt preview from explicit local Hugging Face weights or operator-owned Ollama Cloud configuration; no split or payment authority |
| evaluation/ | Frozen synthetic fixtures, benchmark runner, actual inference/route timing and honest reproducible metrics |
| public/demo.js | Independent in-memory fictional three-person model, readiness, sequential capture, pending compensation, local tickets and duplicate admission rejection |
| public/expenses.js, app/expenses/ | Owner-private readiness, contact, exact-share, Activity/History and recurring ledger; optional receipt preview; no payment authority |
| app/factory.py, app/*/routes.py | Flask factory, session/Origin/CSRF/ownership boundary, and thin feature Blueprints |
| app/shared/storage.py | SQLAlchemy Core schema, immutable migration sequence, trusted catalog and participant identities |
| app/groups/ | Membership/invites/privacy, room messages and coarse coordination |
| app/planning/ | Validated untrusted interpretation, no-key fallback, confirmation and authoritative selection checks |
| app/bookings/ | Quotes, reservations, consent, fenced payment operations, reconciliation and compensation |
| app/payments/ | Sandbox adapter and pure provider-evidence validation; no browser credentials or database authority |
| app/workshops/ | Individual workshop checkout coordinator, owner recovery and protected lesson entitlement |
| app/tickets/ | QR encoding of an existing owned ticket; no issuance or real admission authority |
| tests/ | Mock provider regressions, original UI/SDK contracts and independent local-demo model checks |

Keep price, currency, roster, merchant validation and inventory server-owned. Confirm every member's own preferences before matching. Only all required validated completed captures unlock private tickets. Persist request IDs and known provider IDs; reconcile unknown outcomes before retrying. Never hold a transaction over a provider call. Fence writes and keep failed refunds/voids visible. GET polling is read-only.

Migrations 4 and 5 extend revision 3 without rewriting original schemas. Revision 6 additively stores merchant-checkout mode, its trusted offer and fixed roster size; it does not alter historical purchases or provider evidence. Legacy purchase evidence is preserved and quarantined for merchant review. Never reset storage or substitute the prior application's database. Local SQLite is not hosting; managed PostgreSQL runtime/concurrency still needs verification.

Published revision 6 adds merchant checkout columns and revision 7 adds the informal ledger; revision 8 adds contact and receiving-handle snapshots without altering applied revisions. New shares with friend IDs must resolve to contacts owned by the same browser participant. Historical name-only shares stay readable. A contact or phone number is not group membership or payment authorization. The local teaching lab compares fictional budgets and words; the saved group uses verified constraints and server-local BGE.

The real room uses one participant per browser profile. Aliases cannot switch identity. Shared discussion is distinct from private preferences, and explicit sharing consent governs aliases/coarse progress. Cookie identities have no account recovery.

Every `/api/groups/<group_id>/...` route must preserve the same hidden-not-found response for an authenticated non-member, without group data, and must reject a missing participant session before route logic. The browser treats either a lost session or hidden group as stale private context and returns to `/` without rendering the raw error. This is the complete current mocked-session boundary, not production account authentication; hosting still needs account recovery/session rotation review.

Receipt-provider credentials are process-wide operator configuration. They may be read from the private startup environment but never accepted through a participant route, written into `.env` at runtime, returned in status, or stored with a split. Ollama Cloud uploads must remain an explicit UI disclosure and an unsaved preview until the owner reviews and saves fields.

The lab receives copied catalog DTOs and has no network, cookie, session or persistent-storage capability. Its reset affects only its model. Tests of the model do not establish provider settlement. The application ticket checker verifies only the current owner's confirmed reference and does not redeem supplier admission.

Read [AI and guided UX](AI_AND_GUIDED_UX.md) and [the current phased experience guide](GUIDED_EXPERIENCE_PHASES.md). New code belongs in its `app/<feature>/` package. Root Python modules were removed in the collaborator refactor: run `python -m app` and `python -m app.recommendations.assets` instead. `app/groups/journey.py` derives read-only caller guidance; `app/planning/catalog.py` derives public availability snapshots; `app/planning/demo_catalog.py` owns explicit development fixture creation. Run unittest, frontend and demo contracts; check dependencies after dependency edits; run the real CPU benchmark when model assets are available; then run git diff --check. Record actual browser, real Sandbox, Gemini and PostgreSQL evidence separately. No commit/push/deploy is implied by implementation authorization.

The subsequent AI candidate builds on fb07b49. Read [recommendation design](RECOMMENDATION_DESIGN.md) and [actual results](../evaluation/RESULTS.md). No model call belongs in polling, quotes, payment operations or a DB transaction. Preserve user-requested compromise default and explicit alternatives. Synthetic quality is not real-user satisfaction.
