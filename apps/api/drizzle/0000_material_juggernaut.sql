CREATE TABLE `actions` (
	`id` text PRIMARY KEY NOT NULL,
	`story_id` text NOT NULL,
	`idx` integer NOT NULL,
	`type` text NOT NULL,
	`text` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`story_id`) REFERENCES `stories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `actions_story_id_idx_idx` ON `actions` (`story_id`,`idx`);--> statement-breakpoint
CREATE UNIQUE INDEX `actions_story_id_idx_unique` ON `actions` (`story_id`,`idx`);--> statement-breakpoint
CREATE TABLE `compressed_ranges` (
	`id` text PRIMARY KEY NOT NULL,
	`story_id` text NOT NULL,
	`start_idx` integer NOT NULL,
	`end_idx` integer NOT NULL,
	`summary` text NOT NULL,
	`parent_range_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`story_id`) REFERENCES `stories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_range_id`) REFERENCES `compressed_ranges`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `compressed_ranges_story_id_range_idx` ON `compressed_ranges` (`story_id`,`start_idx`,`end_idx`);--> statement-breakpoint
CREATE TABLE `provider_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`label` text NOT NULL,
	`kind` text NOT NULL,
	`base_url` text,
	`model` text NOT NULL,
	`api_key_enc` text NOT NULL,
	`is_default` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `provider_configs_user_id_idx` ON `provider_configs` (`user_id`);--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `scenarios` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`opening` text NOT NULL,
	`ai_instructions` text NOT NULL,
	`tags` text NOT NULL,
	`builtin` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_user_id_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `stories` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`scenario_id` text,
	`title` text NOT NULL,
	`ai_instructions` text DEFAULT '' NOT NULL,
	`plot_essentials` text DEFAULT '' NOT NULL,
	`memory` text DEFAULT '' NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`scenario_id`) REFERENCES `scenarios`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `stories_user_id_deleted_at_idx` ON `stories` (`user_id`,`deleted_at`);--> statement-breakpoint
CREATE TABLE `story_cards` (
	`id` text PRIMARY KEY NOT NULL,
	`story_id` text NOT NULL,
	`keys` text NOT NULL,
	`entry` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`story_id`) REFERENCES `stories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `story_cards_story_id_idx` ON `story_cards` (`story_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text,
	`password_hash` text,
	`instance_admin` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);