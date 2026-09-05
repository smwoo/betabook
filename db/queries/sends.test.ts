import { env } from "cloudflare:test";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { createDb, type Database } from "@/db/client";
import { climbs, sends } from "@/db/schema";
import { BOULDER_HUECO, ROPE_YDS } from "@/lib/grades";
import { seedFixtureSend, seedFixtureTree, seedFixtureUser, seedManyClimbs } from "@/test/fixtures";
import { explainQueries } from "@/test/query-plans";
import { resetDb } from "@/test/reset-db";

import {
  getClimbSendStats,
  getClimbSendSummary,
  getSendsForClimb,
  getSendsForUserPage,
  getSendsForUserExportPage,
  getUserSendForClimb,
  getUserSendsSummary,
  getUserSentClimbIds,
  type UserSendsExportCursor,
  type UserSendsFilter,
} from "./sends";

const ALL_SENDS_FILTER: UserSendsFilter = {
  disciplines: ["boulder", "sport", "trad"],
  boulderRange: [0, BOULDER_HUECO.length - 1],
  sportRange: [0, ROPE_YDS.length - 1],
  tradRange: [0, ROPE_YDS.length - 1],
  ascentStyles: [],
  minRating: 0,
};

let db: Database;

beforeEach(async () => {
  db = createDb(env.DB);
  await resetDb(db);
  await seedFixtureTree(db);

  await seedFixtureUser(db, { id: "test-user-1", name: "Alice Climber" });
  await seedFixtureUser(db, { id: "test-user-2", name: "Bob Climber" });

  // Test Highball (climb id 1) sent by both users on different dates;
  // Test Slab (climb id 2) sent only by test-user-1.
  await seedFixtureSend(db, {
    userId: "test-user-1",
    climbId: 1,
    dateSent: "2026-01-01",
    rating: 4,
  });
  await seedFixtureSend(db, {
    userId: "test-user-2",
    climbId: 1,
    dateSent: "2026-02-01",
    ascentStyle: "flash",
  });
  await seedFixtureSend(db, {
    userId: "test-user-1",
    climbId: 2,
    dateSent: "2026-03-01",
    ascentStyle: "onsight",
  });
});

async function seedMultiDiscipline() {
  await seedFixtureUser(db, { id: "test-user-5", name: "Multi Discipline" });
  await seedFixtureSend(db, {
    userId: "test-user-5",
    climbId: 1, // Test Highball, boulder
    dateSent: "2026-01-01",
  });
  await seedFixtureSend(db, {
    userId: "test-user-5",
    climbId: 3, // Test Crimper, sport
    dateSent: "2026-02-01",
  });
}
async function seedNameSends() {
  await seedFixtureUser(db, { id: "test-user-10", name: "Name Filter Tester" });
  // Test Highball lives in Test Highball Alcove, under Test Boulders,
  // under Test Crag; Test Crimper lives directly in Test Sport Wall,
  // also under Test Crag — a sibling subtree of Test Boulders.
  await seedFixtureSend(db, {
    userId: "test-user-10",
    climbId: 1, // Test Highball
    dateSent: "2026-05-01",
  });
  await seedFixtureSend(db, {
    userId: "test-user-10",
    climbId: 3, // Test Crimper
    dateSent: "2026-05-02",
  });
}
async function seedSortSends() {
  await seedFixtureUser(db, { id: "test-user-11", name: "Sort Tester" });
  // climbs.grade (ordinal index): Test Slab=2, Test Highball=5,
  // Test Crack=6, Test Crimper=10 — deliberately mixed disciplines,
  // since grade sort is documented as a raw-index sort, not a
  // cross-discipline difficulty comparison.
  await seedFixtureSend(db, {
    userId: "test-user-11",
    climbId: 2, // Test Slab, grade 2
    dateSent: "2026-06-01",
    rating: 3,
  });
  await seedFixtureSend(db, {
    userId: "test-user-11",
    climbId: 3, // Test Crimper, grade 10
    dateSent: "2026-06-02",
    rating: null,
  });
  await seedFixtureSend(db, {
    userId: "test-user-11",
    climbId: 1, // Test Highball, grade 5
    dateSent: "2026-06-03",
    rating: 5,
  });
  await seedFixtureSend(db, {
    userId: "test-user-11",
    climbId: 4, // Test Crack, grade 6
    dateSent: null,
    rating: 1,
  });
}

describe("getUserSendForClimb", () => {
  it("returns the user's send for a climb they've sent", async () => {
    const send = await getUserSendForClimb(db, "test-user-1", 1);
    expect(send?.rating).toBe(4);
  });

  it("returns undefined when the user hasn't sent that climb", async () => {
    const send = await getUserSendForClimb(db, "test-user-1", 3);
    expect(send).toBeUndefined();
  });
});

