import Link from 'next/link'
import { Logo } from '@/components/brand/logo'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { LEGAL_PAGES, type LegalPageSlug } from '@/lib/cloud/legal/terms'
import { LEGAL_TEXTS_REVIEWED, type LegalDocument } from '@/lib/cloud/legal/documents'
import { formatIsoDateFr } from '@/lib/utils/date'

/** Frame of the public legal pages of Kledg Cloud: one readable column and the list of documents. */
export function LegalPage({ slug, document }: { slug: LegalPageSlug | null; document: LegalDocument | null }) {
  return (
    <div className="bg-background min-h-svh px-4 py-10 md:px-10">
      <div className="mx-auto flex max-w-2xl flex-col gap-8">
        <Link href="/" aria-label="Kledg, accueil" className="self-start">
          <Logo />
        </Link>
        <main className="flex flex-col gap-6">
          {slug && document ? (
            <>
              <header className="space-y-1">
                <h1 className="text-2xl font-semibold tracking-tight">{LEGAL_PAGES[slug].title}</h1>
                <p className="text-muted-foreground text-sm">Version du {formatIsoDateFr(document.version)}</p>
              </header>
              {LEGAL_TEXTS_REVIEWED ? null : (
                <Alert>
                  <AlertDescription>Version provisoire, en cours de validation juridique.</AlertDescription>
                </Alert>
              )}
              <p className="text-sm leading-relaxed">{document.intro}</p>
              {document.sections.map((section) => (
                <section key={section.heading} className="space-y-2">
                  <h2 className="text-base font-semibold">{section.heading}</h2>
                  {section.paragraphs.map((paragraph) => (
                    <p key={paragraph} className="text-muted-foreground text-sm leading-relaxed">
                      {paragraph}
                    </p>
                  ))}
                </section>
              ))}
            </>
          ) : (
            <h1 className="text-2xl font-semibold tracking-tight">Informations légales</h1>
          )}
        </main>
        <nav aria-label="Informations légales" className="border-t pt-6">
          <ul className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
            {Object.values(LEGAL_PAGES).map((page) => (
              <li key={page.slug}>
                <Link
                  href={`/legal/${page.slug}`}
                  aria-current={page.slug === slug ? 'page' : undefined}
                  className="text-link underline-offset-4 hover:underline"
                >
                  {page.title}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </div>
  )
}
