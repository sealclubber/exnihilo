import { describe, expect, it } from 'vitest';
import type { Activity, Calendar, ClockState, PackLabels, Trip, Whereabouts } from '@worldsim/core';
import { ClockSync, clockFace, describeRate, formatClock, nextTimeOfDay, tripPosition, tripWindow, wanderPosition } from '../src/clock.ts';
import { activityWord, describeActivity, describeHours, describeWhereabouts, timeline } from '../src/life-format.ts';
import { describeSeen } from '../src/town-format.ts';

const DAY = 86_400;
const calendar: Calendar = {
  week: ['Moonday', 'Tilsday', 'Midweek', 'Thunsday', 'Freeday', 'Marketday', 'Restday'].map((name) => ({ name, rest: name === 'Restday' })),
  daysPerYear: 364,
  sunrise: 6 * 3600,
  sunset: 19 * 3600,
};
const state = (gameTime: number, rate: number, running: boolean): ClockState => ({ gameTime, rate, running, rates: [1, 30, 3600] });

describe('keeping in step with the server\'s clock', () => {
  it('knows nothing until it has heard from the server', () => {
    const sync = new ClockSync(() => 0);
    expect(sync.known).toBe(false);
    expect(sync.now()).toBeUndefined();
  });

  it('moves on from the state it was told, at the rate it was told', () => {
    let real = 5000;
    const sync = new ClockSync(() => real);
    sync.apply(state(1000, 30, true));
    expect(sync.now()).toBe(1000);
    real += 2000;
    expect(sync.now()).toBe(1060);
    sync.apply(state(1060, 1, true));
    real += 2000;
    expect(sync.now()).toBe(1062);
  });

  it('stands still while the clock is paused, and takes a jump at once', () => {
    let real = 0;
    const sync = new ClockSync(() => real);
    sync.apply(state(500, 3600, false));
    real += 60_000;
    expect(sync.now()).toBe(500);
    sync.apply(state(7 * DAY, 3600, false));
    expect(sync.now()).toBe(7 * DAY);
    expect(sync.current).toMatchObject({ rate: 3600, running: false });
  });
});

describe('showing game time', () => {
  it('gives the day, its name, the time and whether it is light', () => {
    expect(clockFace(0, calendar)).toEqual({ day: 1, dayName: 'Moonday', isRestDay: false, time: '00:00', isLight: false });
    expect(clockFace(6 * DAY + 10 * 3600 + 5 * 60 + 59, calendar)).toEqual({ day: 7, dayName: 'Restday', isRestDay: true, time: '10:05', isLight: true });
    expect(clockFace(7 * DAY + 19 * 3600, calendar)).toMatchObject({ day: 8, dayName: 'Moonday', isLight: false });
    expect(clockFace(7 * DAY + 19 * 3600 - 1, calendar).isLight).toBe(true);
    expect(formatClock(3 * DAY + 23 * 3600 + 59 * 60)).toBe('23:59');
  });

  it('finds the next morning, midday or evening after a moment', () => {
    const noon = 2 * DAY + 12 * 3600;
    expect(nextTimeOfDay(noon, calendar.sunrise)).toBe(3 * DAY + 6 * 3600);
    expect(nextTimeOfDay(noon, calendar.sunset)).toBe(2 * DAY + 19 * 3600);
    // At the very moment, it is the next day's that is next.
    expect(nextTimeOfDay(noon, 12 * 3600)).toBe(3 * DAY + 12 * 3600);
    expect(nextTimeOfDay(0, calendar.sunrise)).toBe(6 * 3600);
  });

  it('describes a rate by what it does to a game day', () => {
    expect(describeRate(1)).toEqual({ label: '1×', title: 'Real time: a game day takes 24 real hours' });
    expect(describeRate(30)).toEqual({ label: '30×', title: 'A game day takes 48 real minutes' });
    expect(describeRate(3600)).toEqual({ label: '3,600×', title: 'A game day takes 24 real seconds' });
    expect(describeRate(10).title).toBe('A game day takes 2.4 real hours');
  });

  it('asks for more game time ahead at higher rates, within limits', () => {
    expect(tripWindow(1)).toBe(900);
    expect(tripWindow(30)).toBe(1800);
    expect(tripWindow(120)).toBe(7200);
    expect(tripWindow(3600)).toBe(4 * 3600);
  });
});

