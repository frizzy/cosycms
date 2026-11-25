CREATE TABLE `entries` (
	`id` text PRIMARY KEY NOT NULL,
	`collection` text NOT NULL,
	`slug` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`data` text NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `entries_path` ON `entries` (`collection`,`slug`);--> statement-breakpoint
CREATE INDEX `entries_status` ON `entries` (`status`);--> statement-breakpoint
CREATE TABLE `publish_state` (
	`target` text NOT NULL,
	`entryId` text NOT NULL,
	`hash` text NOT NULL,
	`ref` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `publish_state_pk` ON `publish_state` (`target`,`entryId`);