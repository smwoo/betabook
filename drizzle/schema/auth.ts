import { relations, sql } from "drizzle-orm";
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  // Unique case-insensitively via user_name_unique_idx (COLLATE NOCASE),
  // declared in drizzle/migrations/0033_user_name_unique.sql rather than
  // here — drizzle-kit can't express a collated index. The friendly
  // uniqueness errors live in lib/auth.ts (sign-up) and actions/account.ts
  // (rename); the index is the race-proof backstop.
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).default(false).notNull(),
  image: text("image"),
  // Our own moderation marker, not a better-auth plugin column: null for
  // every ordinary user, "admin" only via scripts/promote-admin.ts. Exposed
  // into session.user through user.additionalFields (lib/auth.ts) so
  // lib/session.ts's requireAdmin()/isAdmin can check for "admin" exactly.
  role: text("role"),
  // Null means "never welcomed", and that is not derivable from
  // emailVerified: better-auth routes a *changed* address through the same
  // afterEmailVerification hook as a first verification, so an established
  // user would get a second "Welcome to Betabook" without this. Claimed by a
  // conditional UPDATE in lib/welcome-email.ts, which is the whole guard.
  welcomeEmailSentAt: integer("welcome_email_sent_at", { mode: "timestamp_ms" }),
  // Hides this user's profile and sends from every page and API route other
  // than their own — see lib/user-visibility.ts's canViewUser, the one
  // predicate every read path branches on. Deliberately NOT read by
  // drizzle/migrations/0014_sends_aggregate_triggers.sql or
  // getClimbSendStats/getClimbSendSummary (db/queries/sends.ts): those touch
  // `sends` only, with no join to `user`, so a private user's ascents keep
  // counting toward a climb's rating and suggested grade exactly as before.
  isPrivate: integer("is_private", { mode: "boolean" }).default(false).notNull(),
  journalVisibility: text("journal_visibility", { enum: ["private", "public"] })
    .default("private")
    .notNull(),
  productTourReturning: integer("product_tour_returning", { mode: "boolean" })
    .default(false)
    .notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_user_id_idx").on(t.userId)],
);

export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", {
      mode: "timestamp_ms",
    }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", {
      mode: "timestamp_ms",
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (t) => [index("account_user_id_idx").on(t.userId)],
);

export const verification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}));
