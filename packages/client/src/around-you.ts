/**
 * The "around you" panel: what the avatar is doing, the controls that go with
 * it, and who it perceives, nearest first. On a street that is the residents
 * walking or out of doors nearby; in a building, everyone at that building.
 */
import type { AvatarPerception, AvatarState, PackLabels, Person } from '@worldsim/core';
import { describeAvatar, describeDistance, describeNearby, describeOccupant } from './avatar.ts';
import { buildingTypeName, workName } from './city-format.ts';
import { h, link } from './dom.ts';

export interface AroundYou {
  element: HTMLElement;
  /** How many people the avatar perceives, for the pane's one line when it is folded. */
  count(): string;
  /** Shows the avatar as it is at a game time, and what it perceives. `here` is whether it is in the town on show. */
  render(avatar: AvatarState | undefined, here: boolean, time: number, perception: AvatarPerception | undefined, labels: PackLabels): void;
  /** Shows a message, such as the server's reason for refusing an action. An empty one clears it. */
  note(text: string): void;
  /** Unticks the follow box, when the map has stopped following for a reason of its own. */
  unfollow(): void;
}

export interface AroundYouHandlers {
  onStop(): void;
  onLeave(): void;
  onFollow(on: boolean): void;
  onPerson(personId: string): void;
  onBuilding(buildingId: string): void;
  /** Told that the cursor is on an entry, or has left it. */
  onHover(personId: string | undefined): void;
}

export function createAroundYou(handlers: AroundYouHandlers): AroundYou {
  const status = h('p', { class: 'status' });
  const actions = h('p', { class: 'actions' });
  const message = h('p', { class: 'error' });
  const list = h('ul');
  const follow = h('input', { attrs: { type: 'checkbox', id: 'follow-avatar' } });
  follow.addEventListener('change', () => handlers.onFollow(follow.checked));
  const followRow = h('p', {}, h('label', { attrs: { for: 'follow-avatar' } }, follow, ' Follow on the map'));
  const element = h('div', { class: 'around-you' }, status, actions, followRow, message, list);
  let counted = '';
  const button = (text: string, onClick: () => void) => h('button', { attrs: { type: 'button' }, onClick }, text);
  /** A row for one person: hovering it marks them on the map. */
  const hoverable = (personId: string, ...children: HTMLElement[]) => {
    const row = h('li', { attrs: { 'data-person': personId } }, ...children);
    row.addEventListener('mouseenter', () => handlers.onHover(personId));
    row.addEventListener('mouseleave', () => handlers.onHover(undefined));
    return row;
  };
  const who = (person: Person, labels: PackLabels) => `${person.age}${person.occupationId ? ` · ${workName(person, labels)}` : ''}`;
  message.hidden = true;

  return {
    element,
    count: () => counted,
    unfollow: () => void (follow.checked = false),
    note(text) {
      message.textContent = text;
      message.hidden = text === '';
    },
    render(avatar, here, time, perception, labels) {
      if (!avatar || !here) {
        counted = avatar ? 'in another town' : 'not in the world';
        status.textContent = avatar
          ? `Your avatar is in another town (${avatar.settlementId}). Spawn here to bring it to this one.`
          : 'You are not in the world yet. Choose Spawn, then click the map, to stand in this town.';
        actions.replaceChildren();
        followRow.hidden = true;
        list.replaceChildren();
        return;
      }
      followRow.hidden = false;
      const inside = perception?.where === 'building' ? perception : undefined;
      status.textContent = describeAvatar(avatar, time, inside ? buildingTypeName(inside.buildingType, labels).toLowerCase() : undefined);
      const walking = avatar.kind === 'walking' && time < avatar.departAt + avatar.path.length / avatar.speed;
      actions.replaceChildren(
        ...(walking ? [button('Stop', handlers.onStop)] : []),
        ...(inside ? [button('Leave', handlers.onLeave), link('Show the building', () => handlers.onBuilding(inside.buildingId))] : []),
      );
      if (!perception) {
        counted = '';
        list.replaceChildren();
        return;
      }
      const rows =
        perception.where === 'building'
          ? perception.occupants.map((occupant) => ({ person: occupant.person, doing: describeOccupant(occupant, labels), away: '' }))
          : perception.nearby.map((entry) => ({ person: entry.person, doing: describeNearby(entry, perception.buildings, labels), away: describeDistance(entry.distance) }));
      counted = String(rows.length);
      list.replaceChildren(
        ...(rows.length === 0 ? [h('li', { class: 'hint' }, perception.where === 'building' ? 'Nobody else is here.' : 'Nobody is in sight.')] : []),
        ...rows.map(({ person, doing, away }) =>
          hoverable(
            person.id,
            h('div', {}, link(`${person.givenName} ${person.familyName}`, () => handlers.onPerson(person.id), 'Show this person'), h('span', { class: 'who' }, ` ${who(person, labels)}`)),
            h('div', { class: 'doing' }, doing, away ? h('span', { class: 'away' }, ` · ${away}`) : ''),
          ),
        ),
      );
    },
  };
}
