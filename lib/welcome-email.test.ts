import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createDb, type Database } from "@/db/client";
import { user } from "@/db/schema";
import { sendWelcomeEmail } from "@/lib/email";
import { sendWelcomeEmailOnce } from "@/lib/welcome-email";
import { seedFixtureUser } from "@/test/fixtures";

/** The guard is the point of this module: verification can reach the hook
 * more than once per account (a later change-email verification goes through
 * the same path), and welcome_email_sent_at is the only thing standing between
 * that and a duplicate. */

// Reaching for getCloudflareContext outside a request. Stub the decision —
// whether an email went out — not the Resend client.
vi.mock("@/lib/email", () => ({ sendWelcomeEmail: vi.fn<() => Promise<void>>(async () => {}) }));

let db: Database;

beforeAll(() => {
  db = createDb(env.DB);
});

beforeEach(() => {
  vi.mocked(sendWelcomeEmail).mockResolvedValue(undefined);
  vi.clearAllMocks();
});

async function stampFor(id: string) {
  const row = await db
    .select({ welcomeEmailSentAt: user.welcomeEmailSentAt })
    .from(user)
    .where(eq(user.id, id))
    .get();
  return row?.welcomeEmailSentAt ?? null;
}

describe("sendWelcomeEmailOnce", () => {
  it("sends the email and stamps the account", async () => {
    const account = await seedFixtureUser(db, { id: "welcome-first", name: "Ada" });

    await sendWelcomeEmailOnce(db, account);

    expect(sendWelcomeEmail).toHaveBeenCalledExactlyOnceWith(account.email, "Ada");
    expect(await stampFor(account.id)).toBeInstanceOf(Date);
  });

  it("claims a welcome once when verification callbacks race", async () => {
    const account = await seedFixtureUser(db, { id: "welcome-concurrent", name: "Grace" });
    await Promise.all([
      sendWelcomeEmailOnce(db, account),
      sendWelcomeEmailOnce(db, account),
      sendWelcomeEmailOnce(db, account),
    ]);
    expect(sendWelcomeEmail).toHaveBeenCalledExactlyOnceWith(account.email, "Grace");
    expect(await stampFor(account.id)).toBeInstanceOf(Date);
  });

  it("sends nothing the second time — the change-email case", async () => {
    const account = await seedFixtureUser(db, { id: "welcome-twice" });

    await sendWelcomeEmailOnce(db, account);
    const stamped = await stampFor(account.id);
    vi.clearAllMocks();

    await sendWelcomeEmailOnce(db, account);

    expect(sendWelcomeEmail).not.toHaveBeenCalled();
    // The claim is not refreshed either, so the stamp still says when the one
    // email that exists actually went out.
    expect(await stampFor(account.id)).toEqual(stamped);
  });

  it("never re-sends to an account the migration backfilled", async () => {
    const account = await seedFixtureUser(db, {
      id: "welcome-backfilled",
      emailVerified: true,
      welcomeEmailSentAt: new Date(1_700_000_000_000),
    });

    await sendWelcomeEmailOnce(db, account);

    expect(sendWelcomeEmail).not.toHaveBeenCalled();
  });

  it("keeps the claim when Resend rejects the send", async () => {
    // Claim-then-send means a failure costs this account its welcome email
    // rather than risking a duplicate. Pinned because it's a deliberate
    // trade, not an accident: nothing here retries.
    vi.mocked(sendWelcomeEmail).mockRejectedValue(new Error("Resend is down"));
    const account = await seedFixtureUser(db, { id: "welcome-failed" });

    await expect(sendWelcomeEmailOnce(db, account)).rejects.toThrow("Resend is down");

    expect(await stampFor(account.id)).toBeInstanceOf(Date);
  });

  it("welcomes an OAuth user registered with a profile image and verified email", async () => {
    const account = await seedFixtureUser(db, {
      id: "welcome-oauth",
      name: "Google Climber",
      image: "https://lh3.googleusercontent.com/a/avatar",
      emailVerified: true,
    });

    const userRow = await db.select().from(user).where(eq(user.id, account.id)).get();
    expect(userRow?.image).toBe("https://lh3.googleusercontent.com/a/avatar");

    await sendWelcomeEmailOnce(db, account);

    expect(sendWelcomeEmail).toHaveBeenCalledExactlyOnceWith(account.email, "Google Climber");
    expect(await stampFor(account.id)).toBeInstanceOf(Date);
  });
});
