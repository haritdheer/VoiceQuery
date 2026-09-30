/**
 * The persistent credit bar.
 *
 * Fixed to the bottom of the viewport so it is visible on every page without
 * each page having to render it. Pages reserve space for it with the
 * `FOOTER_HEIGHT_CLASS` padding below, rather than letting it float over
 * content — on the dashboard it would otherwise sit on top of the question
 * composer.
 */

/** Apply to a page root so nothing ends up hidden behind the fixed bar. */
export const FOOTER_SPACER_CLASS = 'pb-8';

export function AppFooter() {
  return (
    <footer
      className="fixed inset-x-0 bottom-0 z-30 h-8 border-t border-[var(--border-subtle)] bg-[var(--surface-1)]"
      aria-label="Credits"
    >
      <div className="mx-auto flex h-full max-w-7xl items-center justify-center px-4 sm:px-6">
        <p className="truncate text-xs text-[var(--text-muted)]">
          Conceived and built by{' '}
          <span className="font-medium text-[var(--text-secondary)]">Harit</span>, in
          collaboration with my buddy{' '}
          <span className="font-medium text-[var(--text-secondary)]">Claude</span>{' '}
          {/* Decorative: a screen reader announcing "blue heart" mid-sentence adds nothing. */}
          <span aria-hidden="true">💙</span>
        </p>
      </div>
    </footer>
  );
}
