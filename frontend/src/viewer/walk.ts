// Walking through a floor at eye height: walls stop you, doors and passages let you through, a tap on the
// floor walks there (around walls, through doors), dragging looks around, keys and a stick move.
// The geometry part (walls, doors, paths) is plain maths; WalkCamera drives NeonPlan's 3D view.
import { generateWalls, locateOpening, openingHost, type Wall } from "../geometry/walls.ts";
import { centroid, furnitureFootprint, pointInPolygon, type Building, type Floor, type Furniture, type Room, type Vec2 } from "../model.ts";

export const EYE = 1.62;
const RADIUS = 0.2;
/** How close a pet passes furniture (its body half-width) and the extra gap of the corner points it steers by. */
const PET_R = 0.16;
const CORNER_GAP = 0.04;

interface Solid {
  a: Vec2;
  /** Unit direction along the wall and its length. */
  u: Vec2;
  len: number;
  left: number;
  right: number;
  /** Passable stretches along the wall (doors, passages, French windows). */
  gaps: [number, number][];
}

export interface DoorNode {
  /** Points on both sides of the opening, a little into each room. */
  p: [Vec2, Vec2];
  centre: Vec2;
}

/** A piece of furniture a pet walks around: its footprint grown by the pet's width, and the corner points to steer by. */
interface Obstacle {
  poly: Vec2[];
  corners: Vec2[];
  box: [number, number, number, number];
}

export class FloorMap {
  readonly solids: Solid[] = [];
  private items: readonly Furniture[] = [];
  /** The furniture grown by a margin, per margin (a big dog needs more room than a cat). */
  private grown = new Map<number, Obstacle[]>();
  readonly doors: DoorNode[] = [];
  readonly rooms: Room[];
  readonly walls: Wall[];
  readonly building: Building;
  readonly floor: Floor;

  constructor(building: Building, floor: Floor) {
    this.building = building;
    this.floor = floor;
    const s = building.settings;
    this.rooms = floor.rooms.filter((r) => r.points.length >= 3);
    const result = generateWalls(this.rooms, { exterior: s.wall_exterior, interior: s.wall_interior }, floor.walls ?? []);
    this.walls = result.walls;
    const gapsBy = new Map<Wall, [number, number][]>();
    for (const o of floor.openings) {
      const passable = o.type !== "window" || o.sill < 0.1;
      if (!passable) continue;
      const host = openingHost(o, floor.rooms, floor.walls ?? []);
      if (!host) continue;
      const at = locateOpening(this.walls, o, host);
      if (!at) continue;
      const list = gapsBy.get(at.wall) ?? [];
      list.push([at.s - o.width / 2 + 0.05, at.s + o.width / 2 - 0.05]);
      gapsBy.set(at.wall, list);
      const w = at.wall;
      const dx = w.b[0] - w.a[0];
      const dz = w.b[1] - w.a[1];
      const len = Math.hypot(dx, dz) || 1;
      const ux = dx / len;
      const uz = dz / len;
      const c: Vec2 = [w.a[0] + ux * at.s, w.a[1] + uz * at.s];
      // the door points stand 45 cm beyond the wall faces on both sides (normal of the left face: (-uz, ux))
      const nl = w.left + 0.45;
      const nr = w.right + 0.45;
      this.doors.push({ centre: c, p: [[c[0] - uz * nl, c[1] + ux * nl], [c[0] + uz * nr, c[1] - ux * nr]] });
    }
    for (const w of this.walls) {
      if (w.height !== undefined && w.height < 0.9) continue;
      const dx = w.b[0] - w.a[0];
      const dz = w.b[1] - w.a[1];
      const len = Math.hypot(dx, dz);
      if (len < 1e-6) continue;
      this.solids.push({ a: w.a, u: [dx / len, dz / len], len, left: w.left, right: w.right, gaps: gapsBy.get(w) ?? [] });
    }
  }

