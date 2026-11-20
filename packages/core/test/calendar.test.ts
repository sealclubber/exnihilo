import { describe, expect, it } from 'vitest';
import { SECONDS_PER_DAY, dayOf, describeMoment, formatTimeOfDay, isRestDay, startOfDay, timeOfDay, weekdayOf } from '../src/index.ts';
import { medievalPack } from './pack.ts';

const { calendar } = medievalPack();
const at = (day: number, hours: number, minutes = 0) => startOfDay(day) + hours * 3600 + minutes * 60;

describe('game time', () => {
  it('counts days from 1, each of 24 hours of 60 minutes', () => {
    expect(SECONDS_PER_DAY).toBe(24 * 60 * 60);
    expect(dayOf(0)).toBe(1);
    expect(dayOf(86_399)).toBe(1);
    expect(dayOf(86_400)).toBe(2);
    expect(startOfDay(1)).toBe(0);
    expect(startOfDay(8)).toBe(7 * 86_400);
    expect(dayOf(startOfDay(123))).toBe(123);
    expect(timeOfDay(at(5, 13, 30))).toBe(13 * 3600 + 30 * 60);
  });

  it('writes a time of day as hours and minutes', () => {
    expect(formatTimeOfDay(0)).toBe('00:00');
    expect(formatTimeOfDay(at(3, 7, 5))).toBe('07:05');
    expect(formatTimeOfDay(at(3, 23, 59) + 59)).toBe('23:59');
  });
});

describe('the calendar', () => {
  it('names the days of the week in order, starting on day 1', () => {
    expect(calendar.week.map((day) => day.name)).toEqual(['Moonday', 'Tilsday', 'Midweek', 'Thunsday', 'Freeday', 'Marketday', 'Restday']);
    expect(weekdayOf(1, calendar)).toBe(0);
    expect(weekdayOf(7, calendar)).toBe(6);
    expect(weekdayOf(8, calendar)).toBe(0);
    expect(weekdayOf(0, calendar)).toBe(6);
  });

  it('knows the rest days', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 14].map((day) => isRestDay(day, calendar))).toEqual([false, false, false, false, false, false, true, false, true]);
  });

  it('derives everything about a moment', () => {
    expect(describeMoment(at(7, 14, 30), calendar)).toEqual({
      time: at(7, 14, 30),
      day: 7,
      year: 1,
      dayOfYear: 7,
      weekday: 6,
      weekdayName: 'Restday',
      isRestDay: true,
      timeOfDay: 14 * 3600 + 30 * 60,
      isLight: true,
    });
    expect(describeMoment(at(calendar.daysPerYear + 1, 0), calendar)).toMatchObject({ year: 2, dayOfYear: 1 });
    expect(describeMoment(at(calendar.daysPerYear, 0), calendar)).toMatchObject({ year: 1, dayOfYear: calendar.daysPerYear });
  });

  it('knows whether it is light', () => {
    const light = (hours: number, minutes = 0) => describeMoment(at(2, hours, minutes), calendar).isLight;
    expect(light(5, 59)).toBe(false);
    expect(light(6)).toBe(true);
    expect(light(12)).toBe(true);
    expect(light(18, 59)).toBe(true);
    expect(light(19)).toBe(false);
    expect(light(23)).toBe(false);
  });
});
