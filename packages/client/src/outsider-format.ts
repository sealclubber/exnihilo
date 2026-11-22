/**
 * Outsiders in words: what kind of traveller someone is and where they are
 * from, and the day's outsiders as the groups a list shows. Pure, so the
 * wording can be tested without a browser.
 *
 * Nothing here decides who is in town: it puts into words and into groups
 * what the server sent. The kinds and their names come from the pack.
 */
import type { Anyone, OutsidersToday, Outsider, PackLabels, RouteEnd, Seen, Traveller, Vagrant } from '@worldsim/core';
import { workName } from './city-format.ts';

/** Whether someone an answer is about is an outsider rather than a resident. */
export const isOutsider = (person: Anyone): person is Outsider => 'group' in person;

/** What a kind of traveller is called; with no kind, what a vagrant is called. */
export function kindName(kindId: string | undefined, labels: Pick<PackLabels, 'travellerKinds' | 'vagrantName'>): string {
  return kindId === undefined ? (labels.vagrantName ?? 'Vagrant') : (labels.travellerKinds[kindId] ?? kindId);
}

/** The place at the far end of a route: the settlement it leads to, or failing that the route itself. */
export function routeEndName(end: RouteEnd): string {
  return end.settlement?.name ?? end.routeName ?? end.routeId;
}

/** The route someone comes or goes by, as the end of a phrase: "by the Pusztaszian trail", "by an unnamed sea route". */
export function byRoute(end: RouteEnd): string {
  return end.routeName !== undefined ? `by the ${end.routeName}` : `by an unnamed ${end.routeKind.replace('-', ' ')}`;
}

/** The far end of a route in full: "Pusztaszi (town), by the Pusztaszian trail"; the route alone where it leads to no settlement. */
export function describeRouteEnd(end: RouteEnd): string {
  return end.settlement ? `${end.settlement.name} (${end.settlement.sizeGroup}), ${byRoute(end)}` : byRoute(end).replace(/^by /, '');
}

/** An outsider in a phrase: "Merchant from Pusztaszi", or what the pack calls a vagrant. */
export function describeOutsider(outsider: Outsider, labels: Pick<PackLabels, 'travellerKinds' | 'vagrantName'>): string {
  return outsider.group === 'vagrant' ? kindName(undefined, labels) : `${kindName(outsider.kindId, labels)} from ${routeEndName(outsider.origin)}`;
}

/** The label for someone seen on the map: a resident's name and occupation, or an outsider's name, kind and where they are from. */
export function seenLabel(person: Seen & { outsider?: true | undefined }, labels: PackLabels): string {
  if (person.outsider) return `${person.name} · ${kindName(person.kindId, labels)}${person.origin !== undefined ? ` from ${person.origin}` : ''}`;
  return person.occupationId !== undefined ? `${person.name} · ${workName(person, labels)}` : person.name;
}

/** A day as seen from another: "Today", "Yesterday", "3 days ago", "Tomorrow", "In 2 days". A traveller may have come before day 1. */
export function relativeDay(day: number, today: number): string {
  const apart = day - today;
  if (apart === 0) return 'Today';
  if (apart === -1) return 'Yesterday';
  if (apart === 1) return 'Tomorrow';
  return apart < 0 ? `${-apart} days ago` : `In ${apart} days`;
}

export interface OutsiderGroup {
  /** The kind of traveller, by ID; nothing for the vagrants. */
  kindId?: string;
  name: string;
  /** How many there are, as the server counted them. */
  count: number;
  people: Array<Traveller | Vagrant>;
}

/**
 * The day's outsiders as a list shows them: the travellers of each kind in the pack's order, with the server's
 * count, then the vagrants. A kind with nobody in town is left out.
 */
export function outsiderGroups(today: Pick<OutsidersToday, 'travellers' | 'byKind' | 'vagrants'>, labels: Pick<PackLabels, 'travellerKinds' | 'vagrantName'>): OutsiderGroup[] {
  // The pack's kinds first, in its order; then any kind the labels do not name, so that nobody sent is left out.
  const kinds = [...new Set([...Object.keys(labels.travellerKinds), ...Object.keys(today.byKind)])];
  const groups: OutsiderGroup[] = kinds
    .map((kindId) => ({ kindId, name: kindName(kindId, labels), count: today.byKind[kindId] ?? 0, people: today.travellers.filter((traveller) => traveller.kindId === kindId) }))
    .filter((group) => group.count > 0);
  if (today.vagrants.length > 0) groups.push({ name: kindName(undefined, labels), count: today.vagrants.length, people: today.vagrants });
  return groups;
}
