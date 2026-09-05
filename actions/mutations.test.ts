import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createClimb, deleteSend, updateClimb, updateDisplayName, updateSend } from "@/actions";
import { createDb } from "@/db/client";
import { climbs, journalEntries, sends, user } from "@/db/schema";
import { SESSION_EXPIRED_MESSAGE } from "@/lib/action-result";
import { DISPLAY_NAME_TAKEN_MESSAGE } from "@/lib/display-name";
import { seedFixtureSend, seedFixtureTree, seedFixtureUser } from "@/test/fixtures";

/** The action boundary must never throw — Next.js redacts uncaught
 * server-action errors in production, so these tests pin the structured
 * ActionResult contract: user-facing messages come back as { ok: false }. */

const sessionState = vi.hoisted(() => ({ userId: "test-user" as string | null }));

vi.mock("next/cache", () => ({
  refresh: () => {},
  revalidatePath: () => {},
}));

// The real lib/session.ts pulls in next/headers and the whole auth stack,
// neither of which runs outside a Next request — stub the session itself and
// keep throwing the real NotSignedInError so the boundary mapping is
// exercised for real.
vi.mock("@/lib/session", async () => {
  const { NotSignedInError } = await import("@/lib/action-result");
  return {
    getSession: async () => (sessionState.userId ? { user: { id: sessionState.userId } } : null),
    requireSession: async () => {
      if (!sessionState.userId) throw new NotSignedInError();
      return { user: { id: sessionState.userId } };
    },
  };
});

// Point the actions' getDb/getDbAndContext at the test D1 binding instead of
// the OpenNext Cloudflare context (which only exists in a deployed worker).
vi.mock("@/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db/client")>();
  const { env } = await import("cloudflare:test");
  return {
    ...actual,
    getDb: async () => actual.createDb(env.DB),
    getDbAndContext: async () => ({
      db: actual.createDb(env.DB),
      ctx: { waitUntil: () => {} } as unknown as ExecutionContext,
    }),
  };
});

const db = createDb(env.DB);

function sendFormData(overrides: Record<string, string> = {}): FormData {
  const formData = new FormData();
  const fields: Record<string, string> = {
    ascentStyle: "redpoint",
    dateSent: "2026-01-15",
    comment: "",
    rating: "",
    suggestedGrade: "5",
    gradeFeel: "solid",
    ...overrides,
  };
  for (const [key, value] of Object.entries(fields)) formData.set(key, value);
  return formData;
}

// Seeded once for the whole file (matching the other DB suites); each test
// below targets distinct rows so no test depends on another's writes.
// Climb 1 (Test Highball) carries the pre-logged send.
beforeAll(async () => {
  await seedFixtureTree(db);
  await seedFixtureUser(db, { id: "test-user" });
  await seedFixtureUser(db, { id: "other-user" });
  await seedFixtureSend(db, { userId: "test-user", climbId: 1, dateSent: "2026-01-01" });
});

beforeEach(() => {
  sessionState.userId = "test-user";
});