describe('moving a dot along a trip', () => {
  const trip: Trip = {
    personId: 'person-1-000001',
    fromBuildingId: 'building-1-000001',
    toBuildingId: 'building-1-000002',
    departAt: 1000,
    arriveAt: 1100,
    length: 200,
    // A bent line: 100 m east, then 100 m south.
    points: [[0, 0], [100, 0], [100, 100]],
  };

  it('places it by the share of the trip\'s time that has passed', () => {
    expect(tripPosition(trip, 1000)).toEqual([0, 0]);
    expect(tripPosition(trip, 1025)).toEqual([50, 0]);
    expect(tripPosition(trip, 1050)).toEqual([100, 0]);
    expect(tripPosition(trip, 1075)).toEqual([100, 50]);
    expect(tripPosition(trip, 1100)).toEqual([100, 100]);
  });

  it('shows nothing before the trip starts or after it ends', () => {
    expect(tripPosition(trip, 999)).toBeUndefined();
    expect(tripPosition(trip, 1101)).toBeUndefined();
  });

  it('gives the same answer in any order, at any rate of asking', () => {
    const times = [1090, 1001, 1050, 1001, 1099.5, 1033];
    const forwards = times.map((time) => tripPosition(trip, time));
    expect([...times].reverse().map((time) => tripPosition(trip, time)).reverse()).toEqual(forwards);
  });

  it('copes with a trip of no length or no duration', () => {
    expect(tripPosition({ ...trip, points: [[5, 5]], length: 0 }, 1050)).toEqual([5, 5]);
    expect(tripPosition({ ...trip, arriveAt: 1000 }, 1000)).toEqual([100, 100]);
  });
});

