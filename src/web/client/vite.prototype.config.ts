import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const sourceDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: sourceDir,
  mode: "prototype",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "/tmp/claude-0/-home-user-software-factory/8a7e3237-256b-56ff-aec2-de708eacea14/scratchpad/proto-build",
    emptyOutDir: true,
    assetsInlineLimit: 100000000,
    cssCodeSplit: false,
    modulePreload: false,
    rollupOptions: { input: fileURLToPath(new URL("prototype.html", import.meta.url)), output: { inlineDynamicImports: true } },
  },
});