describe("updateSend action boundary", () => {
  // Climb 4 is this describe's alone — re-seeded per test, per the
  // one-test-one-row convention above.
  async function seedSend(dateSent: string | null): Promise<number> {
    await db.delete(sends).where(eq(sends.climbId, 4));
    await db.delete(journalEntries).where(eq(journalEntries.climbId, 4));
    await seedFixtureSend(db, { userId: "test-user", climbId: 4, dateSent });
    const row = await db.select().from(sends).where(eq(sends.climbId, 4)).get();
    return row!.id;
  }

  // drizzle's .set() drops `undefined` keys, so a dateSent gone missing from
  // validateSendInput's result would make this clear a silent no-op.
  it("clears the date on a dated send when the form submits a blank date", async () => {
    const sendId = await seedSend("2026-01-15");

    const result = await updateSend(sendId, sendFormData({ dateSent: "" }));
    expect(result).toEqual({ ok: true, value: undefined });

    const row = await db.select().from(sends).where(eq(sends.id, sendId)).get();
    expect(row?.dateSent).toBeNull();
  });

  it("sets a date on a previously undated send", async () => {
    const sendId = await seedSend(null);

    const result = await updateSend(sendId, sendFormData({ dateSent: "2026-02-20" }));
    expect(result).toEqual({ ok: true, value: undefined });

    const row = await db.select().from(sends).where(eq(sends.id, sendId)).get();
    expect(row?.dateSent).toBe("2026-02-20");
    const entry = await db.select().from(journalEntries).where(eq(journalEntries.climbId, 4)).get();
    expect(entry).toMatchObject({ sent: true, entryDate: "2026-02-20" });
  });

  it("updates a journal-backed send date atomically", async () => {
    const sendId = await seedSend("2026-01-15");
    await db.insert(journalEntries).values({
      userId: "test-user",
      climbId: 4,
      kind: "session",
      sent: true,
      isAscent: true,
      entryDate: "2026-01-15",
    });

    const result = await updateSend(
      sendId,
      sendFormData({ dateSent: "2026-02-20", comment: "Updated note." }),
    );
    expect(result).toEqual({ ok: true, value: undefined });

    expect((await db.select().from(sends).where(eq(sends.id, sendId)).get())?.dateSent).toBe(
      "2026-02-20",
    );
    expect(
      await db.select().from(journalEntries).where(eq(journalEntries.climbId, 4)).get(),
    ).toMatchObject({
      entryDate: "2026-02-20",
      body: "Updated note.",
    });
  });

  it("won't clear the date on a journal-backed send", async () => {
    const sendId = await seedSend("2026-01-15");
    await db.insert(journalEntries).values({
      userId: "test-user",
      climbId: 4,
      kind: "session",
      sent: true,
      isAscent: true,
      entryDate: "2026-01-15",
    });

    expect(await updateSend(sendId, sendFormData({ dateSent: "" }))).toEqual({
      ok: false,
      error: "A send with journal history must keep its date",
    });
    expect((await db.select().from(sends).where(eq(sends.id, sendId)).get())?.dateSent).toBe(
      "2026-01-15",
    );
  });

  it("leaves the rest of the send intact when only the date is cleared", async () => {
    const sendId = await seedSend("2026-01-15");

    const result = await updateSend(
      sendId,
      sendFormData({ dateSent: "", rating: "5", comment: "Classic" }),
    );
    expect(result).toEqual({ ok: true, value: undefined });

    const row = await db.select().from(sends).where(eq(sends.id, sendId)).get();
    expect(row?.dateSent).toBeNull();
    expect(row?.rating).toBe(5);
    expect(row?.comment).toBe("Classic");
    expect(row?.ascentStyle).toBe("redpoint");
  });

  it("rejects a malformed date without touching the stored one", async () => {
    const sendId = await seedSend("2026-01-15");

    const result = await updateSend(sendId, sendFormData({ dateSent: "15/01/2026" }));
    expect(result).toEqual({ ok: false, error: "Invalid send date" });

    const row = await db.select().from(sends).where(eq(sends.id, sendId)).get();
    expect(row?.dateSent).toBe("2026-01-15");
  });
});

describe("deleteSend action boundary", () => {
  it("keeps journal sessions but clears their sent state", async () => {
    await db.delete(journalEntries).where(eq(journalEntries.climbId, 2));
    await db.delete(sends).where(eq(sends.climbId, 2));
    await seedFixtureSend(db, {
      userId: "test-user",
      climbId: 2,
      dateSent: "2026-01-15",
    });
    await db.insert(journalEntries).values([
      {
        userId: "test-user",
        climbId: 2,
        kind: "session",
        sent: true,
        entryDate: "2026-01-15",
      },
      {
        userId: "test-user",
        climbId: 2,
        kind: "session",
        sent: true,
        entryDate: "2026-02-15",
      },
    ]);
    const send = await db.select().from(sends).where(eq(sends.climbId, 2)).get();

    expect((await deleteSend(send!.id)).ok).toBe(true);
    expect(await db.select().from(sends).where(eq(sends.climbId, 2)).get()).toBeUndefined();
    expect(
      (await db.select().from(journalEntries).where(eq(journalEntries.climbId, 2))).map(
        (entry) => entry.sent,
      ),
    ).toEqual([false, false]);
  });
});

describe("updateClimb action boundary", () => {
  it("returns ok:false when the climb doesn't exist", async () => {
    const formData = new FormData();
    formData.set("description", "New description");
    expect(await updateClimb(999, formData)).toEqual({ ok: false, error: "Climb not found" });
  });

  it("updates the description, ignoring any other submitted fields", async () => {
    const formData = new FormData();
    formData.set("name", "Hacked Name");
    formData.set("type", "sport");
    formData.set("grade", "99");
    formData.set("description", "New description");

    expect(await updateClimb(2, formData)).toEqual({ ok: true, value: undefined });

    const row = await db.select().from(climbs).where(eq(climbs.id, 2)).get();
    expect(row?.name).toBe("Test Slab");
    expect(row?.type).toBe("boulder");
    expect(row?.grade).toBe(2);
    expect(row?.description).toBe("New description");
  });

  it("works on a climb with logged sends, since discipline is never touched", async () => {
    const formData = new FormData();
    formData.set("description", "Highball beta");

    expect(await updateClimb(1, formData)).toEqual({ ok: true, value: undefined });

    const row = await db.select().from(climbs).where(eq(climbs.id, 1)).get();
    expect(row?.type).toBe("boulder");
    expect(row?.description).toBe("Highball beta");
  });
});