describe("getSendsForClimb", () => {
  it("returns every user's send for the climb, newest dateSent first", async () => {
    const { sends, hasMore } = await getSendsForClimb(db, 1);
    expect(sends.map((s) => s.userName)).toEqual(["Bob Climber", "Alice Climber"]);
    expect(hasMore).toBe(false);
  });

  it("returns an empty page for a climb with no sends", async () => {
    const results = await getSendsForClimb(db, 3);
    expect(results).toEqual({ sends: [], hasMore: false });
  });

  it("paginates with an offset and page size, reporting hasMore", async () => {
    const page1 = await getSendsForClimb(db, 1, 0, 1);
    expect(page1.sends.map((s) => s.userName)).toEqual(["Bob Climber"]);
    expect(page1.hasMore).toBe(true);

    const page2 = await getSendsForClimb(db, 1, 1, 1);
    expect(page2.sends.map((s) => s.userName)).toEqual(["Alice Climber"]);
    expect(page2.hasMore).toBe(false);
  });
});

describe("getSendsForUserPage", () => {
  it("returns every send across a user's climbs, newest dateSent first, with area info", async () => {
    const { sends: results, hasMore } = await getSendsForUserPage(
      db,
      "test-user-1",
      ALL_SENDS_FILTER,
      0,
    );
    expect(results.map((s) => s.climbName)).toEqual(["Test Slab", "Test Highball"]);
    expect(results.map((s) => s.areaName)).toEqual(["Test Slab Area", "Test Highball Alcove"]);
    expect(hasMore).toBe(false);
  });

  it("returns an empty page for a user with no sends", async () => {
    await seedFixtureUser(db, { id: "test-user-3", name: "No Sends" });
    const { sends: results, hasMore } = await getSendsForUserPage(
      db,
      "test-user-3",
      ALL_SENDS_FILTER,
      0,
    );
    expect(results).toEqual([]);
    expect(hasMore).toBe(false);
  });

  it("paginates with a page size and reports hasMore", async () => {
    const page1 = await getSendsForUserPage(db, "test-user-1", ALL_SENDS_FILTER, 0, 1);
    expect(page1.sends.map((s) => s.climbName)).toEqual(["Test Slab"]);
    expect(page1.hasMore).toBe(true);

    const page2 = await getSendsForUserPage(db, "test-user-1", ALL_SENDS_FILTER, 1, 1);
    expect(page2.sends.map((s) => s.climbName)).toEqual(["Test Highball"]);
    expect(page2.hasMore).toBe(false);
  });

  it("excludes disciplines not selected", async () => {
    await seedMultiDiscipline();

    const boulderOnly = await getSendsForUserPage(
      db,
      "test-user-5",
      {
        ...ALL_SENDS_FILTER,
        disciplines: ["boulder"],
      },
      0,
    );
    expect(boulderOnly.sends.map((s) => s.climbName)).toEqual(["Test Highball"]);

    const sportOnly = await getSendsForUserPage(
      db,
      "test-user-5",
      {
        ...ALL_SENDS_FILTER,
        disciplines: ["sport"],
      },
      0,
    );
    expect(sportOnly.sends.map((s) => s.climbName)).toEqual(["Test Crimper"]);
  });

  it("returns every discipline when none are selected (unfiltered, not empty)", async () => {
    await seedMultiDiscipline();
    const results = await getSendsForUserPage(
      db,
      "test-user-5",
      {
        ...ALL_SENDS_FILTER,
        disciplines: [],
      },
      0,
    );
    expect(results.sends.map((s) => s.climbName)).toEqual(["Test Crimper", "Test Highball"]);
  });

  it("filters by grade range within a discipline", async () => {
    // Test Highball is V4 (ordinal 5), Test Slab is V1 (ordinal 2).
    const highOnly = await getSendsForUserPage(
      db,
      "test-user-1",
      {
        ...ALL_SENDS_FILTER,
        boulderRange: [3, BOULDER_HUECO.length - 1],
      },
      0,
    );
    expect(highOnly.sends.map((s) => s.climbName)).toEqual(["Test Highball"]);
  });

  describe("grade-unknown sends", () => {
    beforeEach(async () => {
      // Two new climbs in Test Highball Alcove (area 4) rather than sends on
      // the shared fixture climbs — later describe blocks assert exact
      // cumulative send counts for climbs 1-4 "in this fixture" in the file's
      // fixture history. Grade V4 = ordinal 5 (BOULDER_HUECO).
      await db.insert(climbs).values([
        { id: 850, areaId: 4, name: "Test Mystery Problem", type: "boulder", grade: null },
        { id: 851, areaId: 4, name: "Test Graded Problem", type: "boulder", grade: 5 },
      ]);
      await db.run(
        sql`INSERT INTO climbs_fts(rowid, name) SELECT id, name FROM climbs WHERE id IN (850, 851)`,
      );
      await seedFixtureUser(db, { id: "test-user-nullgrade", name: "Null Grade Tester" });
      await seedFixtureSend(db, {
        userId: "test-user-nullgrade",
        climbId: 850,
        dateSent: "2026-06-01",
      });
      await seedFixtureSend(db, {
        userId: "test-user-nullgrade",
        climbId: 851,
        dateSent: "2026-06-02",
      });
    });

    it("includes grade-unknown sends while the discipline's grade range is the full default", async () => {
      const results = await getSendsForUserPage(
        db,
        "test-user-nullgrade",
        {
          ...ALL_SENDS_FILTER,
          disciplines: ["boulder"],
        },
        0,
      );
      expect(results.sends.map((s) => s.climbName).sort()).toEqual([
        "Test Graded Problem",
        "Test Mystery Problem",
      ]);
    });

    it("excludes grade-unknown sends once the grade range is narrowed", async () => {
      // Regression: NULL grades were OR-ed into the range predicate, so a
      // "grade unknown" send matched every narrowed range. An unknown grade
      // can't be known to fall inside [V2, top], so only the graded (V4)
      // climb's send matches.
      const results = await getSendsForUserPage(
        db,
        "test-user-nullgrade",
        {
          ...ALL_SENDS_FILTER,
          disciplines: ["boulder"],
          boulderRange: [3, BOULDER_HUECO.length - 1],
        },
        0,
      );
      expect(results.sends.map((s) => s.climbName)).toEqual(["Test Graded Problem"]);
    });

    it("excludes grade-unknown sends when only the upper bound is narrowed", async () => {
      const results = await getSendsForUserPage(
        db,
        "test-user-nullgrade",
        {
          ...ALL_SENDS_FILTER,
          disciplines: ["boulder"],
          boulderRange: [0, 3],
        },
        0,
      );
      expect(results.sends).toEqual([]);
    });
  });

  describe("name/areaName filtering", () => {
    beforeEach(seedNameSends);

    it("fuzzy-matches by partial climb name", async () => {
      const results = await getSendsForUserPage(
        db,
        "test-user-10",
        {
          ...ALL_SENDS_FILTER,
          name: "Highb",
        },
        0,
      );
      expect(results.sends.map((s) => s.climbName)).toEqual(["Test Highball"]);
    });

    it("matches by area name against the climb's own area or any ancestor", async () => {
      const results = await getSendsForUserPage(
        db,
        "test-user-10",
        {
          ...ALL_SENDS_FILTER,
          areaName: "Boulders",
        },
        0,
      );
      expect(results.sends.map((s) => s.climbName)).toEqual(["Test Highball"]);
    });

    it("matches every send under a shared top-level ancestor", async () => {
      const results = await getSendsForUserPage(
        db,
        "test-user-10",
        {
          ...ALL_SENDS_FILTER,
          areaName: "Test Crag",
        },
        0,
      );
      expect(results.sends.map((s) => s.climbName).sort()).toEqual([
        "Test Crimper",
        "Test Highball",
      ]);
    });

    it("returns no sends when the climb name matches nothing", async () => {
      const results = await getSendsForUserPage(
        db,
        "test-user-10",
        {
          ...ALL_SENDS_FILTER,
          name: "NoSuchClimbNameAtAll",
        },
        0,
      );
      expect(results).toEqual({ sends: [], hasMore: false });
    });

    it("returns no sends when the area name matches nothing", async () => {
      const results = await getSendsForUserPage(
        db,
        "test-user-10",
        {
          ...ALL_SENDS_FILTER,
          areaName: "NoSuchAreaNameAtAll",
        },
        0,
      );
      expect(results).toEqual({ sends: [], hasMore: false });
    });
  });

  describe("sort", () => {
    beforeEach(seedSortSends);

    it("defaults to newest send first", async () => {
      const results = await getSendsForUserPage(db, "test-user-11", ALL_SENDS_FILTER, 0);
      expect(results.sends.map((s) => s.climbName)).toEqual([
        "Test Highball",
        "Test Crimper",
        "Test Slab",
        "Test Crack",
      ]);
    });

    it("sorts oldest first, with an unknown date last", async () => {
      const results = await getSendsForUserPage(
        db,
        "test-user-11",
        { ...ALL_SENDS_FILTER, sort: "date_asc" },
        0,
      );
      expect(results.sends.map((s) => s.climbName)).toEqual([
        "Test Slab",
        "Test Crimper",
        "Test Highball",
        "Test Crack",
      ]);
    });

    it("sorts hardest grade first", async () => {
      const results = await getSendsForUserPage(
        db,
        "test-user-11",
        { ...ALL_SENDS_FILTER, sort: "grade_desc" },
        0,
      );
      expect(results.sends.map((s) => s.climbName)).toEqual([
        "Test Crimper",
        "Test Crack",
        "Test Highball",
        "Test Slab",
      ]);
    });

    it("sorts easiest grade first", async () => {
      const results = await getSendsForUserPage(
        db,
        "test-user-11",
        { ...ALL_SENDS_FILTER, sort: "grade_asc" },
        0,
      );
      expect(results.sends.map((s) => s.climbName)).toEqual([
        "Test Slab",
        "Test Highball",
        "Test Crack",
        "Test Crimper",
      ]);
    });

    it("sorts highest rated first, with an unrated send last", async () => {
      const results = await getSendsForUserPage(
        db,
        "test-user-11",
        { ...ALL_SENDS_FILTER, sort: "rating_desc" },
        0,
      );
      expect(results.sends.map((s) => s.climbName)).toEqual([
        "Test Highball",
        "Test Slab",
        "Test Crack",
        "Test Crimper",
      ]);
    });

    it("sorts lowest rated first, with an unrated send last", async () => {
      const results = await getSendsForUserPage(
        db,
        "test-user-11",
        { ...ALL_SENDS_FILTER, sort: "rating_asc" },
        0,
      );
      expect(results.sends.map((s) => s.climbName)).toEqual([
        "Test Crack",
        "Test Slab",
        "Test Highball",
        "Test Crimper",
      ]);
    });
  });
});

