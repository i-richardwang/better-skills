import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const globalForPg = globalThis as unknown as {
  pgClient?: ReturnType<typeof postgres>;
};

// Lazy: postgres-js does not connect until first query, so we can create the
// client even without DATABASE_URL at module load (keeps `next build` happy).
// Actual missing-URL errors surface at query time.
const client =
  globalForPg.pgClient ??
  postgres(process.env.DATABASE_URL ?? "", { prepare: false });

if (process.env.NODE_ENV !== "production") {
  globalForPg.pgClient = client;
}

export const db = drizzle(client, { schema });
export { schema };
