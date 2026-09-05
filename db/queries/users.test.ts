import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { createDb, type Database } from "@/db/client";
import { seedFixtureUser } from "@/test/fixtures";

import { getUser, getUserIdByName } from "./users";

let db: Database;

beforeAll(async () => {
  db = createDb(env.DB);
  await seedFixtureUser(db, { id: "test-user-1", name: "Alice Climber" });
});

describe("getUser", () => {
  it("returns the user for a known id", async () => {
    const user = await getUser(db, "test-user-1");
    expect(user?.name).toBe("Alice Climber");
  });

  it("returns undefined for an unknown id", async () => {
    const user = await getUser(db, "no-such-user");
    expect(user).toBeUndefined();
  });
});

describe("getUserIdByName", () => {
  it("matches case-insensitively, agreeing with user_name_unique_idx", async () => {
    expect(await getUserIdByName(db, "ALICE climber")).toBe("test-user-1");
  });

  it("returns null when nobody holds the name", async () => {
    expect(await getUserIdByName(db, "Nobody Here")).toBeNull();
  });
});

describe("user_name_unique_idx (migration 0033)", () => {
  it("rejects a second user whose name differs only in case", async () => {
    await expect(seedFixtureUser(db, { id: "test-user-2", name: "alice climber" })).rejects.toThrow(
      /UNIQUE|Failed query/i,
    );
  });
});