describe("getUserSendsSummary", () => {
  it("summarizes send count, distinct areas, and peak grade in the most-logged discipline", async () => {
    expect(await getUserSendsSummary(db, "test-user-1")).toEqual({
      sendCount: 2,
      areaCount: 2,
      peakGrade: "V4",
      mostLoggedDiscipline: { type: "boulder", count: 2 },
      latestSendDate: "2026-03-01",
    });
  });

  it("returns zeroed/null stats for a user with no sends", async () => {
    await seedFixtureUser(db, { id: "test-user-6", name: "Also No Sends" });
    expect(await getUserSendsSummary(db, "test-user-6")).toEqual({
      sendCount: 0,
      areaCount: 0,
      peakGrade: null,
      mostLoggedDiscipline: null,
      latestSendDate: null,
    });
  });
});

describe("getUserSentClimbIds", () => {
  it("returns every climb id the user has sent", async () => {
    const ids = await getUserSentClimbIds(db, "test-user-1");
    expect(ids).toEqual(new Set([1, 2]));
  });

  it("only includes the given user's own sends", async () => {
    const ids = await getUserSentClimbIds(db, "test-user-2");
    expect(ids).toEqual(new Set([1]));
  });

  it("returns an empty set for a user with no sends", async () => {
    await seedFixtureUser(db, { id: "test-user-4", name: "Still No Sends" });
    const ids = await getUserSentClimbIds(db, "test-user-4");
    expect(ids).toEqual(new Set());
  });

  it("scopes to more ids than D1 allows bound parameters", async () => {
    // Keep the scoped helper safe for batches beyond D1's 100-parameter
    // statement cap by sending the ids as one JSON binding.
    const manyIds = Array.from({ length: 400 }, (_, index) => index + 1);
    expect(await getUserSentClimbIds(db, "test-user-1", manyIds)).toEqual(new Set([1, 2]));
  });

  it("can scope the lookup to only the visible climb ids", async () => {
    expect(await getUserSentClimbIds(db, "test-user-1", [2, 3])).toEqual(new Set([2]));
    expect(await getUserSentClimbIds(db, "test-user-1", [])).toEqual(new Set());
  });
});

