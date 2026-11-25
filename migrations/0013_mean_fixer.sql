CREATE TABLE `activity` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`actor` text NOT NULL,
	`via` text,
	`action` text NOT NULL,
	`collection` text,
	`entryId` text,
	`label` text,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `activity_at` ON `activity` (`at`);--> statement-breakpoint
CREATE INDEX `activity_entry` ON `activity` (`entryId`,`at`);--> statement-breakpoint
ALTER TABLE `entries` ADD `pending` integer DEFAULT false NOT NULL;