/**
 * A readable text summary of a generated city, and the display names a
 * viewer needs to label its records.
 */
import type { PackLabels } from '../api.ts';
import { type SettingPack, allOccupations, roleColours } from '../pack/schema.ts';
import type { City } from './records.ts';

/** Display names for everything a city's records refer to by ID. */
export function packLabels(pack: SettingPack): PackLabels {
  return {
    name: pack.pack.name,
    version: pack.pack.version,
    categories: pack.categories.map((category) => ({ id: category.id, name: category.name })),
    statusTiers: pack.pack.statusTiers,
    ...(pack.pack.apprenticeLabel !== undefined && { apprenticeLabel: pack.pack.apprenticeLabel }),
    ...(pack.pack.homeAndWorkLabel !== undefined && { homeAndWorkLabel: pack.pack.homeAndWorkLabel }),
    occupations: Object.fromEntries(
      allOccupations(pack).map((occupation) => [occupation.id, { name: occupation.name, category: occupation.category }]),
    ),
    buildingTypes: Object.fromEntries(
      [...pack.landmarks, ...pack.workplaces, ...pack.dwellings].map((type) => [type.id, type.name]),
    ),
    districtKinds: Object.fromEntries(pack.districts.kinds.map((kind) => [kind.id, kind.name])),
    calendar: pack.calendar,
    avatar: pack.avatar,
    roleColours: roleColours(pack),
    visits: Object.fromEntries([...pack.visits.visits, ...(pack.travellers?.visits ?? [])].map((visit) => [visit.id, visit.name])),
    travellerKinds: Object.fromEntries((pack.travellers?.kinds ?? []).map((kind) => [kind.id, kind.name])),
    ...(pack.travellers?.vagrants && { vagrantName: pack.travellers.vagrants.name }),
  };
}

const number = (value: number) => value.toLocaleString('en-US');
const percent = (part: number, whole: number) => `${whole === 0 ? '0.0' : ((part / whole) * 100).toFixed(1)}%`;

function table(rows: string[][], rightAligned: number[]): string[] {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => (row[column] as string).length)));
  return rows.map((row) =>
    `  ${row
      .map((cell, column) =>
        rightAligned.includes(column) ? cell.padStart(widths[column] as number) : cell.padEnd(widths[column] as number),
      )
      .join('  ')}`.trimEnd(),
  );
}

export function describeCity(city: City, pack: SettingPack): string {
  const { summary } = city;
  const labels = packLabels(pack);
  const lines: string[] = [];
  const section = (title: string, rows: string[][], rightAligned: number[]) => {
    lines.push('', title, ...table(rows, rightAligned));
  };

  lines.push(
    `${summary.settlementName} (${summary.settlementId})`,
    `Generator version ${summary.generatorVersion}, pack ${summary.pack.name} ${summary.pack.version}, seed ${summary.seed}`,
  );
  section(
    'Totals',
    [
      ['Residents', number(summary.population)],
      ['Households', number(summary.households)],
      ['Buildings', number(summary.buildings)],
      ['Districts', number(summary.districts)],
    ],
    [1],
  );
  section(
    'Workforce',
    [
      ['Working', number(summary.workforce.working), percent(summary.workforce.working, summary.population)],
      ['Keeping house', number(summary.workforce.keepingHouse), percent(summary.workforce.keepingHouse, summary.population)],
      ['Not working', number(summary.workforce.notWorking), percent(summary.workforce.notWorking, summary.population)],
    ],
    [1, 2],
  );
  section(
    'Categories (workers, share of the workforce after modifiers)',
    labels.categories.map((category) => [
      category.name,
      number(summary.categories[category.id]),
      `${(summary.shares[category.id] * 100).toFixed(1)}%`,
    ]),
    [1, 2],
  );

  lines.push('', 'Occupations');
  for (const category of labels.categories) {
    const rows = Object.entries(summary.occupations)
      .filter(([id]) => labels.occupations[id]?.category === category.id)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([id, count]) => [`  ${labels.occupations[id]?.name ?? id}`, number(count)]);
    if (rows.length > 0) lines.push(`  ${category.name}`, ...table(rows, [1]));
  }

  section(
    'Status tiers (households, residents)',
    labels.statusTiers.map((tier) => [
      tier.name,
      number(summary.statusTiers[tier.id]?.households ?? 0),
      number(summary.statusTiers[tier.id]?.residents ?? 0),
    ]),
    [1, 2],
  );
  section(
    'Districts (residents, households, buildings, workers)',
    city.districts.map((district) => {
      const totals = summary.districtTotals[district.id]!;
      return [
        district.name,
        labels.districtKinds[district.kind] ?? district.kind,
        number(totals.residents),
        number(totals.households),
        number(totals.buildings),
        number(totals.workers),
      ];
    }),
    [2, 3, 4, 5],
  );

  const byType = new Map<string, number>();
  for (const building of city.buildings) byType.set(building.type, (byType.get(building.type) ?? 0) + 1);
  section(
    'Buildings by type',
    Object.keys(labels.buildingTypes)
      .filter((type) => byType.has(type))
      .map((type) => [labels.buildingTypes[type] as string, number(byType.get(type) as number)]),
    [1],
  );

  return `${lines.join('\n')}\n`;
}
