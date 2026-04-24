import { defineConfig } from "drizzle-kit";

// `generate` works offline and does not need DATABASE_URL.
// `push` / `migrate` / `studio` require it — drizzle-kit will error out
// at command time if missing, which is the desired UX.
export default defineConfig({
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
  strict: true,
  verbose: true,
});
