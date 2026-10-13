ALTER TABLE `scenarios` ADD `user_id` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `stories` ADD `provider_id` text REFERENCES provider_configs(id) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
ALTER TABLE `stories` ADD `compress_trigger_pct` real;--> statement-breakpoint
ALTER TABLE `stories` ADD `compress_max_tokens` integer;--> statement-breakpoint
ALTER TABLE `stories` ADD `compress_temperature` real;--> statement-breakpoint
ALTER TABLE `stories` ADD `context_tokens` integer;--> statement-breakpoint
ALTER TABLE `stories` ADD `max_output_tokens` integer;