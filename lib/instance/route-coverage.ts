/**
 * MCP coverage of the instance's own API routes (docs/extension-points.md).
 * Kledg Cloud: its routes for the subscription, the account's contract and
 * data, the operator console and sign-up stay out of the MCP server.
 */

export type InstanceRouteCoverage = { tools: readonly string[] } | { excluded: string }

const BILLING =
  "Abonnement et paiement dans Stripe (commande, portail, factures du service) : seule la personne s'engage financièrement, jamais un assistant."
const CONTRACT =
  "Contrat du compte (acceptation des conditions, demande de suppression du compte et de ses données) : un consentement ou une décision que seule la personne donne."
const DATA_EXPORT = "Export complet des données du compte dans un fichier ; l'assistant lit les mêmes données avec les outils de lecture."
const OPERATOR = "Console de l'opérateur du service hébergé (comptes clients, essais) : administration de l'instance, hors de toute société."
const SIGNUP = "Inscription publique d'un nouveau compte, avant toute connexion ; un assistant agit toujours pour un compte existant."
const WEBHOOK = "Notification signée envoyée par Stripe, jamais par un utilisateur."
const CRON = "Tâche planifiée appelée par la plateforme avec son secret, jamais par un utilisateur."

export const INSTANCE_ROUTE_COVERAGE: Readonly<Record<string, InstanceRouteCoverage>> = {
  'POST /api/billing/checkout': { excluded: BILLING },
  'GET /api/billing/invoices': { excluded: BILLING },
  'POST /api/billing/portal': { excluded: BILLING },
  'POST /api/billing/webhook': { excluded: WEBHOOK },
  'GET /api/cloud/account/deletion': { excluded: CONTRACT },
  'POST /api/cloud/account/deletion': { excluded: CONTRACT },
  'DELETE /api/cloud/account/deletion': { excluded: CONTRACT },
  'GET /api/cloud/export': { excluded: DATA_EXPORT },
  'POST /api/cloud/operator/accounts/[id]/trial': { excluded: OPERATOR },
  'GET /api/cloud/operator/accounts': { excluded: OPERATOR },
  'POST /api/cloud/terms': { excluded: CONTRACT },
  'GET /api/cron/cloud-maintenance': { excluded: CRON },
  'POST /api/signup': { excluded: SIGNUP },
}
