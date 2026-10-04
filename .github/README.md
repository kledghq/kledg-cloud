# Kledg Cloud

The hosted version of [Kledg](https://github.com/kledghq/kledg), the
open-source accounting application for French companies, served at
https://app.kledg.com.

This repository is a fork of kledghq/kledg. It adds public sign-up,
subscriptions through Stripe, plan limits, read-only accounts, data export,
account deletion and an operator console, without changing how Kledg
works: the hosted features live in their own files and plug into Kledg's
extension points. Without `KLEDG_CLOUD_MODE=true` it behaves exactly like
Kledg.

- How it works, the billing model, the Stripe setup, the environment and the
  go-live checklist: [docs/cloud.md](../docs/cloud.md)
- Kledg's documentation: [docs/README.md](../docs/README.md)
- Extension points: [docs/extension-points.md](../docs/extension-points.md)
- Row level security: [docs/rls.md](../docs/rls.md)

## Layout

| Path | Content |
|---|---|
| `lib/cloud/` | billing, plans and state machine, Stripe, sign-up, terms, export, deletion, maintenance, operator console |
| `components/cloud/` | banner, sign-up form, billing, data and console pages |
| `app/api/{signup,billing,cloud}/`, `app/api/cron/cloud-maintenance/` | the hosted service's routes |
| `app/(auth)/inscription/`, `app/(account)/settings/{billing,data,console}/` | its pages |
| `lib/instance/policy.ts`, `components/instance/slots.tsx` | Kledg's extension points, delegating to the above |

Shared files a merge from Kledg may touch: the two extension point files,
the cloud block at the top of `prisma/schema.prisma`, `package.json` and
`pnpm-lock.yaml` (the Stripe SDK), `vercel.json` (the maintenance cron),
`docs/rls.md` and `lib/rls/__tests__/system-context-usage.test.ts` (the
cloud's system contexts). Changes to Kledg itself are made upstream, in
commits titled "Core: ...".

## Development

```bash
pnpm install
cp .env.example .env.local   # Kledg's variables
cat .env.cloud.example >> .env.local   # the hosted service's (placeholders)
pnpm db:migrate
pnpm dev
```

Tests never call Stripe: they run the official SDK on a mocked fetch with
Stripe-shaped fixtures (`lib/cloud/__tests__/helpers/stripe-fixtures.ts`).

```bash
pnpm typecheck && pnpm lint
KLEDG_REQUIRE_TEST_DB=1 KLEDG_TEST_DB_PREFIX=kledg_cloud \
KLEDG_TEST_DATABASE_URL=postgresql://kledg:kledg@localhost:55432/kledg_test pnpm test:run
# and again with KLEDG_RLS=enforce
pnpm build
node scripts/check-migrations.mjs
```

## License

AGPL-3.0-only, like Kledg ([LICENSE](../LICENSE)).
