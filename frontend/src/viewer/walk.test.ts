import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyBuilding, newFloor, type Furniture, type Room, type Vec2 } from "../model.ts";
import { FloorMap } from "./walk.ts";

const room: Room = { id: "a", name: "a", area_id: null, points: [[0, 0], [6, 0], [6, 4], [0, 4]], floor_material: "wood" };
const item = (id: string, x: number, z: number, w: number, d: number): Furniture => ({ id, type: "sofa", x, z, rotation: 0, w, d, h: 0.8, variant: null, entity: null, power: null });

function mapWith(items: Furniture[]) {
  const b = emptyBuilding();
  const floor = { ...newFloor("f", "F", 0), rooms: [room] };
  b.floors = [floor];
  const map = new FloorMap(b, floor);
  map.setFurniture(items);
  return map;
}

const hits = (pts: Vec2[], f: Furniture) => {
  // does the walked line cut through the furniture's footprint
  const x0 = f.x - f.w / 2;
  const x1 = f.x + f.w / 2;
  const z0 = f.z - f.d / 2;
  const z1 = f.z + f.d / 2;
  for (let i = 1; i < pts.length; i++) {
    for (let t = 0; t <= 1; t += 0.02) {
      const x = pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t;
      const z = pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t;
      if (x > x0 && x < x1 && z > z0 && z < z1) return true;
    }
  }
  return false;
};

test("a pet's way leads around a sofa instead of through it", () => {
  const sofa = item("s", 3, 2, 2, 0.9);
  const map = mapWith([sofa]);
  const a: Vec2 = [0.6, 2];
  const way = map.walk(a, [5.4, 2]);
  assert.ok(way, "a way exists");
  assert.ok(way!.length > 1, "it bends");
  assert.ok(!hits([a, ...way!], sofa), "the line cuts through the sofa");
  assert.deepEqual(way![way!.length - 1], [5.4, 2]);
});

test("without furniture the way stays straight", () => {
  const map = mapWith([]);
  assert.deepEqual(map.walk([0.6, 2], [5.4, 2]), [[5.4, 2]]);
});

test("a goal inside a piece of furniture (a pet's bed) can be reached", () => {
  const bed = item("b", 3, 2, 0.6, 0.5);
  const map = mapWith([bed]);
  const way = map.walk([0.6, 2], [3, 2]);
  assert.ok(way && way.length >= 1);
  assert.deepEqual(way![way!.length - 1], [3, 2]);
});

test("a row of furniture is walked around, even along a wall", () => {
  const row = [item("a", 1.5, 2, 2, 0.8), item("b", 3.4, 2, 1.6, 0.8), item("c", 5.0, 2, 1.2, 0.8)];
  const map = mapWith(row);
  const a: Vec2 = [0.2, 2];
  const way = map.walk(a, [5.8, 2]);
  assert.ok(way);
  for (const f of row) assert.ok(!hits([a, ...way!], f), `cuts through ${f.id}`);
});

test("a spot walled in by furniture cannot be reached: no way instead of one through the furniture", () => {
  // a corner boxed in by a couch in an L (the gap between the items is narrower than a pet)
  const couch = [item("a", 1.5, 1.1, 3, 0.6), item("b", 2.85, 0.5, 0.6, 1.8)];
  const map = mapWith(couch);
  assert.equal(map.walk([4.5, 3], [0.5, 0.5]), null);
  // the same corner can be left (a pet that sits there) – only the way in is refused
  assert.ok(map.walk([4.5, 3], [4.5, 0.5]));
});

test("a door with a couch in front of it is no way through for a pet", () => {
  const next: Room = { ...room, id: "b", name: "b", points: [[4, 0], [8, 0], [8, 4], [4, 4]] };
  const left: Room = { ...room, points: [[0, 0], [4, 0], [4, 4], [0, 4]] };
  const b = emptyBuilding();
  const door = { id: "d", room_id: "a", edge: 1, offset: 1.5, width: 0.9, type: "door", sill: 0, height: 2.05, hinge: "left", leaves: 1, swing: "in", cover: null, contact: null, contact2: null, tilt: null } as const;
  const floor = { ...newFloor("f", "F", 0), rooms: [left, next], openings: [door] };
  b.floors = [floor];
  const map = new FloorMap(b, floor);
  assert.ok(map.path([1, 1], [7, 1]), "the door leads through");
  map.setFurniture([item("couch", 3.5, 2, 0.8, 3)]);
  assert.equal(map.walk([1, 1], [7, 1]), null, "the way through the couch is no way");
});
