/**
 * Phase 6C: people who do not live in town. Travellers, who arrive by the
 * roads and the sea and leave again, and vagrants, who live on the streets;
 * and every query answering for them as it does for residents.
 */
import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type Activity,
  type City,
  type Layout,
  type Outsiders,
  type Party,
  type Point,
  type SettingPack,
  type SettlementBrief,
  type SettlementLife,
  type Traveller,
  DayPlanSchema,
  DaySummarySchema,
  LIFE_VERSION,
  NearbySchema,
  OutsiderSchema,
  PackError,
  PartySchema,
  SECONDS_PER_DAY,
  TravellerIdSchema,
  TripSchema,
  OutsideStaySchema,
  WhereaboutsSchema,
  arrivalRate,
  avatarTown,
  createLife,
  createOutsiderChecker,
  createOutsiders,
  createPathFinder,
  createRng,
  dayOf,
  generateCity,
  generateLayout,
  geometry,
  isOutsiderId,
  parsePack,
  perceive,
  sleepingPlacesAt,
  spawnAvatar,
  startOfDay,
  walkToBuilding,
} from '../src/index.ts';
import { inYardsticks } from './cost.ts';
import { medievalPack, medievalPackBefore6C, rawMedievalPack, settlement } from './pack.ts';

const SLOW = 240_000;
const pack = medievalPack();
const rules = pack.travellers!;
const { distance } = geometry;
const at = (day: number, hours: number, minutes = 0) => startOfDay(day) + hours * 3600 + minutes * 60;
const edited = (edit: (raw: any) => void): SettingPack => {
  const raw = rawMedievalPack();
  edit(raw);
  return parsePack(raw);
};
interface Town {
  brief: SettlementBrief;
  city: City;
  layout: Layout;
  life: SettlementLife;
  outsiders: Outsiders;
}
const town = (brief: SettlementBrief, packUsed: SettingPack = pack): Town => {
  const city = generateCity(brief, packUsed);
  const layout = generateLayout(city, brief, packUsed);
  const life = createLife({ city, layout, pack: packUsed, brief });
  return { brief, city, layout, life, outsiders: life.outsiders! };
};
/** A made-up settlement: Vereceldo's brief with some of it replaced. */
const madeUp = (changes: Partial<SettlementBrief>): SettlementBrief => ({
  ...settlement('settlement-455'),
  flags: { capital: false, port: false, citadel: false, walls: false, plaza: false, temple: false, shantyTown: false },
  isProvinceSeat: false,
  specialtyTags: [],
  ...changes,
});
const WORK_DAYS = [8, 9, 10, 11, 12, 13];
const REST_DAY = 14;
/** The parties that arrive over a run of days. */
const arrivalsOver = (outsiders: Outsiders, from: number, to: number): Party[] => Array.from({ length: to - from + 1 }, (_, index) => outsiders.arrivals(from + index)).flat();
const travellersOf = (outsiders: Outsiders, party: Party): Traveller[] => party.memberIds.map((id) => outsiders.outsider(id) as Traveller);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

let badanos: Town;
let vereceldo: Town;
beforeAll(() => {
  badanos = town(settlement('settlement-641'));
  vereceldo = town(settlement('settlement-455'));
}, SLOW);

