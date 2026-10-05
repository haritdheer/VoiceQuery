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
    left: 1, top: 10, z: -120, rotateX: 6, rotateY: 24, seconds: 15, delay: 0,
    content: 'sql',
    sql: ['SELECT region,', '  SUM(revenue) AS total', 'FROM t', 'GROUP BY region'],
  },
  { left: 9, top: 56, z: -220, rotateX: -5, rotateY: 20, seconds: 19, delay: 2, content: 'bars' },
  {
    left: 77, top: 6, z: -170, rotateX: 8, rotateY: -26, seconds: 17, delay: 1,
    content: 'sql',
    sql: ['SELECT product,', '  COUNT(*) AS orders', 'FROM t', 'ORDER BY orders DESC'],
  },
  { left: 86, top: 48, z: -90, rotateX: -7, rotateY: -22, seconds: 13, delay: 3, content: 'line' },
  {
    left: 70, top: 76, z: -260, rotateX: 5, rotateY: -16, seconds: 21, delay: 1.5,
    content: 'sql',
    sql: ["WHERE order_date", "  >= DATE '2024-01-01'"],
  },
  { left: 3, top: 80, z: -150, rotateX: -6, rotateY: 18, seconds: 16, delay: 4, content: 'bars' },
  {
    left: 40, top: 2, z: -320, rotateX: 11, rotateY: 5, seconds: 23, delay: 2.5,
    content: 'sql',
    sql: ['SELECT channel, AVG(unit_price)', 'FROM t GROUP BY channel'],
  },
  { left: 28, top: 86, z: -290, rotateX: -9, rotateY: 9, seconds: 18, delay: 5, content: 'line' },
  {
    left: 88, top: 24, z: -240, rotateX: 4, rotateY: -18, seconds: 20, delay: 0.5,
    content: 'sql',
    sql: ['HAVING SUM(revenue) > 10000'],
  },
  { left: 62, top: 34, z: -380, rotateX: -4, rotateY: -10, seconds: 24, delay: 6, content: 'bars' },
  {
    left: 16, top: 30, z: -350, rotateX: 7, rotateY: 14, seconds: 22, delay: 3.5,
    content: 'sql',
    sql: ['ORDER BY total DESC', 'LIMIT 10'],
  },
  { left: 48, top: 68, z: -420, rotateX: -6, rotateY: 3, seconds: 26, delay: 1, content: 'line' },
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
  const baseOpacity = intensity === 'landing' ? 1 : 0.55;

  return (
    <div className="vq-field" aria-hidden="true">
      {PANELS.map((p, i) => {
        // Further-back panels are dimmer, which sells the depth more than the
        // transform does. The floor is high enough that the back row is still
        // actually visible — at the old 0.2 it may as well not have rendered.
        const depth = Math.min(1, Math.abs(p.z) / 420);
        const style: CSSProperties & Record<string, string | number> = {
          left: `${p.left}%`,
          top: `${p.top}%`,
          opacity: (0.95 - depth * 0.35) * baseOpacity,
          animationDuration: `${p.seconds}s`,
          animationDelay: `-${p.delay}s`,
          '--vq-z': `${p.z}px`,
          '--vq-z2': `${p.z + 140}px`,
          // Travel large enough to read as drift. Alternating direction keeps
          // the field from sliding as one block.
          '--vq-dx': `${i % 2 === 0 ? 110 : -110}px`,
          '--vq-dy': `${-70 - (i % 3) * 35}px`,
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