describe("getClimbSendStats", () => {
  beforeEach(async () => {
    await seedMultiDiscipline();
    await seedNameSends();
    await seedSortSends();
  });
  it("averages ratings (ignoring nulls) and counts every send for a climb", async () => {
    // The per-test fixture has five sends: ratings 4 and 5, the rest null.
    const stats = await getClimbSendStats(db, [1]);
    expect(stats[1]).toEqual({ avgRating: 4.5, sendCount: 5, avgSuggestedGrade: null });
  });

  it("returns a null average when no send on the climb has a rating", async () => {
    // Test Crimper (climb 3) has three sends in this fixture, all with no rating.
    const stats = await getClimbSendStats(db, [3]);
    expect(stats[3]).toEqual({ avgRating: null, sendCount: 3, avgSuggestedGrade: null });
  });

  it("includes zero-send climbs in the requested ids rather than omitting them", async () => {
    // Id 999 doesn't match any send in this test file.
    const stats = await getClimbSendStats(db, [999]);
    expect(stats[999]).toEqual({ avgRating: null, sendCount: 0, avgSuggestedGrade: null });
  });

  it("returns an empty map for an empty id list, without querying", async () => {
    expect(await getClimbSendStats(db, [])).toEqual({});
  });

  it("handles an id batch larger than D1's bound-parameter cap", async () => {
    const ids = Array.from({ length: 200 }, (_, index) => index + 1);
    const stats = await getClimbSendStats(db, ids);
    expect(Object.keys(stats)).toHaveLength(200);
    expect(stats[1]?.sendCount).toBeGreaterThan(0);
    expect(stats[200]).toEqual({
      avgRating: null,
      sendCount: 0,
      avgSuggestedGrade: null,
    });
  });

  it("averages non-null suggested grades independently of rating", async () => {
    await seedFixtureUser(db, { id: "test-user-7", name: "Grade Suggester" });
    await seedFixtureUser(db, { id: "test-user-8", name: "Grade Suggester Two" });
    // Test Crimper (climb 3) already has three sends from the per-test fixture, with no suggested grade.
    await seedFixtureSend(db, {
      userId: "test-user-7",
      climbId: 3,
      dateSent: "2026-01-01",
      suggestedGrade: 8,
    });
    await seedFixtureSend(db, {
      userId: "test-user-8",
      climbId: 3,
      dateSent: "2026-01-02",
      suggestedGrade: 10,
    });

    const stats = await getClimbSendStats(db, [3]);
    expect(stats[3]).toEqual({ avgRating: null, sendCount: 5, avgSuggestedGrade: 9 });
  });

  it("returns a null suggested-grade average when sends are rated but not grade-suggested", async () => {
    await seedFixtureUser(db, { id: "test-user-9", name: "Rater Only" });
    // Test Slab (climb 2) already has a null-rating send and a rating-3
    // send from the per-test fixture; add a rating-5 send with no
    // suggested grade to confirm the two aggregates are computed
    // independently.
    await seedFixtureSend(db, {
      userId: "test-user-9",
      climbId: 2,
      dateSent: "2026-04-01",
      rating: 5,
    });

    const stats = await getClimbSendStats(db, [2]);
    expect(stats[2]).toEqual({ avgRating: 4, sendCount: 3, avgSuggestedGrade: null });
  });

  it("weighs a high gradeFeel by +0.3 when averaging suggested grades", async () => {
    await seedFixtureUser(db, { id: "test-user-14", name: "High End" });
    // Test Crack (climb 4) already has one send with no suggested grade
    // from this describe's per-test fixture, which does not count toward this
    // average either way. A plain (unweighted) average of the one
    // suggested grade added here would be exactly 4; a "high" gradeFeel
    // should instead land on 4.3, proving the offset is actually applied
    // rather than the CASE expression silently being a no-op.
    await seedFixtureSend(db, {
      userId: "test-user-14",
      climbId: 4,
      dateSent: "2026-08-01",
      suggestedGrade: 4,
      gradeFeel: "high",
    });

    const stats = await getClimbSendStats(db, [4]);
    expect(stats[4].sendCount).toBe(2);
    expect(stats[4].avgSuggestedGrade).toBeCloseTo(4.3, 5);
  });

  it("weighs a low gradeFeel by -0.3 when averaging suggested grades", async () => {
    await seedFixtureUser(db, { id: "test-user-15", name: "Low End" });
    // The local fixture has one unrated send; the new low suggestion is 3.7.
    await seedFixtureSend(db, {
      userId: "test-user-15",
      climbId: 4,
      dateSent: "2026-08-02",
      suggestedGrade: 4,
      gradeFeel: "low",
    });

    const stats = await getClimbSendStats(db, [4]);
    expect(stats[4].sendCount).toBe(2);
    expect(stats[4].avgSuggestedGrade).toBeCloseTo(3.7, 5);
  });
});

