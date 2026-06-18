import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "contact-form": "src/contact-form.ts",
    deploy: "src/deploy.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  outDir: "dist",
});
