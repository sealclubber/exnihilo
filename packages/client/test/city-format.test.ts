import { beforeAll, describe, expect, it } from 'vitest';
import { type City, type PackLabels, generateCity, packLabels } from '@worldsim/core';
import { medievalPack, settlement } from '../../core/test/pack.ts';
import {
  buildingKindName,
  buildingTypeName,
  describeMember,
  districtLabel,
  filterChips,
  listQuery,
  occupationName,
  summaryBars,
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
    const worker = city.people.find((person) => person.occupationId === 'tanner' && person.role === 'head')!;
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
