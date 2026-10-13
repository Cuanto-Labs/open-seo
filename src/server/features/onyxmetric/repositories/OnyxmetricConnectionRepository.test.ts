import { readFileSync } from "node:fs";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { OnyxmetricConnectionRepository as Repository } from "./OnyxmetricConnectionRepository";

vi.mock("cloudflare:workers", () => ({ env: {} }));

let client: Client;
let repository: typeof Repository;

beforeAll(async () => {
  client = createClient({ url: ":memory:" });
  // The repository reads the module-level `db`, so the real migration SQL runs
  // against an in-memory SQLite swapped in before first import.
  vi.doMock("@/db", () => ({ db: drizzle(client) }));
  await client.executeMultiple(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE organization (id text PRIMARY KEY);
    CREATE TABLE projects (id text PRIMARY KEY);
    INSERT INTO organization VALUES ('org1');
    INSERT INTO projects VALUES ('p1'), ('p2');
  `);
  await client.executeMultiple(
    readFileSync("drizzle/sqlite/0055_onyxmetric_connections.sql", "utf8")
      .split("--> statement-breakpoint")
      .join("\n"),
  );
  ({ OnyxmetricConnectionRepository: repository } =
    await import("./OnyxmetricConnectionRepository"));
});

afterAll(() => client.close());

beforeEach(async () => {
  await client.execute("DELETE FROM onyxmetric_connections");
});

const connection = (projectId: string, siteId: string) => ({
  projectId,
  organizationId: "org1",
  siteId,
  siteName: `Site ${siteId}`,
  connectedByUserId: "u1",
});

describe("OnyxmetricConnectionRepository", () => {
  it("keeps one connection per project, replacing the site on upsert", async () => {
    await repository.upsert(connection("p1", "7"));
    await repository.upsert(connection("p1", "9"));
    await repository.upsert(connection("p2", "7"));

    await expect(repository.getByProjectId("p1")).resolves.toMatchObject({
      siteId: "9",
      siteName: "Site 9",
    });
    const count = await client.execute(
      "SELECT count(*) AS n FROM onyxmetric_connections",
    );
    expect(count.rows[0]?.n).toBe(2);
  });

  it("deletes only the given project's connection", async () => {
    await repository.upsert(connection("p1", "7"));
    await repository.upsert(connection("p2", "7"));

    await repository.deleteByProjectId("p1");

    await expect(repository.getByProjectId("p1")).resolves.toBeNull();
    await expect(repository.getByProjectId("p2")).resolves.not.toBeNull();
  });
});
