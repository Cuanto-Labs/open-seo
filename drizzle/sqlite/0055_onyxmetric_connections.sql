CREATE TABLE `onyxmetric_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`site_id` text NOT NULL,
	`site_name` text NOT NULL,
	`connected_by_user_id` text NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `onyxmetric_connections_project_idx` ON `onyxmetric_connections` (`project_id`);--> statement-breakpoint
CREATE INDEX `onyxmetric_connections_organization_idx` ON `onyxmetric_connections` (`organization_id`);