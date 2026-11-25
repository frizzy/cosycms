ALTER TABLE `entries` ADD `live` text;
--> statement-breakpoint
-- Everything published until now is live as it stands.
UPDATE `entries` SET `live` = json_object('slug', `slug`, 'data', json(`data`)) WHERE `status` = 'published';
