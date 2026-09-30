import { useMemo } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { ChartSpec, QueryResult } from '@voicequery/shared';
import { formatCategory, formatCell, formatCompact, formatNumber } from '../lib/format.ts';

/**
 * Chart rendering.
 *
 * Colours come from the validated categorical palette defined in index.css and
 * are assigned in fixed slot order — never cycled, never reassigned by rank,
 * so a value keeps its colour when a filter changes the series set.
 *
 * Three of the light-mode slots sit below 3:1 against the light surface, which
 * the palette validation flags as requiring "relief". The relief here is
 * structural: every chart is rendered directly above the full result table, so
 * no value is ever conveyed by colour alone.
 */

const SERIES_VARS = [
  'var(--series-1)',
  'var(--series-2)',
  'var(--series-3)',
  'var(--series-4)',
  'var(--series-5)',
  'var(--series-6)',
] as const;

const seriesColor = (index: number) => SERIES_VARS[index % SERIES_VARS.length]!;

const AXIS_STYLE = { fontSize: 12, fill: 'var(--text-muted)' } as const;

function TooltipContent({
  active,
  payload,
  label,
  valueFormat,
}: {
  active?: boolean;
  payload?: { name?: string; value?: unknown; color?: string; dataKey?: string }[];
  label?: unknown;
  valueFormat: ChartSpec['valueFormat'];
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-[var(--border-strong)] bg-[var(--surface-raised)] px-3 py-2 text-xs shadow-lg">
      <p className="mb-1 font-medium text-[var(--text-primary)]">{formatCell(label)}</p>
      {payload.map((entry, i) => (
        <div key={i} className="flex items-center gap-2 text-[var(--text-secondary)]">
          <span
            aria-hidden="true"
            className="inline-block h-2 w-2 shrink-0 rounded-full"
            style={{ background: entry.color }}
          />
          <span>{entry.name ?? entry.dataKey}</span>
          <span className="ml-auto font-medium text-[var(--text-primary)]">
            {formatNumber(entry.value, valueFormat)}
          </span>
        </div>
      ))}
    </div>
  );
}

