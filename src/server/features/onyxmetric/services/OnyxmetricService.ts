import { AppError } from "@/server/lib/errors";
import {
  createOnyxmetricClient,
  isOnyxmetricConfigured,
} from "@/server/lib/onyxmetricClient";
import {
  OnyxmetricApiError,
  OnyxmetricNotConfiguredError,
} from "@/server/lib/onyxmetricErrors";
import {
  OnyxmetricConnectionRepository,
  type OnyxmetricConnection,
} from "@/server/features/onyxmetric/repositories/OnyxmetricConnectionRepository";

async function getConnection(
  projectId: string,
): Promise<OnyxmetricConnection | null> {
  return OnyxmetricConnectionRepository.getByProjectId(projectId);
}

/** Sites the server's API key can read. `available: false` means the key is
 *  missing or rejected, so the UI can explain instead of erroring. */
async function listSites() {
  if (!(await isOnyxmetricConfigured())) {
    return { available: false as const, sites: [] };
  }
  try {
    const client = await createOnyxmetricClient();
    return { available: true as const, sites: await client.listSites() };
  } catch (error) {
    console.error("onyxmetric.site_discovery_failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
      status: error instanceof OnyxmetricApiError ? error.status : undefined,
    });
    return { available: false as const, sites: [] };
  }
}

async function setSite(input: {
  projectId: string;
  organizationId: string;
  siteId: string;
  userId: string;
}): Promise<OnyxmetricConnection> {
  const client = await createOnyxmetricClient().catch((error: unknown) => {
    if (error instanceof OnyxmetricNotConfiguredError) {
      throw new AppError("VALIDATION_ERROR", error.message);
    }
    throw error;
  });
  // Validates that the key can read the site and captures its display name.
  const site = await client.getSite(input.siteId).catch((error: unknown) => {
    if (
      error instanceof OnyxmetricApiError &&
      [401, 403, 404].includes(error.status)
    ) {
      throw new AppError(
        "NOT_FOUND",
        "That OnyxMetric site isn't available to this server's API key.",
      );
    }
    throw error;
  });
  return OnyxmetricConnectionRepository.upsert({
    projectId: input.projectId,
    organizationId: input.organizationId,
    siteId: site.siteId,
    siteName: site.name,
    connectedByUserId: input.userId,
  });
}

async function disconnect(input: { projectId: string }): Promise<void> {
  await OnyxmetricConnectionRepository.deleteByProjectId(input.projectId);
}

export const OnyxmetricService = {
  getConnection,
  listSites,
  setSite,
  disconnect,
};
