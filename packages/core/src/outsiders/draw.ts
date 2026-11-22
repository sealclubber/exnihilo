/**
 * What a settlement's brief says about the people who come to it: its draw,
 * and how many travellers the pack's rules expect in a day.
 *
 * Everything here is a function of the brief and the pack alone, so the city
 * generator may use it: the brief is still its only world input.
 */
import { type Condition, type SettingPack, type TravellerKind, CONDITIONS } from '../pack/schema.ts';
import type { RouteKind, SettlementBrief } from '../schema.ts';

/** One part of a settlement's draw: what it is for, and what it adds. */
export interface DrawTerm {
  /** A flag or status of the brief, `population` or `specialties`. */
  term: Condition | 'population' | 'specialties';
  value: number;
}

/** A settlement's draw, and why. */
export interface Draw {
  /** The sum of the terms. */
  total: number;
  /** The pack's floor: below it the settlement draws no visitors who have no business there. */
  floor: number;
  /** Whether the total reaches the floor. */
  attracts: boolean;
  /** Every term that adds something, flags first in the pack's order. */
  terms: DrawTerm[];
}

const conditionsOf = (brief: SettlementBrief): Record<Condition, boolean> => ({ ...brief.flags, provinceSeat: brief.isProvinceSeat });

/** How much a settlement attracts visitors who have no business there, by the pack's rules. Nothing for a pack with no travellers file. */
export function drawOf(brief: SettlementBrief, pack: SettingPack): Draw {
  const rules = pack.travellers?.draw;
  if (!rules) return { total: 0, floor: 0, attracts: false, terms: [] };
  const met = conditionsOf(brief);
  const terms: DrawTerm[] = [];
  for (const condition of CONDITIONS) {
    const value = rules.conditions[condition] ?? 0;
    if (met[condition] && value > 0) terms.push({ term: condition, value });
  }
  const size = Math.min((brief.population / 1000) * rules.population.perThousand, rules.population.max ?? Infinity);
  if (size > 0) terms.push({ term: 'population', value: size });
  const tags = brief.specialtyTags.filter((tag) => !pack.specialties.tags[tag]?.ignore).length;
  const known = Math.min(tags, rules.specialties.maxTags) * rules.specialties.perTag;
  if (known > 0) terms.push({ term: 'specialties', value: known });
  const total = terms.reduce((sum, term) => sum + term.value, 0);
  return { total, floor: rules.floor, attracts: total >= rules.floor, terms };
}

/** The exits of a brief by kind of route. */
function exitsByKind(brief: SettlementBrief): Record<RouteKind, number> {
  const counts: Record<RouteKind, number> = { road: 0, trail: 0, 'sea-route': 0 };
  for (const exit of brief.routes) counts[exit.kind]++;
  return counts;
}

/** The average number of parties of a kind that arrive on a day of the week, counting from 0. */
export function arrivalRate(kind: TravellerKind, brief: SettlementBrief, pack: SettingPack, weekday: number): number {
  const { base = 0, perThousandResidents = 0, perExit = {}, perDraw = 0, weekdays = {} } = kind.arrivals;
  const exits = exitsByKind(brief);
  const draw = perDraw > 0 ? drawOf(brief, pack) : undefined;
  const rate =
    base +
    (perThousandResidents * brief.population) / 1000 +
    (perExit.road ?? 0) * exits.road +
    (perExit.trail ?? 0) * exits.trail +
    (perExit['sea-route'] ?? 0) * exits['sea-route'] +
    (draw?.attracts ? perDraw * draw.total : 0);
  // Nobody arrives in a settlement that no route reaches.
  if (brief.routes.length === 0) return 0;
  return rate * (weekdays[(pack.calendar.week[weekday] as SettingPack['calendar']['week'][number]).name] ?? 1);
}

/**
 * How many travellers the pack's rules expect to arrive in a day, averaged over the week: for each kind, its
 * parties a day times the middle of its party size. Nothing for a pack with no travellers file.
 */
export function expectedTravellers(brief: SettlementBrief, pack: SettingPack): number {
  const kinds = pack.travellers?.kinds ?? [];
  const days = pack.calendar.week.length;
  let expected = 0;
  for (const kind of kinds) {
    let parties = 0;
    for (let weekday = 0; weekday < days; weekday++) parties += arrivalRate(kind, brief, pack, weekday);
    expected += (parties / days) * ((kind.partySize.min + kind.partySize.max) / 2);
  }
  return expected;
}