  /** True when a body standing at p touches a wall. */
  blocked(p: Vec2, r = RADIUS): boolean {
    for (const s of this.solids) {
      const px = p[0] - s.a[0];
      const pz = p[1] - s.a[1];
      const along = px * s.u[0] + pz * s.u[1];
      if (along < -r || along > s.len + r) continue;
      // left face normal (-uz, ux): positive across = left side
      const across = -px * s.u[1] + pz * s.u[0];
      if (across > s.left + r || across < -s.right - r) continue;
      if (s.gaps.some(([g0, g1]) => along > g0 + r * 0.6 && along < g1 - r * 0.6)) continue;
      return true;
    }
    return false;
  }

  /** Whether a straight walk from a to b stays clear of walls. */
  clear(a: Vec2, b: Vec2): boolean {
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(d / 0.08));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      if (this.blocked([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])) return false;
    }
    return true;
  }

  roomAt(p: Vec2): Room | null {
    return this.rooms.find((r) => pointInPolygon(p, r.points)) ?? null;
  }

  /**
   * A path from a to b through doors (Dijkstra over the door points), or null when b cannot be reached.
   * `usable` rules door points out (the pets: one that lies in a couch's place).
   */
  path(a: Vec2, b: Vec2, usable?: (p: Vec2) => boolean): Vec2[] | null {
    if (this.clear(a, b)) return [b];
    const nodes: Vec2[] = [a, b, ...this.doors.flatMap((d) => d.p).filter((p) => !this.blocked(p) && (!usable || usable(p)))];
    const n = nodes.length;
    const dist = new Array<number>(n).fill(Infinity);
    const prev = new Array<number>(n).fill(-1);
    const done = new Array<boolean>(n).fill(false);
    dist[0] = 0;
    const edge = new Map<string, boolean>();
    const ok = (i: number, j: number) => {
      const k = i < j ? `${i}:${j}` : `${j}:${i}`;
      let v = edge.get(k);
      if (v === undefined) {
        v = this.clear(nodes[i], nodes[j]);
        edge.set(k, v);
      }
      return v;
    };
    for (;;) {
      let u = -1;
      for (let i = 0; i < n; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
      if (u < 0) return null;
      if (u === 1) break;
      done[u] = true;
      for (let v = 0; v < n; v++) {
        if (done[v] || v === u) continue;
        const d = Math.hypot(nodes[u][0] - nodes[v][0], nodes[u][1] - nodes[v][1]);
        if (dist[u] + d >= dist[v]) continue;
        if (!ok(u, v)) continue;
        dist[v] = dist[u] + d;
        prev[v] = u;
      }
    }
    const out: Vec2[] = [];
    for (let i = 1; i > 0; i = prev[i]) out.unshift(nodes[i]);
    return out;
  }

  /**
   * A good place to start: the largest room (usually the living room – the best first impression), looking
   * across it; `entrance` starts just inside the front door instead.
   */
  start(entrance = false): { p: Vec2; yaw: number } {
    for (const o of entrance ? this.floor.openings : []) {
      if (o.type !== "door") continue;
      const host = openingHost(o, this.floor.rooms, this.floor.walls ?? []);
      if (!host) continue;
      const at = locateOpening(this.walls, o, host);
      if (!at || !at.wall.exterior) continue;
      const w = at.wall;
      const dx = w.b[0] - w.a[0];
      const dz = w.b[1] - w.a[1];
      const len = Math.hypot(dx, dz) || 1;
      const ux = dx / len;
      const uz = dz / len;
      const c: Vec2 = [w.a[0] + ux * at.s, w.a[1] + uz * at.s];
      // exterior walls have their room on the left
      const p: Vec2 = [c[0] - uz * (w.left + 0.9), c[1] + ux * (w.left + 0.9)];
      if (this.blocked(p)) continue;
      return { p, yaw: this.openYaw(p, Math.atan2(ux, -uz)) };
    }
    const big = [...this.rooms].sort((p, q) => area(q) - area(p))[0];
    const c = big ? this.freeNear(centroid(big.points)) : ([0, 0] as Vec2);
    return { p: c, yaw: this.openYaw(c) };
  }

  /** How far one sees from p in a direction before a wall (up to max metres). */
  sight(p: Vec2, yaw: number, max = 9): number {
    const dx = Math.cos(yaw);
    const dz = Math.sin(yaw);
    for (let d = 0.2; d < max; d += 0.15) if (this.blocked([p[0] + dx * d, p[1] + dz * d], 0.05)) return d;
    return max;
  }

  /** The direction with the widest view from p (a wish direction counts a little more). */
  openYaw(p: Vec2, wish: number | null = null): number {
    let best = wish ?? 0;
    let score = -1;
    for (let i = 0; i < 24; i++) {
      const yaw = (i / 24) * Math.PI * 2;
      let s = this.sight(p, yaw);
      if (wish !== null) {
        let d = Math.abs(yaw - wish) % (Math.PI * 2);
        if (d > Math.PI) d = Math.PI * 2 - d;
        s *= 1.25 - (d / Math.PI) * 0.5;
      }
      if (s > score) {
        score = s;
        best = yaw;
      }
    }
    return best;
  }

  /**
   * Furniture the pets walk around (the walk through the house ignores it: walls only). A way ends inside an item
   * all the same when its goal lies there (a pet's bed), and starts inside one just as well.
   */
  setFurniture(items: readonly Furniture[]): void {
    this.items = items;
    this.grown = new Map();
  }

  /** The furniture's footprints grown by a margin (made once per margin). */
  private obstacles(margin: number): Obstacle[] {
    const key = Math.round(margin * 1000) / 1000;
    let list = this.grown.get(key);
    if (!list) {
      const grown = (f: Furniture, by: number) => furnitureFootprint({ ...f, w: f.w + 2 * by, d: f.d + 2 * by });
      list = this.items.map((f) => {
        const poly = grown(f, key);
        const xs = poly.map((p) => p[0]);
        const zs = poly.map((p) => p[1]);
        return { poly, corners: grown(f, key + CORNER_GAP), box: [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)] as [number, number, number, number] };
      });
      this.grown.set(key, list);
    }
    return list;
  }

  /** Whether p lies inside (the reach of) a piece of furniture. */
  inFurniture(p: Vec2, margin = PET_R): boolean {
    return this.obstacles(margin).some((o) => pointInPolygon(p, o.poly));
  }

  /** A path like path(), steering around the furniture too: the points to walk to, the last one is b; null when b cannot be reached. */
  walk(a: Vec2, b: Vec2, margin = PET_R, narrow = margin / 2): Vec2[] | null {
    if (!this.items.length) return this.path(a, b);
    // a door with furniture in front of it leads nowhere
    const base = this.path(a, b, (p) => !this.inFurniture(p, margin));
    if (!base) return null;
    const out: Vec2[] = [];
    let from = a;
    for (const to of base) {
      const leg = this.around(from, to, margin, narrow);
      // a spot walled in by furniture: no way at all, rather than one through it
      if (!leg) return null;
      out.push(...leg);
      from = to;
    }
    return out;
  }

  /** One straight leg from a to b, bent around the furniture in its way. */
  private around(a: Vec2, b: Vec2, margin: number, narrow: number): Vec2[] | null {
    // a roomy margin first (room to turn); where furniture stands too close together for it (chairs at a table) one
    // as wide as the body only
    return this.detour(a, b, margin) ?? this.detour(a, b, narrow);
  }

  /** A visibility graph over the corner points of the furniture near the leg; null when there is no way through. */
  private detour(a: Vec2, b: Vec2, margin: number): Vec2[] | null {
    const lo = [Math.min(a[0], b[0]) - 1.5, Math.min(a[1], b[1]) - 1.5];
    const hi = [Math.max(a[0], b[0]) + 1.5, Math.max(a[1], b[1]) + 1.5];
    // an end inside an item (a pet's bed) lets the leg start or end there; an end only in its margin keeps to the footprint
    const used: Obstacle[] = [];
    const polys: Vec2[][] = [];
    const tight = this.obstacles(0.02);
    this.obstacles(margin).forEach((o, i) => {
      if (!(o.box[2] > lo[0] && o.box[0] < hi[0] && o.box[3] > lo[1] && o.box[1] < hi[1])) return;
      if (pointInPolygon(a, tight[i].poly) || pointInPolygon(b, tight[i].poly)) return;
      used.push(o);
      polys.push(pointInPolygon(a, o.poly) || pointInPolygon(b, o.poly) ? tight[i].poly : o.poly);
    });
    const cuts = (p: Vec2, q: Vec2) => polys.some((poly) => segmentHits(p, q, poly));
    if (!cuts(a, b)) return [b];
    const nodes: Vec2[] = [a, b];
    for (const o of used) {
      for (const c of o.corners) {
        if (polys.some((poly) => pointInPolygon(c, poly)) || this.blocked(c, 0.05) || !this.roomAt(c)) continue;
        nodes.push(c);
      }
    }
    const n = nodes.length;
    const dist = new Array<number>(n).fill(Infinity);
    const prev = new Array<number>(n).fill(-1);
    const done = new Array<boolean>(n).fill(false);
    dist[0] = 0;
    for (;;) {
      let u = -1;
      for (let i = 0; i < n; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
      if (u < 0) return null;
      if (u === 1) break;
      done[u] = true;
      for (let v = 0; v < n; v++) {
        if (done[v] || v === u) continue;
        const d = dist[u] + Math.hypot(nodes[u][0] - nodes[v][0], nodes[u][1] - nodes[v][1]);
        if (d >= dist[v] || cuts(nodes[u], nodes[v]) || !this.clear(nodes[u], nodes[v])) continue;
        dist[v] = d;
        prev[v] = u;
      }
    }
    const way: Vec2[] = [];
    for (let i = 1; i > 0; i = prev[i]) way.unshift(nodes[i]);
    return way;
  }

  /** A free spot near p (the middle of a room may hold a table – walls only matter here). */
  freeNear(p: Vec2): Vec2 {
    if (!this.blocked(p)) return p;
    for (let r = 0.2; r < 2; r += 0.2) for (let a = 0; a < 6.28; a += 0.5) {
      const q: Vec2 = [p[0] + Math.cos(a) * r, p[1] + Math.sin(a) * r];
      if (!this.blocked(q)) return q;
    }
    return p;
  }
}

