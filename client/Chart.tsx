import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Dashboard } from "./types.ts";

/** Fills days with no runs so gaps in activity stay visible. */
function fillDays(trend: Dashboard["trend"], days: number) {
  const byDay = new Map(trend.map((point) => [point.day, point]));
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(Date.now() - (days - 1 - index) * 86_400_000);
    const day = date.toISOString().slice(0, 10);
    return { day: day.slice(5).replace("-", "/"), runs: byDay.get(day)?.runs ?? 0 };
  });
}

export default function ActivityChart({ trend, days }: { trend: Dashboard["trend"]; days: number }) {
  return (
    <div className="chart" role="img" aria-label={`Review runs per day over the last ${days} days`}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={fillDays(trend, days)} margin={{ top: 8, right: 8, bottom: 0, left: -24 }}>
          <CartesianGrid vertical={false} stroke="var(--rule)" />
          <XAxis
            dataKey="day"
            tickLine={false}
            axisLine={false}
            minTickGap={36}
            tick={{ fill: "var(--ink-soft)", fontSize: 12 }}
          />
          <YAxis
            allowDecimals={false}
            tickLine={false}
            axisLine={false}
            tick={{ fill: "var(--ink-soft)", fontSize: 12 }}
          />
          <Tooltip
            cursor={{ fill: "var(--wash)" }}
            contentStyle={{
              background: "var(--surface)",
              border: "1px solid var(--rule)",
              borderRadius: 6,
              color: "var(--ink)",
            }}
          />
          <Bar dataKey="runs" name="Review runs" fill="var(--link)" radius={[2, 2, 0, 0]} maxBarSize={22} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
