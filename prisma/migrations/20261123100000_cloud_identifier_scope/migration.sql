-- Kledg Cloud only (kledghq/kledg-cloud, never in Kledg): SIREN and SIRET
-- unique per customer, not across the shared database (pentest round 3,
-- KLEDG-R3-CLOUD-01). With instance-wide unique indexes, a free trial could
-- take the SIREN of a business that is not a customer yet (SIRENs are
-- public), and any customer could learn which SIRENs other customers use.
--
-- The uniqueness is now checked by the application within the customer's
-- own companies (companyIdentifierScope of lib/instance/policy.ts,
-- lib/cloud/enforcement.ts, through kledg_company_identifier_taken).
-- Establishments keep their non-unique index on "siret". Company slugs stay
-- unique across the instance (they are URLs) and get a random suffix.
-- No data change; Kledg's own instances keep their unique indexes.

-- DropIndex
DROP INDEX "companies_siren_key";

-- DropIndex
DROP INDEX "establishments_siret_key";
