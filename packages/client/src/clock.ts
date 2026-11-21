/**
 * The viewer's side of the world clock: keeping in step with the server's,
 * and the arithmetic for showing it and for moving dots along trips.
 *
 * The viewer does not plan or decide anything. It is told the clock's state
 * and the trips for a window of game time, and works out where on its path
 * each trip has reached.
 */
import type { Calendar, ClockState, Point, Trip, Wander } from '@worldsim/core';

const SECONDS_PER_DAY = 86_400;

/** Follows the server's clock between the messages that report it. */
export class ClockSync {
  private state: ClockState | undefined;
  private heardAt = 0;
  private readonly realNow: () => number;

  /** `realNow` gives real time in milliseconds; it is passed in so tests can drive it. */
  constructor(realNow: () => number) {
    this.realNow = realNow;
  }

  /** Takes a state reported by the server as true from this moment. */
  apply(state: ClockState): void {
    this.state = state;
    this.heardAt = this.realNow();
  }

  get known(): boolean {
    return this.state !== undefined;
  }

  get current(): ClockState | undefined {
    return this.state;
  }

  /** The game time now, or undefined until the server has been heard from. */
  now(): number | undefined {
    if (!this.state) return undefined;
    if (!this.state.running) return this.state.gameTime;
    return this.state.gameTime + ((this.realNow() - this.heardAt) / 1000) * this.state.rate;
  }
}

export interface ClockFace {
  day: number;
  dayName: string;
  isRestDay: boolean;
  /** "HH:MM". */
  time: string;
  isLight: boolean;
}

/** What to show for a game time: the day, its name, and the time of day. */
export function clockFace(gameTime: number, calendar: Calendar): ClockFace {
  const day = Math.floor(gameTime / SECONDS_PER_DAY) + 1;
  const weekday = calendar.week[(((day - 1) % calendar.week.length) + calendar.week.length) % calendar.week.length] as Calendar['week'][number];
  const seconds = ((gameTime % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY;
  return {
    day,
    dayName: weekday.name,
    isRestDay: weekday.rest,
    time: formatClock(seconds),
    isLight: seconds >= calendar.sunrise && seconds < calendar.sunset,
  };
}

/** A game time as "HH:MM" on its day. */
export function formatClock(gameTime: number): string {
  const minutes = Math.floor((((gameTime % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY) / 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** The next game time, after the one given, at which the day reaches a time of day. */
export function nextTimeOfDay(gameTime: number, secondsOfDay: number): number {
  const today = Math.floor(gameTime / SECONDS_PER_DAY) * SECONDS_PER_DAY + secondsOfDay;
  return today > gameTime ? today : today + SECONDS_PER_DAY;
}

/** A rate as a label, such as "30×", and what it means for a game day. */
export function describeRate(rate: number): { label: string; title: string } {
  const realSeconds = SECONDS_PER_DAY / rate;
  const length =
    realSeconds >= 3600
      ? `${+(realSeconds / 3600).toFixed(1)} real ${realSeconds === 3600 ? 'hour' : 'hours'}`
      : realSeconds >= 60
        ? `${+(realSeconds / 60).toFixed(1)} real minutes`
        : `${+realSeconds.toFixed(1)} real seconds`;
  return { label: `${rate.toLocaleString('en-US')}×`, title: rate === 1 ? 'Real time: a game day takes 24 real hours' : `A game day takes ${length}` };
}

/**
 * How much game time ahead to ask for trips at a rate: enough for about a
 * minute of real time, within limits that keep each answer a sensible size.
 */
export function tripWindow(rate: number): number {
  return Math.min(Math.max(rate * 60, 900), 4 * 3600);
}

const lengthsOf = new WeakMap<Trip, number[]>();

/** Where a trip has reached at a game time, or undefined before it starts or after it ends. */
export function tripPosition(trip: Trip, time: number): Point | undefined {
  if (time < trip.departAt || time > trip.arriveAt) return undefined;
  const { points } = trip;
  let marks = lengthsOf.get(trip);
  if (!marks) {
    // The distance along the line at each of its points, worked out once per trip.
    marks = [0];
    for (let at = 1; at < points.length; at++) {
      const [ax, ay] = points[at - 1] as Point;
      const [bx, by] = points[at] as Point;
      marks.push((marks[at - 1] as number) + Math.hypot(bx - ax, by - ay));
    }
    lengthsOf.set(trip, marks);
  }
  const total = marks[marks.length - 1] as number;
  const share = trip.arriveAt === trip.departAt ? 1 : (time - trip.departAt) / (trip.arriveAt - trip.departAt);
  const along = total * share;
  for (let at = 1; at < points.length; at++) {
    const end = marks[at] as number;
    if (along <= end) {
      const start = marks[at - 1] as number;
      const part = end === start ? 0 : (along - start) / (end - start);
      const [ax, ay] = points[at - 1] as Point;
      const [bx, by] = points[at] as Point;
      return [ax + (bx - ax) * part, ay + (by - ay) * part];
    }
  }
  return points[points.length - 1] as Point;
}

/**
 * Where someone moving about outside is at a game time, on the wander they
 * were sent: at a point while they pause, part of the way to the next while
 * they move. Before the wander begins they are at its first point; after it
 * ends, at its last.
 */
export function wanderPosition(wander: Wander, time: number): Point {
  const { times, points } = wander;
  const last = times.length - 1;
  if (time <= (times[0] as number)) return points[0] as Point;
  if (time >= (times[last] as number)) return points[last] as Point;
  let low = 0;
  let high = last;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((times[middle] as number) <= time) low = middle;
    else high = middle - 1;
  }
  const [ax, ay] = points[low] as Point;
  const [bx, by] = points[low + 1] as Point;
  const span = (times[low + 1] as number) - (times[low] as number);
  const share = span === 0 ? 0 : (time - (times[low] as number)) / span;
  return [ax + (bx - ax) * share, ay + (by - ay) * share];
}
