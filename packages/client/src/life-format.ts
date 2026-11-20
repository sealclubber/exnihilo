/**
 * Daily life in words: what someone is doing, and their day as a timeline.
 * Pure, so the wording can be tested without a browser.
 */
import type { Activity, PackLabels, Whereabouts } from '@worldsim/core';
import { buildingTypeName } from './city-format.ts';
import { formatClock } from './clock.ts';
import { formatMetres } from './town-format.ts';

type Buildings = Record<string, string>;

const place = (buildingId: string, buildings: Buildings, labels: PackLabels) => {
  const type = buildings[buildingId];
  return type === undefined ? buildingId : buildingTypeName(type, labels).toLowerCase();
};

/** A short word for what someone is doing, for a table cell. */
export function activityWord(kind: Activity['kind']): string {
  return { sleep: 'Asleep', home: 'At home', work: 'At work', visit: 'Visiting', travel: 'On the street' }[kind];
}

/** What an activity is, in a phrase: "Work at the tannery". */
export function describeActivity(activity: Activity, buildings: Buildings, labels: PackLabels, home?: string): string {
  switch (activity.kind) {
    case 'sleep':
      return 'Asleep at home';
    case 'home':
      return 'At home';
    case 'work':
      return activity.buildingId === home ? 'Work, at home' : `Work at the ${place(activity.buildingId, buildings, labels)}`;
    case 'visit':
      return `${labels.visits[activity.visitId ?? ''] ?? 'A visit'}, at the ${place(activity.buildingId, buildings, labels)}`;
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
      return `${where.buildingId === home ? 'At work, at home' : `At work at the ${place(where.buildingId, buildings, labels)}`}, ${until}`;
    case 'visit':
      return `${labels.visits[where.visitId ?? ''] ?? 'A visit'}, at the ${place(where.buildingId, buildings, labels)}, ${until}`;
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
