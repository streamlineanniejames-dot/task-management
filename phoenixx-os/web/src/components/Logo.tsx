/**
 * The Phoenixx identity.
 *
 * The bird is the real Phoenixx IT mark, taken from the master artwork in
 * logo.svg at the repo root. That file is not usable as-is: it is 90KB, it
 * paints the bird as a raster driven through an SVG luminance mask, and it
 * bakes the wordmark in as outlined paths locked to one colour. Here the mark
 * ships as a plain transparent PNG (public/phoenix-mark.png) and the wordmark
 * is live text, so the type stays crisp at any size, is selectable and
 * searchable, and can take its colour from the theme.
 *
 * The bird carries its own ember colouring and reads on light, on dark and on
 * the brand panel, so there is no "on dark" variant of the mark itself — only
 * the wordmark beside it changes.
 */

/** Intrinsic 185 x 230 — `size` is the height and the width follows. */
const MARK_SRC = '/phoenix-mark.png';
const MARK_RATIO = 185 / 230;

export function Logo({ size = 40, className, alt = 'Phoenixx' }: {
  size?: number; className?: string; alt?: string;
}) {
  return (
    <img
      src={MARK_SRC}
      alt={alt}
      width={Math.round(size * MARK_RATIO)}
      height={size}
      // Width and height are set so the mark cannot arrive late and shift the
      // layout; the style keeps it honest if a caller scales the box.
      style={{ height: size, width: 'auto' }}
      className={className}
      draggable={false}
    />
  );
}

/**
 * Mark plus name — the lockup used in headers and on the sign-in page.
 * `onDark` is for the ember brand panel, `plain` inherits currentColor.
 */
export function Wordmark({ size = 48, variant = 'brand', tagline, className }: {
  size?: number;
  variant?: 'brand' | 'onDark' | 'plain';
  tagline?: string;
  className?: string;
}) {
  const nameColor =
    variant === 'onDark' ? 'text-white' : variant === 'plain' ? 'text-current' : 'text-ink';
  const taglineColor = variant === 'onDark' ? 'text-white/60' : 'text-subtle';

  return (
    <div className={`flex items-center gap-3 ${className || ''}`}>
      {/* The name is right here in text, so the mark is decorative. */}
      <Logo size={size} alt="" />
      <div className="leading-tight">
        {/* Serif, uppercase and tracked out to match the master artwork. */}
        {/* The bird is tall and mostly negative space, so it needs to run
            noticeably larger than the type to read as its equal in the lockup:
            0.34 keeps the cap height of the name against the bird's body. */}
        <p
          className={`font-serif font-semibold uppercase tracking-[0.07em] ${nameColor}`}
          style={{ fontSize: Math.round(size * 0.34) }}
        >
          Phoenixx <span className="tracking-[0.04em]">OS</span>
        </p>
        {tagline && <p className={`mt-1 text-[12px] ${taglineColor}`}>{tagline}</p>}
      </div>
    </div>
  );
}