describe('daily life in words', () => {
  const labels = {
    buildingTypes: { tannery: 'Tannery', tavern: 'Tavern', cottage: 'Cottage' },
    visits: { tavern: 'A drink after work', play: 'Playing outside' },
  } as unknown as PackLabels;
  const buildings = { 'building-1-000001': 'cottage', 'building-1-000002': 'tannery', 'building-1-000003': 'tavern' };
  const home = 'building-1-000001';
  const path = { segmentIds: ['segment-1-000001'], walked: [412], length: 412, points: [[0, 0], [412, 0]] as [number, number][] };
  const activities: Activity[] = [
    { kind: 'sleep', start: DAY, end: DAY + 6 * 3600, buildingId: home },
    { kind: 'home', start: DAY + 6 * 3600, end: DAY + 7 * 3600 + 50 * 60, buildingId: home },
    { kind: 'travel', start: DAY + 7 * 3600 + 50 * 60, end: DAY + 8 * 3600, fromBuildingId: home, toBuildingId: 'building-1-000002', departAt: DAY + 7 * 3600 + 50 * 60, arriveAt: DAY + 8 * 3600, path },
    { kind: 'work', start: DAY + 8 * 3600, end: DAY + 17 * 3600, buildingId: 'building-1-000002' },
    { kind: 'travel', start: DAY + 17 * 3600, end: DAY + 17 * 3600 + 300, fromBuildingId: 'building-1-000002', toBuildingId: 'building-1-000003', departAt: DAY + 17 * 3600, arriveAt: DAY + 17 * 3600 + 300, path },
    { kind: 'visit', start: DAY + 17 * 3600 + 300, end: DAY + 18 * 3600, buildingId: 'building-1-000003', visitId: 'tavern' },
    { kind: 'travel', start: DAY + 18 * 3600, end: DAY + 18 * 3600 + 400, fromBuildingId: 'building-1-000003', toBuildingId: home, departAt: DAY + 18 * 3600, arriveAt: DAY + 18 * 3600 + 400, path },
    { kind: 'sleep', start: DAY + 18 * 3600 + 400, end: 2 * DAY, buildingId: home },
  ];

  it('describes each activity', () => {
    expect(activities.map((activity) => describeActivity(activity, buildings, labels, home))).toEqual([
      'Asleep at home',
      'At home',
      'Walk to the tannery (412 m)',
      'Work at the tannery',
      'Walk to the tavern (412 m)',
      'A drink after work, at the tavern',
      'Walk home (412 m)',
      'Asleep at home',
    ]);
    expect(describeActivity({ kind: 'work', start: 0, end: 1, buildingId: home }, buildings, labels, home)).toBe('Work, at home');
    expect(describeActivity({ kind: 'work', start: 0, end: 1, buildingId: 'building-1-000009' }, buildings, labels, home)).toBe('Work at the building-1-000009');
    expect(['sleep', 'home', 'work', 'visit', 'travel'].map((kind) => activityWord(kind as Activity['kind']))).toEqual(['Asleep', 'At home', 'At work', 'Visiting', 'On the street']);
  });

  it('lays a plan out as a timeline, marking what is under way', () => {
    const rows = timeline(activities, buildings, labels, DAY + 12 * 3600, home);
    expect(rows.map((row) => row.time)).toEqual(['00:00 – 06:00', '06:00 – 07:50', '07:50 – 08:00', '08:00 – 17:00', '17:00 – 17:05', '17:05 – 18:00', '18:00 – 18:06', '18:06 – 24:00']);
    expect(rows.filter((row) => row.current).map((row) => row.text)).toEqual(['Work at the tannery']);
    expect(timeline(activities, buildings, labels).every((row) => !row.current)).toBe(true);
  });

  it('says what someone is doing now, and until when', () => {
    const at = (where: Partial<Whereabouts>) => describeWhereabouts({ personId: 'person-1-000001', time: 0, since: 0, until: DAY + 17 * 3600 + 3 * 60, ...where } as Whereabouts, buildings, labels, home);
    expect(at({ kind: 'work', buildingId: 'building-1-000002' })).toBe('At work at the tannery, until 17:03');
    expect(at({ kind: 'work', buildingId: home })).toBe('At work, at home, until 17:03');
    expect(at({ kind: 'sleep', buildingId: home })).toBe('Asleep at home, until 17:03');
    expect(at({ kind: 'visit', buildingId: 'building-1-000003', visitId: 'tavern' })).toBe('A drink after work, at the tavern, until 17:03');
    expect(at({ kind: 'travel', point: [0, 0], segmentId: 'segment-1-000001', fromBuildingId: 'building-1-000002', toBuildingId: home })).toBe('Walking home, arriving at 17:03');
    expect(at({ kind: 'travel', point: [0, 0], segmentId: 'segment-1-000001', fromBuildingId: home, toBuildingId: 'building-1-000003' })).toBe('Walking to the tavern, arriving at 17:03');
  });

  it('says when someone is out of doors, at a place or outside their own home', () => {
    const at = (where: Partial<Whereabouts>) => describeWhereabouts({ personId: 'person-1-000001', time: 0, since: 0, until: DAY + 17 * 3600 + 3 * 60, ...where } as Whereabouts, buildings, labels, home);
    expect(at({ kind: 'work', buildingId: 'building-1-000002', outside: true, point: [1, 2] })).toBe('At work, outside at the tannery, until 17:03');
    expect(at({ kind: 'visit', buildingId: 'building-1-000003', visitId: 'tavern', outside: true, point: [1, 2] })).toBe('A drink after work, outside at the tavern, until 17:03');
    expect(at({ kind: 'visit', buildingId: home, visitId: 'play', outside: true, point: [1, 2] })).toBe('Playing outside, outside their home, until 17:03');
    expect(at({ kind: 'visit', buildingId: home, visitId: 'play' })).toBe('Playing outside, at home, until 17:03');
    expect(describeActivity({ kind: 'work', start: 0, end: 1, buildingId: 'building-1-000002', outside: true, wander: { times: [0, 1], points: [[1, 2], [1, 2]] } }, buildings, labels, home)).toBe('Work, outside at the tannery');
    expect(describeActivity({ kind: 'visit', start: 0, end: 1, buildingId: home, visitId: 'play', outside: true, wander: { times: [0, 1], points: [[1, 2], [1, 2]] } }, buildings, labels, home)).toBe('Playing outside, outside their home');
  });

  it('says whether a building is open, and its hours that day', () => {
    expect(describeHours(true, [{ from: DAY + 15 * 3600, to: DAY + 23 * 3600 }])).toBe('Open now · today 15:00 – 23:00');
    expect(describeHours(false, [{ from: DAY + 15 * 3600, to: DAY + 23 * 3600 }])).toBe('Closed now · today 15:00 – 23:00');
    expect(describeHours(false, [])).toBe('Closed now · closed all day');
    expect(describeHours(true, [{ from: DAY, to: 2 * DAY }])).toBe('Open now · open all day');
    // A night shift seen from one day: the small hours, then the late evening up to midnight.
    expect(describeHours(true, [{ from: DAY, to: DAY + 18 * 3600 }, { from: DAY + 22 * 3600, to: 2 * DAY }])).toBe('Open now · today 00:00 – 18:00, 22:00 – 24:00');
  });

  it('counts the people to be seen, walking and outside apart', () => {
    expect(describeSeen(31, 1000, true)).toBe('31 walking · 1,000 outside');
    expect(describeSeen(4, 0, false)).toBe('4 walking · 0 outside, in view');
  });
});

