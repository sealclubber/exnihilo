/**
 * Daily life in words: what someone is doing, and their day as a timeline.
 * Pure, so the wording can be tested without a browser.
 */
import type { Activity, OpenSpan, PackLabels, Whereabouts } from '@worldsim/core';
import { buildingTypeName } from './city-format.ts';
import { formatClock } from './clock.ts';
import { formatMetres } from './town-format.ts';

const SECONDS_PER_DAY = 86_400;

type Buildings = Record<string, string>;

const place = (buildingId: string, buildings: Buildings, labels: PackLabels) => {
  const type = buildings[buildingId];
  return type === undefined ? buildingId : buildingTypeName(type, labels).toLowerCase();
};

/** A short word for what someone is doing, for a table cell. */
export function activityWord(kind: Activity['kind']): string {
  return { sleep: 'Asleep', home: 'At home', work: 'At work', visit: 'Visiting', travel: 'On the street' }[kind];
}

/** Where a stay at a building is spent, as the end of a phrase: "at the tavern", "outside at the market stall", "outside their home". */
function whereAt(stay: { buildingId: string; outside?: true | undefined }, buildings: Buildings, labels: PackLabels, home?: string): string {
  if (stay.buildingId === home) return stay.outside ? 'outside their home' : 'at home';
  return `${stay.outside ? 'outside at' : 'at'} the ${place(stay.buildingId, buildings, labels)}`;
}

/**
 * Whether a building is open at a moment, and its hours that day:
 * "Open now · today 15:00 – 23:00". The hours are those of the day the moment falls on.
 */
export function describeHours(open: boolean, hours: OpenSpan[]): string {
  const now = open ? 'Open now' : 'Closed now';
  if (hours.length === 0) return `${now} · closed all day`;
  const allDay = hours.length === 1 && (hours[0] as OpenSpan).to - (hours[0] as OpenSpan).from >= SECONDS_PER_DAY;
  if (allDay) return `${now} · open all day`;
  // A stretch that runs to midnight ends at 24:00, not at the next day's 00:00.
  const end = (span: OpenSpan) => (span.to % SECONDS_PER_DAY === 0 ? '24:00' : formatClock(span.to));
  return `${now} · today ${hours.map((span) => `${formatClock(span.from)} – ${end(span)}`).join(', ')}`;
}

/** What an activity is, in a phrase: "Work at the tannery". */
export function describeActivity(activity: Activity, buildings: Buildings, labels: PackLabels, home?: string): string {
  switch (activity.kind) {
    case 'sleep':
      return 'Asleep at home';
    case 'home':
      return 'At home';
    case 'work':
      if (activity.outside) return `Work, ${whereAt(activity, buildings, labels, home)}`;
      return activity.buildingId === home ? 'Work, at home' : `Work at the ${place(activity.buildingId, buildings, labels)}`;
    case 'visit':
      return `${labels.visits[activity.visitId ?? ''] ?? 'A visit'}, ${whereAt(activity, buildings, labels, home)}`;
    case 'travel':
      return `Walk ${activity.toBuildingId === home ? 'home' : `to the ${place(activity.toBuildingId, buildings, labels)}`} (${formatMetres(activity.path.length)})`;
  }
}

/** What someone is doing at a moment, and until when. */
export function describeWhereabouts(where: Whereabouts, buildings: Buildings, labels: PackLabels, home?: string): string {
  const until = `until ${formatClock(where.until)}`;
  switch (where.kind) {
    case 'sleep':
      return `Asleep at home, ${until}`;
    case 'home':
      return `At home, ${until}`;
    case 'work':
      if (where.outside) return `At work, ${whereAt(where, buildings, labels, home)}, ${until}`;
      return `${where.buildingId === home ? 'At work, at home' : `At work at the ${place(where.buildingId, buildings, labels)}`}, ${until}`;
    case 'visit':
      return `${labels.visits[where.visitId ?? ''] ?? 'A visit'}, ${whereAt(where, buildings, labels, home)}, ${until}`;
    case 'travel':
      return `Walking ${where.toBuildingId === home ? 'home' : `to the ${place(where.toBuildingId, buildings, labels)}`}, arriving at ${formatClock(where.until)}`;
  }
}

export interface TimelineRow {
  /** "06:12 – 07:31". */
  time: string;
  text: string;
  kind: Activity['kind'];
  /** Whether the game time given falls within this activity. */
  current: boolean;
}

/** A day plan as rows for a timeline, marking the activity under way at a game time. */
export function timeline(activities: Activity[], buildings: Buildings, labels: PackLabels, now?: number, home?: string): TimelineRow[] {
  return activities.map((activity, index) => ({
    time: `${formatClock(activity.start)} – ${index === activities.length - 1 ? '24:00' : formatClock(activity.end)}`,
    text: describeActivity(activity, buildings, labels, home),
    kind: activity.kind,
    current: now !== undefined && now >= activity.start && now < activity.end,
  }));
}
