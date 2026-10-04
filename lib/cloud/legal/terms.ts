/**
 * Terms accepted by Kledg Cloud clients. Pure.
 *
 * The CGV are published on the website (LEGAL_URLS.cgv, lib/cloud/config.ts):
 * version 1.0, in force since 4 October 2026. Accepting them is required at
 * sign-up; each acceptance is stored with its version and date
 * (CloudTermsAcceptance). Publishing a new version means changing it here:
 * every user is then asked to accept it again (banner of the application
 * frame) before going on.
 */

export const TERMS_DOCUMENTS = ['cgv'] as const
export type TermsDocument = (typeof TERMS_DOCUMENTS)[number]

/** Version in force of each document users accept. */
export const CURRENT_TERMS: Readonly<Record<TermsDocument, { version: string; effective: string }>> = {
  cgv: { version: '1.0', effective: '2026-10-04' },
}

/** The single version string sent by the sign-up form ("cgv:1.0"). */
export function currentTermsVersion(): string {
  return TERMS_DOCUMENTS.map((document) => `${document}:${CURRENT_TERMS[document].version}`).join(',')
}
