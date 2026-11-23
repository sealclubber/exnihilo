/**
 * The town map: a layout drawn on a canvas, with pan and zoom, a scale bar,
 * lots that can be clicked, a tool that shows the walking path between two
 * lots, and the residents who can be seen: those walking as moving dots, and
 * those out of doors at a place as smaller dots that stay where they are.
 * The avatar is drawn too, with the reach of what it perceives around it.
 *
 * It draws what the layout format holds and nothing more: water, segments as
 * polylines of their own width, open places, lots as polygons, and walls
 * as lines of their own width, open at their gates. The dots are moved
 * along the trips the server sends, by the clock; nothing here plans or
 * decides where anyone goes.
 */
import type { AvatarState, District, Layout, LayoutPath, Lot, OutsideStay, Point, Region, Seen, Trip } from '@worldsim/core';
import { avatarPlace, followScale } from './avatar.ts';
import { tripPosition, tripWindow, wanderPosition } from './clock.ts';
import { h } from './dom.ts';
import { describePath, describeSeen, districtColours, fitBox, formatMetres, lotAt, riverOutline, scaleBar, wallRuns } from './town-format.ts';
import { type View, panBy, toMap, toScreen, zoomAt } from './view.ts';

// A small palette, flat fills and thin lines: every mark says something.
const LAND = '#f6f4ee';
const WATER = '#a9cbe8';
const INK = '#23272e';
/** Open paved ground, such as a plaza: paler than a street and warmer than the land, with no district's tint. */
const PAVED = '#ebe4d2';
/** A green: open ground inside the town that belongs to no building. */
const GREEN = '#dfe8cf';
/** A town wall: the darkest line on the map, so that it reads as the one thing streets do not cross. */
const WALL = '#4b443a';
/** A wall is never drawn thinner than this many pixels, so that it can be seen with the whole town in view. */
const WALL_LEAST = 1.5;
/** Night dims the town without hiding it; people are drawn over the dimming, so they stay as clear as by day. */
const NIGHT = 'rgba(22, 32, 64, 0.26)';
/** Streets are told apart by tone and by their own width: the arterials that carry the routes are warmest. */
const SEGMENT_COLOURS: Record<Layout['segments'][number]['kind'], string> = {
  arterial: '#d8c6a4',
  street: '#dcd8ce',
  lane: '#e6e3da',
  bridge: '#9a8f7d',
};
/** A lot's open ground is its district's colour, faint; a building on it is the same colour, solid. */
const GROUND_ALPHA = 0.3;
const OUTLINE = 'rgba(35, 39, 46, 0.3)';
const CLICK_SLOP = 4;
const DOT_RADIUS = 2.6;
/** Someone out of doors at a place is a small square; someone walking is a dot. Shape tells them apart, colour tells their role. */
const OUTSIDE_HALF = 2.1;
/** Someone standing on a lot is picked only by a click close to them, so that the lot itself can still be clicked. */
const OUTSIDE_REACH = 4;
const DOT_REACH = 8;
/** Hovering is more generous than clicking, since it changes nothing: the nearest person within this many pixels is marked. */
const HOVER_REACH = 12;
const HOVER_BOX = 7;
const UNKNOWN_ROLE = '#555555';
/** The inner outline of a home that is also a workplace is this share of its footprint's size, and is drawn once a metre is at least a third of a pixel. */
const HOME_MARK = 0.55;
const HOME_MARK_FROM = 3;
/**
 * People keep much the same size on screen at every zoom, so they stay easy to click: zoomed in they grow a
 * little, up to this many times, and never shrink.
 */
const MOST_GROWTH = 2.2;
const GROWTH_PER_SCALE = 0.35;
const AVATAR_INK = '#1d4ed8';
const AVATAR_RADIUS = 5;
/** The ring around a resident the avatar perceives. */
const PERCEIVED_RING = 5.5;
/** After a failed request for trips, how long to wait before asking again, in real milliseconds. */
const RETRY_AFTER = 3000;

export interface TownMap {
  /**
   * Shows a layout, fitted to the canvas. With `living` false the town is shown without its people: no trips are
   * asked for, nobody is drawn, and the tools that act through the street graph are put away. That is for a layout
   * other than the one the residents walk.
   */
  show(layout: Layout, districts: District[], options?: { living?: boolean }): void;
  /** Shows a message in place of a map, while loading or on failure. */
  message(text: string): void;
  /** Outlines the lot of a building, or clears the outline. */
  highlight(buildingId: string | undefined): void;
  /** Keeps the map centred on a person: on their dot while they walk, otherwise on the building given. */
  follow(person: { personId: string; buildingId?: string } | undefined): void;
  /** Call when the clock has been set or its rate changed, so the trips on hand are checked afresh. */
  clockChanged(): void;
  /** The avatar to draw, as the server sent it, and how far it perceives; nothing if it is not in this town. */
  setAvatar(avatar: { state: AvatarState; radius: number } | undefined): void;
  /** The people the avatar perceives, to be ringed on the map. */
  setPerceived(personIds: ReadonlySet<string>): void;
  /** Keeps the map centred on the avatar, at a zoom where a street fills the view. */
  followAvatar(on: boolean): void;
  /** The buildings in which a household lives and people work, to be marked on the map so they can be told from a plain home or a plain workplace. */
  markHomesWithWork(buildingIds: ReadonlySet<string>): void;
  /** Marks a person as the hover marker would, when they are hovered somewhere else on the page; nothing clears it. */
  mark(personId: string | undefined): void;
  /** What the last frame drew, for tests and for measuring: nothing here changes the map. */
  drawn(): Drawn;
}

