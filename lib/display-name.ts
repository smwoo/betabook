/** Display-name rules shared by the sign-up hook (lib/auth.ts), the rename
 * action (actions/account.ts), and the forms that collect the value. Pure —
 * client components import MAX_DISPLAY_NAME_LENGTH for their inputs, so
 * nothing here may touch the db or auth stack. */

export const MAX_DISPLAY_NAME_LENGTH = 100;

export const DISPLAY_NAME_TAKEN_MESSAGE = "That display name is already taken — pick another.";

/** The user-facing problem with an already-trimmed display name, or null if
 * it's acceptable. Callers wrap the message in their boundary's error type
 * (ActionError in actions, APIError in better-auth hooks). */
export function displayNameProblem(name: string): string | null {
  if (!name) return "Display name is required";
  if (name.length > MAX_DISPLAY_NAME_LENGTH) {
    return `Display name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer`;
  }
  return null;
}
