import { beforeAll, describe, expect, it } from 'vitest';
import { type City, type PackLabels, generateCity, packLabels } from '@worldsim/core';
import { medievalPack, settlement } from '../../core/test/pack.ts';
import {
  buildingKindName,
  buildingTypeName,
  describeKin,
  describeMember,
  describeRowMember,
  districtLabel,
  filterChips,
  listQuery,
  occupationName,
  summaryBars,
  workName,
  workplaceText,
  buildingName,
} from '../src/city-format.ts';

let city: City;
let labels: PackLabels;
beforeAll(() => {
  city = generateCity(settlement('settlement-641'), medievalPack());
  labels = packLabels(medievalPack());
});

describe('summaryBars', () => {
  const section = (key: string) => summaryBars(city.summary, city.districts, labels).find((entry) => entry.key === key)!;

  it('shows residents by workforce state, summing to the population', () => {
    const { bars } = section('workforce');
    expect(bars.map((bar) => bar.label)).toEqual(['Working', 'Keeping house', 'Not working']);
    expect(bars.reduce((sum, bar) => sum + bar.value, 0)).toBe(9607);
    expect(bars[0]).toMatchObject({ value: 4419, note: '46.0%' });
    expect(bars[0]!.length).toBeCloseTo(0.46, 3);
    expect(bars.every((bar) => bar.id === undefined)).toBe(true);
  });

  it('shows the seven categories with counts and shares', () => {
    const { bars } = section('category');
    expect(bars.map((bar) => bar.id)).toEqual(['food', 'utilities', 'services', 'construction', 'military', 'luxury', 'trade']);
    expect(bars.at(-1)).toMatchObject({ label: 'Trade', value: 1487, note: '33.7%' });
    expect(bars.reduce((sum, bar) => sum + bar.value, 0)).toBe(4419);
    expect(bars.reduce((sum, bar) => sum + bar.length, 0)).toBeCloseTo(1, 9);
  });

  it('shows occupations by name, largest first, with bars relative to the largest', () => {
    const { bars } = section('occupation');
    expect(bars[0]).toMatchObject({ id: 'tanner', label: 'Tanner', length: 1 });
    expect(bars.map((bar) => bar.value)).toEqual([...bars.map((bar) => bar.value)].sort((a, b) => b - a));
    expect(bars.reduce((sum, bar) => sum + bar.value, 0)).toBe(4419);
    expect(bars.every((bar) => bar.length > 0 && bar.length <= 1)).toBe(true);
  });

  it('shows every status tier, lowest first, even one with no households', () => {
    const { bars } = section('status');
    expect(bars.map((bar) => bar.label)).toEqual(['Poor', 'Modest', 'Comfortable', 'Wealthy', 'Noble']);
    expect(bars.reduce((sum, bar) => sum + bar.value, 0)).toBe(city.households.length);
    expect(bars[0]!.note).toMatch(/^[\d,]+ residents$/);
  });

  it('shows every district with its kind and residents', () => {
    const { bars } = section('district');
    expect(bars.map((bar) => bar.id)).toEqual(city.districts.map((district) => district.id));
    expect(bars.reduce((sum, bar) => sum + bar.value, 0)).toBe(9607);
    expect(bars[0]!.label).toBe(`${city.districts[0]!.name} (Centre)`);
    expect(Math.max(...bars.map((bar) => bar.length))).toBe(1);
  });
});