/** A person as the map drew them. */
export interface DrawnPerson {
  personId: string;
  /** On the canvas, in CSS pixels. */
  x: number;
  y: number;
  /** On the map, in metres. */
  point: Point;
  colour: string;
  shape: 'dot' | 'square';
}

export interface Drawn {
  people: DrawnPerson[];
  /** What the hover marker is on, and the label it shows. */
  hover: { kind: 'person' | 'avatar' | 'lot'; id: string; label: string } | undefined;
  avatar: { x: number; y: number } | undefined;
  /** The person marked from a list elsewhere on the page, if they can be seen. */
  marked: string | undefined;
  /** How many buildings are marked as both a home and a workplace. */
  homesWithWork: number;
  /** What of the town itself was drawn: the generator that made the layout, and how many rivers, walls, gates and open places. */
  town: { generator: string; rivers: number; walls: number; gates: number; places: number; living: boolean } | undefined;
  /** How many frames have been drawn since the map was shown, and the real milliseconds spent drawing them. */
  frames: number;
  drawMs: number;
  /** The canvas's size in CSS pixels, and the view: screen = map × scale + offset. */
  size: { width: number; height: number };
  view: { scale: number; x: number; y: number };
}

export interface TownMapHandlers {
  onLotClick(lot: Lot): void;
  /** Asked for the walking path between two lots. */
  findPath(fromLotId: string, toLotId: string): Promise<LayoutPath>;
  /** The game time now, if the clock is known, and its rate. */
  now(): number | undefined;
  rate(): number;
  /** Whether the sun is up at a game time. */
  isLight(time: number): boolean;
  /** Asked for the trips under way in a window of game time that pass through a region, and the stays out of doors in it. */
  loadTrips(from: number, to: number, region: Region): Promise<{ trips: Array<Trip & Seen>; outside: Array<OutsideStay & Seen> }>;
  /** The colour of a role, from the pack; nothing for a role the pack does not know. */
  roleColour(role: string): string | undefined;
  /** The label for a person under the cursor: their name and occupation, or for an outsider their kind and where they are from. */
  personLabel(person: Seen & { outsider?: true | undefined }): string;
  /** The label for a lot under the cursor: its building's name. */
  lotLabel(lot: Lot): string;
  /** Told who the cursor is on, or that it is on nobody. Hovering changes nothing else. */
  onHover(personId: string | undefined): void;
  /** Told that someone was clicked: a resident, or an outsider. */
  onPersonClick(personId: string, outsider: boolean): void;
  /** Asked to place the avatar on the street nearest a point of the map. */
  onSpawn(point: Point): void;
  /** Asked to walk the avatar to the street nearest a point, or into a building. */
  onWalkToPoint(point: Point): void;
  onWalkToBuilding(buildingId: string): void;
  /** Told that the map has stopped following the avatar, because the whole town was asked for. */
  onUnfollowAvatar(): void;
}

