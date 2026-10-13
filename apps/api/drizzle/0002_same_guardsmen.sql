CREATE TABLE `script_states` (
	`script_id` text NOT NULL,
	`story_id` text NOT NULL,
	`state` text DEFAULT '{}' NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`script_id`, `story_id`),
	FOREIGN KEY (`script_id`) REFERENCES `scripts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`story_id`) REFERENCES `stories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `scripts` (
	`id` text PRIMARY KEY NOT NULL,
	`story_id` text,
	`scenario_id` text,
	`name` text NOT NULL,
	`source` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`story_id`) REFERENCES `stories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`scenario_id`) REFERENCES `scenarios`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "scripts_single_owner" CHECK(("scripts"."story_id" IS NULL) <> ("scripts"."scenario_id" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `scripts_story_id_position_idx` ON `scripts` (`story_id`,`position`);--> statement-breakpoint
CREATE INDEX `scripts_scenario_id_position_idx` ON `scripts` (`scenario_id`,`position`);