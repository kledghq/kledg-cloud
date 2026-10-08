/**
 * Terms accepted by Kledg Cloud clients. Pure.
 *
 * The CGV are published on the website (LEGAL_URLS.cgv, lib/cloud/config.ts):
 * version 1.1, in force since 8 October 2026 (art. 14: the receipt files
 * are deleted with the rest of the data after the retrieval period).
 * Accepting them is required at sign-up; each acceptance is stored with its version and date
 * (CloudTermsAcceptance). Publishing a new version means changing it here:
 * every user is then asked to accept it again (banner of the application
 * frame) before going on.
 */

export const TERMS_DOCUMENTS = ['cgv'] as const
export type TermsDocument = (typeof TERMS_DOCUMENTS)[number]

/** Version in force of each document users accept. */
export const CURRENT_TERMS: Readonly<Record<TermsDocument, { version: string; effective: string }>> = {
  cgv: { version: '1.1', effective: '2026-10-08' },
}

/** The single version string sent by the sign-up form ("cgv:1.0"). */
export function currentTermsVersion(): string {
  return TERMS_DOCUMENTS.map((document) => `${document}:${CURRENT_TERMS[document].version}`).join(',')
}