export function Chart({ spec, result }: { spec: ChartSpec; result: QueryResult }) {
  // Charting hundreds of categories is unreadable; cap the plotted rows and
  // say so. The table below still shows everything that was returned.
  const MAX_POINTS = spec.kind === 'pie' ? 8 : 60;

  const data = useMemo(
    () =>
      result.rows.slice(0, MAX_POINTS).map((row) => {
        const point: Record<string, unknown> = { ...row };
        point.__label = formatCell(row[spec.xKey]);
        return point;
      }),
    [result.rows, spec.xKey, MAX_POINTS],
  );

  const clipped = result.rows.length > MAX_POINTS;
  const valueFormat = spec.valueFormat ?? 'number';
  const showLegend = spec.yKeys.length >= 2;

  const tooltip = (
    <Tooltip
      content={<TooltipContent valueFormat={valueFormat} />}
      cursor={{ fill: 'var(--surface-2)', opacity: 0.55 }}
    />
  );
  const grid = <CartesianGrid stroke="var(--grid)" strokeDasharray="3 3" vertical={false} />;
  const legend = showLegend ? (
    <Legend
      wrapperStyle={{ fontSize: 12, color: 'var(--text-secondary)', paddingTop: 8 }}
      iconType="circle"
      iconSize={8}
    />
  ) : null;

  const yAxis = (
    <YAxis
      tick={AXIS_STYLE}
      tickLine={false}
      axisLine={false}
      width={64}
      tickFormatter={(v: unknown) => formatCompact(v, valueFormat)}
    />
  );

  function renderChart() {
    switch (spec.kind) {
      case 'horizontalBar':
        return (
          <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
            {grid}
            <XAxis
              type="number"
              tick={AXIS_STYLE}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: unknown) => formatCompact(v, valueFormat)}
            />
            <YAxis
              type="category"
              dataKey="__label"
              tick={AXIS_STYLE}
              tickLine={false}
              axisLine={false}
              width={130}
            />
            {tooltip}
            {legend}
            {spec.yKeys.map((key, i) => (
              // 2px surface-coloured stroke keeps adjacent fills separated.
              <Bar
                key={key}
                dataKey={key}
                fill={seriesColor(i)}
                radius={[0, 4, 4, 0]}
                stroke="var(--surface-raised)"
                strokeWidth={2}
              />
            ))}
          </BarChart>
        );

      case 'line':
        return (
          <LineChart data={data} margin={{ top: 4, right: 16, bottom: 4, left: 0 }}>
            {grid}
            <XAxis
              dataKey="__label"
              tick={AXIS_STYLE}
              tickLine={false}
              axisLine={false}
              tickFormatter={formatCategory}
              minTickGap={16}
            />
            {yAxis}
            {tooltip}
            {legend}
            {spec.yKeys.map((key, i) => (
              <Line
                key={key}
                type="monotone"
                dataKey={key}
                stroke={seriesColor(i)}
                strokeWidth={2}
                dot={{ r: 3, strokeWidth: 0, fill: seriesColor(i) }}
                activeDot={{ r: 5, stroke: 'var(--surface-raised)', strokeWidth: 2 }}
              />
            ))}
          </LineChart>
        );

      case 'area':
        return (
          <AreaChart data={data} margin={{ top: 4, right: 16, bottom: 4, left: 0 }}>
            {grid}
            <XAxis
              dataKey="__label"
              tick={AXIS_STYLE}
              tickLine={false}
              axisLine={false}
              tickFormatter={formatCategory}
              minTickGap={16}
            />
            {yAxis}
            {tooltip}
            {legend}
            {spec.yKeys.map((key, i) => (
              <Area
                key={key}
                type="monotone"
                dataKey={key}
                stroke={seriesColor(i)}
                strokeWidth={2}
                fill={seriesColor(i)}
                fillOpacity={0.16}
              />
            ))}
          </AreaChart>
        );

      case 'pie': {
        const key = spec.yKeys[0]!;
        return (
          <PieChart>
            <Pie
              data={data}
              dataKey={key}
              nameKey="__label"
              innerRadius="52%"
              outerRadius="78%"
              paddingAngle={2}
              stroke="var(--surface-raised)"
              strokeWidth={2}
            >
              {data.map((_, i) => (
                <Cell key={i} fill={seriesColor(i)} />
              ))}
            </Pie>
            {tooltip}
            <Legend
              wrapperStyle={{ fontSize: 12, color: 'var(--text-secondary)' }}
              iconType="circle"
              iconSize={8}
            />
          </PieChart>
        );
      }

      case 'scatter': {
        const [xKey, yKey] = [spec.yKeys[0]!, spec.yKeys[1] ?? spec.yKeys[0]!];
        return (
          <ScatterChart margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
            {grid}
            <XAxis
              type="number"
              dataKey={xKey}
              name={xKey}
              tick={AXIS_STYLE}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: unknown) => formatCompact(v, valueFormat)}
            />
            <YAxis
              type="number"
              dataKey={yKey}
              name={yKey}
              tick={AXIS_STYLE}
              tickLine={false}
              axisLine={false}
              width={64}
              tickFormatter={(v: unknown) => formatCompact(v, valueFormat)}
            />
            {tooltip}
            <Scatter data={data} fill={seriesColor(0)} />
          </ScatterChart>
        );
      }

      case 'bar':
      default:
        return (
          <BarChart data={data} margin={{ top: 4, right: 16, bottom: 4, left: 0 }}>
            {grid}
            <XAxis
              dataKey="__label"
              tick={AXIS_STYLE}
              tickLine={false}
              axisLine={false}
              tickFormatter={formatCategory}
              interval="preserveStartEnd"
              minTickGap={8}
            />
            {yAxis}
            {tooltip}
            {legend}
            {spec.yKeys.map((key, i) => (
              <Bar
                key={key}
                dataKey={key}
                fill={seriesColor(i)}
                radius={[4, 4, 0, 0]}
                stroke="var(--surface-raised)"
                strokeWidth={2}
              />
            ))}
          </BarChart>
        );
    }
  }

  return (
    <figure className="m-0">
      <figcaption className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-sm font-semibold text-[var(--text-primary)]">{spec.title}</h4>
        {clipped && (
          <span className="text-xs text-[var(--text-muted)]">
            Showing the first {MAX_POINTS} of {result.rows.length.toLocaleString()} rows — the
            table below has them all
          </span>
        )}
      </figcaption>
      <div className="h-72 w-full" role="img" aria-label={`${spec.kind} chart: ${spec.title}`}>
        <ResponsiveContainer width="100%" height="100%">
          {renderChart()}
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