describe('moving about outside', () => {
  const wander = { times: [100, 160, 180, 240], points: [[0, 0], [0, 0], [10, 0], [10, 0]] as [number, number][] };

  it('puts someone where their wander has them at a game time: pausing at a point, part of the way while moving', () => {
    expect(wanderPosition(wander, 100)).toEqual([0, 0]);
    expect(wanderPosition(wander, 150)).toEqual([0, 0]);
    expect(wanderPosition(wander, 165)).toEqual([2.5, 0]);
    expect(wanderPosition(wander, 170)).toEqual([5, 0]);
    expect(wanderPosition(wander, 180)).toEqual([10, 0]);
    expect(wanderPosition(wander, 200)).toEqual([10, 0]);
  });

  it('holds them at the ends before it begins and after it is over', () => {
    expect(wanderPosition(wander, 0)).toEqual([0, 0]);
    expect(wanderPosition(wander, 9999)).toEqual([10, 0]);
    expect(wanderPosition({ times: [5, 5], points: [[1, 1], [2, 2]] }, 5)).toEqual([1, 1]);
  });
});

describe('rounds, strolls and the street, in words', () => {
  const labels = { buildingTypes: { tannery: 'Tannery', cottage: 'Cottage', well: 'Well' }, visits: { play: 'Playing outside', walk: 'An evening walk' } } as unknown as PackLabels;
  const buildings = { 'building-1-000001': 'cottage', 'building-1-000002': 'tannery', 'building-1-000003': 'well' };
  const home = 'building-1-000001';
  const path = { segmentIds: ['segment-1-000001'], walked: [120], length: 120, points: [[0, 0], [120, 0]] as [number, number][] };
  const wander = { times: [0, 60], points: [[1, 2], [1, 2]] as [number, number][] };
  const street = { segmentId: 'segment-1-000001', point: [120, 0] as [number, number] };

  it('says when a walk or a stop is part of a round', () => {
    const leg: Activity = { kind: 'travel', start: 0, end: 90, fromBuildingId: 'building-1-000002', toStreet: street, departAt: 0, arriveAt: 90, path, round: true };
    expect(describeActivity(leg, buildings, labels, home)).toBe('On their round: walk along the street (120 m)');
    expect(describeActivity({ ...leg, toStreet: undefined, toBuildingId: 'building-1-000003' } as Activity, buildings, labels, home)).toBe('On their round: walk to the well (120 m)');
    expect(describeActivity({ kind: 'street', start: 0, end: 60, segmentId: 'segment-1-000001', wander, purpose: 'work', round: true }, buildings, labels, home)).toBe('On their round: a stop in the street');
    expect(describeActivity({ kind: 'work', start: 0, end: 60, buildingId: 'building-1-000003', outside: true, wander, round: true }, buildings, labels, home)).toBe('On their round: a stop outside at the well');
    expect(activityWord('street')).toBe('On the street');
  });

  it('says where someone is who is on a round, on a stroll or out in front of a building', () => {
    const at = (where: object) => describeWhereabouts({ personId: 'person-1-000001', time: 0, since: 0, until: 17 * 3600 + 3 * 60, ...where } as Whereabouts, buildings, labels, home);
    expect(at({ kind: 'travel', point: [0, 0], segmentId: 'segment-1-000001', fromBuildingId: 'building-1-000002', toStreet: street, round: true })).toBe('On their round, walking along the street, arriving at 17:03');
    expect(at({ kind: 'street', point: [0, 0], segmentId: 'segment-1-000001', purpose: 'work', round: true })).toBe('On their round, stopped in the street, until 17:03');
    expect(at({ kind: 'street', point: [0, 0], segmentId: 'segment-1-000001', purpose: 'visit', visitId: 'walk' })).toBe('An evening walk, pausing in the street, until 17:03');
    expect(at({ kind: 'travel', point: [0, 0], segmentId: 'segment-1-000001', fromBuildingId: home, toStreet: street })).toBe('Walking along the street, arriving at 17:03');
    expect(at({ kind: 'visit', buildingId: home, visitId: 'play', outside: true, onStreet: true, point: [1, 2] })).toBe('Playing outside, in the street outside their home, until 17:03');
    expect(at({ kind: 'work', buildingId: 'building-1-000003', outside: true, point: [1, 2], round: true })).toBe('On their round, stopped outside at the well, until 17:03');
  });
});
