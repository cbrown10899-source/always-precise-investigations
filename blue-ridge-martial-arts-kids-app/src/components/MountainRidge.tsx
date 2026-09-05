/**
 * The Blue Ridge silhouette used behind the masthead.
 *
 * Purely decorative: it carries no information the wordmark above it does not
 * already state, so it is hidden from the accessibility tree. It is inline SVG
 * rather than an image file so it inherits the palette and costs no request.
 */
export function MountainRidge({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 400 78"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      {/* Back ridge, palest and furthest away. */}
      <path
        d="M0 46 L38 24 L72 42 L108 16 L150 44 L190 22 L232 46 L272 26 L316 48 L356 30 L400 50 L400 78 L0 78 Z"
        fill="var(--sky-400)"
        opacity="0.55"
      />
      {/* Middle ridge. */}
      <path
        d="M0 58 L44 38 L84 56 L126 32 L168 54 L214 36 L258 58 L302 40 L344 60 L400 42 L400 78 L0 78 Z"
        fill="var(--navy-600)"
        opacity="0.62"
      />
      {/* Front ridge, darkest and nearest. */}
      <path
        d="M0 70 L36 56 L78 70 L122 52 L164 68 L210 54 L252 70 L296 56 L340 70 L400 58 L400 78 L0 78 Z"
        fill="var(--navy-800)"
      />
      {/* A little snow on the two tallest front peaks, as in the brand art. */}
      <path d="M122 52 L131 56 L126 57 L118 57 Z" fill="var(--white)" opacity="0.85" />
      <path d="M296 56 L304 60 L299 61 L291 61 Z" fill="var(--white)" opacity="0.8" />
    </svg>
  )
}