/** Whether the segment p-q passes through the inside of a convex polygon (touching its outline does not count). */
function segmentHits(p: Vec2, q: Vec2, poly: readonly Vec2[]): boolean {
  if (pointInPolygon(p, poly) || pointInPolygon(q, poly)) return true;
  const mid: Vec2 = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  if (pointInPolygon(mid, poly)) return true;
  const cross = (o: Vec2, u: Vec2, v: Vec2) => (u[0] - o[0]) * (v[1] - o[1]) - (u[1] - o[1]) * (v[0] - o[0]);
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const c = poly[j];
    const d = poly[i];
    const d1 = cross(p, q, c);
    const d2 = cross(p, q, d);
    const d3 = cross(c, d, p);
    const d4 = cross(c, d, q);
    if (d1 * d2 < -1e-12 && d3 * d4 < -1e-12) return true;
  }
  return false;
}

function area(r: Room): number {
  let a = 0;
  const pts = r.points;
  for (let i = 0; i < pts.length; i++) {
    const [x0, z0] = pts[i];
    const [x1, z1] = pts[(i + 1) % pts.length];
    a += x0 * z1 - x1 * z0;
  }
  return Math.abs(a / 2);
}

// ------------------------------------------------------------------ the camera

/** The parts of NeonPlan's viewer the walk takes over (private there, reached at run time). */
interface ViewerInternals {
  camera: { position: { set(x: number, y: number, z: number): void; x: number; y: number; z: number }; lookAt(x: number, y: number, z: number): void; fov: number; near: number; updateProjectionMatrix(): void; aspect: number };
  controls: { update(now: number): boolean; view: { target: { x: number; y: number; z: number; set(x: number, y: number, z: number): void }; radius: number; theta: number; phi: number } };
  floorMap: Map<string, { y: number; floor: Floor; mask: { standing: { value: number }; glass: { value: number } } }>;
  floors: { mask: { standing: { value: number }; glass: { value: number } } }[];
  labels: HTMLElement;
  renderer: { domElement: HTMLCanvasElement };
  invalidate(): void;
  updateWalls(): void;
}

