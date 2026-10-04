/**
 * Texts of the legal pages of Kledg Cloud (/legal/<slug>). Pure.
 *
 * DRAFTS. They give the structure and the commitments the service is built
 * on (data location, sub-processors, retention, portability, deletion), and
 * leave the operator's details as bracketed placeholders. They must be
 * reviewed and completed by a lawyer before the service opens, set
 * LEGAL_TEXTS_REVIEWED to true then, which removes the "provisional
 * version" notice (docs/cloud.md, go-live checklist).
 */

import { CURRENT_TERMS, type LegalPageSlug } from './terms'

export const LEGAL_TEXTS_REVIEWED = false

export interface LegalSection {
  heading: string
  paragraphs: string[]
}

export interface LegalDocument {
  /** Version shown under the title (the date of publication). */
  version: string
  intro: string
  sections: LegalSection[]
}

const OPERATOR = '[Raison sociale de l’éditeur], [forme juridique] au capital de [montant], immatriculée au RCS de [ville] sous le numéro [SIREN], dont le siège est situé [adresse]'
const CONTACT = '[adresse email de contact]'

export const LEGAL_DOCUMENTS: Readonly<Record<LegalPageSlug, LegalDocument>> = {
  cgu: {
    version: CURRENT_TERMS.cgu,
    intro: `Les présentes conditions générales d'utilisation encadrent l'accès au service Kledg Cloud, édité par ${OPERATOR}.`,
    sections: [
      {
        heading: 'Objet du service',
        paragraphs: [
          'Kledg Cloud est une version hébergée du logiciel libre de comptabilité Kledg (licence AGPL-3.0). Il permet de tenir la comptabilité de sociétés françaises selon le plan comptable général, de produire les états et le fichier des écritures comptables (FEC).',
          "Kledg Cloud est un outil : il ne remplace pas un expert-comptable. L'utilisateur reste responsable des écritures qu'il saisit ou valide, y compris celles proposées par un assistant d'intelligence artificielle connecté.",
        ],
      },
      {
        heading: 'Compte',
        paragraphs: [
          "La création d'un compte demande une adresse email confirmée et l'acceptation des présentes conditions et des conditions générales de vente. L'utilisateur garde son mot de passe confidentiel et signale sans délai tout usage non autorisé.",
          'Le titulaire du compte peut inviter d’autres personnes dans ses sociétés. Il répond de leur usage du service.',
        ],
      },
      {
        heading: 'Données et réversibilité',
        paragraphs: [
          "Les données saisies appartiennent au client. Elles restent consultables et exportables à tout moment, y compris lorsque l'abonnement a pris fin : FEC par exercice et export complet de chaque société.",
          'Les données sont hébergées dans l’Union européenne. Le détail des traitements figure dans la politique de confidentialité et dans l’accord de traitement des données.',
        ],
      },
      {
        heading: 'Disponibilité',
        paragraphs: ['[Engagement de disponibilité, maintenance programmée, sauvegardes et support à préciser.]'],
      },
      {
        heading: 'Suspension et suppression',
        paragraphs: [
          "Un compte dont l'essai ou l'abonnement a pris fin passe en lecture seule après un délai de grâce : aucune donnée n'est supprimée ni masquée.",
          "La suppression du compte est demandée depuis la page Données et compte. Elle intervient après un délai pendant lequel elle peut être annulée. Les livres comptables soumis à une obligation légale de conservation sont conservés, archivés, sauf demande expresse contraire du client.",
        ],
      },
      { heading: 'Responsabilité', paragraphs: ['[Limitation de responsabilité à rédiger.]'] },
      { heading: 'Droit applicable', paragraphs: ['Les présentes conditions sont soumises au droit français. [Juridiction compétente à préciser.]'] },
    ],
  },
  cgv: {
    version: CURRENT_TERMS.cgv,
    intro: `Les présentes conditions générales de vente s'appliquent aux abonnements Kledg Cloud souscrits auprès de ${OPERATOR}.`,
    sections: [
      {
        heading: 'Offres',
        paragraphs: [
          "Chaque offre permet de tenir la comptabilité d'un nombre défini de sociétés appartenant au titulaire du compte. Les personnes invitées dans une société ne paient pas. Le détail et le prix des offres figurent sur la page Facturation et sur le site.",
        ],
      },
      {
        heading: 'Essai gratuit',
        paragraphs: ["Un essai gratuit, sans moyen de paiement, est proposé à l'ouverture du compte. À son terme, le compte passe en lecture seule après un délai de grâce s'il n'est pas abonné."],
      },
      {
        heading: 'Prix, facturation et paiement',
        paragraphs: [
          'Les prix sont indiqués hors taxes, la TVA applicable est calculée selon le pays et le statut du client. Les abonnements sont payables d’avance, par mois ou par an, par carte ou prélèvement, via notre prestataire de paiement Stripe. Les factures sont disponibles sur la page Facturation.',
          '[Conditions de révision des prix et pénalités de retard pour les professionnels (Code de commerce art. L441-10) à préciser.]',
        ],
      },
      {
        heading: 'Durée et résiliation',
        paragraphs: [
          "L'abonnement est reconduit tacitement. Le client peut le résilier à tout moment depuis son espace de facturation, la résiliation prend effet à la fin de la période en cours. [Conditions de remboursement à préciser.]",
        ],
      },
      { heading: 'Droit applicable', paragraphs: ['Les présentes conditions sont soumises au droit français. [Juridiction compétente à préciser.]'] },
    ],
  },
  dpa: {
    version: CURRENT_TERMS.cgu,
    intro:
      "Cet accord, conclu en application de l'article 28 du RGPD, fait partie des conditions générales. Pour les données personnelles contenues dans la comptabilité du client (salariés, clients, fournisseurs, associés), le client est responsable de traitement et l'éditeur de Kledg Cloud agit comme sous-traitant.",
    sections: [
      {
        heading: 'Objet et durée',
        paragraphs: ["Hébergement et traitement des données comptables du client pour lui fournir le service, pendant la durée du contrat puis le temps de leur restitution ou de leur suppression."],
      },
      {
        heading: 'Obligations du sous-traitant',
        paragraphs: [
          "Traiter les données sur instruction documentée du client uniquement, garantir la confidentialité des personnes autorisées, mettre en œuvre les mesures de sécurité décrites ci-dessous, aider le client à répondre aux demandes d'exercice des droits et à ses obligations (articles 32 à 36), notifier toute violation de données dans les meilleurs délais, mettre à disposition les informations nécessaires aux audits.",
        ],
      },
      {
        heading: 'Sous-traitants ultérieurs',
        paragraphs: [
          "[Liste à compléter, par exemple : hébergement de l'application (Vercel, région Union européenne), base de données (Neon, région Union européenne), envoi des emails (Resend), paiement (Stripe).] Le client est informé de tout changement et peut s'y opposer.",
        ],
      },
      {
        heading: 'Mesures de sécurité',
        paragraphs: [
          'Chiffrement des échanges (TLS) et des secrets au repos, isolement des données de chaque client, contrôle des accès par rôle, journal d’audit, sauvegardes, mots de passe hachés, limitation des tentatives. [À compléter.]',
        ],
      },
      {
        heading: 'Fin du contrat',
        paragraphs: [
          "Au choix du client, les données sont restituées (FEC et export complet, disponibles à tout moment) puis supprimées, sous réserve des obligations légales de conservation que le client nous demande de respecter.",
        ],
      },
    ],
  },
  confidentialite: {
    version: CURRENT_TERMS.cgu,
    intro: `Cette politique décrit les données personnelles que ${OPERATOR} traite en tant que responsable de traitement pour fournir Kledg Cloud.`,
    sections: [
      {
        heading: 'Données traitées',
        paragraphs: [
          'Compte : nom, adresse email, mot de passe haché, sessions (adresse IP, navigateur). Facturation : identifiants du client et de l’abonnement chez Stripe, les données de carte ne nous parviennent jamais. Preuves : version et date d’acceptation des conditions.',
        ],
      },
      {
        heading: 'Finalités et bases légales',
        paragraphs: ["Fournir le service et le facturer (exécution du contrat), sécuriser les comptes (intérêt légitime), respecter nos obligations comptables et fiscales (obligation légale)."],
      },
      {
        heading: 'Durées de conservation',
        paragraphs: [
          "Les données du compte sont conservées pendant la durée du contrat, puis supprimées à la clôture du compte. Les comptes jamais confirmés sont supprimés au bout de quelques jours. Nos propres factures sont conservées dix ans (Code de commerce art. L123-22).",
        ],
      },
      {
        heading: 'Vos droits',
        paragraphs: [
          `Accès, rectification, effacement, limitation, opposition et portabilité : depuis votre compte (export complet, suppression) ou en écrivant à ${CONTACT}. Vous pouvez saisir la CNIL.`,
        ],
      },
    ],
  },
  'mentions-legales': {
    version: CURRENT_TERMS.cgu,
    intro: 'Informations légales du service Kledg Cloud (loi n° 2004-575 du 21 juin 2004, article 6).',
    sections: [
      { heading: 'Éditeur', paragraphs: [`${OPERATOR}. Directeur de la publication : [nom]. Contact : ${CONTACT}.`] },
      { heading: 'Hébergement', paragraphs: ['[Hébergeur de l’application et de la base de données : raison sociale, adresse, téléphone.]'] },
      { heading: 'Logiciel', paragraphs: ['Kledg est un logiciel libre publié sous licence AGPL-3.0. Son code source et celui de Kledg Cloud sont publics.'] },
    ],
  },
}
