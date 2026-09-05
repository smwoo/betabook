"use server";

import { eq } from "drizzle-orm";
import { refresh, revalidatePath } from "next/cache";

import { getDb } from "@/db/client";
import { getUserIdByName } from "@/db/queries";
import { user } from "@/db/schema";
import { ActionError, toActionResult, type ActionResult } from "@/lib/action-result";
import { DISPLAY_NAME_TAKEN_MESSAGE, displayNameProblem } from "@/lib/display-name";
import { parseJournalVisibility } from "@/lib/journal";
import { requireSession } from "@/lib/session";

function revalidateProfileSurfaces(userId: string) {
  revalidatePath(`/users/${userId}`);
  revalidatePath(`/users/${userId}/journal`);
  revalidatePath(`/users/${userId}/sends`);
  revalidatePath(`/users/${userId}/projects`);
  revalidatePath(`/users/${userId}/analytics`);
}

/** Toggles whether the signed-in user's profile and sends are hidden from
 * everyone but themselves (see lib/user-visibility.ts). Only the two profile
 * pages are revalidated here — a toggle doesn't fan out to every climb page
 * the user has ever sent, which for an active climber can run into the
 * thousands; those pick up the change on their own next revalidation, the
 * same eventual-consistency window every other cached page already accepts. */
export async function setUserPrivate(isPrivate: boolean): Promise<ActionResult> {
  return toActionResult(async () => {
    const session = await requireSession();
    const db = await getDb();

    await db.update(user).set({ isPrivate }).where(eq(user.id, session.user.id));

    revalidateProfileSurfaces(session.user.id);
    refresh();
  });
}

export async function updateDisplayName(formData: FormData): Promise<ActionResult> {
  return toActionResult(async () => {
    const session = await requireSession();
    const db = await getDb();

    const raw = formData.get("name");
    const name = typeof raw === "string" ? raw.trim() : "";
    const problem = displayNameProblem(name);
    if (problem) throw new ActionError(problem);

    // Friendly pre-check; a same-instant race falls through to
    // user_name_unique_idx and comes back as the generic error instead.
    const holder = await getUserIdByName(db, name);
    if (holder && holder !== session.user.id) throw new ActionError(DISPLAY_NAME_TAKEN_MESSAGE);

    await db.update(user).set({ name }).where(eq(user.id, session.user.id));

    // The name also shows in send histories on climb pages, but those render
    // from the db per-request — only the profile surfaces are cached under
    // the old name.
    revalidateProfileSurfaces(session.user.id);
    refresh();
  });
}

export async function setJournalVisibility(visibility: string): Promise<ActionResult> {
  return toActionResult(async () => {
    const session = await requireSession();
    const db = await getDb();
    const journalVisibility = parseJournalVisibility(visibility);

    await db.update(user).set({ journalVisibility }).where(eq(user.id, session.user.id));

    revalidateProfileSurfaces(session.user.id);
    refresh();
  });
}
