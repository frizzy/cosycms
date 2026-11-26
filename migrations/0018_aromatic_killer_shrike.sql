CREATE TABLE `schedule` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`ref` text NOT NULL,
	`runAt` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`error` text,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `schedule_job` ON `schedule` (`kind`,`ref`);--> statement-breakpoint
CREATE INDEX `schedule_due` ON `schedule` (`status`,`runAt`);--> statement-breakpoint
ALTER TABLE `collections` ADD `scheduleField` text;