describe("getSendsForUserPage ascentStyles/minRating filtering", () => {
  beforeEach(async () => {
    await seedFixtureUser(db, { id: "test-user-12", name: "Style Rating Tester" });
    await seedFixtureSend(db, {
      userId: "test-user-12",
      climbId: 1, // Test Highball
      dateSent: "2026-07-01",
      ascentStyle: "flash",
      rating: 5,
    });
    await seedFixtureSend(db, {
      userId: "test-user-12",
      climbId: 2, // Test Slab
      dateSent: "2026-07-02",
      ascentStyle: "redpoint",
      rating: 2,
    });
    await seedFixtureSend(db, {
      userId: "test-user-12",
      climbId: 3, // Test Crimper
      dateSent: "2026-07-03",
      ascentStyle: "onsight",
      // no rating
    });
  });

  it("returns every ascent style when none are selected (unfiltered, not empty)", async () => {
    const results = await getSendsForUserPage(db, "test-user-12", ALL_SENDS_FILTER, 0);
    expect(results.sends.map((s) => s.climbName).sort()).toEqual([
      "Test Crimper",
      "Test Highball",
      "Test Slab",
    ]);
  });

  it("filters down to a single selected ascent style", async () => {
    const results = await getSendsForUserPage(
      db,
      "test-user-12",
      { ...ALL_SENDS_FILTER, ascentStyles: ["flash"] },
      0,
    );
    expect(results.sends.map((s) => s.climbName)).toEqual(["Test Highball"]);
  });

  it("filters by multiple selected ascent styles", async () => {
    const results = await getSendsForUserPage(
      db,
      "test-user-12",
      { ...ALL_SENDS_FILTER, ascentStyles: ["flash", "onsight"] },
      0,
    );
    expect(results.sends.map((s) => s.climbName).sort()).toEqual(["Test Crimper", "Test Highball"]);
  });

  it("filters by a minimum rating, excluding unrated sends", async () => {
    const results = await getSendsForUserPage(
      db,
      "test-user-12",
      { ...ALL_SENDS_FILTER, minRating: 3 },
      0,
    );
    expect(results.sends.map((s) => s.climbName)).toEqual(["Test Highball"]);
  });

  it("combines ascent-style and minimum-rating filters", async () => {
    const results = await getSendsForUserPage(
      db,
      "test-user-12",
      { ...ALL_SENDS_FILTER, ascentStyles: ["redpoint", "onsight"], minRating: 1 },
      0,
    );
    expect(results.sends.map((s) => s.climbName)).toEqual(["Test Slab"]);
  });
});

