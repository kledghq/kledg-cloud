-- Kledg Cloud only (kledghq/kledg-cloud, never in Kledg): billing accounts,
-- company ownership, Stripe event idempotency and terms
-- acceptances. Additive, no Kledg table is changed. See docs/cloud.md.

-- CreateTable
CREATE TABLE "cloud_billing_accounts" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "stripeCustomerId" TEXT,
    "stripeSubscriptionId" TEXT,
    "subscriptionStatus" TEXT,
    "planId" TEXT,
    "priceId" TEXT,
    "billingInterval" TEXT,
    "trialEnd" TIMESTAMP(3),
    "trialUsed" BOOLEAN NOT NULL DEFAULT false,
    "currentPeriodEnd" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "subscriptionEndedAt" TIMESTAMP(3),
    "paymentFailedAt" TIMESTAMP(3),
    "extraCompanies" INTEGER NOT NULL DEFAULT 0,
    "dedicatedDatabase" BOOLEAN NOT NULL DEFAULT false,
    "stripeSyncedAt" TIMESTAMP(3),
    "renewalReminderFor" TIMESTAMP(3),
    "contractEndNoticeFor" TIMESTAMP(3),
    "deletionRequestedAt" TIMESTAMP(3),
    "deletionScheduledFor" TIMESTAMP(3),
    "deletionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cloud_billing_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cloud_company_ownerships" (
    "companyId" TEXT NOT NULL,
    "billingAccountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cloud_company_ownerships_pkey" PRIMARY KEY ("companyId")
);