export interface WalkState {
  x: number;
  z: number;
  yaw: number;
  pitch: number;
}

export class WalkCamera {
  state: WalkState;
  private path: Vec2[] = [];
  private keys = new Set<string>();
  private stick: { x: number; y: number } | null = null;
  private raf = 0;
  private last = 0;
  private origUpdate: ViewerInternals["controls"]["update"];
  private origWalls: () => void;
  private origFov: number;
  private origNear: number;
  private onRoom: (room: Room | null) => void;
  private roomId: string | null = null;
  private listeners: [EventTarget, string, EventListener, boolean][] = [];
  /** Turning toward the walking direction while a path is followed. */
  private turnTo: number | null = null;

  private readonly v: ViewerInternals;
  map: FloorMap;
  private readonly surface: HTMLElement;

  constructor(v: ViewerInternals, map: FloorMap, surface: HTMLElement, opts: { onRoom: (room: Room | null) => void; start?: WalkState }) {
    this.v = v;
    this.map = map;
    this.surface = surface;
    this.onRoom = opts.onRoom;
    const s = opts.start ?? (() => {
      const st = map.start();
      return { x: st.p[0], z: st.p[1], yaw: st.yaw, pitch: -0.05 };
    })();
    this.state = { ...s };
    this.origUpdate = v.controls.update;
    this.origWalls = v.updateWalls;
    this.origFov = v.camera.fov;
    this.origNear = v.camera.near;
    // NeonPlan's frame calls these: the walk owns the camera, walls stand whole and opaque
    v.controls.update = () => this.apply();
    v.updateWalls = () => {
      for (const fv of v.floors) {
        fv.mask.standing.value = 0xffff;
        fv.mask.glass.value = 0;
      }
    };
    v.camera.fov = 72;
    v.camera.near = 0.05;
    v.camera.updateProjectionMatrix();
    v.labels.style.visibility = "hidden";
    this.bind();
    this.reportRoom();
    v.invalidate();
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    for (const [t, type, fn, capture] of this.listeners) t.removeEventListener(type, fn, capture);
    this.v.controls.update = this.origUpdate;
    this.v.updateWalls = this.origWalls;
    this.v.camera.fov = this.origFov;
    this.v.camera.near = this.origNear;
    this.v.camera.updateProjectionMatrix();
    this.v.labels.style.visibility = "";
    this.v.invalidate();
  }

