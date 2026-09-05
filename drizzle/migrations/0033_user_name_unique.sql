-- Hand-written, like 0018/0023: the index compares with COLLATE NOCASE,
-- which drizzle-kit can't express, so it's declared here rather than in
-- drizzle/schema/auth.ts (see the comment on user.name there).
--
-- Display names become unique so a profile name identifies one account —
-- case-insensitively, so "alice" can't pass for "Alice". Existing duplicates
-- have to be renamed first or the index creation fails: every duplicate
-- except the earliest-created account (ties broken by id) keeps its name
-- with a short id-derived suffix appended. User ids are 32-char random
-- strings, so a 6-char prefix doesn't collide in practice.
UPDATE `user`
SET `name` = `name` || ' ' || substr(`id`, 1, 6)
WHERE `id` IN (
  SELECT `dupe`.`id`
  FROM `user` `dupe`
  WHERE EXISTS (
    SELECT 1
    FROM `user` `earlier`
    WHERE `earlier`.`name` = `dupe`.`name` COLLATE NOCASE
      AND (
        `earlier`.`created_at` < `dupe`.`created_at`
        OR (`earlier`.`created_at` = `dupe`.`created_at` AND `earlier`.`id` < `dupe`.`id`)
      )
  )
);--> statement-breakpoint
CREATE UNIQUE INDEX `user_name_unique_idx` ON `user` (`name` COLLATE NOCASE);