describe('record text', () => {
  it('describes a household member', () => {
    const worker = city.people.find((person) => person.occupationId === 'tanner' && person.role === 'head' && !person.apprentice)!;
    expect(describeMember(worker, labels)).toEqual({
      name: `${worker.givenName} ${worker.familyName}`,
      age: String(worker.age),
      sex: worker.sex === 'male' ? 'Male' : 'Female',
      role: 'Head',
      work: 'Tanner',
    });
    const keeper = city.people.find((person) => person.workforceState === 'keeping-house')!;
    expect(describeMember(keeper, labels).work).toBe('Keeping house');
    const child = city.people.find((person) => person.role === 'child' && person.age < 5)!;
    expect(describeMember(child, labels)).toMatchObject({ role: 'Child', work: 'Not working' });
  });

  it('shows an apprentice with the pack\'s label', () => {
    const apprentice = city.people.find((person) => person.occupationId === 'tanner' && person.apprentice)!;
    expect(workName(apprentice, labels)).toBe('Apprentice tanner');
    expect(describeMember(apprentice, labels).work).toBe('Apprentice tanner');
    expect(workName({ occupationId: 'tanner' }, labels)).toBe('Tanner');
    expect(workName({ occupationId: 'tanner', apprentice: true }, { ...labels, apprenticeLabel: '{occupation} (learning)' })).toBe('Tanner (learning)');
    const { apprenticeLabel: _, ...unlabelled } = labels;
    expect(workName({ occupationId: 'tanner', apprentice: true }, unlabelled)).toBe('Tanner');
  });

  it('describes kinship in words', () => {
    const household = city.households.find((entry) => {
      const members = entry.memberIds.map((id) => city.people.find((person) => person.id === id)!);
      return members.some((person) => person.role === 'partner') && members.filter((person) => person.role === 'child').length === 2 && members.some((person) => person.role === 'elder');
    })!;
    const members = household.memberIds.map((id) => city.people.find((person) => person.id === id)!);
    const [head, partner] = members as [typeof members[0], typeof members[0]];
    const children = members.filter((person) => person.role === 'child');
    const names = `${children[0]!.givenName} and ${children[1]!.givenName}`;
    expect(describeKin(partner, members)).toBe(`Partner of ${head.givenName}; ${partner.parentIds.length ? `child of ${members.find((person) => person.id === partner.parentIds[0])!.givenName}; ` : ''}parent of ${names}`);
    expect(describeKin(children[0]!, members)).toBe(`Child of ${head.givenName} and ${partner.givenName}`);
    const elder = members.find((person) => person.role === 'elder')!;
    expect(describeKin(elder, members)).toMatch(/[Pp]arent of \p{Lu}\p{Ll}+$/u);
    const lodger = city.people.find((person) => person.role === 'lodger')!;
    expect(describeKin(lodger, [lodger])).toBe('');
  });

  it('describes the member a household row shows', () => {
    expect(describeRowMember({ id: 'person-1-000001', name: 'Ada Smith', role: 'head', occupationId: 'tanner' }, labels)).toBe('Ada Smith, tanner');
    expect(describeRowMember({ id: 'person-1-000002', name: 'Bo Smith', role: 'child', occupationId: 'soldier' }, labels)).toBe('Bo Smith (child), soldier');
    expect(describeRowMember({ id: 'person-1-000003', name: 'Cy Smith', role: 'lodger', occupationId: 'tanner', apprentice: true }, labels)).toBe('Cy Smith (lodger), apprentice tanner');
    expect(describeRowMember({ id: 'person-1-000004', name: 'Di Smith', role: 'head' }, labels)).toBe('Di Smith');
  });

  it('names a workplace by its type, or by the household that employs the worker', () => {
    const person = city.people.find((entry) => entry.occupationId === 'tanner')!;
    const dwelling = city.buildings[0]!;
    expect(workplaceText(person, { workplaces: { [person.workplaceId!]: { type: 'tannery' } }, dwelling }, labels)).toBe('Tannery');
    expect(workplaceText(person, { workplaces: { [person.workplaceId!]: { type: 'bakery' } }, dwelling: { ...dwelling, id: person.workplaceId! } }, labels)).toBe('Bakery (home)');
    const servant = city.people.find((entry) => entry.occupationId === 'servant')!;
    const employer = { householdId: servant.employerHouseholdId!, familyName: 'Nagy' };
    expect(workplaceText(servant, { workplaces: { [servant.workplaceId!]: { type: 'mansion', employer } }, dwelling }, labels)).toBe('Home of the Nagy household');
    expect(workplaceText(city.people.find((entry) => !entry.workplaceId)!, { workplaces: {}, dwelling }, labels)).toBe('');
  });

  it('names occupations, buildings and districts, falling back to the ID', () => {
    expect(occupationName('night-soil-collector', labels)).toBe('Night-soil collector');
    expect(occupationName('astronaut', labels)).toBe('astronaut');
    expect(occupationName(undefined, labels)).toBe('');
    expect(buildingTypeName('province-hall', labels)).toBe('Provincial administration hall');
    expect(buildingTypeName('igloo', labels)).toBe('igloo');
    expect(districtLabel({ name: 'Old Town', kind: 'centre' }, labels)).toBe('Old Town (Centre)');
    expect(buildingKindName('both')).toBe('Workplace and home');
  });

  it('has a name for every occupation and building type the city uses', () => {
    for (const id of Object.keys(city.summary.occupations)) expect(labels.occupations[id], id).toBeDefined();
    for (const building of city.buildings) expect(labels.buildingTypes[building.type], building.type).toBeDefined();
  });
});

describe('list requests', () => {
  it('builds a query from the filters that are set', () => {
    expect(listQuery({}, 0, 100)).toBe('offset=0&limit=100');
    expect(listQuery({ district: 'district-641-002', q: 'Kis ujhely', occupation: undefined }, 200, 50)).toBe(
      'district=district-641-002&q=Kis+ujhely&offset=200&limit=50',
    );
    expect(listQuery({ q: '' }, 0, 10)).toBe('offset=0&limit=10');
  });

  it('names the active filters for showing and clearing', () => {
    const district = city.districts[1]!;
    expect(filterChips({}, city.districts, labels)).toEqual([]);
    expect(filterChips({ district: district.id, category: 'trade', occupation: 'tanner', status: 'poor', q: 'x' }, city.districts, labels)).toEqual([
      { key: 'district', text: `District: ${district.name}` },
      { key: 'category', text: 'Category: Trade' },
      { key: 'occupation', text: 'Occupation: Tanner' },
      { key: 'status', text: 'Status: Poor' },
    ]);
  });
});

describe('a building that is both a home and a workplace', () => {
  const named = { buildingTypes: { forge: 'Forge', cottage: 'Cottage' }, homeAndWorkLabel: '{workplace} and home' } as unknown as PackLabels;

  it('is named as both, by the pack\'s pattern', () => {
    expect(buildingName({ type: 'forge', kind: 'both' }, named)).toBe('Forge and home');
  });

  it('is named plainly when it is only a home, only a workplace or a landmark', () => {
    expect(buildingName({ type: 'forge', kind: 'workplace' }, named)).toBe('Forge');
    expect(buildingName({ type: 'cottage', kind: 'dwelling' }, named)).toBe('Cottage');
    expect(buildingName({ type: 'forge', kind: 'landmark' }, named)).toBe('Forge');
  });

  it('keeps the type\'s own name when the pack gives no pattern', () => {
    expect(buildingName({ type: 'forge', kind: 'both' }, { buildingTypes: { forge: 'Forge' } } as unknown as PackLabels)).toBe('Forge');
    expect(buildingName({ type: 'smithy', kind: 'both' }, named)).toBe('smithy and home');
  });
});