  setMap(map: FloorMap, start?: WalkState): void {
    this.map = map;
    this.path = [];
    const s = start ?? (() => {
      const st = map.start();
      return { x: st.p[0], z: st.p[1], yaw: st.yaw, pitch: -0.05 };
    })();
    this.state = { ...s };
    this.reportRoom();
    this.kick();
  }

  private floorY(): number {
    const fv = this.v.floorMap.get(this.map.floor.id);
    return (fv ? fv.floor.elevation + fv.y : this.map.floor.elevation) + EYE;
  }

  /** Sets the camera (called by the viewer's frame); true while it still moves. */
  private apply(): boolean {
    const { x, z, yaw, pitch } = this.state;
    const y = this.floorY();
    const cp = Math.cos(pitch);
    this.v.camera.position.set(x, y, z);
    this.v.camera.lookAt(x + Math.cos(yaw) * cp, y + Math.sin(pitch), z + Math.sin(yaw) * cp);
    // keep the orbit view near the walker, so leaving the walk flies out from here
    this.v.controls.view.target.set(x, y - EYE, z);
    return false;
  }

  /** Walk to a point on the floor (through doors when needed). */
  goTo(p: Vec2): boolean {
    const path = this.map.path([this.state.x, this.state.z], this.map.freeNear(p));
    if (!path) return false;
    this.path = path;
    this.kick();
    return true;
  }