describe('the medieval pack\'s outsiders', () => {
  it('has five kinds of traveller, each with a colour, and vagrants, at life version 5', () => {
    expect(rules.kinds.map((kind) => kind.id)).toEqual(['merchant', 'tourist', 'adventurer', 'mercenary', 'passing-through']);
    expect(Object.keys(pack.display.travellers!).sort()).toEqual(rules.kinds.map((kind) => kind.id).sort());
    expect(pack.display.vagrants).toMatch(/^#/);
    // Tourists depend on the draw, and on nothing else.
    expect(rules.kinds.find((kind) => kind.id === 'tourist')!.arrivals).toEqual({ perDraw: 0.3 });
    // Adventurers and mercenaries lodge at the adventurers' guild hall or an inn.
    for (const id of ['adventurer', 'mercenary']) expect(rules.kinds.find((kind) => kind.id === id)!.lodging).toEqual(['adventurers-guild', 'inn']);
    // People passing through may not lodge at all, and leave by another exit.
    expect(rules.kinds.find((kind) => kind.id === 'passing-through')).toMatchObject({ nights: { min: 0, max: 1 }, leaves: 'other' });
    expect(rules.vagrants).toMatchObject({ sleepsAt: ['lane', 'bridge-end', 'edge'] });
    expect(LIFE_VERSION).toBe(5);
  });
});

describe('arrivals', () => {
  it('are the same however they are asked for, and whatever was computed first', () => {
    const { brief, city, layout } = badanos;
    const fresh = () => createOutsiders({ brief, city, layout, pack });
    const direct = fresh();
    const wanted = JSON.stringify(direct.arrivals(40));
    // After every day before it; after asking who is in town later; through daily life; and a second time.
    const inOrder = fresh();
    for (let day = 1; day < 40; day++) inOrder.arrivals(day);
    const backwards = fresh();
    backwards.inTown(45);
    backwards.plansForDay(41);
    for (const other of [inOrder, backwards, createLife({ city, layout, pack, brief }).outsiders!, direct]) expect(JSON.stringify(other.arrivals(40))).toBe(wanted);
    expect(direct.arrivals(40).length).toBeGreaterThan(3);
    // And each traveller's record and plan with them.
    for (const party of direct.arrivals(40)) {
      for (const id of party.memberIds) {
        expect(inOrder.outsider(id)).toEqual(direct.outsider(id));
        expect(JSON.stringify(backwards.plan(id, 40))).toBe(JSON.stringify(direct.plan(id, 40)));
      }
    }
    // A different seed brings different people.
    expect(JSON.stringify(createOutsiders({ brief, city, layout, pack, seed: 7 }).arrivals(40))).not.toBe(wanted);
  });

  it('give every party and traveller a record that fits its schema, with an ID from which the visit can be found again', () => {
    const { outsiders } = badanos;
    const parties = arrivalsOver(outsiders, -2, 10);
    expect(parties.length).toBeGreaterThan(60);
    const ids = new Set<string>();
    for (const party of parties) {
      expect(PartySchema.safeParse(party).success, party.id).toBe(true);
      expect(outsiders.party(party.id)).toEqual(party);
      const kind = rules.kinds.find((entry) => entry.id === party.kindId)!;
      expect(party.memberIds.length).toBeGreaterThanOrEqual(kind.partySize.min);
      expect(party.memberIds.length).toBeLessThanOrEqual(kind.partySize.max);
      expect(dayOf(party.arrival.time)).toBe(party.arrivalDay);
      for (const traveller of travellersOf(outsiders, party)) {
        expect(OutsiderSchema.safeParse(traveller).success, traveller.id).toBe(true);
        expect(TravellerIdSchema.safeParse(traveller.id).success).toBe(true);
        expect(isOutsiderId(traveller.id)).toBe(true);
        expect(traveller).toMatchObject({ group: 'traveller', kindId: party.kindId, partyId: party.id, arrival: party.arrival, departure: party.departure, origin: party.origin });
        expect(traveller.age).toBeGreaterThanOrEqual(kind.ages.min);
        expect(traveller.age).toBeLessThanOrEqual(kind.ages.max);
        expect(outsiders.party(traveller.id)).toEqual(party);
        expect(ids.has(traveller.id)).toBe(false);
        ids.add(traveller.id);
      }
    }
    // A party that arrived before day 1 has an `m` in its ID.
    expect(parties.some((party) => /-m00000[12]-/.test(party.id))).toBe(true);
    expect(outsiders.outsider('traveller-641-000003-merchant-999-01')).toBeUndefined();
    expect(outsiders.outsider('traveller-5-000003-merchant-001-01')).toBeUndefined();
  });

  it('stay as long as the kind says, lodging at a building of a type it names', () => {
    const { outsiders, city } = badanos;
    const typeOf = new Map(city.buildings.map((building) => [building.id, building.type]));
    const lodged = new Map<string, number>();
    for (const party of arrivalsOver(outsiders, 1, 20)) {
      const kind = rules.kinds.find((entry) => entry.id === party.kindId)!;
      expect(party.nights).toBeGreaterThanOrEqual(kind.nights.min);
      expect(party.nights).toBeLessThanOrEqual(kind.nights.max);
      if (party.nights === 0) {
        // On the way through: no lodging, and gone within a few hours.
        expect(party.lodgingId).toBeUndefined();
        expect(party.departure.time - party.arrival.time).toBeLessThan(8 * 3600);
        continue;
      }
      expect(kind.lodging).toContain(typeOf.get(party.lodgingId!));
      expect(dayOf(party.departure.time)).toBe(party.arrivalDay + party.nights);
      lodged.set(`${party.kindId}:${typeOf.get(party.lodgingId!)}`, (lodged.get(`${party.kindId}:${typeOf.get(party.lodgingId!)}`) ?? 0) + 1);
    }
    // Merchants at the inns; adventurers at the guild hall and at the inns.
    expect(lodged.get('merchant:inn')).toBeGreaterThan(50);
    expect(lodged.get('adventurer:adventurers-guild')).toBeGreaterThan(2);
    expect(lodged.get('adventurer:inn')).toBeGreaterThan(2);
  });
});

describe('who is in town', () => {
  it('is, by brute force, every party of earlier days whose stay covers the day, and that day\'s arrivals', () => {
    for (const { outsiders } of [badanos, vereceldo]) {
      for (const day of [1, 9, REST_DAY, 40]) {
        const from = startOfDay(day);
        const expected: string[] = [];
        // Twenty days back is far longer than any stay.
        for (let arrived = day - 20; arrived <= day; arrived++) {
          for (const party of outsiders.arrivals(arrived)) {
            if (arrived === day || party.departure.time > from) expected.push(party.id);
          }
        }
        expect(outsiders.partiesInTown(day).map((party) => party.id)).toEqual(expected);
        const people = outsiders.partiesInTown(day).flatMap((party) => party.memberIds);
        expect(outsiders.inTown(day).map((outsider) => outsider.id)).toEqual([...people, ...outsiders.vagrants().map((vagrant) => vagrant.id)]);
        // Everyone in town has a plan for the day, and nobody else has one.
        expect(outsiders.plansForDay(day).map((plan) => plan.personId)).toEqual(outsiders.inTown(day).map((outsider) => outsider.id));
      }
    }
    expect(badanos.outsiders.partiesInTown(40).length).toBeGreaterThan(10);
  });

  it('does not need the days before: day 40 asked alone gives what it gives after every day before it', () => {
    const { brief, city, layout } = badanos;
    const alone = createOutsiders({ brief, city, layout, pack });
    const after = createOutsiders({ brief, city, layout, pack });
    for (let day = 1; day < 40; day++) after.plansForDay(day);
    expect(digest(alone.plansForDay(40))).toBe(digest(after.plansForDay(40)));
    expect(alone.inTown(40)).toEqual(after.inTown(40));
  });
});

describe('a traveller\'s visit', () => {
  it('enters at an exit junction and leaves at one, walking on the street graph, and is nowhere before or after', () => {
    const { outsiders, life, layout } = badanos;
    const junctions = new Map(layout.junctions.map((junction) => [junction.id, junction]));
    const exitPoint = new Map(layout.exits.map((exit) => [exit.id, junctions.get(exit.junctionId)!]));
    const ends = new Map(layout.segments.map((segment) => [segment.id, [segment.fromJunctionId, segment.toJunctionId]]));
    let walks = 0;
    for (const party of arrivalsOver(outsiders, 1, 7)) {
      const id = party.memberIds[0]!;
      const { arrival, departure } = party;
      const activities: Activity[] = [];
      for (let day = party.arrivalDay; day <= dayOf(departure.time); day++) activities.push(...life.plan(id, day).activities);
      const first = activities[0]!;
      const last = activities[activities.length - 1]!;
      // In by an exit junction, at the moment of arrival; out by one, at the moment of departure.
      expect(exitPoint.get(arrival.exitId)!.kind).toBe('exit');
      expect(first.kind).toBe('travel');
      if (first.kind === 'travel') {
        expect(first.departAt).toBe(arrival.time);
        expect(distance(first.fromStreet!.point, exitPoint.get(arrival.exitId)!.position)).toBeLessThan(1e-6);
        expect(distance(first.path.points[0]!, exitPoint.get(arrival.exitId)!.position)).toBeLessThan(1e-6);
      }
      expect(last.kind).toBe('travel');
      if (last.kind === 'travel') {
        expect(last.arriveAt).toBe(departure.time);
        expect(distance(last.toStreet!.point, exitPoint.get(departure.exitId)!.position)).toBeLessThan(1e-6);
      }
      // Every walk runs along segments that join end to end.
      for (const activity of activities) {
        if (activity.kind !== 'travel') continue;
        walks++;
        const segments = activity.path.segmentIds.filter((segment, index, list) => segment !== list[index - 1]);
        segments.forEach((segment, index) => {
          if (index > 0) expect(ends.get(segment)!.some((junction) => ends.get(segments[index - 1]!)!.includes(junction)), `${id}: ${segments[index - 1]} to ${segment}`).toBe(true);
        });
      }
      // Nowhere before arriving or after leaving; somewhere in between.
      for (const member of party.memberIds) {
        expect(life.whereabouts(member, arrival.time - 1)).toEqual({ personId: member, outsider: true, time: arrival.time - 1, kind: 'away' });
        expect(life.whereabouts(member, departure.time)).toMatchObject({ kind: 'away' });
        expect(life.whereabouts(member, departure.time + 3600)).toMatchObject({ kind: 'away' });
        expect(life.plan(member, party.arrivalDay - 1).activities).toEqual([]);
        expect(life.plan(member, dayOf(departure.time) + 1).activities).toEqual([]);
        if (departure.time > arrival.time) {
          expect(life.whereabouts(member, arrival.time)).toMatchObject({ kind: 'travel', outsider: true });
          const midway = life.whereabouts(member, Math.floor((arrival.time + departure.time) / 2));
          expect(midway.kind).not.toBe('away');
          expect(WhereaboutsSchema.safeParse(midway).success).toBe(true);
        }
      }
    }
    expect(walks).toBeGreaterThan(200);
  });

  it('keeps the members of a party in the same place at every moment', () => {
    const { outsiders, life } = badanos;
    let compared = 0;
    for (const party of arrivalsOver(outsiders, 1, 5).filter((entry) => entry.memberIds.length > 1)) {
      for (let time = party.arrival.time; time < party.departure.time; time += 600) {
        const [lead, ...rest] = party.memberIds.map((id) => life.whereabouts(id, time));
        for (const other of rest) {
          expect({ ...other, personId: '' }).toEqual({ ...lead, personId: '' });
          compared++;
        }
      }
      // They share one plan.
      const plans = party.memberIds.map((id) => life.plan(id, party.arrivalDay).activities);
      for (const plan of plans) expect(plan).toEqual(plans[0]);
    }
    expect(compared).toBeGreaterThan(5000);
  });

  it('gives each traveller as origin the settlement their entry route leads from, where the brief names one', () => {
    const { outsiders, layout, brief } = badanos;
    const exits = new Map(layout.exits.map((exit) => [exit.id, exit]));
    const from = new Map<string, number>();
    for (const party of arrivalsOver(outsiders, 1, 14)) {
      const exit = exits.get(party.arrival.exitId)!;
      const route = brief.routes.find((entry) => entry.routeId === exit.routeId && entry.bearing === exit.bearing)!;
      expect(party.origin).toEqual({ routeId: route.routeId, routeName: route.name, routeKind: route.kind, settlement: route.leadsTo });
      const leaving = exits.get(party.departure.exitId)!;
      expect(party.destination.settlement).toEqual(brief.routes.find((entry) => entry.routeId === leaving.routeId && entry.bearing === leaving.bearing)!.leadsTo);
      from.set(party.origin.settlement!.name, (from.get(party.origin.settlement!.name) ?? 0) + 1);
    }
    // Badanos stands on one trail: everyone comes from Pusztaszi or from Veszfetaros.
    expect([...from.keys()].sort()).toEqual(['Pusztaszi', 'Veszfetaros']);
    expect(Math.min(...from.values())).toBeGreaterThan(20);
  });

  it('is the route itself where the brief says no settlement lies along it', () => {
    // A town whose routes lead nowhere the brief knows.
    const nowhere = town({ ...settlement('settlement-455'), routes: settlement('settlement-455').routes.map(({ leadsTo: _leadsTo, ...exit }) => exit) });
    const parties = arrivalsOver(nowhere.outsiders, 1, 30);
    expect(parties.length).toBeGreaterThan(10);
    for (const party of parties) {
      expect(party.origin.settlement).toBeUndefined();
      expect(party.origin).toMatchObject({ routeId: 'route-35', routeName: 'Hurepolansian pass', routeKind: 'trail' });
    }
  });

  it('has people passing through leave by a different exit where the town has more than one, and by the same where it has one', () => {
    const passing = (outsiders: Outsiders) => arrivalsOver(outsiders, 1, 30).filter((party) => party.kindId === 'passing-through');
    const through = passing(badanos.outsiders);
    expect(through.length).toBeGreaterThan(20);
    for (const party of through) expect(party.departure.exitId, party.id).not.toBe(party.arrival.exitId);
    // Some stop for the night and some do not.
    expect(through.some((party) => party.nights === 0)).toBe(true);
    expect(through.some((party) => party.nights === 1)).toBe(true);
    // Vereceldo with one of its two exits taken away.
    const deadEnd = town({ ...settlement('settlement-455'), routes: settlement('settlement-455').routes.slice(0, 1) });
    const turning = passing(deadEnd.outsiders);
    expect(turning.length).toBeGreaterThan(3);
    for (const party of turning) expect(party.departure.exitId).toBe(party.arrival.exitId);
  });

  it('passes the rules a resident\'s plan passes while in town, with continuity across midnight and opening hours', { timeout: SLOW }, () => {
    let plans = 0;
    let visits = 0;
    for (const { city, layout, outsiders, life } of [badanos, vereceldo]) {
      const checker = createOutsiderChecker({ city, layout, pack, outsiders });
      const failures: string[] = [];
      for (let day = 7; day <= 14; day++) {
        for (const plan of outsiders.plansForDay(day)) {
          plans++;
          if (!DayPlanSchema.safeParse(plan).success) failures.push(`${plan.personId}, day ${day}: does not fit the schema`);
          failures.push(...checker.check(plan), ...checker.checkContinuity(plan, life.plan(plan.personId, day + 1)), ...checker.checkContinuity(life.plan(plan.personId, day - 1), plan));
          for (const activity of plan.activities) {
            if (activity.kind !== 'visit') continue;
            visits++;
            // Open when they arrive, by the shifts of those who work there.
            if (!life.isOpen(activity.buildingId, activity.start)) failures.push(`${plan.personId}: at ${activity.buildingId} when it is closed`);
          }
        }
      }
      expect(failures.slice(0, 10)).toEqual([]);
    }
    expect(plans).toBeGreaterThan(700);
    expect(visits).toBeGreaterThan(500);
  });

  it('reports a plan that breaks a rule', () => {
    const { city, layout, outsiders, life } = badanos;
    const checker = createOutsiderChecker({ city, layout, pack, outsiders });
    const party = arrivalsOver(outsiders, 8, 12).find((entry) => entry.kindId === 'merchant' && entry.nights >= 2)!;
    const id = party.memberIds[0]!;
    const sound = life.plan(id, party.arrivalDay + 1);
    expect(checker.check(sound)).toEqual([]);
    const broken = (change: (activities: Activity[]) => void) => {
      const copy = structuredClone(sound);
      change(copy.activities);
      return checker.check(copy).join('\n');
    };
    const home = city.households[0]!.dwellingId;
    expect(broken((activities) => (activities[0] = { ...activities[0]!, buildingId: home } as Activity))).toMatch(/which is not where they lodge|begins in/);
    expect(broken((activities) => (activities[0]!.end -= 60))).toMatch(/starts at \d+ but the one before ends at/);
    expect(broken((activities) => activities.push({ kind: 'work', start: activities[activities.length - 1]!.end, end: activities[activities.length - 1]!.end + 60, buildingId: party.lodgingId! }))).toMatch(/is work, but an outsider has none/);
    expect(broken((activities) => activities.splice(0, activities.length))).toMatch(/is in town but has no plan/);
    // A day on which they are not in town has no plan, and one is reported.
    expect(checker.check({ ...sound, day: party.arrivalDay - 3 })).toHaveLength(1);
    expect(checker.check({ ...sound, personId: 'traveller-641-000001-merchant-999-01' })[0]).toMatch(/is not an outsider/);
  });

  it('does what its kind does: merchants trade, tourists see the sights, adventurers keep to their hall and the taverns', () => {
    const { outsiders, life, city } = town(settlement('settlement-5'));
    const typeOf = new Map(city.buildings.map((building) => [building.id, building.type]));
    const done = new Map<string, Map<string, number>>();
    const places = new Map<string, Set<string>>();
    for (const day of [9, 10]) {
      for (const outsider of outsiders.inTown(day)) {
        if (outsider.group !== 'traveller') continue;
        for (const activity of life.plan(outsider.id, day).activities) {
          if (activity.kind !== 'visit' && activity.kind !== 'street') continue;
          const byVisit = done.get(outsider.kindId) ?? new Map<string, number>();
          byVisit.set(activity.visitId!, (byVisit.get(activity.visitId!) ?? 0) + 1);
          done.set(outsider.kindId, byVisit);
          if (activity.kind === 'visit') places.set(outsider.kindId, (places.get(outsider.kindId) ?? new Set()).add(typeOf.get(activity.buildingId)!));
        }
      }
    }
    for (const kind of rules.kinds) {
      // Nothing but the visits the kind lists.
      for (const visit of done.get(kind.id)?.keys() ?? []) expect(kind.visits.map((entry) => entry.visit), kind.id).toContain(visit);
    }
    expect(done.get('merchant')!.get('trading')).toBeGreaterThan(50);
    expect(done.get('tourist')!.get('sights')).toBeGreaterThan(50);
    expect(done.get('tourist')!.get('seeing-the-town')).toBeGreaterThan(5);
    expect([...places.get('adventurer')!].sort()).toEqual(expect.arrayContaining(['tavern']));
    for (const type of places.get('adventurer')!) expect(['adventurers-guild', 'tavern', 'general-shop', 'market-stall', 'market-square', 'bakery']).toContain(type);
    for (const type of places.get('mercenary') ?? []) expect(['adventurers-guild', 'tavern']).toContain(type);
  });
});

describe('tourists', () => {
  it('never come to a made-up village of 100 with no flags and no specialty, on any of 30 days', () => {
    const village = town(madeUp({ population: 100 }));
    expect(village.outsiders.draw.attracts).toBe(false);
    const kinds = new Set(arrivalsOver(village.outsiders, 1, 30).map((party) => party.kindId));
    expect(kinds.has('tourist')).toBe(false);
    for (let day = 1; day <= 30; day++) expect(village.life.daySummary(day).outsiders!.byKind.tourist).toBeUndefined();
    // Other people still come by its trail.
    expect(kinds.size).toBeGreaterThan(0);
  });

  it('come to a made-up town of 40,000 with no flags, which its population alone puts above the floor', { timeout: SLOW }, () => {
    const big = town(madeUp({ population: 40_000 }));
    expect(big.outsiders.draw).toMatchObject({ attracts: true });
    const tourists = arrivalsOver(big.outsiders, 1, 30).filter((party) => party.kindId === 'tourist');
    expect(tourists.length).toBeGreaterThan(30);
  });
});

describe('vagrants', () => {
  it('number the pack\'s share of the residents, and are the same people every day', () => {
    const { outsiders, city } = badanos;
    const vagrants = outsiders.vagrants();
    expect(vagrants).toHaveLength(Math.round(city.people.length * rules.vagrants!.share));
    expect(vagrants).toHaveLength(29);
    for (const vagrant of vagrants) {
      expect(OutsiderSchema.safeParse(vagrant).success).toBe(true);
      expect(vagrant.age).toBeGreaterThanOrEqual(rules.vagrants!.ages.min);
      expect(outsiders.outsider(vagrant.id)).toEqual(vagrant);
    }
    for (const day of [1, 2, 50, 400]) expect(outsiders.inTown(day).filter((outsider) => outsider.group === 'vagrant')).toEqual(vagrants);
    // They are not residents: the city has nobody more, and none of them is in it.
    expect(city.people).toHaveLength(9607);
    expect(city.people.some((person) => person.id.startsWith('vagrant'))).toBe(false);
  });

  it('are none in a settlement below the pack\'s minimum size', () => {
    expect(vereceldo.brief.population).toBeLessThan(rules.vagrants!.minPopulation);
    expect(vereceldo.outsiders.vagrants()).toEqual([]);
    const raised = edited((raw) => (raw.travellers.vagrants.minPopulation = 20_000));
    const { brief, city, layout } = badanos;
    expect(createOutsiders({ brief, city, layout, pack: raised }).vagrants()).toEqual([]);
  });

  it('sleep at 03:00 at a street point of a kind the pack allows, standing still', () => {
    const { outsiders, life, layout } = badanos;
    const segments = new Map(layout.segments.map((segment) => [segment.id, segment]));
    const bridgeEnds = layout.junctions.filter((junction) => junction.kind === 'bridge-end');
    const reach = pack.visits.streetReach!;
    const kinds = new Map<string, number>();
    for (const day of [8, 9, REST_DAY, 30]) {
      for (const vagrant of outsiders.vagrants()) {
        const where = life.whereabouts(vagrant.id, at(day, 3));
        expect(where).toMatchObject({ kind: 'street', purpose: 'sleep', outsider: true });
        if (where.kind !== 'street') continue;
        const found = sleepingPlacesAt(layout, { segmentId: where.segmentId, point: where.point }, reach);
        expect(found.some((kind) => rules.vagrants!.sleepsAt.includes(kind)), `${vagrant.id} on ${where.segmentId}`).toBe(true);
        for (const kind of found) kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
        // Checked again without the module's help: a lane is a lane, and a bridge end is near one.
        const segment = segments.get(where.segmentId)!;
        if (found.includes('lane')) expect(segment.kind).toBe('lane');
        if (found.includes('bridge-end')) expect(bridgeEnds.some((junction) => distance(junction.position, where.point) <= reach + 1e-6)).toBe(true);
        if (found.includes('edge')) expect(['street', 'arterial']).toContain(segment.kind);
        expect(geometry.distanceToPolyline(where.point, segment.points)).toBeLessThan(1e-6);
        // Standing still: in the same place half an hour before and after.
        for (const minutes of [-30, 30]) {
          const then = life.whereabouts(vagrant.id, at(day, 3) + minutes * 60);
          expect(then.kind === 'street' && distance(then.point, where.point)).toBe(0);
        }
      }
    }
    // Lanes mostly, and some at the town's edge.
    expect(kinds.get('lane')).toBeGreaterThan(20);
    expect([...kinds.keys()].length).toBeGreaterThanOrEqual(2);
  });

  it('keep a sleeping place for a run of days, and have only a few', () => {
    const { outsiders, life } = badanos;
    const { haunts, spotDays } = rules.vagrants!;
    let moved = 0;
    for (const vagrant of outsiders.vagrants()) {
      const nights = Array.from({ length: 60 }, (_, index) => {
        const where = life.whereabouts(vagrant.id, at(index + 2, 3));
        return where.kind === 'street' ? `${where.segmentId}:${where.point.join()}` : '';
      });
      expect(new Set(nights).size).toBeLessThanOrEqual(haunts);
      // Runs of the same place, each at least as long as the pack's shortest; the first and last are cut by the window.
      const runs: number[] = [];
      nights.forEach((place, index) => (index > 0 && place === nights[index - 1] ? runs[runs.length - 1]!++ : runs.push(1)));
      for (const run of runs.slice(1, -1)) expect(run).toBeGreaterThanOrEqual(spotDays.min);
      moved += runs.length - 1;
    }
    expect(moved).toBeGreaterThan(outsiders.vagrants().length);
  });

  it('are never inside a dwelling or an inn, or inside anything: by day they are out on the streets', { timeout: SLOW }, () => {
    const { outsiders, life, city, layout } = badanos;
    const typeOf = new Map(city.buildings.map((building) => [building.id, building.type]));
    const dwellings = new Set(pack.dwellings.map((type) => type.id));
    const checker = createOutsiderChecker({ city, layout, pack, outsiders });
    const doing = new Map<string, number>();
    const failures: string[] = [];
    for (let day = 7; day <= 14; day++) {
      for (const vagrant of outsiders.vagrants()) {
        const plan = life.plan(vagrant.id, day);
        failures.push(...checker.check(plan), ...checker.checkContinuity(plan, life.plan(vagrant.id, day + 1)));
        expect(plan.activities[0]!.start).toBe(startOfDay(day));
        expect(plan.activities[plan.activities.length - 1]!.end).toBe(startOfDay(day) + SECONDS_PER_DAY);
        for (const activity of plan.activities) {
          if (activity.kind === 'travel') continue;
          if (activity.kind === 'street') {
            doing.set(activity.visitId ?? activity.purpose, (doing.get(activity.visitId ?? activity.purpose) ?? 0) + 1);
            continue;
          }
          // At a building only on a visit, out on the street in front of it.
          expect(activity).toMatchObject({ kind: 'visit', outside: true, onStreet: true });
          expect(dwellings.has(typeOf.get(activity.buildingId)!)).toBe(false);
          expect(typeOf.get(activity.buildingId)).not.toBe('inn');
          doing.set(activity.visitId!, (doing.get(activity.visitId!) ?? 0) + 1);
        }
        // At every hour they are on a street or in front of a building, never indoors.
        for (let hour = 0; hour < 24; hour++) {
          const where = life.whereabouts(vagrant.id, at(day, hour, 20));
          expect(where.kind === 'travel' || where.kind === 'street' || (where.kind === 'visit' && where.outside === true && where.onStreet === true)).toBe(true);
        }
      }
    }
    expect(failures.slice(0, 10)).toEqual([]);
    // Outside chapels and taverns, at wells, and wandering.
    for (const visit of ['waiting-about', 'at-the-well', 'wandering', 'sleep', 'home']) expect(doing.get(visit), visit).toBeGreaterThan(20);
  });

  it('are left alone by the watch: no round stops for anyone, and the watch\'s plans are the same with them and without', () => {
    const { city, layout } = badanos;
    const without = createLife({ city, layout, pack });
    for (const watchman of city.people.filter((person) => person.occupationId === 'watchman').slice(0, 20)) {
      expect(JSON.stringify(badanos.life.plan(watchman.id, 9))).toBe(JSON.stringify(without.plan(watchman.id, 9)));
    }
  });
});

describe('residents are untouched', () => {
  it('have identical plans in Badanos over eight days with and without outsiders computed', { timeout: SLOW }, () => {
    const { city, layout, brief } = badanos;
    const without = createLife({ city, layout, pack });
    const withThem = createLife({ city, layout, pack, brief });
    expect(without.outsiders).toBeUndefined();
    for (let day = 1; day <= 8; day++) {
      // The outsiders are worked out first, so that nothing about them can have been left out.
      expect(withThem.outsiders!.plansForDay(day).length).toBeGreaterThan(50);
      withThem.nearby([0, 0], 100, at(day, 12));
      expect(digest(withThem.plansForDay(day)), `day ${day}`).toBe(digest(without.plansForDay(day)));
    }
    // Opening hours and shifts likewise.
    const tavern = city.buildings.find((building) => building.type === 'tavern')!;
    expect(withThem.openingHours(tavern.id, 3)).toEqual(without.openingHours(tavern.id, 3));
    expect(withThem.segmentLoads(3)).toEqual(without.segmentLoads(3));
  });

  it('are exactly the brief\'s population, with no outsider among them', () => {
    expect(badanos.city.people).toHaveLength(badanos.brief.population);
    expect(badanos.city.summary.population).toBe(9607);
    for (const outsider of badanos.outsiders.inTown(9)) expect(badanos.city.people.some((person) => person.id === outsider.id)).toBe(false);
    expect(badanos.life.plansForDay(9)).toHaveLength(9607);
  });
});

describe('one population for every query', () => {
  /** Everyone within a distance of a point, found the slow way: by asking where each resident and each outsider is. */
  const bruteForce = ({ city, life, outsiders }: Town, point: Point, radius: number, time: number) =>
    [...city.people.map((person) => person.id), ...outsiders.inTown(dayOf(time)).map((outsider) => outsider.id)]
      .flatMap((personId) => {
        const where = life.whereabouts(personId, time);
        if (where.kind === 'away') return [];
        const seen = where.kind === 'travel' || where.kind === 'street' ? where.point : where.outside ? where.point! : undefined;
        if (!seen) return [];
        const away = distance(point, seen);
        return away <= radius ? [{ personId, distance: away, kind: where.kind === 'travel' ? 'walking' : 'outside', outsider: isOutsiderId(personId) }] : [];
      })
      .sort((a, b) => a.distance - b.distance || (a.personId < b.personId ? -1 : 1));

  it('finds with the nearby query exactly whom a check of everyone\'s whereabouts finds, outsiders among them', { timeout: SLOW }, () => {
    const { layout, life } = badanos;
    const finder = createPathFinder(layout);
    const rng = createRng(6);
    const { minX, minY, maxX, maxY } = layout.summary.bounds;
    const points = Array.from({ length: 16 }, () => finder.nearestPosition([minX + rng.next() * (maxX - minX), minY + rng.next() * (maxY - minY)]).point);
    let outsiders = 0;
    let found = 0;
    for (const [hours, minutes] of [[3, 0], [10, 15], [12, 30], [16, 40], [20, 30]] as const) {
      const time = at(9, hours, minutes);
      for (const point of points) {
        for (const radius of [pack.avatar.perceptionRadius, 250]) {
          const near = life.nearby(point, radius, time);
          expect(near.map(({ personId, distance: away, kind, outsider }) => ({ personId, distance: away, kind, outsider: outsider === true }))).toEqual(bruteForce(badanos, point, radius, time));
          for (const entry of near.slice(0, 5)) expect(NearbySchema.safeParse(entry).success).toBe(true);
          outsiders += near.filter((entry) => entry.outsider).length;
          found += near.length;
        }
      }
    }
    expect(found).toBeGreaterThan(2000);
    expect(outsiders).toBeGreaterThan(40);
  });

  it('reports outsiders in the day summary, apart from the residents', () => {
    const { city, layout, life, outsiders } = badanos;
    const summary = life.daySummary(9);
    expect(DaySummarySchema.safeParse(summary).success).toBe(true);
    // The residents' figures are those of a town with no outsiders computed.
    const { outsiders: apart, ...residents } = summary;
    expect(residents).toEqual(createLife({ city, layout, pack }).daySummary(9));
    for (const hour of residents.hours) expect(hour.asleep + hour.atHome + hour.atWork + hour.visiting + hour.travelling).toBeCloseTo(9607, 6);
    const inTown = outsiders.inTown(9);
    expect(apart).toMatchObject({ vagrants: 29, travellers: inTown.length - 29 });
    expect(Object.values(apart!.byKind).reduce((sum, count) => sum + count, 0)).toBe(apart!.travellers);
    for (const hour of apart!.hours) {
      expect(hour.asleep + hour.atLodging + hour.visiting + hour.travelling).toBeCloseTo(hour.inTown, 6);
      // The vagrants at least are always in town.
      expect(hour.inTown).toBeGreaterThanOrEqual(29);
      expect(hour.inTown).toBeLessThanOrEqual(inTown.length);
    }
    // At 03:00 everyone in town is asleep: travellers at their lodging, vagrants on the street.
    expect(apart!.hours[3]!.asleep).toBeCloseTo(apart!.hours[3]!.inTown, 6);
    expect(apart!.hours[3]!.outside).toBeCloseTo(29, 6);
    expect(apart!.trips).toBeGreaterThan(100);
  });

  it('counts outsiders among a building\'s occupants, the trips and the stays out of doors of a window, each marked', () => {
    const { city, life, outsiders } = badanos;
    // The guests of an inn at 03:00 are asleep in it, beside the household that lives there.
    const inns = city.buildings.filter((building) => building.type === 'inn');
    const guests = inns.flatMap((inn) => life.occupants(inn.id, at(9, 3)).filter((occupant) => occupant.outsider));
    expect(guests.length).toBeGreaterThan(10);
    for (const guest of guests) {
      expect(guest).toMatchObject({ kind: 'sleep', outsider: true });
      expect((outsiders.outsider(guest.personId) as Traveller).lodgingId).toMatch(/^building-/);
    }
    const household = life.occupants(inns[0]!.id, at(9, 3)).filter((occupant) => !occupant.outsider);
    expect(household.length).toBeGreaterThan(0);
    // A window of the afternoon.
    const trips = life.trips(at(9, 14), at(9, 15));
    const strangers = trips.filter((trip) => trip.outsider);
    expect(strangers.length).toBeGreaterThan(5);
    for (const trip of strangers) {
      expect(isOutsiderId(trip.personId)).toBe(true);
      expect(TripSchema.safeParse(trip).success).toBe(true);
    }
    expect(trips.filter((trip) => !trip.outsider).every((trip) => !isOutsiderId(trip.personId))).toBe(true);
    const stays = life.outsideStays(at(9, 14), at(9, 15));
    const outside = stays.filter((stay) => stay.outsider);
    expect(outside.length).toBeGreaterThan(5);
    for (const stay of outside) expect(OutsideStaySchema.safeParse(stay).success).toBe(true);
    // And at night the vagrants are the stays out of doors.
    const night = life.outsideStays(at(9, 3), at(9, 3) + 60).filter((stay) => stay.outsider);
    expect(night).toHaveLength(29);
    for (const stay of night) expect(stay).toMatchObject({ kind: 'sleep' });
  });

  it('lets the avatar perceive outsiders exactly as it perceives residents: on the street, and in a building', () => {
    const { city, layout, life, outsiders } = badanos;
    const finder = createPathFinder(layout);
    const avatar = avatarTown(city, layout, finder);
    // Beside a sleeping vagrant at 03:00.
    const vagrant = outsiders.vagrants()[0]!;
    const asleep = life.whereabouts(vagrant.id, at(9, 3));
    if (asleep.kind !== 'street') throw new Error('expected the vagrant on a street');
    const standing = spawnAvatar(avatar, asleep.point);
    const seen = perceive(standing, life, pack.avatar.perceptionRadius, at(9, 3));
    expect(seen.where).toBe('street');
    if (seen.where === 'street') expect(seen.nearby.find((entry) => entry.personId === vagrant.id)).toMatchObject({ outsider: true, kind: 'outside', activity: 'sleep' });
    // In an inn at 03:00, among its sleeping guests.
    const inn = city.buildings.find((building) => building.type === 'inn' && life.occupants(building.id, at(9, 3)).some((occupant) => occupant.outsider))!;
    const walk = walkToBuilding(standing, avatar, inn.id, at(9, 1), pack.avatar.walkingSpeed);
    const inside = perceive(walk, life, pack.avatar.perceptionRadius, at(9, 3));
    expect(inside.where).toBe('building');
    if (inside.where === 'building') {
      expect(inside.occupants).toEqual(life.occupants(inn.id, at(9, 3)));
      expect(inside.occupants.some((occupant) => occupant.outsider)).toBe(true);
    }
  });

  it('answers for an outsider by ID as for a resident, and says so of an ID nobody has', () => {
    const { life, outsiders } = badanos;
    const traveller = outsiders.inTown(9).find((outsider) => outsider.group === 'traveller')!;
    expect(life.plan(traveller.id, 9)).toMatchObject({ personId: traveller.id, outsider: true, day: 9 });
    expect(() => life.plan('traveller-641-000009-merchant-999-01', 9)).toThrow(/there is no outsider with the ID/);
    expect(() => life.whereabouts('vagrant-641-009999', at(9, 3))).toThrow(/there is no outsider/);
    // Without outsiders computed, their IDs are nobody's.
    const { city, layout } = badanos;
    expect(() => createLife({ city, layout, pack }).plan(traveller.id, 9)).toThrow(/there is no person with the ID/);
  });
});

describe('magnitudes', () => {
  it('has between 0.5% and 3% of Badanos\'s residents in town as travellers on a work day, a higher share in Pombal, and a handful in Vereceldo with no tourists', { timeout: SLOW }, () => {
    const pombal = town(settlement('settlement-5'));
    const figures = [badanos, pombal, vereceldo].map(({ brief, outsiders }) => {
      const byDay = WORK_DAYS.map((day) => outsiders.inTown(day).filter((outsider) => outsider.group === 'traveller') as Traveller[]);
      const mean = byDay.reduce((sum, list) => sum + list.length, 0) / byDay.length;
      const kinds: Record<string, number> = {};
      for (const traveller of byDay.flat()) kinds[traveller.kindId] = (kinds[traveller.kindId] ?? 0) + 1 / byDay.length;
      console.log(
        `${brief.name}: ${mean.toFixed(0)} travellers in town on a work day (${((mean / brief.population) * 100).toFixed(2)}% of ${brief.population.toLocaleString('en-US')} residents; day by day ${byDay.map((list) => list.length).join(', ')}): ` +
          `${Object.entries(kinds).map(([kind, count]) => `${count.toFixed(0)} ${kind}`).join(', ')}; ${outsiders.vagrants().length} vagrants; draw ${outsiders.draw.total.toFixed(1)}`,
      );
      return { mean, share: mean / brief.population, kinds, most: Math.max(...byDay.map((list) => list.length)) };
    });
    const [inBadanos, inPombal, inVereceldo] = figures as [(typeof figures)[number], (typeof figures)[number], (typeof figures)[number]];
    expect(inBadanos.share).toBeGreaterThanOrEqual(0.005);
    expect(inBadanos.share).toBeLessThanOrEqual(0.03);
    expect(inPombal.share).toBeGreaterThan(inBadanos.share);
    expect(inVereceldo.kinds.tourist).toBeUndefined();
    expect(inVereceldo.most).toBeLessThanOrEqual(8);
  });
});

describe('pack behaviour', () => {
  const without = (kindId: string) =>
    edited((raw) => {
      raw.travellers.kinds = raw.travellers.kinds.filter((kind: any) => kind.id !== kindId);
      delete raw.display.travellers[kindId];
    });

  it('removes a kind\'s travellers, and nobody else, when the kind is removed from a copy of the pack', () => {
    const { brief } = badanos;
    // Tourists are not what inns are counted by alone, so the town is generated again; the others must not move.
    const fewer = without('mercenary');
    const there = town(brief, fewer);
    for (const day of [3, 9, REST_DAY]) {
      const kept = badanos.outsiders.arrivals(day).filter((party) => party.kindId !== 'mercenary');
      // The same parties: who, from where, when, and for how long. Where they lodge may differ if the town has an inn fewer.
      const identity = (party: Party) => ({ id: party.id, memberIds: party.memberIds, origin: party.origin, arrival: party.arrival, nights: party.nights > 0 });
      expect(there.outsiders.arrivals(day).map(identity)).toEqual(kept.map(identity));
      for (const party of kept) {
        const names = (outsiders: Outsiders) => party.memberIds.map((id) => ({ ...(outsiders.outsider(id) as Traveller), departure: undefined, destination: undefined, lodgingId: undefined }));
        expect(names(there.outsiders)).toEqual(names(badanos.outsiders));
      }
    }
    expect(arrivalsOver(badanos.outsiders, 1, 30).some((party) => party.kindId === 'mercenary')).toBe(true);
    expect(arrivalsOver(there.outsiders, 1, 30).some((party) => party.kindId === 'mercenary')).toBe(false);
    expect(there.outsiders.vagrants()).toEqual(badanos.outsiders.vagrants());
    // On the same town, with the same inns, everything about everyone else is identical.
    const { city, layout } = badanos;
    const same = createOutsiders({ brief, city, layout, pack: fewer });
    for (const day of [3, 9]) {
      const others = badanos.outsiders.plansForDay(day).filter((plan) => (badanos.outsiders.outsider(plan.personId) as Traveller).kindId !== 'mercenary');
      expect(digest(same.plansForDay(day))).toBe(digest(others));
    }
  });

  it('roughly doubles a kind\'s arrivals over 30 days when its rate is doubled', () => {
    const { brief, city, layout } = badanos;
    const doubled = edited((raw) => {
      const merchant = raw.travellers.kinds.find((kind: any) => kind.id === 'merchant');
      merchant.arrivals.perThousandResidents *= 2;
      for (const route of Object.keys(merchant.arrivals.perExit)) merchant.arrivals.perExit[route] *= 2;
    });
    const merchant = (packUsed: SettingPack) => packUsed.travellers!.kinds.find((kind) => kind.id === 'merchant')!;
    expect(arrivalRate(merchant(doubled), brief, doubled, 0)).toBeCloseTo(2 * arrivalRate(merchant(pack), brief, pack, 0), 10);
    const count = (packUsed: SettingPack) => arrivalsOver(createOutsiders({ brief, city, layout, pack: packUsed }), 1, 30).filter((party) => party.kindId === 'merchant').length;
    const [once, twice] = [count(pack), count(doubled)];
    console.log(`Merchant parties arriving in Badanos over 30 days: ${once}; with the rate doubled, ${twice}`);
    expect(twice / once).toBeGreaterThan(1.7);
    expect(twice / once).toBeLessThan(2.3);
    // And about as many as the rate says: its average over the week, for thirty days.
    const perDay = Array.from({ length: 7 }, (_, weekday) => arrivalRate(merchant(pack), brief, pack, weekday)).reduce((sum, rate) => sum + rate, 0) / 7;
    expect(once / 30).toBeGreaterThan(perDay * 0.8);
    expect(once / 30).toBeLessThan(perDay * 1.2);
  });

  it('brings more merchants on Marketday and fewer on the rest day', () => {
    const { outsiders } = badanos;
    const onWeekday = (weekday: number) => Array.from({ length: 12 }, (_, week) => outsiders.arrivals(week * 7 + weekday + 1).filter((party) => party.kindId === 'merchant').length).reduce((sum, count) => sum + count, 0);
    const marketday = pack.calendar.week.findIndex((entry) => entry.name === 'Marketday');
    const restday = pack.calendar.week.findIndex((entry) => entry.rest);
    expect(onWeekday(marketday)).toBeGreaterThan(onWeekday(0));
    expect(onWeekday(restday)).toBeLessThan(onWeekday(0) / 2);
  });

  it('has no vagrants with a share of 0', () => {
    const { brief, city, layout } = badanos;
    const none = createOutsiders({ brief, city, layout, pack: edited((raw) => (raw.travellers.vagrants.share = 0)) });
    expect(none.vagrants()).toEqual([]);
    expect(none.inTown(9).every((outsider) => outsider.group === 'traveller')).toBe(true);
    const absent = createOutsiders({ brief, city, layout, pack: edited((raw) => delete raw.travellers.vagrants) });
    expect(absent.vagrants()).toEqual([]);
  });

  it('rejects on load a kind that names a missing lodging type or a missing visit, and a vagrant who would go indoors', () => {
    const problems = (edit: (raw: any) => void): string => {
      try {
        edited(edit);
        return '';
      } catch (error) {
        return (error as PackError).problems.join('\n');
      }
    };
    const kind = (raw: any, id: string) => raw.travellers.kinds.find((entry: any) => entry.id === id);
    expect(problems((raw) => (kind(raw, 'merchant').lodging = ['hostelry']))).toMatch(/travellers: "merchant" lodges at the building type "hostelry", which does not exist/);
    expect(problems((raw) => kind(raw, 'tourist').visits.push({ visit: 'boat-trip', chance: 0.5 }))).toMatch(/travellers: "tourist" names the visit "boat-trip", which travellers does not define/);
    expect(problems((raw) => raw.travellers.vagrants.visits.push({ visit: 'boat-trip', chance: 0.5 }))).toMatch(/travellers: vagrants names the visit "boat-trip"/);
    expect(problems((raw) => (raw.travellers.visits.find((visit: any) => visit.id === 'trading').destinations = ['bazaar']))).toMatch(/travellers: the visit "trading" names the building type "bazaar", which does not exist/);
    expect(problems((raw) => raw.travellers.vagrants.visits.push({ visit: 'evening-out', chance: 0.5 }))).toMatch(/vagrants makes the visit "evening-out", which is not a stroll and not spent out on the street/);
    expect(problems((raw) => delete kind(raw, 'merchant').lodging)).toMatch(/"merchant" can stay the night, so it needs somewhere to lodge/);
    expect(problems((raw) => (kind(raw, 'merchant').arrivals.weekdays = { Someday: 2 }))).toMatch(/names the weekday "Someday"/);
    expect(problems((raw) => (raw.travellers.kinds = raw.travellers.kinds.filter((entry: any) => entry.id !== 'tourist')))).toMatch(/display: travellers gives a colour to "tourist", which is not a kind of traveller/);
    expect(problems((raw) => raw.travellers.visits.push({ ...raw.travellers.visits[0], id: 'market' }))).toMatch(/the visit "market" is defined more than once, here or in visits/);
  });

  it('computes no outsiders for a pack with no travellers file, or without the brief', () => {
    const { brief, city, layout } = badanos;
    const before = medievalPackBefore6C();
    const was = generateCity(brief, before);
    const life = createLife({ city: was, layout: generateLayout(was, brief, before), pack: before, brief });
    expect(life.outsiders).toBeUndefined();
    expect(life.daySummary(1).outsiders).toBeUndefined();
    expect(createLife({ city, layout, pack }).outsiders).toBeUndefined();
    // Asked for directly, there is nobody.
    const none = createOutsiders({ brief, city: was, layout: generateLayout(was, brief, before), pack: before });
    expect(none.inTown(9)).toEqual([]);
    expect(none.plansForDay(9)).toEqual([]);
  });
});

describe('cost', () => {
  it('works out a day of Pombal\'s outsiders in a small part of what its residents take', { timeout: SLOW }, () => {
    const brief = settlement('settlement-5');
    const city = generateCity(brief, pack);
    const layout = generateLayout(city, brief, pack);
    const outsiders = createOutsiders({ brief, city, layout, pack });
    const cost = inYardsticks(() => {
      for (const day of [9, 10, 11]) outsiders.plansForDay(day);
    });
    console.log(`Three days of Pombal's outsiders (${outsiders.inTown(9).length} in town on day 9): ${cost.seconds.toFixed(2)} s, ${cost.yardsticks.toFixed(1)} yardsticks`);
    expect(cost.yardsticks).toBeLessThan(6);
  });
});
