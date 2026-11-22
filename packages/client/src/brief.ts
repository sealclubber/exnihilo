/**
 * Turns a settlement brief into readable text. Pure, so the wording can be
 * tested without a browser.
 */
import type { DrawTerm, NeighbourLink, RouteLead, SettlementBrief, SettlementDraw, WorldInfo } from '@worldsim/core';

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

/** What each part of a settlement's draw is for: one of the brief's flags, being a province seat, its size, or its specialties. */
const TERM_LABELS: Record<DrawTerm['term'], string> = {
  ...(Object.fromEntries(FLAG_LABELS) as Record<keyof SettlementBrief['flags'], string>),
  provinceSeat: 'Seat of the province',
  population: 'Population',
  specialties: 'Specialties',
};

/** A draw, or a part of one: at most two decimal places. */
const formatDraw = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 2 });

/** Where a route leads: "leading to Pusztaszi (town, 34 mi)". The distance is in the world's unit, when the world is known. */
function leading(lead: RouteLead | undefined, world?: WorldInfo): string {
  if (!lead) return 'leading to no settlement';
  const distance = lead.distance.toLocaleString('en-US', { maximumFractionDigits: 1 });
  return `leading to ${lead.name} (${lead.sizeGroup}, ${distance}${world ? ` ${world.distanceScale.unit}` : ''})`;
}

/** The draw of a settlement as a section: the total, what each term adds, and what the pack's rules make of it. */
function drawSection({ draw, expectedTravellers, quarterAt, hasQuarter }: SettlementDraw): BriefSection {
  return {
    heading: 'Draw',
    rows: [
      ['Total', `${formatDraw(draw.total)}, ${draw.attracts ? 'at or above' : 'below'} the floor of ${formatDraw(draw.floor)}`],
      ...draw.terms.map((term): [string, string] => [TERM_LABELS[term.term] ?? term.term, `+${formatDraw(term.value)}`]),
      ['Travellers expected', `${expectedTravellers.toLocaleString('en-US', { maximumFractionDigits: 1 })} a day`],
      ...(quarterAt !== undefined ? [['Visitors\' quarter', `${hasQuarter ? 'Yes' : 'No'}, at a draw of ${formatDraw(quarterAt)}`] as [string, string]] : []),
    ],
  };
}

/** A brief as text. With the settlement's draw, as the server worked it out, the text has a section for it. */
export function describeBrief(brief: SettlementBrief, world?: WorldInfo, draw?: SettlementDraw): BriefText {
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
            return `${name} (${exit.routeId}), toward the ${direction(exit.bearing)}, ${exit.towardCellId}, ${leading(exit.leadsTo, world)}`;
          })
        : ['None'],
  });

  if (draw) sections.push(drawSection(draw));

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