  goToRoom(room: Room): boolean {
    return this.goTo(centroid(room.points));
  }

  private kick(): void {
    if (!this.raf) {
      this.last = performance.now();
      this.raf = requestAnimationFrame((t) => this.tick(t));
    }
    this.v.invalidate();
  }

  private tick(now: number): void {
    this.raf = 0;
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    let moving = false;
    const s = this.state;
    // keys and stick: forward/back and sideways relative to the view
    let fwd = 0;
    let side = 0;
    let turn = 0;
    if (this.keys.has("w") || this.keys.has("arrowup")) fwd += 1;
    if (this.keys.has("s") || this.keys.has("arrowdown")) fwd -= 1;
    if (this.keys.has("a")) side -= 1;
    if (this.keys.has("d")) side += 1;
    if (this.keys.has("arrowleft") || this.keys.has("q")) turn -= 1;
    if (this.keys.has("arrowright") || this.keys.has("e")) turn += 1;
    if (this.stick) {
      fwd += -this.stick.y;
      turn += this.stick.x * 0.9;
    }
    if (turn) {
      s.yaw += turn * 1.6 * dt;
      moving = true;
    }
    if (fwd || side) {
      this.path = [];
      this.turnTo = null;
      const speed = 1.5 * dt;
      const dx = (Math.cos(s.yaw) * fwd - Math.sin(s.yaw) * side) * speed;
      const dz = (Math.sin(s.yaw) * fwd + Math.cos(s.yaw) * side) * speed;
      this.move(dx, dz);
      moving = true;
    } else if (this.path.length) {
      const [tx, tz] = this.path[0];
      const dx = tx - s.x;
      const dz = tz - s.z;
      const d = Math.hypot(dx, dz);
      const step = 1.4 * dt;
      if (d <= step) {
        s.x = tx;
        s.z = tz;
        this.path.shift();
      } else {
        s.x += (dx / d) * step;
        s.z += (dz / d) * step;
        this.turnTo = Math.atan2(dz, dx);
      }
      moving = true;
    }
    if (this.turnTo !== null) {
      let d = this.turnTo - s.yaw;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      if (Math.abs(d) < 0.01) this.turnTo = null;
      else {
        s.yaw += d * Math.min(1, dt * 4);
        moving = true;
      }
      if (!this.path.length && Math.abs(d) < 0.05) this.turnTo = null;
    }
    this.reportRoom();
    this.v.invalidate();
    if (moving || this.keys.size || this.stick) this.raf = requestAnimationFrame((t) => this.tick(t));
  }

  private move(dx: number, dz: number): void {
    const s = this.state;
    const p: Vec2 = [s.x + dx, s.z + dz];
    if (!this.map.blocked(p)) {
      s.x = p[0];
      s.z = p[1];
      return;
    }
    // slide along the wall
    if (!this.map.blocked([s.x + dx, s.z])) s.x += dx;
    else if (!this.map.blocked([s.x, s.z + dz])) s.z += dz;
  }

  private reportRoom(): void {
    const room = this.map.roomAt([this.state.x, this.state.z]);
    const id = room?.id ?? null;
    if (id !== this.roomId) {
      this.roomId = id;
      this.onRoom(room);
    }
  }

  setStick(v: { x: number; y: number } | null): void {
    this.stick = v;
    this.kick();
  }

