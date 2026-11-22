import { describe, expect, it } from 'vitest';
import type { PackLabels, RouteEnd, Traveller, Vagrant } from '@worldsim/core';
import { byRoute, describeOutsider, describeRouteEnd, isOutsider, kindName, outsiderGroups, relativeDay, routeEndName, seenLabel } from '../src/outsider-format.ts';

const labels = {
  occupations: { tanner: { name: 'Tanner', category: 'craft' } },
  travellerKinds: { merchant: 'Merchant', tourist: 'Tourist', 'passing-through': 'Passing through' },
  vagrantName: 'Vagrant',
} as unknown as PackLabels;
const lead = { settlementId: 'settlement-7', name: 'Pusztaszi', sizeGroup: 'town' as const, population: 2100, culture: 'Monzian', state: 'Monzia', distance: 34.2 };
const toTown: RouteEnd = { routeId: 'route-34', routeName: 'Pusztaszian trail', routeKind: 'trail', settlement: lead };
const toSea: RouteEnd = { routeId: 'route-9', routeKind: 'sea-route' };
const traveller = (id: string, kindId: string, origin: RouteEnd = toTown): Traveller => ({
  group: 'traveller',
  id,
  kindId,
  partyId: 'party-1-000009-merchant-002',
  givenName: 'Ilka',
  familyName: 'Varga',
  age: 41,
  sex: 'female',
  species: 'human',
  origin,
  destination: toSea,
  arrival: { time: 1000, exitId: 'exit-1-001' },
  departure: { time: 90_000, exitId: 'exit-1-002' },
});
const vagrant = (id: string): Vagrant => ({ group: 'vagrant', id, givenName: 'Odo', familyName: 'Kis', age: 60, sex: 'male', species: 'human' });

describe('an outsider in words', () => {
  it('names a kind of traveller as the pack does, and a vagrant as the pack does', () => {
    expect(kindName('merchant', labels)).toBe('Merchant');
    expect(kindName('passing-through', labels)).toBe('Passing through');
    expect(kindName(undefined, labels)).toBe('Vagrant');
    expect(kindName(undefined, { ...labels, vagrantName: 'Beggar' })).toBe('Beggar');
    // A kind the labels do not name is shown by its ID rather than left blank.
    expect(kindName('pilgrim', labels)).toBe('pilgrim');
  });

  it('says where a route leads: the settlement, or failing that the route', () => {
    expect(routeEndName(toTown)).toBe('Pusztaszi');
    expect(routeEndName({ ...toSea, routeName: 'Amber way' })).toBe('Amber way');
    expect(routeEndName(toSea)).toBe('route-9');
    expect(byRoute(toTown)).toBe('by the Pusztaszian trail');
    expect(byRoute(toSea)).toBe('by an unnamed sea route');
    expect(describeRouteEnd(toTown)).toBe('Pusztaszi (town), by the Pusztaszian trail');
    expect(describeRouteEnd(toSea)).toBe('an unnamed sea route');
  });

  it('says what kind of traveller someone is and where they are from', () => {
    expect(describeOutsider(traveller('traveller-1-000009-merchant-002-01', 'merchant'), labels)).toBe('Merchant from Pusztaszi');
    expect(describeOutsider(traveller('traveller-1-000009-tourist-001-01', 'tourist', toSea), labels)).toBe('Tourist from route-9');
    expect(describeOutsider(vagrant('vagrant-1-000003'), labels)).toBe('Vagrant');
  });

  it('says how far the day someone came or goes is from today', () => {
    expect([2, 1, 3, -1, 5].map((day) => relativeDay(day, 2))).toEqual(['Today', 'Yesterday', 'Tomorrow', '3 days ago', 'In 3 days']);
  });

  it('tells an outsider from a resident by their group', () => {
    expect(isOutsider(vagrant('vagrant-1-000003'))).toBe(true);
    expect(isOutsider({ id: 'person-1-000001', householdId: 'household-1-000001' } as never)).toBe(false);
  });

  it('labels someone seen on the map: an outsider by kind and origin, a resident by occupation', () => {
    expect(seenLabel({ name: 'Ilka Varga', role: 'traveller:merchant', kindId: 'merchant', origin: 'Pusztaszi', outsider: true }, labels)).toBe('Ilka Varga · Merchant from Pusztaszi');
    expect(seenLabel({ name: 'Odo Kis', role: 'vagrant', outsider: true }, labels)).toBe('Odo Kis · Vagrant');
    expect(seenLabel({ name: 'Anna Nagy', role: 'craft', occupationId: 'tanner' }, labels)).toBe('Anna Nagy · Tanner');
    expect(seenLabel({ name: 'Bela Nagy', role: 'not-working' }, labels)).toBe('Bela Nagy');
  });
});

describe('the outsiders in town, as a list shows them', () => {
  const travellers = [traveller('traveller-1-000009-tourist-001-01', 'tourist'), traveller('traveller-1-000009-merchant-002-01', 'merchant'), traveller('traveller-1-000009-merchant-002-02', 'merchant')];

  it('groups the travellers by kind in the pack\'s order with the server\'s counts, then the vagrants', () => {
    const groups = outsiderGroups({ travellers, byKind: { tourist: 1, merchant: 2 }, vagrants: [vagrant('vagrant-1-000001'), vagrant('vagrant-1-000002')] }, labels);
    expect(groups.map((group) => [group.kindId, group.name, group.count, group.people.map((person) => person.id)])).toEqual([
      ['merchant', 'Merchant', 2, ['traveller-1-000009-merchant-002-01', 'traveller-1-000009-merchant-002-02']],
      ['tourist', 'Tourist', 1, ['traveller-1-000009-tourist-001-01']],
      [undefined, 'Vagrant', 2, ['vagrant-1-000001', 'vagrant-1-000002']],
    ]);
  });

  it('leaves out a kind with nobody in town, and the vagrants when there are none', () => {
    expect(outsiderGroups({ travellers: [travellers[0]!], byKind: { tourist: 1, merchant: 0 }, vagrants: [] }, labels).map((group) => group.name)).toEqual(['Tourist']);
    expect(outsiderGroups({ travellers: [], byKind: {}, vagrants: [] }, labels)).toEqual([]);
  });

  it('keeps a kind the labels do not name', () => {
    const groups = outsiderGroups({ travellers: [traveller('traveller-1-000009-pilgrim-001-01', 'pilgrim')], byKind: { pilgrim: 1 }, vagrants: [] }, labels);
    expect(groups.map((group) => [group.kindId, group.name, group.count])).toEqual([['pilgrim', 'pilgrim', 1]]);
  });
});
