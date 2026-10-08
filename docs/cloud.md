# Kledg Cloud

Kledg Cloud is the hosted Kledg at https://app.kledg.com: the same
open-source application, plus public sign-up, subscriptions through Stripe,
plan limits, read-only accounts, data export, account deletion and an
operator console. This repository (kledghq/kledg-cloud) is a fork of
kledghq/kledg; it is public too.

## Architecture

```
Vercel (app.kledg.com, region fra1) ──► Neon PostgreSQL (one database for all customers)
   │  Next.js app = Kledg + lib/cloud           tenant isolation: row level security (docs/rls.md)
   ├─► Stripe (Checkout, Customer Portal, Stripe Tax, webhooks)
   └─► Resend (transactional emails)
```

The hosted features live in their own files and plug into Kledg through
its extension points ([extension-points.md](extension-points.md)), so a
merge from Kledg only conflicts where those two files change:

| Kledg extension point | Kledg Cloud |
|---|---|
| `lib/instance/policy.ts` | thin delegation to `lib/cloud/policy.ts` (pure rules) and `lib/cloud/enforcement.ts` (rules reading the database, loaded lazily) |
| `components/instance/slots.tsx` | the banner, the sign-up prompt of the login page, the Facturation, Données et compte and Console pages in the settings navigation |

Everything else is new files: `lib/cloud/**`, `components/cloud/**`,
`app/api/{signup,billing,cloud}/**`, `app/api/cron/cloud-maintenance`,
`app/(auth)/inscription/**`, `app/(account)/settings/{billing,data,console}`, the
cloud block of `prisma/schema.prisma` and its migration
`prisma/migrations/20261021090000_cloud_billing`. The few shared files a
fork must touch are listed in the [repository README](../.github/README.md).

