-- Kledg Cloud only (kledghq/kledg-cloud, never in Kledg): billing accounts,
-- company ownership, retained books, Stripe event idempotency and terms
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
    "trialEndsAt" TIMESTAMP(3) NOT NULL,
    "currentPeriodEnd" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "subscriptionEndedAt" TIMESTAMP(3),
    "paymentFailedAt" TIMESTAMP(3),
    "stripeSyncedAt" TIMESTAMP(3),
    "deletionRequestedAt" TIMESTAMP(3),
    "deletionScheduledFor" TIMESTAMP(3),
    "deletionIncludesBooks" BOOLEAN NOT NULL DEFAULT false,
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
CREATE TABLE "cloud_retained_companies" (
    "companyId" TEXT NOT NULL,
    "retainUntil" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cloud_retained_companies_pkey" PRIMARY KEY ("companyId")
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
CREATE INDEX "cloud_company_ownerships_billingAccountId_idx" ON "cloud_company_ownerships"("billingAccountId");

-- CreateIndex
CREATE INDEX "cloud_retained_companies_retainUntil_idx" ON "cloud_retained_companies"("retainUntil");

-- CreateIndex
CREATE INDEX "cloud_stripe_events_processedAt_idx" ON "cloud_stripe_events"("processedAt");

-- CreateIndex
CREATE INDEX "cloud_terms_acceptances_userId_idx" ON "cloud_terms_acceptances"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "cloud_terms_acceptances_userId_document_version_key" ON "cloud_terms_acceptances"("userId", "document", "version");

-- AddForeignKey
ALTER TABLE "cloud_company_ownerships" ADD CONSTRAINT "cloud_company_ownerships_billingAccountId_fkey" FOREIGN KEY ("billingAccountId") REFERENCES "cloud_billing_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

