-- Kledg Cloud only (kledghq/kledg-cloud, never in Kledg): row level
-- security of the billing tables tightened (pentest round 3,
-- KLEDG-R3-CLOUD-04). Defense in depth: no route lets a customer write
-- these columns; the database now refuses it too, should application code
-- ever pass a user's input through. No table or column change.
--
-- cloud_company_ownerships: only unrestricted contexts (the creation hook in
--   an instance-extension system context, the maintenance, the operator)
--   insert, change or delete a row. A member of a company could otherwise
--   delete its ownership row (the company then belonged to no account:
--   never billed nor read-only) or point it to another account. Reading is
--   unchanged.
-- cloud_billing_accounts: the owner still inserts a bare row and updates
--   its own, but a trigger keeps the billing state to Stripe's webhook, the
--   maintenance and the operator: where the policies apply, in a restricted
--   context, an insert must
--   leave every billing column at its default, and an update may only set
--   the Stripe customer once, request a deletion (deletionReason
--   'requested', when none is scheduled) or cancel its own request.

DROP POLICY "kledg_rls_insert" ON "cloud_company_ownerships";
DROP POLICY "kledg_rls_update" ON "cloud_company_ownerships";
DROP POLICY "kledg_rls_delete" ON "cloud_company_ownerships";
CREATE POLICY "kledg_rls_insert" ON "cloud_company_ownerships" FOR INSERT WITH CHECK ((SELECT kledg_rls_unrestricted()));
CREATE POLICY "kledg_rls_update" ON "cloud_company_ownerships" FOR UPDATE USING ((SELECT kledg_rls_unrestricted())) WITH CHECK ((SELECT kledg_rls_unrestricted()));
CREATE POLICY "kledg_rls_delete" ON "cloud_company_ownerships" FOR DELETE USING ((SELECT kledg_rls_unrestricted()));

CREATE FUNCTION kledg_cloud_guard_billing_account() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  -- Like the policies: only where they apply (not for the table owner, which
  -- runs the migrations and single-role installs), and not for unrestricted
  -- contexts.
  IF NOT row_security_active('cloud_billing_accounts') OR kledg_rls_unrestricted() THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."stripeCustomerId" IS NOT NULL OR NEW."stripeSubscriptionId" IS NOT NULL
      OR NEW."subscriptionStatus" IS NOT NULL OR NEW."planId" IS NOT NULL OR NEW."priceId" IS NOT NULL
      OR NEW."billingInterval" IS NOT NULL OR NEW."trialEnd" IS NOT NULL OR NEW."trialUsed"
      OR NEW."currentPeriodEnd" IS NOT NULL OR NEW."cancelAtPeriodEnd" OR NEW."subscriptionEndedAt" IS NOT NULL
      OR NEW."paymentFailedAt" IS NOT NULL OR NEW."extraCompanies" <> 0 OR NEW."dedicatedDatabase"
      OR NEW."discountSummary" IS NOT NULL OR NEW."discountEnd" IS NOT NULL OR NEW."stripeSyncedAt" IS NOT NULL
      OR NEW."renewalReminderFor" IS NOT NULL OR NEW."contractEndNoticeFor" IS NOT NULL
      OR NEW."deletionRequestedAt" IS NOT NULL OR NEW."deletionScheduledFor" IS NOT NULL OR NEW."deletionReason" IS NOT NULL
    THEN
      RAISE EXCEPTION 'kledg-cloud: the billing state of an account is written by Stripe and the operator only'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."ownerUserId" IS DISTINCT FROM OLD."ownerUserId"
    OR NEW."stripeSubscriptionId" IS DISTINCT FROM OLD."stripeSubscriptionId"
    OR NEW."subscriptionStatus" IS DISTINCT FROM OLD."subscriptionStatus"
    OR NEW."planId" IS DISTINCT FROM OLD."planId"
    OR NEW."priceId" IS DISTINCT FROM OLD."priceId"
    OR NEW."billingInterval" IS DISTINCT FROM OLD."billingInterval"
    OR NEW."trialEnd" IS DISTINCT FROM OLD."trialEnd"
    OR NEW."trialUsed" IS DISTINCT FROM OLD."trialUsed"
    OR NEW."currentPeriodEnd" IS DISTINCT FROM OLD."currentPeriodEnd"
    OR NEW."cancelAtPeriodEnd" IS DISTINCT FROM OLD."cancelAtPeriodEnd"
    OR NEW."subscriptionEndedAt" IS DISTINCT FROM OLD."subscriptionEndedAt"
    OR NEW."paymentFailedAt" IS DISTINCT FROM OLD."paymentFailedAt"
    OR NEW."extraCompanies" IS DISTINCT FROM OLD."extraCompanies"
    OR NEW."dedicatedDatabase" IS DISTINCT FROM OLD."dedicatedDatabase"
    OR NEW."discountSummary" IS DISTINCT FROM OLD."discountSummary"
    OR NEW."discountEnd" IS DISTINCT FROM OLD."discountEnd"
    OR NEW."stripeSyncedAt" IS DISTINCT FROM OLD."stripeSyncedAt"
    OR NEW."renewalReminderFor" IS DISTINCT FROM OLD."renewalReminderFor"
    OR NEW."contractEndNoticeFor" IS DISTINCT FROM OLD."contractEndNoticeFor"
    -- The Stripe customer is set once (Checkout), never replaced.
    OR (NEW."stripeCustomerId" IS DISTINCT FROM OLD."stripeCustomerId" AND OLD."stripeCustomerId" IS NOT NULL)
  THEN
    RAISE EXCEPTION 'kledg-cloud: the billing state of an account is written by Stripe and the operator only'
      USING ERRCODE = '42501';
  END IF;

  IF NEW."deletionRequestedAt" IS DISTINCT FROM OLD."deletionRequestedAt"
    OR NEW."deletionScheduledFor" IS DISTINCT FROM OLD."deletionScheduledFor"
    OR NEW."deletionReason" IS DISTINCT FROM OLD."deletionReason"
  THEN
    -- The owner requests a deletion when none is scheduled, or cancels its own request.
    IF NOT (
      (OLD."deletionScheduledFor" IS NULL AND OLD."deletionReason" IS NULL AND NEW."deletionReason" = 'requested'
        AND NEW."deletionRequestedAt" IS NOT NULL AND NEW."deletionScheduledFor" IS NOT NULL)
      OR (OLD."deletionReason" = 'requested'
        AND NEW."deletionRequestedAt" IS NULL AND NEW."deletionScheduledFor" IS NULL AND NEW."deletionReason" IS NULL)
    ) THEN
      RAISE EXCEPTION 'kledg-cloud: an account deletion scheduled at the end of the contract is the maintenance''s'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "kledg_cloud_guard_billing_account"
  BEFORE INSERT OR UPDATE ON "cloud_billing_accounts"
  FOR EACH ROW EXECUTE FUNCTION kledg_cloud_guard_billing_account();
