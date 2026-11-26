-- Search and "where used" indexes. Hand-written (drizzle does not model virtual tables), so they are not in schema.ts. Rebuilt from the entries at any time (Settings > Search).
-- search_doc holds one row per entry (draft text); search is the full-text index over it, kept in step by the triggers below.
CREATE TABLE `search_doc` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entry` text NOT NULL,
	`collection` text NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`tags` text NOT NULL,
	`body` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `search_doc_entry` ON `search_doc` (`entry`);
--> statement-breakpoint
CREATE VIRTUAL TABLE `search` USING fts5(title, tags, body, slug, content='search_doc', content_rowid='id', tokenize='unicode61 remove_diacritics 2', prefix='2 3');
--> statement-breakpoint
CREATE TRIGGER `search_ai` AFTER INSERT ON `search_doc` BEGIN
	INSERT INTO `search`(rowid, title, tags, body, slug) VALUES (new.id, new.title, new.tags, new.body, new.slug);
END;
--> statement-breakpoint
CREATE TRIGGER `search_ad` AFTER DELETE ON `search_doc` BEGIN
	INSERT INTO `search`(`search`, rowid, title, tags, body, slug) VALUES ('delete', old.id, old.title, old.tags, old.body, old.slug);
END;
--> statement-breakpoint
CREATE TRIGGER `search_au` AFTER UPDATE ON `search_doc` BEGIN
	INSERT INTO `search`(`search`, rowid, title, tags, body, slug) VALUES ('delete', old.id, old.title, old.tags, old.body, old.slug);
	INSERT INTO `search`(rowid, title, tags, body, slug) VALUES (new.id, new.title, new.tags, new.body, new.slug);
END;
--> statement-breakpoint
-- Which entry (or template, as "template:<key>") mentions which entry, in its draft or published version.
CREATE TABLE `refs` (
	`src` text NOT NULL,
	`dst` text NOT NULL,
	PRIMARY KEY(`src`, `dst`)
);
--> statement-breakpoint
CREATE INDEX `refs_dst` ON `refs` (`dst`);
