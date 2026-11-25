CREATE TABLE `collections` (
	`key` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`fields` text NOT NULL,
	`updatedAt` integer NOT NULL
);

--> statement-breakpoint
-- Seed the collection that used to be hard-coded in src/config.ts.
INSERT OR IGNORE INTO `collections` (`key`, `label`, `fields`, `updatedAt`) VALUES ('posts', 'Posts', '[{"key":"title","label":"Title","type":"text","required":true},{"key":"category","label":"Category","type":"select","options":["news","guide","opinion"]},{"key":"publishedAt","label":"Publish date","type":"date"},{"key":"featured","label":"Featured","type":"boolean"},{"key":"body","label":"Body","type":"richtext"}]', unixepoch() * 1000);