// Regression coverage for OFFSET pagination over ties: none of the sortable
// columns (date/grade/rating) is unique, so without the `sends.id`
// tie-breaker in the ORDER BY, sends sharing the sorted value have no
// defined relative order and can duplicate or vanish across pages. Placed
// near the end of the file for the same fixture-history reason as the
// describe above — this seeds more sends on climbs 1-3. Only the
// climb-sends describes below (which seed their own climb) run after this.
describe("getSendsForUserPage tie-breaking across pages", () => {
  beforeEach(async () => {
    await seedFixtureUser(db, { id: "test-user-17", name: "Tie Breaker" });
    // Three sends sharing the same dateSent (and no rating) — under the
    // default date_desc sort, only the sends.id tie-breaker orders them.
    for (const climbId of [1, 2, 3]) {
      await seedFixtureSend(db, {
        userId: "test-user-17",
        climbId,
        dateSent: "2026-08-15",
      });
    }
  });

  it("pages over sends sharing a date without duplicating or skipping any", async () => {
    const pagedIds: number[] = [];
    let offset = 0;
    let hasMore = true;
    while (hasMore) {
      const page = await getSendsForUserPage(db, "test-user-17", ALL_SENDS_FILTER, offset, 1);
      pagedIds.push(...page.sends.map((s) => s.id));
      offset += page.sends.length;
      hasMore = page.hasMore;
    }

    // One oversized page as the reference set for what paging must cover.
    const allIds = (
      await getSendsForUserPage(db, "test-user-17", ALL_SENDS_FILTER, 0, 100)
    ).sends.map((s) => s.id);
    expect(pagedIds.length).toBe(3);
    expect(new Set(pagedIds).size).toBe(3);
    expect(new Set(pagedIds)).toEqual(new Set(allIds));
    expect(pagedIds).toEqual([...pagedIds].sort((a, b) => b - a));
  });
});

// Both describes below seed sends only on their own freshly inserted climb,
// so they can't disturb the cumulative per-climb counts asserted "by this
// point" anywhere above. Nothing runs after these.
describe("getSendsForClimb tie-breaking across pages", () => {
  const CLIMB_ID = 50;

  beforeEach(async () => {
    await db.insert(climbs).values({
      id: CLIMB_ID,
      areaId: 3, // Test Sport Wall
      name: "Test Tie Break Route",
      type: "sport",
      grade: 8,
    });
    // Three sends sharing the same dateSent — under the newest-first order,
    // only the sends.id tie-breaker gives them a defined relative order.
    for (let i = 1; i <= 3; i += 1) {
      await seedFixtureUser(db, { id: `test-user-climb-ties-${i}`, name: `Climb Ties ${i}` });
      await seedFixtureSend(db, {
        userId: `test-user-climb-ties-${i}`,
        climbId: CLIMB_ID,
        dateSent: "2026-08-20",
      });
    }
  });

  it("pages over sends sharing a date without duplicating or skipping any", async () => {
    const pagedIds: number[] = [];
    let offset = 0;
    let hasMore = true;
    while (hasMore) {
      const page = await getSendsForClimb(db, CLIMB_ID, offset, 1);
      pagedIds.push(...page.sends.map((s) => s.id));
      offset += page.sends.length;
      hasMore = page.hasMore;
    }

    expect(pagedIds.length).toBe(3);
    expect(new Set(pagedIds).size).toBe(3);
    // Within the tied date, order is the deterministic sends.id ascending.
    expect(pagedIds).toEqual([...pagedIds].sort((a, b) => a - b));
  });
});

