/**
 * Legal documents of Kledg Cloud and the versions in force. Pure.
 *
 * Accepting the CGU and the CGV is required at sign-up; each acceptance is
 * stored with its version and time (CloudTermsAcceptance). Publishing a new
 * version means changing its date here: every user is then asked to accept
 * it again (banner of the application frame) before going on.
 *
 * The texts in lib/cloud/legal/documents.ts are drafts that must be
 * reviewed by a lawyer before the service opens (docs/cloud.md).
 */

export const TERMS_DOCUMENTS = ['cgu', 'cgv'] as const
export type TermsDocument = (typeof TERMS_DOCUMENTS)[number]

/** Version (date of publication) of each document that users accept. */
export const CURRENT_TERMS: Readonly<Record<TermsDocument, string>> = {
  cgu: '2026-10-20',
  cgv: '2026-10-20',
}

/** The single version string sent by the sign-up form ("cgu:2026-10-20,cgv:2026-10-20"). */
export function currentTermsVersion(): string {
  return TERMS_DOCUMENTS.map((document) => `${document}:${CURRENT_TERMS[document]}`).join(',')
}

export const LEGAL_PAGES = {
  cgu: { slug: 'cgu', title: "Conditions générales d'utilisation" },
  cgv: { slug: 'cgv', title: 'Conditions générales de vente' },
  dpa: { slug: 'dpa', title: 'Accord de traitement des données (sous-traitance, RGPD art. 28)' },
  confidentialite: { slug: 'confidentialite', title: 'Politique de confidentialité' },
  'mentions-legales': { slug: 'mentions-legales', title: 'Mentions légales' },
} as const

export type LegalPageSlug = keyof typeof LEGAL_PAGES

export function isLegalPageSlug(value: string): value is LegalPageSlug {
  return Object.prototype.hasOwnProperty.call(LEGAL_PAGES, value)
}
