import { and, eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { getUserIdByName } from "@/db/queries";
import { changeRequests, sends } from "@/db/schema";
import { MAX_DISPLAY_NAME_LENGTH } from "@/lib/display-name";

/** Finds a free display name starting from `base`, for account-creation
 * paths that must not fail on a collision: OAuth sign-in arrives with
 * whatever name Google supplies, and rejecting it would block the sign-in
 * itself — unlike the email form, where the user can just pick again.
 * Numeric suffixes keep the result recognizable; the random fallback exists
 * only so this terminates even if someone squats "Name 2"–"Name 99". */
export async function uniqueDisplayName(db: Database, base: string): Promise<string> {
  const trimmed = base.trim().slice(0, MAX_DISPLAY_NAME_LENGTH).trim() || "Climber";
  if (!(await getUserIdByName(db, trimmed))) return trimmed;
  for (let n = 2; n <= 99; n += 1) {
    const candidate = `${trimmed.slice(0, MAX_DISPLAY_NAME_LENGTH - 3)} ${n}`;
    if (!(await getUserIdByName(db, candidate))) return candidate;
  }
  return `${trimmed.slice(0, MAX_DISPLAY_NAME_LENGTH - 9)} ${crypto.randomUUID().slice(0, 8)}`;
}

/** Deletes every send belonging to a user, ahead of deleting the user row
 * itself in better-auth's `deleteUser` flow. D1 doesn't fire a table's AFTER
 * DELETE trigger for rows removed via ON DELETE CASCADE (see
 * drizzle/migrations/0014_sends_aggregate_triggers.sql), so letting
 * sends.userId's cascade from `user` do this would silently leave
 * climbs.send_count/rating_sum/rating_count inflated forever. Deleting sends
 * explicitly here, before the user row goes, lets sends_aggregates_ad fire
 * per row and keep those aggregates correct. */
export async function deleteAccountSends(db: Database, userId: string): Promise<void> {
  await db.delete(sends).where(eq(sends.userId, userId));
}

/** Deletes the user's *pending* change requests ahead of the user row —
 * nobody is left to hear a decision on them. Decided rows deliberately
 * survive: requested_by is a set-null FK (see drizzle/schema/moderation.ts),
 * so the audit trail of applied structural changes outlives the account. */
export async function deleteAccountPendingChangeRequests(
  db: Database,
  userId: string,
): Promise<void> {
  await db
    .delete(changeRequests)
    .where(and(eq(changeRequests.requestedBy, userId), eq(changeRequests.status, "pending")));
}
