import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Plain React SPA. We don't need routes (the app uses internal view state),
// but we do want fast dev refresh and a clean production build.
//
// Build output goes to dist/ — that's what Netlify serves.
export default defineConfig({
  plugins: [react()],
  // Default port is 5173; let Vite pick if busy
  server: {
    port: 5173,
    open: false,
  },
  build: {
    outDir: "dist",
    // Source maps in production make debugging dramatically easier for early testing
    sourcemap: true,
    // Roll up the giant artifact files without warning — they're our reality for now
    chunkSizeWarningLimit: 2000,
  },
});