describe("getClimbSendSummary", () => {
  const CLIMB_ID = 51;

  beforeEach(async () => {
    await db.insert(climbs).values({
      id: CLIMB_ID,
      areaId: 3, // Test Sport Wall
      name: "Test Summary Route",
      type: "sport",
      grade: 9,
    });
    await seedFixtureUser(db, { id: "test-user-summary-1", name: "Summary One" });
    await seedFixtureUser(db, { id: "test-user-summary-2", name: "Summary Two" });
    await seedFixtureUser(db, { id: "test-user-summary-3", name: "Summary Three" });
    await seedFixtureSend(db, {
      userId: "test-user-summary-1",
      climbId: CLIMB_ID,
      dateSent: "2026-08-01",
      ascentStyle: "flash",
      rating: 4,
      suggestedGrade: 9,
    });
    await seedFixtureSend(db, {
      userId: "test-user-summary-2",
      climbId: CLIMB_ID,
      dateSent: "2026-08-02",
      ascentStyle: "redpoint",
      rating: 2,
    });
    await seedFixtureSend(db, {
      userId: "test-user-summary-3",
      climbId: CLIMB_ID,
      dateSent: "2026-08-03",
      ascentStyle: "flash",
      suggestedGrade: 9,
      gradeFeel: "high",
    });
  });

  it("aggregates the whole history: count, rating, suggested grade, and style breakdown", async () => {
    const summary = await getClimbSendSummary(db, CLIMB_ID);
    expect(summary.sendCount).toBe(3);
    expect(summary.avgRating).toBe(3); // (4 + 2) / 2, nulls ignored
    expect(summary.avgSuggestedGrade).toBeCloseTo(9.15, 5); // (9 + 9.3) / 2
    expect(summary.styleBreakdown).toEqual({
      flash: 2,
      redpoint: 1,
      onsight: 0,
    });
  });

  it("returns zeroed/null stats for a climb with no sends", async () => {
    expect(await getClimbSendSummary(db, 999_999)).toEqual({
      sendCount: 0,
      avgRating: null,
      avgSuggestedGrade: null,
      styleBreakdown: { flash: 0, redpoint: 0, onsight: 0 },
      suggestedGradeCounts: [],
    });
  });
});

