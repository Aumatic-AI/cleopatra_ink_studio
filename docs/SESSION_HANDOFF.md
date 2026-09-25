# Continuing this project — read this, then start

This codebase was just copied into this folder to begin a new phase: rebuilding it as a multi-tenant, permission-based SaaS product for multiple studio clients.

Read in this order before doing anything else:

1. `AGENTS.md` (this repo) — full technical/architecture reference for the app as it exists today.
2. `docs/PROJECT_SCOPE.md` (this repo) — plain-language feature list, for context.
3. **Rebuild Reference** (artifact) — https://claude.ai/artifact/PKNqkaJTJrg3AKviZ6X6n6 — the actual plan: current app + architecture summary, why we're rebuilding, the two-axis permission model, the full database schema, how permissions are stored/enforced/logged, the feature-based folder structure proposal, and the phased migration order. This is the primary document — everything else is background.

Two earlier artifacts still exist but are secondary now:
- Studio Platform Blueprint — https://claude.ai/artifact/76iH7C1Z2rLDpFufD5eX6F — its permissions section is superseded by Rebuild Reference above; still useful for the storage-provider/cost research.
- Plan Pricing Worksheet — https://claude.ai/artifact/KHPgVSPp9sMHhAsQvFnAGY — internal pricing sheet, unrelated to the technical rebuild.

## Hard constraints already decided — don't re-litigate these

- Supabase only for storage/DB — no S3/R2/AWS.
- No payment gateway for now — billing is handled directly with clients.
- Catalog/folders and WhatsApp Marketing are wanted but deliberately deferred until the multi-tenant + permissions rebuild is done.
- Data model + enforcement come first; the Super Admin panel UI is built last, since it's CRUD over infrastructure that has to already exist.
- Feature-based folder structure (`src/features/<key>/`) is adopted — see Rebuild Reference, section 12 — done feature-by-feature during the migration, not as a separate rewrite.

## What I need from you before any code is written

Read everything above, then produce **one artifact**: a complete implementation plan, kept very minimal — bullets and short tables only, no paragraphs. It should cover what gets built, in what order, and the concrete first steps, referencing the folder-structure proposal. Same visual theme as the linked artifacts. This is what I'll use to explain the build to someone else, so it needs to stand on its own.
