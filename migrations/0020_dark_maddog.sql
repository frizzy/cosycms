ALTER TABLE `collections` ADD `dates` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `entries` ADD `publishAt` integer;--> statement-breakpoint
ALTER TABLE `entries` ADD `publishedAt` integer;--> statement-breakpoint
ALTER TABLE `entries` ADD `revisedAt` integer;--> statement-breakpoint
UPDATE `collections` SET `dates` = 1 WHERE `scheduleField` IS NOT NULL;