export function createTownMap(root: HTMLElement, handlers: TownMapHandlers): TownMap {
  const canvas = h('canvas', { attrs: { 'aria-label': 'Town map' } });
  const note = h('p', { class: 'map-note' });
  const pathButton = h('button', { attrs: { type: 'button' }, title: 'Show the shortest walking path between two lots' }, 'Path');
  const fitButton = h('button', { attrs: { type: 'button' }, title: 'Show the whole town' }, '⌂');
  const spawnButton = h('button', { attrs: { type: 'button' }, title: 'Place your avatar: click this, then a point on the map, to stand on the nearest street' }, 'Spawn');
  /** What a click offers when the avatar could act on it. Inspecting never moves the avatar; only these buttons do. */
  const menu = h('div', { class: 'map-menu' });
  menu.hidden = true;
  const pathStatus = h('span', { class: 'path-status' });
  const streetCount = h('span', { class: 'street-count', title: 'Residents and outsiders who can be seen at this moment: walking somewhere, or out of doors at a place' });
  root.replaceChildren(canvas, note, h('div', { class: 'map-tools' }, fitButton, pathButton, spawnButton, pathStatus), streetCount, menu);
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  /** Everything that does not move is drawn here once per change of view, then copied each frame under the dots. */
  const base = document.createElement('canvas');
  const baseCtx = base.getContext('2d') as CanvasRenderingContext2D;

  let layout: Layout | undefined;
  /** Whether the people of the town are shown on this layout. */
  let living = true;
  /** Water, open places and walls are built once per layout, in map coordinates, like the lots and the streets. */
  let waterPath = new Path2D();
  let placePath = new Path2D();
  let greenPath = new Path2D();
  let walls: Array<{ width: number; standing: Path2D; gates: Path2D; gateCount: number }> = [];
  let districtNames = new Map<string, string>();
  /** Paths are built once per layout, in map coordinates, and redrawn under the view's transform. */
  let lotPaths: Array<{ colour: string; ground: Path2D; built: Path2D }> = [];
  /** The mark of a home that is also a workplace: a second outline inside each of its footprints. */
  let homesWithWork: ReadonlySet<string> = new Set();
  let homeMarks = new Path2D();
  let homeMarkCount = 0;
  const markHomes = () => {
    homeMarks = new Path2D();
    homeMarkCount = 0;
    for (const lot of layout?.lots ?? []) {
      if (!homesWithWork.has(lot.buildingId) || lot.footprints.length === 0) continue;
      homeMarkCount++;
      for (const footprint of lot.footprints) {
        // The footprint again at a smaller size about its own middle: a box within the box, whatever its shape.
        const cx = footprint.reduce((sum, point) => sum + point[0], 0) / footprint.length;
        const cy = footprint.reduce((sum, point) => sum + point[1], 0) / footprint.length;
        trace(homeMarks, footprint.map(([x, y]): Point => [cx + (x - cx) * HOME_MARK, cy + (y - cy) * HOME_MARK]), true);
      }
    }
  };
  let segmentPaths: Array<{ colour: string; width: number; path: Path2D }> = [];
  let lotCentres = new Map<string, Point>();
  let view: View = { scale: 1, x: 0, y: 0 };
  let fitScale = 1;
  let size = { width: 0, height: 0 };
  let highlighted: Lot | undefined;
  let path: LayoutPath | undefined;
  /** The path tool: off, or waiting for its first or second lot. */
  let picking: { from?: Lot; to?: Lot } | undefined;
  let baseStale = true;
  let looping = false;

  // The trips on hand: those of a window of game time, through a region of the map.
  let trips: { from: number; to: number; region: Region; list: Array<Trip & Seen>; outside: Array<OutsideStay & Seen> } | undefined;
  let asking = false;
  let asked = 0;
  let notBefore = 0;
  /** The dots drawn in the last frame, for finding the one under a click. */
  let dots: Array<DrawnPerson & { reach: number; who: Seen & { outsider?: true | undefined } }> = [];
  /** Where the cursor is over the map, when it is; and who or what the hover marker is on. */
  let cursor: { x: number; y: number } | undefined;
  let hover: Drawn['hover'];
  let marked: string | undefined;
  let drawnAvatar: { x: number; y: number } | undefined;
  let frames = 0;
  let drawMs = 0;
  let followed: { personId: string; buildingId?: string } | undefined;
  let avatar: { state: AvatarState; radius: number } | undefined;
  let perceived: ReadonlySet<string> = new Set();
  let followingAvatar = false;
  /** The spawn tool: on, the next click on the map places the avatar. */
  let spawning = false;
  let lastTime: number | undefined;
  let lastLight: boolean | undefined;

  const trace = (target: Path2D | CanvasRenderingContext2D, points: readonly Point[], close: boolean) => {
    points.forEach(([x, y], index) => (index === 0 ? target.moveTo(x, y) : target.lineTo(x, y)));
    if (close) target.closePath();
  };

  /** Draws the town itself: everything that stays put until the view or the selection changes. */
  function drawBase(): void {
    baseStale = false;
    const ratio = window.devicePixelRatio || 1;
    const target = baseCtx;
    target.setTransform(ratio, 0, 0, ratio, 0, 0);
    target.fillStyle = LAND;
    target.fillRect(0, 0, size.width, size.height);
    if (!layout) return;

    target.setTransform(ratio * view.scale, 0, 0, ratio * view.scale, ratio * view.x, ratio * view.y);
    const px = 1 / view.scale;
    target.lineJoin = 'round';
    target.lineCap = 'butt';
    // The sea as its polygon, a river as the outline of its two banks: one flat fill.
    target.fillStyle = WATER;
    target.fill(waterPath);
    for (const { colour, width, path: line } of segmentPaths) {
      target.strokeStyle = colour;
      target.lineWidth = Math.max(width, px);
      target.stroke(line);
    }
    const hairline = Math.min(0.4, px);
    // An open place is paved ground with a thin edge.
    target.fillStyle = PAVED;
    target.fill(placePath);
    target.fillStyle = GREEN;
    target.fill(greenPath);
    target.strokeStyle = OUTLINE;
    target.lineWidth = hairline;
    target.stroke(placePath);
    target.stroke(greenPath);
    // A lot is open ground, drawn faintly, with its buildings drawn solidly on it: a yard and a house can be told apart.
    for (const { colour, ground, built } of lotPaths) {
      target.globalAlpha = GROUND_ALPHA;
      target.fillStyle = colour;
      target.fill(ground);
      target.globalAlpha = 1;
      target.strokeStyle = OUTLINE;
      target.lineWidth = hairline;
      target.stroke(ground);
      target.fillStyle = colour;
      target.fill(built);
      target.stroke(built);
    }
    // A home that is also a workplace has a second outline inside it. Not a colour: an outline, so it reads in any district.
    if (homeMarkCount > 0 && view.scale * HOME_MARK_FROM >= 1) {
      target.strokeStyle = 'rgba(35, 39, 46, 0.55)';
      target.lineWidth = Math.min(0.5, 1.2 * px);
      target.stroke(homeMarks);
    }
    // A wall is a dark line of its own width, open at each gate, with a thin ring about the opening to mark the gate.
    target.strokeStyle = WALL;
    for (const wall of walls) {
      target.lineWidth = Math.max(wall.width, WALL_LEAST * px);
      target.stroke(wall.standing);
      target.lineWidth = Math.max(wall.width / 4, px);
      target.stroke(wall.gates);
    }

    const outline = (lot: Lot, colour: string) => {
      target.beginPath();
      trace(target, lot.polygon, true);
      target.strokeStyle = colour;
      target.lineWidth = 3 * px;
      target.stroke();
    };
    if (path) {
      target.beginPath();
      trace(target, path.points, false);
      target.strokeStyle = '#1d4ed8';
      target.lineWidth = 4 * px;
      target.lineCap = 'round';
      target.stroke();
    }
    if (highlighted) outline(highlighted, '#d92d20');
    if (picking?.from) outline(picking.from, '#1d4ed8');
    if (picking?.to) outline(picking.to, '#1d4ed8');

    // Labels and the scale bar keep their size on screen.
    target.setTransform(ratio, 0, 0, ratio, 0, 0);
    target.textBaseline = 'middle';
    target.lineJoin = 'round';
    const label = (text: string, [x, y]: Point, font: string, align: CanvasTextAlign = 'left') => {
      target.font = font;
      target.textAlign = align;
      target.lineWidth = 3;
      target.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      target.strokeText(text, x, y);
      target.fillStyle = INK;
      target.fillText(text, x, y);
    };
    if (view.scale / fitScale < 6) {
      for (const area of layout.districtAreas) {
        label(districtNames.get(area.districtId) ?? area.districtId, toScreen(view, area.labelPoint), '600 12px system-ui, sans-serif', 'center');
      }
    }
    const junctions = new Map(layout.junctions.map((junction) => [junction.id, junction]));
    for (const exit of layout.exits) {
      const junction = junctions.get(exit.junctionId);
      if (!junction) continue;
      const [x, y] = toScreen(view, junction.position);
      target.beginPath();
      target.arc(x, y, 5, 0, Math.PI * 2);
      target.fillStyle = INK;
      target.fill();
      label(`${exit.name ?? `Unnamed ${exit.kind.replace('-', ' ')}`} →`, [x + 9, y], '12px system-ui, sans-serif');
    }
    const bar = scaleBar(view.scale);
    const left = 14;
    const bottom = size.height - 16;
    target.strokeStyle = INK;
    target.lineWidth = 2;
    target.beginPath();
    target.moveTo(left, bottom - 5);
    target.lineTo(left, bottom);
    target.lineTo(left + bar.pixels, bottom);
    target.lineTo(left + bar.pixels, bottom - 5);
    target.stroke();
    label(formatMetres(bar.metres), [left + bar.pixels + 8, bottom - 2], '12px system-ui, sans-serif');
  }

  /** The part of the map in view, widened so that a little panning needs no new request. */
  const viewRegion = (widen: number): Region => {
    const [minX, minY] = toMap(view, 0, 0);
    const [maxX, maxY] = toMap(view, size.width, size.height);
    const padX = (maxX - minX) * widen;
    const padY = (maxY - minY) * widen;
    return { minX: minX - padX, minY: minY - padY, maxX: maxX + padX, maxY: maxY + padY };
  };
  const contains = (outer: Region, inner: Region) => outer.minX <= inner.minX && outer.minY <= inner.minY && outer.maxX >= inner.maxX && outer.maxY >= inner.maxY;

  /** Makes sure the trips on hand cover the present moment and the part of the map in view. */
  function ensureTrips(time: number): void {
    const ahead = tripWindow(handlers.rate());
    const stale = !trips || time < trips.from || time > trips.to - ahead / 4 || !contains(trips.region, viewRegion(0));
    if (!stale || asking || performance.now() < notBefore) return;
    asking = true;
    const request = ++asked;
    const region = viewRegion(0.5);
    const from = time - 1;
    const to = time + ahead;
    handlers
      .loadTrips(from, to, region)
      .then((loaded) => {
        if (request !== asked) return;
        trips = { from, to, region, list: loaded.trips, outside: loaded.outside };
        // Draw again even if the clock is standing still.
        lastTime = undefined;
      })
      .catch(() => (notBefore = performance.now() + RETRY_AFTER))
      .finally(() => (asking = false));
  }

  function frame(): void {
    if (!layout || !root.isConnected) {
      looping = false;
      return;
    }
    requestAnimationFrame(frame);
    // Nothing to do while the map is out of sight.
    if (root.offsetParent === null || size.width === 0) return;
    const time = handlers.now();
    const light = time === undefined ? true : handlers.isLight(time);
    if (time !== undefined && living) ensureTrips(time);

    // Following someone: on their dot while they walk or stand outside, otherwise on the building they are in.
    let position: Point | undefined;
    if (followed && time !== undefined) {
      const walking = trips?.list.find((trip) => trip.personId === followed!.personId && time >= trip.departAt && time <= trip.arriveAt);
      const standing = walking ? undefined : trips?.outside.find((stay) => stay.personId === followed!.personId && time >= stay.from && time < stay.to);
      if (walking) {
        position = tripPosition(walking, time);
        followed.buildingId = walking.toBuildingId;
      } else if (standing) {
        position = wanderPosition(standing.wander, time);
        followed.buildingId = standing.buildingId;
      } else if (followed.buildingId !== undefined) {
        position = lotCentres.get(followed.buildingId);
      }
      if (position) {
        const x = size.width / 2 - position[0] * view.scale;
        const y = size.height / 2 - position[1] * view.scale;
        if (Math.abs(x - view.x) > 0.01 || Math.abs(y - view.y) > 0.01) {
          view = { scale: view.scale, x, y };
          baseStale = true;
        }
      }
    }

    // The avatar: on the street at a point, or in a building, shown at the middle of its lot.
    const place = avatar && time !== undefined ? avatarPlace(avatar.state, time) : undefined;
    const avatarAt = place ? (place.kind === 'street' ? place.point : lotCentres.get(place.buildingId)) : undefined;
    if (followingAvatar && avatarAt) {
      const x = size.width / 2 - avatarAt[0] * view.scale;
      const y = size.height / 2 - avatarAt[1] * view.scale;
      if (Math.abs(x - view.x) > 0.01 || Math.abs(y - view.y) > 0.01) {
        view = { scale: view.scale, x, y };
        baseStale = true;
      }
    }

    if (!baseStale && time === lastTime && light === lastLight) return;
    const began = performance.now();
    lastTime = time;
    lastLight = light;
    if (baseStale) drawBase();
    const ratio = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(base, 0, 0);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    if (!light) {
      ctx.fillStyle = NIGHT;
      ctx.fillRect(0, 0, size.width, size.height);
    }

    dots = [];
    if (time !== undefined && trips) {
      const onScreen = (x: number, y: number) => x >= -5 && y >= -5 && x <= size.width + 5 && y <= size.height + 5;
      const colourOf = (role: string) => handlers.roleColour(role) ?? UNKNOWN_ROLE;
      const grown = Math.min(MOST_GROWTH, Math.max(1, view.scale * GROWTH_PER_SCALE));
      const half = OUTSIDE_HALF * grown;
      const radius = DOT_RADIUS * grown;
      // People are gathered by colour, so that each colour is filled once. Those out of doors at a place are
      // small squares, drawn first so that walkers, who are dots, pass over them.
      const squares = new Map<string, Path2D>();
      const circles = new Map<string, Path2D>();
      const shapeFor = (shapes: Map<string, Path2D>, colour: string) => {
        let shape = shapes.get(colour);
        if (!shape) shapes.set(colour, (shape = new Path2D()));
        return shape;
      };
      let standing = 0;
      for (const stay of trips.outside) {
        if (time < stay.from || time >= stay.to) continue;
        standing++;
        // Where their moving about has taken them by now.
        const point = wanderPosition(stay.wander, time);
        const [x, y] = toScreen(view, point);
        const colour = colourOf(stay.role);
        dots.push({ personId: stay.personId, x, y, point, colour, shape: 'square', reach: OUTSIDE_REACH * grown, who: stay });
        if (onScreen(x, y)) shapeFor(squares, colour).rect(x - half, y - half, half * 2, half * 2);
      }
      for (const trip of trips.list) {
        // Someone who has arrived is no longer walking: they are indoors, or drawn where they stay outside.
        if (time >= trip.arriveAt) continue;
        const point = tripPosition(trip, time);
        if (!point) continue;
        const [x, y] = toScreen(view, point);
        const colour = colourOf(trip.role);
        dots.push({ personId: trip.personId, x, y, point, colour, shape: 'dot', reach: DOT_REACH * grown, who: trip });
        if (!onScreen(x, y)) continue;
        const shape = shapeFor(circles, colour);
        shape.moveTo(x + radius, y);
        shape.arc(x, y, radius, 0, Math.PI * 2);
      }
      // A thin dark edge keeps every colour clear of the ground beneath it, by day and by night.
      ctx.lineWidth = 0.75;
      ctx.strokeStyle = 'rgba(35, 39, 46, 0.6)';
      for (const shapes of [squares, circles]) {
        for (const [colour, shape] of shapes) {
          ctx.fillStyle = colour;
          ctx.fill(shape);
          ctx.stroke(shape);
        }
      }
      const whole = contains(trips.region, layout.summary.bounds);
      streetCount.textContent = describeSeen(dots.length - standing, standing, whole);
    } else {
      streetCount.textContent = '';
    }
    if (followed && position) {
      const [x, y] = toScreen(view, position);
      ctx.beginPath();
      ctx.arc(x, y, DOT_RADIUS + 5, 0, Math.PI * 2);
      ctx.strokeStyle = '#d92d20';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    // Residents the avatar perceives are ringed.
    if (perceived.size > 0) {
      ctx.beginPath();
      for (const dot of dots) {
        if (!perceived.has(dot.personId)) continue;
        ctx.moveTo(dot.x + PERCEIVED_RING, dot.y);
        ctx.arc(dot.x, dot.y, PERCEIVED_RING, 0, Math.PI * 2);
      }
      ctx.strokeStyle = AVATAR_INK;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    if (avatar && place && avatarAt) {
      const [x, y] = toScreen(view, avatarAt);
      if (place.kind === 'street') {
        // How far it perceives from the street.
        ctx.beginPath();
        ctx.arc(x, y, avatar.radius * view.scale, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(29, 78, 216, 0.08)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(29, 78, 216, 0.55)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(x, y, AVATAR_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = place.kind === 'street' ? AVATAR_INK : '#ffffff';
      ctx.fill();
      ctx.strokeStyle = place.kind === 'street' ? '#ffffff' : AVATAR_INK;
      ctx.lineWidth = place.kind === 'street' ? 2 : 3;
      ctx.stroke();
      drawnAvatar = { x, y };
    } else {
      drawnAvatar = undefined;
    }

    // The hover marker: a box and a label on the person under the cursor, or an outline and a name on the lot.
    // The nearest person within reach wins, then the avatar, then the lot. Hovering changes nothing but this.
    const before = hover?.kind === 'person' ? hover.id : undefined;
    hover = undefined;
    if (cursor && !drag) {
      let nearest: (typeof dots)[number] | undefined;
      let least = HOVER_REACH;
      for (const dot of dots) {
        const away = Math.hypot(dot.x - cursor.x, dot.y - cursor.y);
        if (away <= least) {
          least = away;
          nearest = dot;
        }
      }
      if (nearest) hover = { kind: 'person', id: nearest.personId, label: handlers.personLabel(nearest.who) };
      else if (drawnAvatar && Math.hypot(drawnAvatar.x - cursor.x, drawnAvatar.y - cursor.y) <= HOVER_REACH) hover = { kind: 'avatar', id: 'avatar', label: 'You' };
      else {
        const lot = lotAt(layout.lots, toMap(view, cursor.x, cursor.y));
        if (lot) hover = { kind: 'lot', id: lot.id, label: handlers.lotLabel(lot) };
      }
    }
    const after = hover?.kind === 'person' ? hover.id : undefined;
    if (after !== before) handlers.onHover(after);
    const tag = (text: string, x: number, y: number) => {
      ctx.font = '12px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
      ctx.strokeText(text, x, y);
      ctx.fillStyle = INK;
      ctx.fillText(text, x, y);
    };
    const box = (x: number, y: number, label: string) => {
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x - HOVER_BOX, y - HOVER_BOX, HOVER_BOX * 2, HOVER_BOX * 2);
      tag(label, x + HOVER_BOX + 5, y);
    };
    // Someone hovered in a list is marked the same way, if they can be seen.
    if (marked !== undefined && marked !== after) {
      const dot = dots.find((entry) => entry.personId === marked);
      if (dot) box(dot.x, dot.y, handlers.personLabel(dot.who));
    }
    if (hover?.kind === 'person') {
      const dot = dots.find((entry) => entry.personId === hover!.id);
      if (dot) box(dot.x, dot.y, hover.label);
    } else if (hover?.kind === 'avatar' && drawnAvatar) {
      box(drawnAvatar.x, drawnAvatar.y, hover.label);
    } else if (hover?.kind === 'lot') {
      const lot = layout.lots.find((entry) => entry.id === hover!.id);
      if (lot) {
        const corners = lot.polygon.map((point) => toScreen(view, point));
        ctx.beginPath();
        corners.forEach(([x, y], index) => (index === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
        ctx.closePath();
        ctx.strokeStyle = INK;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        tag(hover.label, Math.max(...corners.map(([x]) => x)) + 6, Math.min(...corners.map(([, y]) => y)) + 6);
      }
    }
    frames++;
    drawMs += performance.now() - began;
  }

  const redraw = () => {
    baseStale = true;
    if (!looping && layout) {
      looping = true;
      requestAnimationFrame(frame);
    }
  };

  function fit(): void {
    if (!layout) return;
    view = fitBox(layout.summary.bounds, size.width, size.height);
    fitScale = view.scale;
    redraw();
  }

  function resize(): void {
    const ratio = window.devicePixelRatio || 1;
    const wasFitted = size.width === 0 || view.scale === fitScale;
    size = { width: root.clientWidth, height: root.clientHeight };
    for (const surface of [canvas, base]) {
      surface.width = Math.round(size.width * ratio);
      surface.height = Math.round(size.height * ratio);
    }
    if (layout && wasFitted) fit();
    else redraw();
  }

  function showPathStatus(text: string): void {
    pathStatus.textContent = text;
    pathButton.classList.toggle('active', picking !== undefined);
    pathButton.textContent = picking ? 'Done' : 'Path';
  }

  async function pick(lot: Lot): Promise<void> {
    if (!picking) return;
    if (!picking.from || picking.to) {
      picking = { from: lot };
      path = undefined;
      showPathStatus('Now pick the lot to walk to.');
      redraw();
      return;
    }
    picking.to = lot;
    redraw();
    const chosen = picking;
    try {
      const found = await handlers.findPath(chosen.from!.id, lot.id);
      if (picking !== chosen) return;
      path = found;
      showPathStatus(`${describePath(found)}. Pick another lot to start again.`);
    } catch (error) {
      if (picking === chosen) showPathStatus((error as Error).message);
    }
    redraw();
  }

  pathButton.addEventListener('click', () => {
    setSpawning(false);
    picking = picking ? undefined : {};
    path = undefined;
    showPathStatus(picking ? 'Pick the lot to walk from.' : '');
    redraw();
  });
  fitButton.addEventListener('click', () => {
    followed = undefined;
    if (followingAvatar) handlers.onUnfollowAvatar();
    followingAvatar = false;
    fit();
  });
  const setSpawning = (on: boolean) => {
    spawning = on;
    spawnButton.classList.toggle('active', on);
    canvas.style.cursor = on ? 'crosshair' : '';
    if (on) showPathStatus('Click where you want to stand.');
    else if (!picking) showPathStatus('');
  };
  spawnButton.addEventListener('click', () => {
    picking = undefined;
    path = undefined;
    pathButton.classList.remove('active');
    pathButton.textContent = 'Path';
    setSpawning(!spawning);
    redraw();
  });
  const hideMenu = () => {
    menu.hidden = true;
    menu.replaceChildren();
  };
  /** Offers, beside a click, what the avatar could do there. */
  const offer = (x: number, y: number, choices: Array<[string, () => void]>) => {
    if (choices.length === 0) return hideMenu();
    menu.replaceChildren(
      ...choices.map(([text, act]) =>
        h('button', { attrs: { type: 'button' }, onClick: () => { hideMenu(); act(); } }, text),
      ),
    );
    menu.hidden = false;
    menu.style.left = `${Math.min(x + 8, size.width - 170)}px`;
    menu.style.top = `${Math.min(y + 8, size.height - 34 * choices.length - 8)}px`;
  };
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    hideMenu();
    if (spawning) setSpawning(false);
  });

  let drag: { pointerId: number; lastX: number; lastY: number; travelled: number } | undefined;
  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    hideMenu();
    drag = { pointerId: event.pointerId, lastX: event.offsetX, lastY: event.offsetY, travelled: 0 };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.offsetX - drag.lastX;
    const dy = event.offsetY - drag.lastY;
    drag.travelled += Math.abs(dx) + Math.abs(dy);
    drag.lastX = event.offsetX;
    drag.lastY = event.offsetY;
    if (drag.travelled > CLICK_SLOP) {
      view = panBy(view, dx, dy);
      redraw();
    }
  });
  canvas.addEventListener('pointerup', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const wasClick = drag.travelled <= CLICK_SLOP;
    drag = undefined;
    if (!wasClick || !layout) return;
    // Without its people the town can only be looked at: a lot is inspected, and nothing is offered.
    if (!living) {
      const lot = lotAt(layout.lots, toMap(view, event.offsetX, event.offsetY));
      if (lot) handlers.onLotClick(lot);
      return;
    }
    const point = toMap(view, event.offsetX, event.offsetY);
    if (spawning) {
      setSpawning(false);
      return handlers.onSpawn(point);
    }
    // A person on the street is picked before the lot behind them. Of several on the very same spot, as a party of
    // travellers is, the one the hover marker names is picked: the last of them drawn.
    if (!picking) {
      let nearest: { personId: string; outsider: boolean; away: number } | undefined;
      for (const dot of dots) {
        const away = Math.hypot(dot.x - event.offsetX, dot.y - event.offsetY);
        if (away <= dot.reach && (!nearest || away <= nearest.away)) nearest = { personId: dot.personId, outsider: dot.who.outsider === true, away };
      }
      if (nearest) return handlers.onPersonClick(nearest.personId, nearest.outsider);
    }
    const lot = lotAt(layout.lots, point);
    if (picking) {
      if (lot) void pick(lot);
      return;
    }
    // A lot is inspected as ever. With the avatar in town, the click also offers to walk there:
    // looking at something never moves the avatar, only choosing to does.
    if (lot) {
      handlers.onLotClick(lot);
      offer(event.offsetX, event.offsetY, avatar ? [['Walk into this building', () => handlers.onWalkToBuilding(lot.buildingId)]] : []);
    } else {
      offer(event.offsetX, event.offsetY, [...(avatar ? [['Walk here', () => handlers.onWalkToPoint(point)] as [string, () => void]] : []), ['Spawn here', () => handlers.onSpawn(point)]]);
    }
  });
  canvas.addEventListener('pointercancel', () => (drag = undefined));
  // The cursor's place is kept for the hover marker, which the next frame works out. Nothing else follows from it.
  canvas.addEventListener('pointermove', (event) => {
    cursor = { x: event.offsetX, y: event.offsetY };
    lastTime = undefined;
  });
  canvas.addEventListener('pointerleave', () => {
    cursor = undefined;
    lastTime = undefined;
  });
  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const factor = Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0015));
      view = zoomAt(view, event.offsetX, event.offsetY, factor, { min: fitScale * 0.5, max: fitScale * 80 });
      redraw();
    },
    { passive: false },
  );
  new ResizeObserver(resize).observe(root);

  return {
    show(next, districts, options = {}) {
      layout = next;
      living = options.living !== false;
      pathButton.hidden = !living;
      spawnButton.hidden = !living;
      note.hidden = true;
      highlighted = undefined;
      path = undefined;
      picking = undefined;
      followed = undefined;
      avatar = undefined;
      perceived = new Set();
      hideMenu();
      setSpawning(false);
      trips = undefined;
      asked++;
      dots = [];
      showPathStatus('');
      districtNames = new Map(districts.map((district) => [district.id, district.name]));
      const colours = districtColours(districts.map((district) => district.id));
      const byColour = new Map<string, { ground: Path2D; built: Path2D }>();
      lotCentres = new Map();
      waterPath = new Path2D();
      for (const water of next.waters) trace(waterPath, water.kind === 'sea' ? water.polygon : riverOutline(water), true);
      // An open place is the lot of its building: it is drawn as paved ground, not in its district's tint.
      placePath = new Path2D();
      greenPath = new Path2D();
      for (const place of next.places) trace(place.kind === 'plaza' ? placePath : greenPath, place.polygon, true);
      const paved = new Set(next.places.flatMap((place) => (place.kind === 'plaza' ? [place.buildingId] : [])));
      // A gate's opening is as long as the widest street through it and the wall's own width besides.
      const junctions = new Map(next.junctions.map((junction) => [junction.id, junction.position]));
      const widest = new Map<string, number>();
      for (const segment of next.segments) {
        for (const junctionId of [segment.fromJunctionId, segment.toJunctionId]) widest.set(junctionId, Math.max(widest.get(junctionId) ?? 0, segment.width));
      }
      walls = next.walls.map((wall) => {
        const gates = wall.gates.flatMap((gate) => {
          const position = junctions.get(gate.junctionId);
          return position ? [{ position, gap: (widest.get(gate.junctionId) ?? wall.width) + wall.width }] : [];
        });
        const standing = new Path2D();
        for (const line of wall.lines) for (const run of wallRuns(line, wall.closed, gates)) trace(standing, run, false);
        const frames = new Path2D();
        for (const { position: [x, y], gap } of gates) {
          frames.moveTo(x + gap / 2, y);
          frames.arc(x, y, gap / 2, 0, Math.PI * 2);
        }
        return { width: wall.width, standing, gates: frames, gateCount: gates.length };
      });
      for (const lot of next.lots) {
        const colour = colours.get(lot.districtId) ?? '#dddddd';
        let shape = byColour.get(colour);
        if (!shape) byColour.set(colour, (shape = { ground: new Path2D(), built: new Path2D() }));
        if (!paved.has(lot.buildingId)) trace(shape.ground, lot.polygon, true);
        for (const footprint of lot.footprints) trace(shape.built, footprint, true);
        const sum = lot.polygon.reduce((total, point) => [total[0] + point[0], total[1] + point[1]] as Point, [0, 0] as Point);
        lotCentres.set(lot.buildingId, [sum[0] / lot.polygon.length, sum[1] / lot.polygon.length]);
      }
      lotPaths = [...byColour].map(([colour, shape]) => ({ colour, ...shape }));
      // Which buildings are homes and workplaces at once may have arrived before the layout did, or may come after.
      markHomes();
      frames = 0;
      drawMs = 0;
      hover = undefined;
      marked = undefined;
      // Segments are grouped by colour and width, the widest kinds drawn last so they lie on top.
      const byStyle = new Map<string, { colour: string; width: number; path: Path2D }>();
      for (const segment of next.segments) {
        const key = `${segment.kind}:${segment.width}`;
        let style = byStyle.get(key);
        if (!style) byStyle.set(key, (style = { colour: SEGMENT_COLOURS[segment.kind], width: segment.width, path: new Path2D() }));
        trace(style.path, segment.points, false);
      }
      segmentPaths = [...byStyle.values()].sort((a, b) => a.width - b.width);
      size = { width: 0, height: 0 };
      resize();
    },
    message(text) {
      layout = undefined;
      trips = undefined;
      asked++;
      dots = [];
      streetCount.textContent = '';
      note.hidden = false;
      note.textContent = text;
      baseStale = true;
      // Clear what was drawn, unless the map is out of sight and has no size to draw at.
      if (base.width > 0 && base.height > 0) {
        drawBase();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(base, 0, 0);
      }
    },
    highlight(buildingId) {
      highlighted = buildingId === undefined ? undefined : layout?.lots.find((lot) => lot.buildingId === buildingId);
      redraw();
    },
    follow(person) {
      followed = person ? { ...person } : undefined;
      // The map can keep to one thing at a time.
      if (person) followingAvatar = false;
      redraw();
    },
    markHomesWithWork(buildingIds) {
      homesWithWork = buildingIds;
      markHomes();
      redraw();
    },
    mark(personId) {
      marked = personId;
      lastTime = undefined;
    },
    drawn() {
      return {
        people: dots.map(({ personId, x, y, point, colour, shape }) => ({ personId, x, y, point, colour, shape })),
        hover,
        avatar: drawnAvatar,
        marked: marked !== undefined && dots.some((dot) => dot.personId === marked) ? marked : undefined,
        homesWithWork: homeMarkCount,
        town: layout && {
          generator: layout.summary.generator,
          rivers: layout.waters.filter((water) => water.kind === 'river').length,
          walls: walls.length,
          gates: walls.reduce((sum, wall) => sum + wall.gateCount, 0),
          places: layout.places.length,
          living,
        },
        frames,
        drawMs,
        size: { ...size },
        view: { ...view },
      };
    },
    setAvatar(next) {
      avatar = next;
      lastTime = undefined;
    },
    setPerceived(personIds) {
      perceived = personIds;
      lastTime = undefined;
    },
    followAvatar(on) {
      followingAvatar = on;
      if (on) {
        followed = undefined;
        // Zoom once to where a street fills the view; after that only the centre is kept.
        if (avatar && size.width > 0) view = { ...view, scale: Math.min(fitScale * 80, Math.max(view.scale, followScale(avatar.radius, size.width, size.height))) };
      }
      redraw();
    },
    clockChanged() {
      // A jump in time or a new rate may leave the trips on hand covering the wrong window.
      const time = handlers.now();
      if (trips && time !== undefined && (time < trips.from || time > trips.to)) trips = undefined;
      lastTime = undefined;
    },
  };
}
