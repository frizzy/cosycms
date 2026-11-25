CREATE TABLE `templates` (
	`key` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`body` text,
	`prompt` text NOT NULL,
	`updatedAt` integer NOT NULL
);