describe("getSendsForUserExportPage", () => {
  const userId = "test-user-export";

  // Both tests below need this history: the paging one to cross the batch
  // boundary, the query-plan one so the planner is choosing against a real,
  // ANALYZEd table rather than an empty one. Seeded here rather than by the
  // first `it` so neither test depends on the other having run.
  beforeEach(async () => {
    const startId = 600_000;
    await seedFixtureUser(db, { id: userId, name: "Large Export" });
    await seedManyClimbs(db, 5, 405, startId);

    const rows = Array.from({ length: 405 }, (_, index) => ({
      userId,
      climbId: startId + index,
      ascentStyle: "redpoint" as const,
      dateSent: index >= 200 ? null : "2026-04-01",
      suggestedGrade: 2,
    }));
    for (let index = 0; index < rows.length; index += 10) {
      await db.insert(sends).values(rows.slice(index, index + 10));
    }
    await db.run(sql`ANALYZE sends`);
  });

  it("keyset-pages a history larger than one export batch without duplicates", async () => {
    const firstPage = await getSendsForUserExportPage(db, userId, null);
    expect(firstPage.sends).toHaveLength(200);
    expect(firstPage.sends.every((send) => send.dateSent !== null)).toBe(true);
    expect(firstPage.sends.map((send) => send.id)).toEqual(
      firstPage.sends.map((send) => send.id).sort((a, b) => b - a),
    );

    const exported: Awaited<ReturnType<typeof getSendsForUserExportPage>>["sends"] = [];
    let cursor: UserSendsExportCursor | null = null;
    let pages = 0;
    do {
      pages += 1;
      expect(pages).toBeLessThanOrEqual(3);
      const page = await getSendsForUserExportPage(db, userId, cursor);
      exported.push(...page.sends);
      cursor = page.nextCursor;
    } while (cursor);

    expect(exported).toHaveLength(405);
    expect(new Set(exported.map((send) => send.id)).size).toBe(405);
    expect(pages).toBe(3);
    expect(exported.map((send) => send.climbId)).toEqual([
      ...Array.from({ length: 200 }, (_, i) => 600199 - i),
      ...Array.from({ length: 205 }, (_, i) => 600404 - i),
    ]);
    expect(exported.slice(200).map((send) => send.dateSent)).toEqual(Array(205).fill(null));
  });

  it("constrains both export cursor phases beyond user_id in the composite index", async () => {
    const datedPlans = await explainQueries(db, () =>
      getSendsForUserExportPage(db, userId, { dateSent: "2026-04-01", id: 999999 }),
    );
    expect(datedPlans).toHaveLength(2);
    const [datedPlan] = datedPlans;
    const undatedPlans = await explainQueries(db, () =>
      getSendsForUserExportPage(db, userId, { dateSent: null, id: 999999 }),
    );
    expect(undatedPlans).toHaveLength(1);
    const [undatedPlan] = undatedPlans;

    const datedDetail = datedPlan.map((row) => row.detail).join("\n");
    const undatedDetail = undatedPlan.map((row) => row.detail).join("\n");

    // `INDEXED BY` already forces this index or raises, so asserting the index
    // NAME proves nothing. What has to hold is the shape of the access: a
    // SEARCH (a seek to the cursor) rather than a SCAN, constrained past
    // user_id by date_sent. Under 0019's original `id ASC` index the row-value
    // range could not be used and this collapsed to `(user_id=?)` — every page
    // re-reading every earlier one, which is the regression 0020 exists to
    // prevent.
    expect(datedDetail).toContain("SEARCH");
    expect(datedDetail).toContain("date_sent<?");
    expect(undatedDetail).toContain("SEARCH");
    expect(undatedDetail).toContain("date_sent=? AND id<?");

    // The index has to satisfy the ORDER BY outright. A temp b-tree here means
    // it sorted the whole matched range per page — silent, and exactly the
    // failure 0018's comment warns descending indexes fail with.
    expect(datedDetail).not.toContain("TEMP B-TREE");
    expect(undatedDetail).not.toContain("TEMP B-TREE");
  });
});

// A dedicated climb isolates this privacy scenario from the base sends.
describe("getSendsForClimb private-user filtering", () => {
  const PRIVATE_CLIMB_ID = 1000;

  beforeEach(async () => {
    await seedManyClimbs(db, 3, 1, PRIVATE_CLIMB_ID);
    await seedFixtureUser(db, { id: "private-user", name: "Private Climber", isPrivate: true });
    await seedFixtureUser(db, { id: "public-user", name: "Public Climber" });
    await seedFixtureSend(db, {
      userId: "private-user",
      climbId: PRIVATE_CLIMB_ID,
      dateSent: "2026-05-02",
      rating: 5,
      suggestedGrade: 3,
    });
    await seedFixtureSend(db, {
      userId: "public-user",
      climbId: PRIVATE_CLIMB_ID,
      dateSent: "2026-05-01",
      rating: 3,
    });
  });

  it("excludes a private user's send when there's no viewer", async () => {
    const { sends: rows } = await getSendsForClimb(db, PRIVATE_CLIMB_ID);
    expect(rows.map((s) => s.userName)).toEqual(["Public Climber"]);
  });

  it("excludes a private user's send from a different signed-in viewer", async () => {
    const { sends: rows } = await getSendsForClimb(db, PRIVATE_CLIMB_ID, 0, 10, "public-user");
    expect(rows.map((s) => s.userName)).toEqual(["Public Climber"]);
  });

  it("includes a private user's own send when they are the viewer", async () => {
    const { sends: rows } = await getSendsForClimb(db, PRIVATE_CLIMB_ID, 0, 10, "private-user");
    // Newest dateSent first: the private user's send (05-02) sorts ahead of
    // the public user's (05-01).
    expect(rows.map((s) => s.userName)).toEqual(["Private Climber", "Public Climber"]);
  });

  it("still counts the private user's send toward the climb's rating and suggested grade", async () => {
    // getClimbSendStats never joins `user`, so the private flag can't reach
    // it — this is the regression guard for that invariant.
    const stats = await getClimbSendStats(db, [PRIVATE_CLIMB_ID]);
    expect(stats[PRIVATE_CLIMB_ID]).toEqual({ avgRating: 4, sendCount: 2, avgSuggestedGrade: 3 });
  });
});
