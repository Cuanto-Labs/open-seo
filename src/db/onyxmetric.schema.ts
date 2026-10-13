import { sql } from "drizzle-orm";
import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { projects } from "./app.schema";
import { organization } from "./better-auth-schema";

// Selected OnyxMetric site per project. The API key is server environment
// configuration (ONYXMETRIC_API_KEY) and is never stored here.
export const onyxmetricConnections = sqliteTable(
  "onyxmetric_connections",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // OnyxMetric numeric site id, kept as text and validated as digits.
    siteId: text("site_id").notNull(),
    siteName: text("site_name").notNull(),
    connectedByUserId: text("connected_by_user_id").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    uniqueIndex("onyxmetric_connections_project_idx").on(table.projectId),
    index("onyxmetric_connections_organization_idx").on(table.organizationId),
  ],
);