describe("send ownership", () => {
  it.each(["update", "delete"] as const)(
    "rejects %s of another user's send without changing stored data",
    async (operation) => {
      const original = await db.select().from(sends).where(eq(sends.climbId, 1)).get();
      expect(original?.userId).toBe("test-user");
      const before = await db.select().from(sends).orderBy(sends.id);
      const journalBefore = await db.select().from(journalEntries).orderBy(journalEntries.id);
      sessionState.userId = "other-user";
      const result =
        operation === "update"
          ? await updateSend(original!.id, sendFormData({ comment: "Stolen" }))
          : await deleteSend(original!.id);
      expect(result).toEqual({ ok: false, error: "Send not found" });
      expect(await db.select().from(sends).orderBy(sends.id)).toEqual(before);
      expect(await db.select().from(journalEntries).orderBy(journalEntries.id)).toEqual(
        journalBefore,
      );
    },
  );
});

describe("climb type immutability (DB trigger)", () => {
  it("rejects a raw write that changes the type of a climb with logged sends", async () => {
    const messages: string[] = [];
    try {
      await db.update(climbs).set({ type: "sport" }).where(eq(climbs.id, 1));
    } catch (error) {
      for (let cause: unknown = error; cause instanceof Error; cause = cause.cause)
        messages.push(cause.message);
    }
    expect(messages.join("\n")).toContain("cannot change climb type with logged sends");
    expect((await db.select().from(climbs).where(eq(climbs.id, 1)).get())?.type).toBe("boulder");
  });
});

describe("updateDisplayName action boundary", () => {
  function nameFormData(name: string): FormData {
    const formData = new FormData();
    formData.set("name", name);
    return formData;
  }

  async function currentName(): Promise<string | undefined> {
    const row = await db.select().from(user).where(eq(user.id, "test-user")).get();
    return row?.name;
  }

  beforeAll(async () => {
    await seedFixtureUser(db, { id: "name-holder", name: "Taken Name" });
  });

  it("renames the signed-in user, trimming the input", async () => {
    const result = await updateDisplayName(nameFormData("  Fresh Name  "));
    expect(result).toEqual({ ok: true, value: undefined });
    expect(await currentName()).toBe("Fresh Name");
  });

  it("rejects a name another user holds, case-insensitively", async () => {
    const result = await updateDisplayName(nameFormData("taken NAME"));
    expect(result).toEqual({ ok: false, error: DISPLAY_NAME_TAKEN_MESSAGE });
    expect(await currentName()).not.toBe("taken NAME");
  });

  it("lets a user re-save their own name to change only its case", async () => {
    expect(await updateDisplayName(nameFormData("case test name"))).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await updateDisplayName(nameFormData("Case Test Name"))).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await currentName()).toBe("Case Test Name");
  });

  it("rejects a blank name", async () => {
    expect(await updateDisplayName(nameFormData("   "))).toEqual({
      ok: false,
      error: "Display name is required",
    });
  });

  it("returns the friendly session message when signed out", async () => {
    sessionState.userId = null;
    expect(await updateDisplayName(nameFormData("Whoever"))).toEqual({
      ok: false,
      error: SESSION_EXPIRED_MESSAGE,
    });
  });
});

describe("createClimb action boundary", () => {
  it("returns the new climb id as the ok value", async () => {
    const formData = new FormData();
    formData.set("name", "Boundary Test Climb");
    formData.set("type", "boulder");
    formData.set("grade", "3");
    formData.set("description", "");

    const result = await createClimb(4, formData);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const row = await db.select().from(climbs).where(eq(climbs.id, result.value)).get();
      expect(row?.name).toBe("Boundary Test Climb");
    }
  });

  it("returns ok:false with the validation message on a missing name", async () => {
    const formData = new FormData();
    formData.set("name", "   ");
    formData.set("type", "boulder");
    formData.set("grade", "3");
    formData.set("description", "");

    expect(await createClimb(4, formData)).toEqual({ ok: false, error: "Name is required" });
  });
});
