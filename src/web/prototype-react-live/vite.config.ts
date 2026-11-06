import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: here,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": `${here}app` } },
  server: { host: "127.0.0.1", port: 5179, strictPort: true, proxy: { "/api": "http://127.0.0.1:7435" } },
  build: { outDir: `${here}../../../dist/web`, emptyOutDir: true },
});
