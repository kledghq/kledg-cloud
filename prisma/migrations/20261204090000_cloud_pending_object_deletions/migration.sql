-- Kledg Cloud only (kledghq/kledg-cloud, never in Kledg): stored objects of
-- purged companies still to delete (docs/cloud.md, Data, GDPR and
-- retention). Rows are written in the purge transaction, with the deletion
-- of the companies, and removed once the object (kind 'object') or every
-- object under the prefix (kind 'prefix', receipts/<companyId>/) is gone;
-- the maintenance job retries what is left. Additive, no Kledg table is
-- changed. No companyId column: the company is gone, the key holds it.
--
-- Row level security: unrestricted contexts only (the maintenance job and
-- the purge), like cloud_stripe_events.

-- CreateTable
CREATE TABLE "cloud_pending_object_deletions" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "storageDriver" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cloud_pending_object_deletions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "cloud_pending_object_deletions_kind_check" CHECK ("kind" IN ('object', 'prefix'))
);

-- CreateIndex
CREATE UNIQUE INDEX "cloud_pending_object_deletions_storageDriver_target_key" ON "cloud_pending_object_deletions"("storageDriver", "target");

-- CreateIndex
CREATE INDEX "cloud_pending_object_deletions_createdAt_idx" ON "cloud_pending_object_deletions"("createdAt");

ALTER TABLE "cloud_pending_object_deletions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "kledg_rls_select" ON "cloud_pending_object_deletions" FOR SELECT USING ((SELECT kledg_rls_unrestricted()));
CREATE POLICY "kledg_rls_insert" ON "cloud_pending_object_deletions" FOR INSERT WITH CHECK ((SELECT kledg_rls_unrestricted()));
CREATE POLICY "kledg_rls_update" ON "cloud_pending_object_deletions" FOR UPDATE USING ((SELECT kledg_rls_unrestricted())) WITH CHECK ((SELECT kledg_rls_unrestricted()));
CREATE POLICY "kledg_rls_delete" ON "cloud_pending_object_deletions" FOR DELETE USING ((SELECT kledg_rls_unrestricted()));
