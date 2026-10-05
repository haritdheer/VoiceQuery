import type { CSSProperties } from 'react';

/**
 * A slow 3D drift of SQL fragments and small charts behind the app.
 *
 * Decoration, so it is `aria-hidden` and takes no pointer events — it must
 * never be something a reader or a cursor can land in.
 *
 * Built from positioned elements in a CSS perspective space rather than a 3D
 * library. The panels are text and rectangles, which the browser already
 * renders better than a canvas would, and every frame is transform/opacity
 * only, so the compositor runs it on the GPU without touching the main
 * thread. A WebGL scene would have cost several hundred kilobytes and a
 * render loop competing with the app, to draw worse text.
 */

interface Panel {
  /** Percentage offsets, so the field reflows with the viewport. */
  left: number;
  top: number;
  /** Depth in the perspective space. Further back reads fainter and smaller. */
  z: number;
  rotateX: number;
  rotateY: number;
  seconds: number;
  delay: number;
  content: 'sql' | 'bars' | 'line';
  sql?: string[];
}

/**
 * Hand-placed rather than random: a seeded scatter still clumps, and these
 * need to stay clear of the centre column where the text lives.
 */
const PANELS: Panel[] = [
  {
    left: 2, top: 12, z: -260, rotateX: 6, rotateY: 22, seconds: 23, delay: 0,
    content: 'sql',
    sql: ['SELECT region,', '  SUM(revenue) AS total', 'FROM t', 'GROUP BY region'],
  },
  { left: 11, top: 58, z: -420, rotateX: -4, rotateY: 18, seconds: 31, delay: 3, content: 'bars' },
  {
    left: 76, top: 8, z: -340, rotateX: 8, rotateY: -24, seconds: 27, delay: 1.5,
    content: 'sql',
    sql: ['SELECT product,', '  COUNT(*) AS orders', 'FROM t', 'ORDER BY orders DESC'],
  },
  { left: 85, top: 52, z: -200, rotateX: -6, rotateY: -20, seconds: 21, delay: 5, content: 'line' },
  {
    left: 68, top: 78, z: -500, rotateX: 5, rotateY: -14, seconds: 35, delay: 2,
    content: 'sql',
    sql: ['WHERE order_date', '  >= DATE \'2024-01-01\''],
  },
  { left: 4, top: 82, z: -300, rotateX: -5, rotateY: 16, seconds: 29, delay: 6, content: 'bars' },
  {
    left: 44, top: 4, z: -620, rotateX: 10, rotateY: 4, seconds: 33, delay: 4,
    content: 'sql',
    sql: ['SELECT channel, AVG(unit_price)', 'FROM t GROUP BY channel'],
  },
  { left: 32, top: 88, z: -560, rotateX: -8, rotateY: 8, seconds: 25, delay: 7, content: 'line' },
];

const KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY',
  'SUM', 'COUNT', 'AVG', 'DESC', 'AS', 'DATE',
]);

// Capturing group, so split keeps the keywords as their own entries. Membership
// is then a Set lookup rather than a second regex test — a /g regex is
// stateful, and reusing one across .test() calls silently skips matches.
const SPLIT_ON_KEYWORDS = /\b(SELECT|FROM|WHERE|GROUP BY|ORDER BY|SUM|COUNT|AVG|DESC|AS|DATE)\b/;

/** Tints a few keywords so the fragments read as SQL at a glance. */
function renderSql(lines: string[]) {
  return lines.map((line, i) => (
    <div key={i}>
      {line.split(SPLIT_ON_KEYWORDS).map((part, j) =>
        KEYWORDS.has(part) ? (
          <span key={j} className="vq-field-kw">
            {part}
          </span>
        ) : (
          <span key={j}>{part}</span>
        ),
      )}
    </div>
  ));
}

const BAR_HEIGHTS = [16, 28, 11, 34, 22, 30];

function Bars() {
  return (
    <svg width="104" height="44" viewBox="0 0 104 44" aria-hidden="true">
      {BAR_HEIGHTS.map((h, i) => (
        <rect
          key={i}
          x={i * 17 + 2}
          y={40 - h}
          width="11"
          height={h}
          rx="2"
          fill="var(--accent)"
          opacity={0.25 + i * 0.07}
        />
      ))}
    </svg>
  );
}

function Line() {
  return (
    <svg width="112" height="44" viewBox="0 0 112 44" fill="none" aria-hidden="true">
      <path
        d="M2 36 L20 28 L38 31 L56 17 L74 21 L92 8 L110 12"
        stroke="var(--accent)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.6"
      />
      <path
        d="M2 36 L20 28 L38 31 L56 17 L74 21 L92 8 L110 12 L110 42 L2 42 Z"
        fill="var(--accent)"
        opacity="0.08"
      />
    </svg>
  );
}

export function QueryField({
  /**
   * `app` is far fainter. The dashboard's whole promise is numbers you can
   * check, and anything busy behind a results table undercuts that — so the
   * backdrop carries the landing page and all but disappears at work.
   */
  intensity = 'landing',
}: {
  intensity?: 'landing' | 'app';
}) {
  const baseOpacity = intensity === 'landing' ? 1 : 0.35;

  return (
    <div className="vq-field" aria-hidden="true">
      {PANELS.map((p, i) => {
        // Further-back panels are dimmer, which is what sells the depth more
        // than the transform does.
        const depth = Math.min(1, Math.abs(p.z) / 620);
        const style: CSSProperties & Record<string, string | number> = {
          left: `${p.left}%`,
          top: `${p.top}%`,
          opacity: (0.5 - depth * 0.3) * baseOpacity,
          animationDuration: `${p.seconds}s`,
          animationDelay: `${p.delay}s`,
          '--vq-z': `${p.z}px`,
          '--vq-z2': `${p.z + 60}px`,
          '--vq-dx': `${i % 2 === 0 ? 18 : -18}px`,
          '--vq-dy': `${-20 - (i % 3) * 10}px`,
          '--vq-rx': `${p.rotateX}deg`,
          '--vq-ry': `${p.rotateY}deg`,
        };

        return (
          <div key={i} className="vq-field-panel" style={style}>
            {p.content === 'sql' && p.sql ? (
              <div className="vq-field-sql">{renderSql(p.sql)}</div>
            ) : p.content === 'bars' ? (
              <Bars />
            ) : (
              <Line />
            )}
          </div>
        );
      })}
    </div>
  );
}
