-- open-channels — baseline schema for the deployed instance.
--
-- Mirrors src/server/schema.ts (drizzle). The platform's CLI deploy path
-- applies schema.sql on every build and does not run drizzle/ migrations,
-- so the DDL is kept idempotent (IF NOT EXISTS) and this file must be
-- regenerated whenever schema.ts changes.

CREATE TABLE IF NOT EXISTS `contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`channel` text NOT NULL,
	`handle` text NOT NULL,
	`name` text,
	`profile_name` text,
	`avatar_url` text,
	`created_at` text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS `contacts_by_org_channel_handle` ON `contacts` (`org_id`,`channel`,`handle`);
CREATE TABLE IF NOT EXISTS `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`channel` text NOT NULL,
	`subject` text,
	`status` text DEFAULT 'open' NOT NULL,
	`unread` integer DEFAULT 0 NOT NULL,
	`last_message_at` text NOT NULL,
	`last_message_preview` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL
);
CREATE INDEX IF NOT EXISTS `conversations_by_org_recency` ON `conversations` (`org_id`,`last_message_at`);
CREATE UNIQUE INDEX IF NOT EXISTS `conversations_by_org_contact` ON `conversations` (`org_id`,`contact_id`);
CREATE TABLE IF NOT EXISTS `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`kind` text NOT NULL,
	`body` text NOT NULL,
	`author_name` text,
	`user_id` text,
	`status` text,
	`error` text,
	`external_id` text,
	`template_name` text,
	`template_language` text,
	`template_variables` text,
	`created_at` text NOT NULL
);
CREATE INDEX IF NOT EXISTS `messages_by_conversation` ON `messages` (`conversation_id`,`created_at`);
CREATE UNIQUE INDEX IF NOT EXISTS `messages_by_org_external` ON `messages` (`org_id`,`external_id`);
CREATE INDEX IF NOT EXISTS `messages_by_org_status` ON `messages` (`org_id`,`status`);
CREATE TABLE IF NOT EXISTS `templates` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`channel` text NOT NULL,
	`name` text NOT NULL,
	`language` text NOT NULL,
	`category` text NOT NULL,
	`status` text NOT NULL,
	`body_text` text DEFAULT '' NOT NULL,
	`variables` text DEFAULT '[]' NOT NULL,
	`components` text DEFAULT '[]' NOT NULL,
	`external_id` text,
	`synced_at` text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS `templates_by_org_channel_name_language` ON `templates` (`org_id`,`channel`,`name`,`language`);
CREATE INDEX IF NOT EXISTS `templates_by_org_channel` ON `templates` (`org_id`,`channel`,`status`);
CREATE TABLE IF NOT EXISTS `settings` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS `settings_by_org_key` ON `settings` (`org_id`,`key`);
