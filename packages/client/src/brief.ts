/**
 * Turns a settlement brief into readable text. Pure, so the wording can be
 * tested without a browser.
 */
import type { NeighbourLink, SettlementBrief, WorldInfo } from '@worldsim/core';

export interface BriefSection {
  heading: string;
  /** Label and value pairs. */
  rows?: Array<[string, string]>;
  /** Free-standing lines, shown as a list. */
  lines?: string[];
}

export interface BriefText {
  title: string;
  subtitle: string;
  sections: BriefSection[];
}

const COMPASS = [
  'north',
  'north-northeast',
  'northeast',
  'east-northeast',
  'east',
  'east-southeast',
  'southeast',
  'south-southeast',
  'south',
  'south-southwest',
  'southwest',
  'west-southwest',
  'west',
  'west-northwest',
  'northwest',
  'north-northwest',
];

/** The nearest of the sixteen compass points to a bearing in degrees. */
export function compassPoint(bearing: number): string {
  return COMPASS[Math.round(bearing / 22.5) % 16] as string;
}

export function formatNumber(value: number): string {
  return value.toLocaleString('en-US');
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function direction(bearing: number): string {
  return `${compassPoint(bearing)} (${bearing}°)`;
}

function link(prefix: string, target: NeighbourLink | undefined, absent: string): string {
  return target ? `${prefix} the ${direction(target.bearing)}, ${target.cellId}` : absent;
}

const FLAG_LABELS: Array<[keyof SettlementBrief['flags'], string]> = [
  ['capital', 'Capital'],
  ['port', 'Port'],
  ['citadel', 'Citadel'],
  ['walls', 'Walls'],
  ['plaza', 'Plaza'],
  ['temple', 'Temple'],
  ['shantyTown', 'Shanty town'],
];

export function describeBrief(brief: SettlementBrief, world?: WorldInfo): BriefText {
  const stateName = brief.state.fullName ?? brief.state.name;
  const sections: BriefSection[] = [];

  sections.push({
    heading: 'Overview',
    rows: [
      ['Size group', capitalise(brief.sizeGroup)],
      ['Population', formatNumber(brief.population)],
      ['Rural population', formatNumber(brief.ruralPopulation)],
      ['State', `${stateName} (${brief.state.id})`],
      [
        'Province',
        brief.province
          ? `${brief.province.fullName} (${brief.province.id})${brief.isProvinceSeat ? ', seat of the province' : ''}`
          : 'None',
      ],
      ['Culture', `${brief.culture.name} (${brief.culture.id})`],
      ['Religion', `${brief.religion.name} (${brief.religion.id})`],
    ],
  });

  sections.push({
    heading: 'Features',
    rows: FLAG_LABELS.map(([flag, label]) => [label, brief.flags[flag] ? 'Yes' : 'No']),
  });

  sections.push({
    heading: 'Specialties',
    lines: brief.specialtyTags.length > 0 ? [brief.specialtyTags.join(', ')] : ['None'],
  });

  sections.push(
    brief.river
      ? {
          heading: 'River',
          rows: [
            ['Name', `${brief.river.name} (${brief.river.id})`],
            ['Arrives', link('From', brief.river.arrivesFrom, 'Rises here')],
            ['Leaves', link('Toward', brief.river.leavesToward, 'Ends here')],
          ],
        }
      : { heading: 'River', lines: ['None'] },
  );

  sections.push({
    heading: `Routes (${brief.routes.length} ${brief.routes.length === 1 ? 'exit' : 'exits'})`,
    lines:
      brief.routes.length > 0
        ? brief.routes.map((exit) => {
            const kind = exit.kind.replace('-', ' ');
            const name = exit.name ? `${exit.name}, a ${kind}` : `Unnamed ${kind}`;
            return `${name} (${exit.routeId}), toward the ${direction(exit.bearing)}, ${exit.towardCellId}`;
          })
        : ['None'],
  });

  sections.push({
    heading: 'Coast',
    lines: [
      brief.coast.waterBearing !== undefined
        ? `Coastal, open water to the ${direction(brief.coast.waterBearing)}`
        : brief.coast.isCoastal
          ? 'Coastal'
          : 'Not coastal',
    ],
  });

  sections.push({
    heading: 'Climate',
    rows: [
      ['Biome', brief.climate.biome],
      ['Height', `${brief.climate.height} of 100`],
      ['Temperature', `${brief.climate.temperature} °C`],
    ],
  });

  const [x, y] = brief.position;
  sections.push({
    heading: 'Reference',
    rows: [
      ['ID', brief.id],
      ['Cell', brief.cellId],
      ['Position', `${x}, ${y}`],
      ['Seed', String(brief.seed)],
    ],
  });

  return {
    title: brief.name,
    subtitle: `${capitalise(brief.sizeGroup)} in ${stateName}${world ? `, ${world.currentYear} ${world.eraName}` : ''}`,
    sections,
  };
}
