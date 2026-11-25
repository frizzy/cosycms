CREATE TABLE `blocks` (
	`key` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`content` text NOT NULL,
	`props` text NOT NULL,
	`updatedAt` integer NOT NULL
);
