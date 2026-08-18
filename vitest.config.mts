import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Pin owner identity to the generic template placeholder so tests are
    // hermetic and match CI (which has no .env). Without this, a local .env
    // setting NEXT_PUBLIC_OWNER_NAME (e.g. "Hunter Zhang" for the dev server)
    // leaks into tests that assert on the generic name. Takes precedence over
    // .env files.
    env: {
      NEXT_PUBLIC_OWNER_NAME: "Alex Rivera",
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
