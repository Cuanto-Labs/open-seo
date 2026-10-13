import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { onyxmetricConnections } from "@/db/schema";

export type OnyxmetricConnection = typeof onyxmetricConnections.$inferSelect;

async function getByProjectId(
  projectId: string,
): Promise<OnyxmetricConnection | null> {
  const rows = await db
    .select()
    .from(onyxmetricConnections)
    .where(eq(onyxmetricConnections.projectId, projectId))
    .limit(1);
  return rows[0] ?? null;
}

async function upsert(input: {
  projectId: string;
  organizationId: string;
  siteId: string;
  siteName: string;
  connectedByUserId: string;
}): Promise<OnyxmetricConnection> {
  const [row] = await db
    .insert(onyxmetricConnections)
    .values({ id: crypto.randomUUID(), ...input })
    .onConflictDoUpdate({
      target: onyxmetricConnections.projectId,
      set: {
        organizationId: input.organizationId,
        siteId: input.siteId,
        siteName: input.siteName,
        connectedByUserId: input.connectedByUserId,
        updatedAt: sql`(current_timestamp)`,
      },
    })
    .returning();
  if (!row) throw new Error("Failed to upsert onyxmetric_connection");
  return row;
}

async function deleteByProjectId(projectId: string): Promise<void> {
  await db
    .delete(onyxmetricConnections)
    .where(eq(onyxmetricConnections.projectId, projectId));
}

export const OnyxmetricConnectionRepository = {
  getByProjectId,
  upsert,
  deleteByProjectId,
};