  /** Point on the floor under a screen position of the surface (null above the horizon). */
  private floorPoint(cx: number, cy: number): Vec2 | null {
    const rect = this.surface.getBoundingClientRect();
    const nx = ((cx - rect.left) / rect.width) * 2 - 1;
    const ny = 1 - ((cy - rect.top) / rect.height) * 2;
    const { yaw, pitch, x, z } = this.state;
    const fov = (this.v.camera.fov * Math.PI) / 180;
    const th = Math.tan(fov / 2);
    const aspect = rect.width / rect.height;
    // camera basis: forward f, right r, up u
    const cp = Math.cos(pitch);
    const f = [Math.cos(yaw) * cp, Math.sin(pitch), Math.sin(yaw) * cp];
    const r = [-Math.sin(yaw), 0, Math.cos(yaw)];
    const u = [f[1] * r[2] - f[2] * r[1], f[2] * r[0] - f[0] * r[2], f[0] * r[1] - f[1] * r[0]];
    // u points down with this cross order; flip it
    const up = [-u[0], -u[1], -u[2]];
    const dir = [f[0] + r[0] * nx * th * aspect + up[0] * ny * th, f[1] + r[1] * nx * th * aspect + up[1] * ny * th, f[2] + r[2] * nx * th * aspect + up[2] * ny * th];
    if (dir[1] >= -0.02) return null;
    const t = EYE / -dir[1];
    return [x + dir[0] * t, z + dir[2] * t];
  }

  private bind(): void {
    const on = (t: EventTarget, type: string, fn: (e: never) => void, opts?: AddEventListenerOptions) => {
      t.addEventListener(type, fn as EventListener, opts);
      this.listeners.push([t, type, fn as EventListener, !!opts?.capture]);
    };
    let drag: { x: number; y: number; moved: boolean; id: number } | null = null;
    on(this.surface, "pointerdown", (e: PointerEvent) => {
      if (drag) return;
      drag = { x: e.clientX, y: e.clientY, moved: false, id: e.pointerId };
      this.surface.setPointerCapture?.(e.pointerId);
    });
    on(this.surface, "pointermove", (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 5) return;
      drag.moved = true;
      drag.x = e.clientX;
      drag.y = e.clientY;
      // drag the world: moving right turns the view left (like grabbing the scene)
      const k = (this.v.camera.fov * Math.PI) / 180 / this.surface.clientHeight;
      this.state.yaw -= dx * k * 1.1;
      this.state.pitch = Math.max(-1.0, Math.min(0.8, this.state.pitch + dy * k * 1.1));
      this.turnTo = null;
      this.v.invalidate();
    });
    const up = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      const tap = !drag.moved;
      drag = null;
      if (tap) {
        const p = this.floorPoint(e.clientX, e.clientY);
        if (p && this.map.roomAt(p)) this.goTo(p);
      }
    };
    on(this.surface, "pointerup", up);
    on(this.surface, "pointercancel", () => (drag = null));
    on(
      this.surface,
      "wheel",
      (e: WheelEvent) => {
        e.preventDefault();
        const s = this.state;
        const step = Math.max(-0.6, Math.min(0.6, -e.deltaY / 300));
        this.path = [];
        this.move(Math.cos(s.yaw) * step, Math.sin(s.yaw) * step);
        this.reportRoom();
        this.v.invalidate();
      },
      { passive: false },
    );
    // the walk's keys come first: the page's own shortcuts on W, A, S, D … stay quiet while walking
    // (caught on the way down, before anything else hears them)
    const walkKey = (e: KeyboardEvent) => ["w", "a", "s", "d", "q", "e", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(e.key.toLowerCase());
    const typing = (e: KeyboardEvent) => !!(e.composedPath()[0] as HTMLElement)?.closest?.("input, textarea, select");
    on(
      window,
      "keydown",
      (e: KeyboardEvent) => {
        if (!walkKey(e) || typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        this.keys.add(e.key.toLowerCase());
        this.kick();
      },
      { capture: true },
    );
    on(
      window,
      "keyup",
      (e: KeyboardEvent) => {
        if (!walkKey(e)) return;
        this.keys.delete(e.key.toLowerCase());
        e.stopImmediatePropagation();
      },
      { capture: true },
    );
    on(window, "blur", () => this.keys.clear());
  }
}
