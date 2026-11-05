import { defineConfig } from "@playwright/test";

// The app must already be running. See the README.
export default defineConfig({
  testDir: "test/browser",
  use: { baseURL: "http://localhost:4310" },
});