-- CreateTable
CREATE TABLE "cloud_stripe_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cloud_stripe_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cloud_terms_acceptances" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "document" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cloud_terms_acceptances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cloud_billing_accounts_ownerUserId_key" ON "cloud_billing_accounts"("ownerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "cloud_billing_accounts_stripeCustomerId_key" ON "cloud_billing_accounts"("stripeCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "cloud_billing_accounts_stripeSubscriptionId_key" ON "cloud_billing_accounts"("stripeSubscriptionId");

-- CreateIndex
CREATE INDEX "cloud_billing_accounts_deletionScheduledFor_idx" ON "cloud_billing_accounts"("deletionScheduledFor");

-- CreateIndex
CREATE INDEX "cloud_billing_accounts_subscriptionStatus_idx" ON "cloud_billing_accounts"("subscriptionStatus");

-- CreateIndex
CREATE INDEX "cloud_company_ownerships_billingAccountId_idx" ON "cloud_company_ownerships"("billingAccountId");

-- CreateIndex
CREATE INDEX "cloud_stripe_events_processedAt_idx" ON "cloud_stripe_events"("processedAt");

-- CreateIndex
CREATE INDEX "cloud_terms_acceptances_userId_idx" ON "cloud_terms_acceptances"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "cloud_terms_acceptances_userId_document_version_key" ON "cloud_terms_acceptances"("userId", "document", "version");

-- AddForeignKey
ALTER TABLE "cloud_company_ownerships" ADD CONSTRAINT "cloud_company_ownerships_billingAccountId_fkey" FOREIGN KEY ("billingAccountId") REFERENCES "cloud_billing_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row level security of the cloud tables (docs/rls.md, docs/cloud.md). Same
-- shape as Kledg's policies: the access functions are scalar subqueries
-- (InitPlans), unrestricted contexts (system jobs, instance administrators)
-- reach every row.
--
-- cloud_billing_accounts: the owner's own account; members of a company it
--   owns read it too (the read-only check of a company runs for any of its
--   members); only the owner or an unrestricted context writes it.
-- cloud_company_ownerships: read and written for reachable companies.
-- cloud_terms_acceptances: the user's own acceptances.
-- cloud_stripe_events: unrestricted contexts only (the Stripe webhook).

ALTER TABLE "cloud_billing_accounts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "kledg_rls_select" ON "cloud_billing_accounts" FOR SELECT USING (((SELECT kledg_rls_unrestricted()) OR "ownerUserId" = (SELECT kledg_rls_user_id()) OR EXISTS (SELECT 1 FROM "cloud_company_ownerships" o WHERE o."billingAccountId" = "cloud_billing_accounts"."id")));
CREATE POLICY "kledg_rls_insert" ON "cloud_billing_accounts" FOR INSERT WITH CHECK (((SELECT kledg_rls_unrestricted()) OR "ownerUserId" = (SELECT kledg_rls_user_id())));
CREATE POLICY "kledg_rls_update" ON "cloud_billing_accounts" FOR UPDATE USING (((SELECT kledg_rls_unrestricted()) OR "ownerUserId" = (SELECT kledg_rls_user_id()))) WITH CHECK (((SELECT kledg_rls_unrestricted()) OR "ownerUserId" = (SELECT kledg_rls_user_id())));
CREATE POLICY "kledg_rls_delete" ON "cloud_billing_accounts" FOR DELETE USING (((SELECT kledg_rls_unrestricted()) OR "ownerUserId" = (SELECT kledg_rls_user_id())));

ALTER TABLE "cloud_company_ownerships" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "kledg_rls_select" ON "cloud_company_ownerships" FOR SELECT USING (((SELECT kledg_rls_unrestricted()) OR "companyId" = ANY ((SELECT kledg_rls_company_ids())::text[])));
CREATE POLICY "kledg_rls_insert" ON "cloud_company_ownerships" FOR INSERT WITH CHECK (((SELECT kledg_rls_unrestricted()) OR "companyId" = ANY ((SELECT kledg_rls_company_ids())::text[])));
CREATE POLICY "kledg_rls_update" ON "cloud_company_ownerships" FOR UPDATE USING (((SELECT kledg_rls_unrestricted()) OR "companyId" = ANY ((SELECT kledg_rls_company_ids())::text[]))) WITH CHECK (((SELECT kledg_rls_unrestricted()) OR "companyId" = ANY ((SELECT kledg_rls_company_ids())::text[])));
CREATE POLICY "kledg_rls_delete" ON "cloud_company_ownerships" FOR DELETE USING (((SELECT kledg_rls_unrestricted()) OR "companyId" = ANY ((SELECT kledg_rls_company_ids())::text[])));

ALTER TABLE "cloud_terms_acceptances" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "kledg_rls_select" ON "cloud_terms_acceptances" FOR SELECT USING (((SELECT kledg_rls_unrestricted()) OR "userId" = (SELECT kledg_rls_user_id())));
CREATE POLICY "kledg_rls_insert" ON "cloud_terms_acceptances" FOR INSERT WITH CHECK (((SELECT kledg_rls_unrestricted()) OR "userId" = (SELECT kledg_rls_user_id())));
CREATE POLICY "kledg_rls_update" ON "cloud_terms_acceptances" FOR UPDATE USING (((SELECT kledg_rls_unrestricted()) OR "userId" = (SELECT kledg_rls_user_id()))) WITH CHECK (((SELECT kledg_rls_unrestricted()) OR "userId" = (SELECT kledg_rls_user_id())));
CREATE POLICY "kledg_rls_delete" ON "cloud_terms_acceptances" FOR DELETE USING (((SELECT kledg_rls_unrestricted()) OR "userId" = (SELECT kledg_rls_user_id())));

ALTER TABLE "cloud_stripe_events" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "kledg_rls_select" ON "cloud_stripe_events" FOR SELECT USING ((SELECT kledg_rls_unrestricted()));
CREATE POLICY "kledg_rls_insert" ON "cloud_stripe_events" FOR INSERT WITH CHECK ((SELECT kledg_rls_unrestricted()));
CREATE POLICY "kledg_rls_update" ON "cloud_stripe_events" FOR UPDATE USING ((SELECT kledg_rls_unrestricted())) WITH CHECK ((SELECT kledg_rls_unrestricted()));
CREATE POLICY "kledg_rls_delete" ON "cloud_stripe_events" FOR DELETE USING ((SELECT kledg_rls_unrestricted()));
