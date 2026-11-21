/**
 * The legend of the town map: the colour of each role that has anyone in it
 * in this town, and what the shapes mean. Colours come from the pack; the
 * viewer knows categories and workforce states, not which one is red.
 */
import type { CitySummary, PackLabels } from '@worldsim/core';
import { h } from './dom.ts';

export interface LegendEntry {
  /** The key of the colour in the pack's role colours. */
  role: string;
  name: string;
  colour: string;
}

/** The roles in use in a town, in the pack's order: categories, occupations with a colour of their own, then those not at work. */
export function legendEntries(summary: CitySummary, labels: PackLabels): LegendEntry[] {
  const entries: LegendEntry[] = [];
  const add = (role: string, name: string, people: number) => {
    const colour = labels.roleColours[role];
    if (colour !== undefined && people > 0) entries.push({ role, name, colour });
  };
  const own = Object.keys(labels.roleColours).filter((role) => labels.occupations[role] !== undefined);
  for (const category of labels.categories) {
    // Workers whose occupation has its own colour are not drawn in their category's.
    const elsewhere = own.filter((role) => labels.occupations[role]?.category === category.id).reduce((sum, role) => sum + (summary.occupations[role] ?? 0), 0);
    add(category.id, category.name, summary.categories[category.id] - elsewhere);
  }
  for (const role of own) add(role, labels.occupations[role]?.name ?? role, summary.occupations[role] ?? 0);
  add('keeping-house', 'Keeping house', summary.workforce.keepingHouse);
  add('not-working', 'Not working', summary.workforce.notWorking);
  return entries;
}

/** The legend's contents: a swatch and a name for each role, then the shapes. */
export function renderLegend(body: HTMLElement, entries: LegendEntry[]): void {
  const swatch = (colour: string, shape: string) => h('span', { class: `swatch ${shape}`, attrs: { style: `background:${colour}` } });
  body.replaceChildren(
    h(
      'ul',
      { class: 'roles' },
      ...entries.map((entry) => h('li', { attrs: { 'data-role': entry.role, 'data-colour': entry.colour } }, swatch(entry.colour, 'round'), entry.name)),
    ),
    h(
      'ul',
      { class: 'shapes' },
      h('li', {}, swatch('#555', 'round'), 'Walking somewhere'),
      h('li', {}, swatch('#555', 'square'), 'Outside at a place'),
      h('li', {}, h('span', { class: 'swatch avatar' }), 'You'),
      h('li', {}, h('span', { class: 'swatch ground' }), 'Open ground'),
      h('li', {}, h('span', { class: 'swatch built' }), 'Building'),
    ),
  );
}
