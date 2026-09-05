import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { createDb } from "@/db/client";
import { changeRequests, climbs, sends, user } from "@/db/schema";
import {
  deleteAccountPendingChangeRequests,
  deleteAccountSends,
  uniqueDisplayName,
} from "@/lib/account";
import { seedFixtureSend, seedFixtureTree, seedFixtureUser } from "@/test/fixtures";
import { resetDb } from "@/test/reset-db";

const db = createDb(env.DB);

beforeEach(async () => {
  await resetDb(db);
  await seedFixtureTree(db);
  await seedFixtureUser(db, { id: "account-test-user-a" });
  await seedFixtureUser(db, { id: "account-test-user-b" });
  // Climb 1 (Test Highball) gets a send from each user, so deleting one
  // account's sends can be checked against the other's surviving untouched.
  await seedFixtureSend(db, {
    userId: "account-test-user-a",
    climbId: 1,
    dateSent: "2026-01-01",
    rating: 4,
  });
  await seedFixtureSend(db, {
    userId: "account-test-user-b",
    climbId: 1,
    dateSent: "2026-01-02",
    rating: 5,
  });
});

describe("deleteAccountSends", () => {
  it("deletes only the given user's sends, letting the aggregate triggers fire", async () => {
    const before = await db.select().from(climbs).where(eq(climbs.id, 1)).get();
    expect(before?.sendCount).toBe(2);
    expect(before?.ratingSum).toBe(9);
    expect(before?.ratingCount).toBe(2);

    await deleteAccountSends(db, "account-test-user-a");

    const aSends = await db
      .select()
      .from(sends)
      .where(eq(sends.userId, "account-test-user-a"))
      .all();
    expect(aSends).toHaveLength(0);

    const bSend = await db
      .select()
      .from(sends)
      .where(eq(sends.userId, "account-test-user-b"))
      .get();
    expect(bSend).toBeDefined();

    // Only user-a's row is gone, so sends_aggregates_ad should have run once
    // (not cascaded away silently) and left user-b's contribution intact.
    const after = await db.select().from(climbs).where(eq(climbs.id, 1)).get();
    expect(after?.sendCount).toBe(1);
    expect(after?.ratingSum).toBe(5);
    expect(after?.ratingCount).toBe(1);
  });

  it("is a no-op for a user with no sends", async () => {
    await seedFixtureUser(db, { id: "empty-account" });
    const before = await db.select().from(sends).orderBy(sends.id);
    expect(before).toHaveLength(2);
    await expect(deleteAccountSends(db, "empty-account")).resolves.toBeUndefined();
    expect(await db.select().from(sends).orderBy(sends.id)).toEqual(before);
  });
});

describe("deleteAccountPendingChangeRequests", () => {
  it("deletes the user's pending requests and keeps the decided audit trail", async () => {
    await seedFixtureUser(db, { id: "account-requests-user" });
    await db.insert(changeRequests).values([
      {
        id: 701,
        type: "area_edit",
        entityId: 1,
        payload: "{}",
        requestedBy: "account-requests-user",
      },
      {
        id: 702,
        type: "climb_edit",
        entityId: 1,
        payload: "{}",
        requestedBy: "account-requests-user",
        status: "approved",
      },
    ]);

    await db.insert(changeRequests).values({
      id: 703,
      type: "area_edit",
      entityId: 1,
      payload: "{}",
      requestedBy: "account-test-user-b",
    });
    const otherBefore = await db
      .select()
      .from(changeRequests)
      .where(eq(changeRequests.id, 703))
      .get();
    await deleteAccountPendingChangeRequests(db, "account-requests-user");
    expect(await db.select().from(changeRequests).where(eq(changeRequests.id, 703)).get()).toEqual(
      otherBefore,
    );

    expect(
      await db.select().from(changeRequests).where(eq(changeRequests.id, 701)).get(),
    ).toBeUndefined();
    expect(
      (await db.select().from(changeRequests).where(eq(changeRequests.id, 702)).get())?.status,
    ).toBe("approved");

    // Deleting the user row itself then nulls (not cascades) the decided
    // row's requester — the audit trail of applied changes outlives the
    // account.
    await db.delete(user).where(eq(user.id, "account-requests-user"));
    const decided = await db.select().from(changeRequests).where(eq(changeRequests.id, 702)).get();
    expect(decided).toBeDefined();
    expect(decided?.requestedBy).toBeNull();
  });
});

describe("uniqueDisplayName", () => {
  it("returns the trimmed base when nobody holds it", async () => {
    expect(await uniqueDisplayName(db, "  Fresh OAuth Name  ")).toBe("Fresh OAuth Name");
  });

  it("suffixes past a taken name, matching case-insensitively", async () => {
    await seedFixtureUser(db, { id: "account-test-user-c", name: "Google Person" });
    expect(await uniqueDisplayName(db, "google person")).toBe("google person 2");
  });

  it("skips suffixes that are themselves taken", async () => {
    await seedFixtureUser(db, { id: "account-test-user-c", name: "Google Person" });
    await seedFixtureUser(db, { id: "account-test-user-d", name: "Google Person 2" });
    expect(await uniqueDisplayName(db, "Google Person")).toBe("Google Person 3");
  });

  it("falls back to a default for a blank name", async () => {
    expect(await uniqueDisplayName(db, "   ")).toBe("Climber");
  });
});
