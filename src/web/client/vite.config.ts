import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import { clientBuildDir, hashClientSources, writeBuildManifest } from "../client-build.ts";

const sourceDir = fileURLToPath(new URL(".", import.meta.url));
const factoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const buildDir = clientBuildDir(factoryRoot);
const apiTarget = process.env.FACTORY_WEB_API ?? "http://127.0.0.1:7433";

function buildManifest(): Plugin {
  let sourceHash = "";
  return {
    name: "factory-build-manifest",
    apply: "build",
    async buildStart() {
      sourceHash = await hashClientSources(sourceDir);
    },
    async closeBundle() {
      await writeBuildManifest(buildDir, sourceHash);
    },
  };
}

export default defineConfig({
  root: sourceDir,
  plugins: [react(), tailwindcss(), buildManifest()],
  server: {
    host: "127.0.0.1",
    port: 5179,
    strictPort: true,
    proxy: { "/api": { target: apiTarget, changeOrigin: true }, "/runs": { target: apiTarget, changeOrigin: true } },
  },
  build: { outDir: buildDir, emptyOutDir: true },
});
