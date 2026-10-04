/**
 * Emails of Kledg Cloud (French), in the same layout as Kledg's own
 * (lib/email/templates.ts). Sent through lib/email.
 */

import { APP_NAME } from '@/lib/config'
import type { EmailMessage } from '@/lib/email'
import { frenchDay } from './billing/notice'

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function layout(title: string, paragraphs: string[], cta: { label: string; url: string }): string {
  const body = paragraphs.map((p) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#3f3f46">${escapeHtml(p)}</p>`).join('')
  return `<!doctype html>
<html lang="fr">
  <body style="margin:0;padding:32px 16px;background:#f6f6f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#18181b">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e4e4e7;border-radius:12px">
      <tr><td style="padding:32px">
        <p style="margin:0 0 24px;font-size:15px;font-weight:600;letter-spacing:-0.01em">${APP_NAME}</p>
        <h1 style="margin:0 0 12px;font-size:20px;line-height:1.3">${escapeHtml(title)}</h1>
        ${body}
        <a href="${escapeHtml(cta.url)}" style="display:inline-block;margin-top:8px;padding:10px 18px;background:#18181b;color:#ffffff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:500">${escapeHtml(cta.label)}</a>
        <p style="margin:16px 0 0;font-size:12px;line-height:1.6;color:#a1a1aa;word-break:break-all">${escapeHtml(cta.url)}</p>
      </td></tr>
    </table>
  </body>
</html>`
}

function message(to: string, subject: string, title: string, paragraphs: string[], cta: { label: string; url: string }): EmailMessage {
  return { to, subject, html: layout(title, paragraphs, cta), text: [...paragraphs, `${cta.label} : ${cta.url}`].join('\n\n') }
}

/**
 * Sent instead of a confirmation link when someone signs up with an address
 * that already has an account: the sign-up page answers the same way in
 * both cases, only the owner of the mailbox learns which one it was.
 */
export function accountExistsEmail(to: string, loginUrl: string): EmailMessage {
  return message(
    to,
    `Votre compte ${APP_NAME} existe déjà`,
    'Vous avez déjà un compte',
    [
      `Quelqu'un, probablement vous, a demandé à créer un compte ${APP_NAME} avec cette adresse. Elle a déjà un compte : aucun nouveau compte n'a été créé.`,
      'Connectez-vous avec votre mot de passe, ou choisissez « Mot de passe oublié » sur la page de connexion pour en définir un nouveau.',
      "Si vous n'êtes pas à l'origine de cette demande, ignorez cet email.",
    ],
    { label: 'Se connecter', url: loginUrl },
  )
}


export function deletionScheduledEmail(to: string, scheduledFor: Date, pageUrl: string): EmailMessage {
  return message(
    to,
    `Suppression de votre compte ${APP_NAME} programmée`,
    'Suppression de votre compte programmée',
    [
      `Votre compte sera supprimé le ${frenchDay(scheduledFor)}. Jusqu'à cette date, vous pouvez annuler la suppression et exporter vos données depuis la page Données et compte.`,
      "Si vous n'êtes pas à l'origine de cette demande, connectez-vous et annulez-la, puis changez votre mot de passe.",
    ],
    { label: 'Annuler ou exporter mes données', url: pageUrl },
  )
}

export function accountDeletedEmail(to: string, keptCompanies: string[], legalUrl: string): EmailMessage {
  const kept = keptCompanies.length
    ? [
        `Les livres comptables de ${keptCompanies.join(', ')} sont conservés, archivés et inaccessibles, jusqu'à la fin de la durée légale de conservation (10 ans, Code de commerce art. L123-22), puis supprimés.`,
      ]
    : []
  return message(
    to,
    `Votre compte ${APP_NAME} a été supprimé`,
    'Votre compte a été supprimé',
    [`Votre compte ${APP_NAME} et ses données personnelles ont été supprimés, et votre abonnement résilié.`, ...kept],
    { label: 'Notre politique de confidentialité', url: legalUrl },
  )
}
