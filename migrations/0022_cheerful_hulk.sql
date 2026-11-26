CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`kind` text NOT NULL,
	`ref` text NOT NULL,
	`level` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`link` text,
	`readAt` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_ref` ON `notifications` (`kind`,`ref`);--> statement-breakpoint
CREATE INDEX `notifications_at` ON `notifications` (`at`);