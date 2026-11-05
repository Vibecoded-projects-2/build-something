import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "client",
  plugins: [react()],
  build: {
    outDir: "../dist/client",
    emptyOutDir: true,
    // The production CSP has no data: font source, so assets stay as files.
    assetsInlineLimit: 0,
  },
});
