import { describe, expect, it } from 'vitest';
import type { AvatarState, Nearby, Occupant, PackLabels } from '@worldsim/core';
import { avatarPlace, describeAvatar, describeDistance, describeNearby, describeOccupant, followScale } from '../src/avatar.ts';

const settlementId = 'settlement-1';
const walk = (destination: Extract<AvatarState, { kind: 'walking' }>['destination']): AvatarState => ({
  kind: 'walking',
  settlementId,
  // 100 m east, then 50 m south.
  path: { segmentIds: ['segment-1-000001', 'segment-1-000002'], walked: [100, 50], length: 150, points: [[0, 0], [100, 0], [100, 50]] },
  departAt: 1000,
  speed: 1.5,
  destination,
});
const toStreet = walk({ kind: 'street', segmentId: 'segment-1-000002', point: [100, 50] });
const toBuilding = walk({ kind: 'building', buildingId: 'building-1-000007' });
const labels = { buildingTypes: { tannery: 'Tannery', 'market-stall': 'Market stall' }, visits: { market: 'Going to market' } } as unknown as PackLabels;

describe('where the avatar is', () => {
  it('is where it stands, or in the building it is in', () => {
    expect(avatarPlace({ kind: 'standing', settlementId, segmentId: 'segment-1-000001', point: [3, 4] }, 0)).toEqual({ kind: 'street', point: [3, 4], walking: false });
    expect(avatarPlace({ kind: 'inside', settlementId, buildingId: 'building-1-000007' }, 99)).toEqual({ kind: 'building', buildingId: 'building-1-000007' });
  });

  it('moves along the path it was sent, as far as speed times the time since it set out', () => {
    expect(avatarPlace(toStreet, 1000)).toEqual({ kind: 'street', point: [0, 0], walking: true, arriveAt: 1100 });
    expect(avatarPlace(toStreet, 1020)).toMatchObject({ point: [30, 0], walking: true });
    // Round the corner: 120 m along is 20 m down the second piece.
    expect(avatarPlace(toStreet, 1080)).toMatchObject({ point: [100, 20], walking: true });
    // Before setting out it is at the start.
    expect(avatarPlace(toStreet, 400)).toMatchObject({ point: [0, 0], walking: true });
  });

  it('has arrived at the arrival time: standing at the street point, or in the building', () => {
    for (const time of [1100, 1100.5, 99_999]) {
      expect(avatarPlace(toStreet, time)).toEqual({ kind: 'street', point: [100, 50], walking: false });
      expect(avatarPlace(toBuilding, time)).toEqual({ kind: 'building', buildingId: 'building-1-000007' });
    }
    expect(avatarPlace(toBuilding, 1099.9)).toMatchObject({ kind: 'street', walking: true });
  });

  it('gives the same answer whatever was asked before, earlier or later', () => {
    const times = [1090, 1010, 2000, 1050, 1010];
    const first = times.map((time) => avatarPlace(toStreet, time));
    expect([...times].reverse().map((time) => avatarPlace(toStreet, time)).reverse()).toEqual(first);
  });
});

