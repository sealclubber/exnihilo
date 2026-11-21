/**
 * A settlement's day as text: the hourly counts and the busiest segments.
 */
import type { Layout } from '../layout/records.ts';
import type { SettingPack } from '../pack/schema.ts';
import { describeMoment, formatTimeOfDay, startOfDay } from './calendar.ts';
import type { SettlementLife } from './life.ts';

const BUSIEST_SHOWN = 10;

export function describeDay(life: SettlementLife, day: number, inputs: { layout: Layout; pack: SettingPack; settlementName: string }): string {
  const { layout, pack, settlementName } = inputs;
  const moment = describeMoment(startOfDay(day), pack.calendar);
  const summary = life.daySummary(day);
  const whole = (value: number) => Math.round(value).toLocaleString('en-US');
  const lines = [
    `${settlementName}, day ${day}: ${moment.weekdayName}${moment.isRestDay ? ', a rest day' : ''}`,
    `Sunrise ${formatTimeOfDay(pack.calendar.sunrise)}, sunset ${formatTimeOfDay(pack.calendar.sunset)}. ${summary.trips.toLocaleString('en-US')} trips begun.`,
    '',
    'Average number of people in each state during each hour, and trips begun in it.',
    'Outside counts those at work or visiting who are out of doors.',
  ];
  const rows = [
    ['Hour', 'Asleep', 'At home', 'At work', 'Visiting', 'Travelling', 'Outside', 'Trips begun'],
    ...summary.hours.map((hour) => [
      `${String(hour.hour).padStart(2, '0')}:00`,
      whole(hour.asleep),
      whole(hour.atHome),
      whole(hour.atWork),
      whole(hour.visiting),
      hour.travelling.toFixed(1),
      whole(hour.outside),
      hour.tripsStarted.toLocaleString('en-US'),
    ]),
  ];
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => (row[column] as string).length)));
  for (const row of rows) lines.push(`  ${row.map((cell, column) => (column === 0 ? cell.padEnd(widths[column] as number) : cell.padStart(widths[column] as number))).join('  ')}`);

  const segments = new Map(layout.segments.map((segment) => [segment.id, segment]));
  lines.push('', 'Busiest segments (trips that use them)');
  for (const { segmentId, trips } of life.segmentLoads(day).slice(0, BUSIEST_SHOWN)) {
    const segment = segments.get(segmentId);
    const what = segment ? `${segment.kind}${segment.name ? `, ${segment.name}` : ''}` : '';
    lines.push(`  ${segmentId}  ${trips.toLocaleString('en-US').padStart(6)}  ${what}`);
  }
  return `${lines.join('\n')}\n`;
}
