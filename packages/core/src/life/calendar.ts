/**
 * Game time and the calendar.
 *
 * Game time is a number of game seconds since the start of day 1 of the
 * world's current year. A day is 24 hours of 60 minutes. Nothing here reads a
 * clock: game time is always an argument.
 */
import { type Calendar, SECONDS_PER_DAY } from '../pack/schema.ts';

export { SECONDS_PER_DAY } from '../pack/schema.ts';

/** The day a game time falls on. Day 1 starts at game time 0. */
export function dayOf(time: number): number {
  return Math.floor(time / SECONDS_PER_DAY) + 1;
}

/** The game time at which a day starts. */
export function startOfDay(day: number): number {
  return (day - 1) * SECONDS_PER_DAY;
}

/** Seconds since midnight. */
export function timeOfDay(time: number): number {
  return ((time % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY;
}

/** Which day of the week a day is, counting from 0. Day 1 is the first day of the week. */
export function weekdayOf(day: number, calendar: Calendar): number {
  const length = calendar.week.length;
  return (((day - 1) % length) + length) % length;
}

export function isRestDay(day: number, calendar: Calendar): boolean {
  return (calendar.week[weekdayOf(day, calendar)] as Calendar['week'][number]).rest;
}

/** A time of day as "HH:MM". */
export function formatTimeOfDay(seconds: number): string {
  const whole = Math.floor(timeOfDay(seconds) / 60);
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
}

/** Everything the calendar says about a moment. */
export interface GameMoment {
  time: number;
  /** Counting from 1. */
  day: number;
  /** Years since the start, counting from 1, and the day within that year, counting from 1. */
  year: number;
  dayOfYear: number;
  weekday: number;
  weekdayName: string;
  isRestDay: boolean;
  /** Seconds since midnight. */
  timeOfDay: number;
  /** Whether the sun is up. */
  isLight: boolean;
}

export function describeMoment(time: number, calendar: Calendar): GameMoment {
  const day = dayOf(time);
  const weekday = weekdayOf(day, calendar);
  const seconds = timeOfDay(time);
  return {
    time,
    day,
    year: Math.floor((day - 1) / calendar.daysPerYear) + 1,
    dayOfYear: ((((day - 1) % calendar.daysPerYear) + calendar.daysPerYear) % calendar.daysPerYear) + 1,
    weekday,
    weekdayName: (calendar.week[weekday] as Calendar['week'][number]).name,
    isRestDay: isRestDay(day, calendar),
    timeOfDay: seconds,
    isLight: seconds >= calendar.sunrise && seconds < calendar.sunset,
  };
}