describe('the avatar in words', () => {
  it('says what the avatar is doing', () => {
    expect(describeAvatar({ kind: 'standing', settlementId, segmentId: 'segment-1-000001', point: [3, 4] }, 0)).toBe('Standing in the street');
    expect(describeAvatar(toStreet, 1010)).toBe('Walking along the street, arriving at 00:18');
    expect(describeAvatar(toBuilding, 1010)).toBe('Walking to a building, arriving at 00:18');
    expect(describeAvatar(toBuilding, 1200, 'tannery')).toBe('In the tannery');
    expect(describeAvatar(toStreet, 1200)).toBe('Standing in the street');
  });

  it('says what someone nearby is doing, and how far off they are', () => {
    const buildings = { 'building-1-000002': 'tannery', 'building-1-000003': 'market-stall' };
    const walking: Nearby = { personId: 'person-1-000001', distance: 12.4, point: [0, 0], kind: 'walking', fromBuildingId: 'building-1-000003', toBuildingId: 'building-1-000002' };
    const working: Nearby = { personId: 'person-1-000002', distance: 3, point: [0, 0], kind: 'outside', buildingId: 'building-1-000003', activity: 'work' };
    const visiting: Nearby = { ...working, activity: 'visit', visitId: 'market' };
    expect(describeNearby(walking, buildings, labels)).toBe('Walking to the tannery');
    expect(describeNearby(working, buildings, labels)).toBe('At work outside the market stall');
    expect(describeNearby(visiting, buildings, labels)).toBe('Going to market, outside the market stall');
    expect(describeDistance(12.4)).toBe('12 m');
    expect(describeDistance(0.3)).toBe('0 m');
  });

  it('says what someone in the same building is doing', () => {
    const occupant = (extra: Partial<Occupant>): Occupant => ({ personId: 'person-1-000001', kind: 'work', ...extra });
    expect(describeOccupant(occupant({}), labels)).toBe('At work');
    expect(describeOccupant(occupant({ outside: true }), labels)).toBe('At work (outside)');
    expect(describeOccupant(occupant({ kind: 'visit', visitId: 'market' }), labels)).toBe('Going to market');
    expect(describeOccupant(occupant({ kind: 'sleep' }), labels)).toBe('Asleep');
    expect(describeOccupant(occupant({ kind: 'home' }), labels)).toBe('At home');
    // A traveller awake at an inn is at their lodging.
    expect(describeOccupant(occupant({ personId: 'traveller-1-000009-merchant-002-01', outsider: true, kind: 'home' }), labels)).toBe('At their lodging');
    expect(describeOccupant(occupant({ personId: 'traveller-1-000009-merchant-002-01', outsider: true, kind: 'sleep' }), labels)).toBe('Asleep');
  });

  it('says when someone nearby lives on the street: asleep there, or awake at the place where they sleep', () => {
    const vagrant = { personId: 'vagrant-1-000003', outsider: true as const, distance: 4, point: [0, 0] as [number, number], kind: 'outside' as const, segmentId: 'segment-1-000001' };
    expect(describeNearby({ ...vagrant, activity: 'sleep' }, {}, labels)).toBe('Asleep in the street');
    expect(describeNearby({ ...vagrant, activity: 'home' }, {}, labels)).toBe('In the street, at the place where they sleep');
  });
});

describe('following the avatar', () => {
  it('zooms to where the smaller side of the map shows a few perception radii', () => {
    expect(followScale(30, 900, 600)).toBe(4);
    expect(followScale(60, 900, 600)).toBe(2);
    expect(followScale(30, 300, 600)).toBe(2);
  });
});

describe('people on rounds and on the street, as the avatar sees them', () => {
  const buildings = { 'building-1-000002': 'tannery' };
  it('says so when there is no building to name', () => {
    expect(describeNearby({ personId: 'person-1-000001', distance: 4, point: [0, 0], kind: 'walking', fromBuildingId: 'building-1-000002', round: true }, buildings, labels)).toBe('On their round, walking along the street');
    expect(describeNearby({ personId: 'person-1-000001', distance: 4, point: [0, 0], kind: 'walking', toBuildingId: 'building-1-000002', round: true }, buildings, labels)).toBe('On their round, walking to the tannery');
    expect(describeNearby({ personId: 'person-1-000001', distance: 4, point: [0, 0], kind: 'outside', segmentId: 'segment-1-000001', activity: 'work', round: true }, buildings, labels)).toBe('On their round, stopped in the street');
    expect(describeNearby({ personId: 'person-1-000001', distance: 4, point: [0, 0], kind: 'outside', segmentId: 'segment-1-000001', activity: 'visit', visitId: 'market' }, buildings, labels)).toBe('Going to market, in the street');
    expect(describeNearby({ personId: 'person-1-000001', distance: 4, point: [0, 0], kind: 'walking', fromBuildingId: 'building-1-000002' }, buildings, labels)).toBe('Walking along the street');
  });
});