`KLEDG_CLOUD_MODE=true` turns all of it on. Without it this repository
behaves exactly like Kledg (Kledg's own test suite runs that way), and every
cloud route answers 404.

| Area | Code |
|---|---|
| Plans, prices, state machine | `lib/cloud/billing/plans.ts`, `stripe-prices.ts`, `state.ts` |
| Billing accounts and company ownership | `lib/cloud/billing/billing-account.service.ts` |
| Plan limits and read-only mode | `lib/cloud/enforcement.ts`, `lib/cloud/messages.ts` |
| Stripe Checkout, Customer Portal, invoices | `lib/cloud/billing/checkout.service.ts`, `app/api/billing/{checkout,portal,invoices}` |
| Stripe webhook | `lib/cloud/billing/stripe-webhook.service.ts`, `app/api/billing/webhook` |
| Cabinet extra companies | `lib/cloud/billing/cabinet-extra.service.ts` |
| Sign-up and terms | `lib/cloud/signup/signup.service.ts`, `lib/cloud/legal/*`, `app/api/signup`, `app/api/cloud/terms` |
| Data export | `lib/cloud/export/*`, `app/api/cloud/export` |
| Account deletion | `lib/cloud/account/account-deletion.service.ts`, `app/api/cloud/account/deletion` |
| Daily maintenance | `lib/cloud/maintenance.service.ts`, `app/api/cron/cloud-maintenance` (vercel.json) |
| Operator console | `lib/cloud/operator/operator.service.ts`, `app/api/cloud/operator/**`, `/settings/console` |

## Billing model

The paying entity is a **billing account** (`CloudBillingAccount`), one per
user who owns companies. It mirrors the user's Stripe customer and
subscription. A company belongs to the billing account of the user who
created it (`CloudCompanyOwnership`); that user becomes its administrator.
Members invited to a company never pay and never count. Companies created
by the operator (an instance administrator) belong to no account: they are
neither billed nor restricted.

| Plan | Companies | Monthly | Yearly |
|---|---|---|---|
| Essentiel | 1 | 15 € HT | 150 € HT |
| Holding | up to 5 | 39 € HT | 390 € HT |
| Cabinet | 25 included, then billed per company | 99 € HT (+3 € per extra company) | 990 € HT (+30 € per extra company) |
| Dedicated database (add-on) | | 20 € HT | 200 € HT |

The amounts are Stripe's, never the code's: prices are looked up at run time
by lookup key (`kledg_<plan>_monthly`, `kledg_<plan>_yearly`, one cached
`prices.list` call), and a subscription line is identified by the
`kledg_plan` metadata of its product (`essentiel`, `holding`, `cabinet`,
`cabinet_extra_company`, `dedicated_database`). To change a price, create a
new price in Stripe and move the lookup key to it (transfer_lookup_key):
existing subscriptions keep the price they were sold at (early adopters
keep it for life). Nothing in the code ever migrates a subscription.

Promotion codes: Checkout accepts them (`allow_promotion_codes`). The
coupons and codes are created in the Stripe dashboard only, never named in
this public repository. Stripe applies the discount before tax (Stripe Tax
computes VAT on the discounted amount) and shows it on the invoices; the
Facturation page shows it next to the plan and on each invoice, and the
operator console next to the account (`discountSummary`, for instance
"-80 %, à vie"). A discount never changes the plan or its limits.

Companies counted against a plan are the companies the account owns and
can reach, archived ones excepted. Essentiel and Holding refuse one company
more, in French, with a link to the plans. Cabinet has no hard limit: after
each creation, and every day, the quantity of the extra company line
follows the number of companies beyond 25 (with prorations). An existing
extra line keeps its price; a new one takes the current price.

The limit is checked again on every write, because a plan can shrink after
the companies were created (a switch to Essentiel in the Customer Portal, a
new subscription after a Cabinet trial or an ended contract) and two
creations at once both pass the creation check: the account's oldest
companies stay writable up to the limit, the others are read-only (French
409 with a link to the plans) until the owner moves to a larger plan or the
operator archives one. A Cabinet trial stops at the 25 included companies:
those beyond are billed, so they are created once the subscription is paid.

## Account lifecycle (CGV version 1.0)

The published CGV (https://www.kledg.com/fr/terms, version 1.0, in force
since 4 October 2026) set what the code does. The state of an account is
computed from the stored subscription and the time (`state.ts`), never by a
job.

| CGV commitment | Implementation |
|---|---|
| Free 30 day trial, no card, one per client, no automatic conversion (art. 5) | Checkout with `trial_period_days` 30, `payment_method_collection: if_required` and `trial_settings.end_behavior.missing_payment_method: cancel`: without a payment method added by the client, the trial ends instead of billing. `trialUsed` on the account; a client who already had a trial pays from the start |
| Prices excluding tax, VAT per the client's situation (art. 7) | prices `tax_behavior: exclusive`, products `tax_code txcd_10103001`, Checkout `automatic_tax` and tax id collection |
| Read-only 14 days after a failed payment, full access once paid (art. 9) | `past_due` and `unpaid`: grace from the first failed payment (`paymentFailedAt`), then read-only; cleared when Stripe reports the subscription active |
| Annual renewal reminder by email at least a month ahead (art. 12) | daily maintenance, 35 days ahead (`KLEDG_CLOUD_RENEWAL_NOTICE_DAYS`, never below 31), once per period (`renewalReminderFor`) |
| Cancellation at any time, effective at period end (art. 12) | Customer Portal (default configuration) |
| Export at any time, free: FEC per fiscal year, structured data (art. 13) | Données et compte page: one ZIP per company; also in read-only and during the retrieval period |
| After the contract ends: 30 days of read-only retrieval, an email with the end date, then deletion within 30 days (art. 14) | `canceled` and `incomplete_expired` (trial ended without a card included): read-only at once. The maintenance sends the notice with the retrieval end date and schedules the deletion for that date (at least 7 days after a late notice); subscribing again before it cancels the deletion |
| Kledg keeps only what the law requires of it (art. 14) | the account, its companies and their books are deleted; Kledg's own invoices stay in Stripe |
| Account deletion on request, cancellable for 30 days, read-only meanwhile (art. 15) | Données et compte page: address, password and, when books exist, an acknowledgement that they will be deleted and must be kept 10 years by the company (Code de commerce art. L123-22); the subscription stops renewing; the maintenance deletes on the date |
| Accepted CGV version and date stored at sign-up | `CloudTermsAcceptance` (`cgv`, `1.0`, date); a new version is accepted again from the banner (`lib/cloud/legal/terms.ts`) |

Read-only never hides data: every write of a company route or an MCP tool
answers 409 with the reason and a link (`companyWriteRefusal`), every read,
report, FEC and export keeps working, for every member of the company.

A read-only company also stops receiving bank operations (Kledg issue #15,
`lib/banking/sync-pause.ts`, which reads the same `companyWriteRefusal`):
the daily bank sync skips it and manual syncs do not call the bank; the
Comptes bancaires page says why. Its last sync date stays, so once the
account is writable again (payment, new subscription, reconciliation) the
next sync catches up the paused period.

Company administrators invite their members and accountant themselves by
email (Kledg issue #13, `lib/rbac/company-invitations.service.ts`). The
hosted service keeps Kledg's defaults: invitations allowed, and an invitee
without an account creates it from the link (the link confirms the address;
the CGV are then accepted from the banner). Members never count against a
plan, so no plan limits invitations; a read-only company neither sends nor
accepts them.

## Sign-up and security

- Public sign-up at `/inscription` (Kledg keeps `/signup` as a permanent redirect
  to its account creation page): email, password, name, CGV acceptance. The
  answer is the same and immediate whether the address has an account or
  not; the work runs after the response. A new address gets a confirmation
  link; an existing one an email saying an account exists. Better Auth's own
  sign-up endpoint stays disabled.
- Sign-in requires a confirmed address (`REQUIRE_EMAIL_VERIFICATION`);
  unconfirmed accounts are deleted after 7 days.
- Rate limits per client IP (an IPv6 address counts for its /64), per
  hashed mailbox (the address without its "+tag", Gmail without dots) and
  for the whole instance (300 sign-ups an hour, each sends an email; an
  error is logged when the cap is reached), KLEDG-R3-CLOUD-07; a honeypot
  field; sign-up stays closed until the operator account exists.
- The webhook checks the Stripe signature on the raw body (5 minute
  tolerance), reads the subscription again from Stripe instead of trusting
  the event, and records the event id in the same transaction as its effect.
  Events about one account are applied one at a time: the transaction takes
  the account's advisory lock before reading Stripe, so a delivery that read
  an older state can never commit after a newer one (KLEDG-R3-CLOUD-02).
- Missed webhooks (KLEDG-CLOUD-005): a trial, or a period that does not
  renew, still mirrored as running two days after its end is read-only
  (`billing_outdated`), and the daily maintenance reads again from Stripe
  every account whose trial or period ended (`resyncStaleBillingAccounts`).
  A period that renews gets seven days (`RENEWAL_UNCONFIRMED_MS`): read-only
  (`billing_outdated`) only when nothing was read from Stripe since its end,
  neither a webhook nor any of the daily reconciliations, until the next
  successful reconciliation or payment brings the new period. A paying
  customer whose webhook is merely late is never blocked: the daily
  maintenance reads the subscription again from the first hour past the
  end of the period.
- No secret in the repository: keys come from the environment, prices from
  Stripe by lookup key.
- Row level security (`KLEDG_RLS=enforce`): the cloud tables have their own
  policies (billing account: its owner, and the members of the companies it
  owns for reading; ownership rows: read for reachable companies, written by
  unrestricted contexts only; terms acceptances: their user; Stripe event
  ids: system only). A trigger keeps the billing state of an account (plan,
  status, trial, periods, Stripe subscription, end of contract) to Stripe's
  webhook, the maintenance and the operator: the owner may only set its
  Stripe customer once, request a deletion or cancel its own request
  (migration `20261123110000_cloud_billing_guards`, KLEDG-R3-CLOUD-04). The
  creation hook records the ownership of a new company in a `system`
  context. The Stripe webhook, the
  maintenance and the rank of a company among its owner's companies (plan
  limit on writes, ids only) run in a `system` context
  (`instance-extension`); everything else runs in the request's user context. A company created by a user runs
  as `system` (`company-creation`) until its membership exists.
- Company identifiers (KLEDG-R3-CLOUD-01): a SIREN and an establishment
  SIRET are unique within the companies of one billing account (the
  operator's companies among themselves), not across the shared database
  (`companyIdentifierScope`, `lib/cloud/enforcement.ts`; migration
  `20261123100000_cloud_identifier_scope` drops the instance-wide unique
  indexes). A trial cannot take the SIREN of a business that is not a
  customer yet, and no answer tells whether another customer uses a SIREN.
  Slugs stay unique across the instance (URLs) and always get a random
  suffix of six letters and digits, so neither a creation nor a slug change
  reveals another customer's company names.

## Environment variables

Kledg's own variables ([configuration.md](configuration.md)), plus
(`.env.cloud.example`):

| Variable | Value |
|---|---|
| `KLEDG_CLOUD_MODE` | `true` |
| `KLEDG_RLS` | `enforce`, with `KLEDG_DATABASE_URL` (application role) and `DATABASE_MIGRATION_URL` (owner), see [rls.md](rls.md). Required: in cloud mode the server refuses to start and to open the database without it (`requiresRowLevelSecurity`, KLEDG-CLOUD-007) |
| `STRIPE_SECRET_KEY` | secret or restricted key of the Stripe account |
| `STRIPE_WEBHOOK_SECRET` | signing secret of the webhook endpoint |
| `BETTER_AUTH_URL` | `https://app.kledg.com` |
| `RESEND_API_KEY`, `EMAIL_FROM` | transactional emails (confirmation links, reminders, notices) |
| `CRON_SECRET` | the daily crons |
| `ADMIN_EMAIL`, `SETUP_TOKEN` | the operator account, created at `/setup` before opening |
| `KLEDG_CLOUD_TRIAL_DAYS`, `..._GRACE_DAYS`, `..._RETRIEVAL_DAYS`, `..._DELETION_DAYS`, `..._RENEWAL_NOTICE_DAYS`, `..._UNVERIFIED_DAYS` | optional; the defaults are the CGV's |

## Stripe setup

The code is written against API version `2026-09-30.endive` (stripe-node 23),
pinned in `lib/cloud/billing/stripe.ts`.

1. **Products and prices**: one product per `kledg_plan` value, metadata
   `kledg_plan`, tax code `txcd_10103001`; recurring EUR prices, `tax_behavior
   exclusive`, lookup keys `kledg_essentiel_monthly` ... `kledg_dedicated_database_yearly`
   (the ten keys of `ALL_LOOKUP_KEYS`).
2. **Stripe Tax**: registration for France (and the countries where
   thresholds are reached), origin address of the company.
3. **Customer Portal**: the default configuration: plan switches between
   Essentiel, Holding and Cabinet with prorations, cancellation at period
   end, invoice history, payment method and tax id updates, return URL
   `https://app.kledg.com/settings/billing`.
4. **Webhook endpoint** `https://app.kledg.com/api/billing/webhook`, events
   `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`,
   `invoice.paid`, `invoice.payment_failed`; its signing secret goes to
   `STRIPE_WEBHOOK_SECRET`.
5. **Billing settings**: retries of failed payments (Smart Retries) ending
   in `unpaid` or a cancellation; the customer emails Stripe sends (receipts,
   failed payments). The annual renewal reminder is sent by Kledg Cloud.
6. Test the whole flow in a sandbox (test keys) before switching to live keys.

## Data, GDPR and retention

- For accounting data, the client is the controller and Kledg Cloud the
  processor (RGPD art. 28, DPA at https://www.kledg.com/fr/dpa). For account
  and billing data, Kledg Cloud is the controller (privacy policy).
- Portability (art. 20): the full export, per company, at any time.
- Erasure (art. 17): account deletion as above; the books are deleted with
  the account once the client acknowledged its own retention duty (art.
  17.3.b does not oblige the processor to keep them).
- Kledg's own invoices are issued and kept by Stripe (10 years, Code de
  commerce art. L123-22).
- The audit log keeps exports, deletions and trial extensions (ids only).

## Dedicated database (paid option, design)

The add-on product exists in Stripe (`dedicated_database`) and is mirrored
on the billing account (`dedicatedDatabase`), but nothing provisions it yet.
Intended design:

1. One Neon project (or branch) per subscribing account, in the same
   region, created by an operator script; its URL encrypted at rest
   (`lib/crypto`) in a cloud table keyed by billing account.
2. A data move per company: export from the shared database, import into
   the dedicated one under the company purge flags, then the company row in
   the shared database is replaced by a routing stub.
3. Request routing: the company resolver selects the Prisma client of the
   company's database; requests touching several databases are refused.
4. Migrations: `prisma migrate deploy` run against every dedicated database
   in the deployment pipeline before the new version goes live.
5. Backups, deletion and the retention commitments apply per database.

Until then, the add-on should not be sold in the Customer Portal.

## Operator console

`/settings/console`, instance administrators only: billing accounts with
owner, plan and interval, state, trial end, companies and billed extra
companies, scheduled deletion. One action: extend a running trial by 14
days (on the Stripe subscription, audited). Everything else is done in the
Stripe dashboard.

## Go-live checklist

1. Neon project in `aws-eu-central-1` (or the Vercel region's), owner and
   application roles: `pnpm db:migrate` then `pnpm db:rls-role` with the
   owner's URL.
2. Vercel project for `app.kledg.com` (region fra1), domain and TLS, all
   variables above, `KLEDG_RLS=enforce`, `KLEDG_CLOUD_MODE=true`.
3. Create the operator account at `/setup` (with `ADMIN_EMAIL` and
   `SETUP_TOKEN`) before announcing the address: sign-up stays closed until
   then.
4. Resend: verified sending domain, `EMAIL_FROM`.
5. Stripe in live mode: the setup steps above, live keys, webhook secret;
   one real subscription and refund to check the flow, invoices and VAT.
6. Legal links: the sign-up form, the banner and the emails point to the published
   CGV, privacy policy and DPA on www.kledg.com.
7. Vercel crons enabled (`vercel.json`: bank sync and cloud maintenance)
   with `CRON_SECRET`.
8. Monitoring: Vercel logs and alerts on webhook 4xx/5xx and on the
   maintenance report.
9. Run the test suite with `KLEDG_RLS=off` and `enforce`, `pnpm build`,
   `node scripts/check-migrations.mjs`.

What the operator provides: the Stripe account and its keys, the Resend
domain, the Neon and Vercel accounts, the legal texts reviewed by a lawyer
(CGU and CGV, DPA as processor under RGPD art. 28, privacy policy, mentions
légales), and the support address shown in the emails.

## Known limitations

- Customers cannot archive or delete a company to free a slot of their
  plan; the operator does it.
- One trial per account, not per person: a new address gets a new trial.
