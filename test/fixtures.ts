import { eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { areas, climbs, user, sends, journalEntries } from "@/db/schema";

/**
 * A small tree exercising: a root with no ancestors, a two-level-deep
 * ancestor chain, an area whose climbs live only on its descendants (not
 * itself), and a leaf area with climbs directly attached.
 *
 *   Test Crag (1)
 *   ├── Test Boulders (2)
 *   │   ├── Test Highball Alcove (4)       -> climb: Test Highball (boulder, V4)
 *   │   └── Test Slab Area (5)             -> climb: Test Slab (boulder, V1)
 *   └── Test Sport Wall (3)                -> climbs: Test Crimper (sport, 5.10a),
 *                                                     Test Crack (trad, 5.6)
 */
export async function seedFixtureTree(db: Database) {
  // parentId is the whole tree — no positions to keep consistent with it.
  await db.insert(areas).values([
    { id: 1, parentId: null, name: "Test Crag", description: "A test crag." },
    { id: 2, parentId: 1, name: "Test Boulders" },
    { id: 3, parentId: 1, name: "Test Sport Wall" },
    { id: 4, parentId: 2, name: "Test Highball Alcove" },
    { id: 5, parentId: 2, name: "Test Slab Area" },
  ]);

  await db.insert(climbs).values([
    { id: 1, areaId: 4, name: "Test Highball", type: "boulder", grade: 5 }, // V4
    { id: 2, areaId: 5, name: "Test Slab", type: "boulder", grade: 2 }, // V1
    { id: 3, areaId: 3, name: "Test Crimper", type: "sport", grade: 10 }, // 5.10a
    { id: 4, areaId: 3, name: "Test Crack", type: "trad", grade: 6 }, // 5.6
  ]);

  // areas_fts/climbs_fts are populated by the sync triggers
  // (drizzle/migrations/0015_fts_sync_triggers.sql) — seeding them by hand
  // here would double-index every row.
}

/** Inserts `count` boulder climbs into `areaId`, for pagination tests. */
export async function seedManyClimbs(db: Database, areaId: number, count: number, startId: number) {
  const area = await db.select().from(areas).where(eq(areas.id, areaId)).get();
  if (!area) throw new Error(`seedManyClimbs: no area with id ${areaId}`);

  const rows = Array.from({ length: count }, (_, i) => ({
    id: startId + i,
    areaId,
    name: `Bulk Climb ${i}`,
    type: "boulder" as const,
    grade: i % 19,
  }));
  // D1 has a bound-parameter limit per statement, so chunk the insert. 8
  // bound columns per row (id/areaId/name/type/grade/sendCount/ratingSum/
  // ratingCount — drizzle binds every column with a default explicitly
  // rather than omitting it), so 12 rows/chunk stays safely under the limit.
  const CHUNK_SIZE = 12;
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    await db.insert(climbs).values(rows.slice(i, i + CHUNK_SIZE));
  }
}

/** Inserts `count` leaf areas sharing a common name prefix, root-level by
 * default. Two uses: exercising an area-name filter that matches many areas at
 * once (regression coverage: matching N areas used to bind 2 SQL parameters
 * per match, blowing past D1's per-statement bound-parameter limit — the same
 * limit `seedManyClimbs`'s chunking works around), and, with `parentId`,
 * building a subtree wide enough to reach LARGE_AREA_SUBTREE_AREAS. */
export async function seedManyAreas(
  db: Database,
  count: number,
  startId: number,
  {
    parentId = null,
    namePrefix = "Bulk Area",
  }: { parentId?: number | null; namePrefix?: string } = {},
) {
  const rows = Array.from({ length: count }, (_, i) => ({
    id: startId + i,
    parentId,
    name: `${namePrefix} ${i}`,
  }));
  const CHUNK_SIZE = 20;
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    await db.insert(areas).values(rows.slice(i, i + CHUNK_SIZE));
  }
}

type FixtureUserOverrides = Partial<typeof user.$inferInsert> & { id: string };

/** Inserts a minimal `user` row for send-query tests; `id` must be unique per
 * call. The default name derives from the id because names are unique
 * (user_name_unique_idx) — a shared "Test Climber" literal would make any
 * second seeded user violate the index. */
export async function seedFixtureUser(db: Database, overrides: FixtureUserOverrides) {
  const row = {
    name: `Test Climber ${overrides.id}`,
    email: `${overrides.id}@example.com`,
    ...overrides,
  };
  await db.insert(user).values(row);
  return row;
}

type FixtureSendOverrides = Partial<typeof sends.$inferInsert> & {
  userId: string;
  climbId: number;
  dateSent: string | null;
};

/** Inserts a `sends` row referencing an existing fixture user/climb.
 * climbs.sendCount/ratingSum/ratingCount follow via the triggers from
 * 0014_sends_aggregate_triggers, which the test pool applies along with
 * every other migration — so seeding directly here stays consistent with a
 * real write, and getSubtreeClimbs sort/rating assertions hold. */
export async function seedFixtureSend(db: Database, overrides: FixtureSendOverrides) {
  const row = {
    ascentStyle: "redpoint" as const,
    comment: null,
    rating: null,
    suggestedGrade: null,
    ...overrides,
  };
  await db.insert(sends).values(row);
  return row;
}

type FixtureJournalEntryOverrides = Partial<typeof journalEntries.$inferInsert> & {
  userId: string;
  entryDate: string;
};

export async function seedFixtureJournalEntry(
  db: Database,
  overrides: FixtureJournalEntryOverrides,
) {
  const kind = overrides.kind ?? "session";
  const row = {
    kind,
    sent: false,
    climbId: kind === "session" ? 1 : null,
    body: null,
    tags: null,
    ...overrides,
  };
  await db.insert(journalEntries).values(row);
  return row;
}
