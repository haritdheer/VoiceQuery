/**
 * The built-in sample sales dataset.
 *
 * Generated deterministically from a fixed seed so the demo behaves
 * identically on every machine and in every screen recording. It spans six
 * months and four regions with per-product seasonality, which is what makes
 * follow-ups like "now show only September" or "which region grew fastest"
 * produce genuinely different answers instead of the same chart twice.
 */

export const SAMPLE_DATASET_ID = 'sample-sales';
export const SAMPLE_DATASET_NAME = 'Sample: Retail Sales 2024';

export interface SampleRow {
  order_date: string;
  product: string;
  category: string;
  region: string;
  channel: string;
  quantity: number;
  unit_price: number;
  revenue: number;
}

/** Small deterministic PRNG (mulberry32) — no dependency, stable output. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PRODUCTS: { name: string; category: string; price: number; trend: number }[] = [
  { name: 'Aurora Headphones', category: 'Audio', price: 129.0, trend: 1.35 },
  { name: 'Nimbus Speaker', category: 'Audio', price: 89.5, trend: 1.05 },
  { name: 'Vertex Keyboard', category: 'Accessories', price: 74.0, trend: 0.85 },
  { name: 'Contour Mouse', category: 'Accessories', price: 42.0, trend: 0.95 },
  { name: 'Lumen Monitor 27', category: 'Displays', price: 319.0, trend: 1.2 },
  { name: 'Lumen Monitor 32', category: 'Displays', price: 459.0, trend: 1.6 },
  { name: 'Halo Webcam', category: 'Video', price: 98.0, trend: 0.7 },
  { name: 'Cradle Dock', category: 'Accessories', price: 155.0, trend: 1.1 },
  { name: 'Pulse Smartwatch', category: 'Wearables', price: 219.0, trend: 1.45 },
  { name: 'Drift Earbuds', category: 'Audio', price: 64.0, trend: 1.15 },
];

const REGIONS = [
  { name: 'North', weight: 1.0 },
  { name: 'South', weight: 0.78 },
  { name: 'East', weight: 1.22 },
  { name: 'West', weight: 0.9 },
];

const CHANNELS = [
  { name: 'Online', weight: 1.5 },
  { name: 'Retail', weight: 0.9 },
  { name: 'Partner', weight: 0.45 },
];

const MONTHS = [
  { year: 2024, month: 4, days: 30, seasonal: 0.85 },
  { year: 2024, month: 5, days: 31, seasonal: 0.95 },
  { year: 2024, month: 6, days: 30, seasonal: 1.0 },
  { year: 2024, month: 7, days: 31, seasonal: 0.92 },
  { year: 2024, month: 8, days: 31, seasonal: 1.08 },
  { year: 2024, month: 9, days: 30, seasonal: 1.3 },
];

export function generateSampleRows(): SampleRow[] {
  const rand = rng(20240917);
  const rows: SampleRow[] = [];

  MONTHS.forEach((m, monthIndex) => {
    // A gentle month-over-month ramp on top of the seasonal multiplier.
    const growth = 1 + monthIndex * 0.06;

    for (const product of PRODUCTS) {
      for (const region of REGIONS) {
        for (const channel of CHANNELS) {
          // Several orders per product/region/channel/month combination.
          const orders = 2 + Math.floor(rand() * 4);
          for (let o = 0; o < orders; o++) {
            const day = 1 + Math.floor(rand() * m.days);
            const intensity =
              product.trend * region.weight * channel.weight * m.seasonal * growth;
            const quantity = Math.max(1, Math.round((1 + rand() * 6) * intensity));

            // Occasional promotional discount so average unit price varies.
            const discount = rand() < 0.18 ? 0.85 + rand() * 0.1 : 1;
            const unitPrice = Math.round(product.price * discount * 100) / 100;
            const revenue = Math.round(quantity * unitPrice * 100) / 100;

            rows.push({
              order_date: `${m.year}-${String(m.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
              product: product.name,
              category: product.category,
              region: region.name,
              channel: channel.name,
              quantity,
              unit_price: unitPrice,
              revenue,
            });
          }
        }
      }
    }
  });

  rows.sort((a, b) => a.order_date.localeCompare(b.order_date));
  return rows;
}

export const SAMPLE_COLUMNS: { name: string; sqlType: string; type: string; description: string }[] =
  [
    { name: 'order_date', sqlType: 'DATE', type: 'date', description: 'Date the order was placed' },
    { name: 'product', sqlType: 'VARCHAR', type: 'string', description: 'Product name' },
    { name: 'category', sqlType: 'VARCHAR', type: 'string', description: 'Product category' },
    { name: 'region', sqlType: 'VARCHAR', type: 'string', description: 'Sales region' },
    { name: 'channel', sqlType: 'VARCHAR', type: 'string', description: 'Sales channel' },
    { name: 'quantity', sqlType: 'BIGINT', type: 'integer', description: 'Units sold' },
    { name: 'unit_price', sqlType: 'DOUBLE', type: 'number', description: 'Price per unit in USD' },
    { name: 'revenue', sqlType: 'DOUBLE', type: 'number', description: 'quantity * unit_price in USD' },
  ];

/** Questions shown on the dashboard. Each one is answerable from this data. */
export const SAMPLE_QUESTIONS = [
  'Which products generated the most revenue?',
  'How did revenue trend month over month?',
  'Which region performed best last quarter?',
  'What is the average order value by channel?',
  'Which category has the highest units sold?',
];
