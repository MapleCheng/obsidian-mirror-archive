import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";

const production = process.argv.includes("--production");
const distDir = "dist";
const stylesPath = "styles.css";

await esbuild.build({
  banner: {
    js: "// This file is generated from src/main.ts. Run npm run build before releasing.",
  },
  bundle: true,
  entryPoints: ["src/main.ts"],
  external: ["obsidian"],
  format: "cjs",
  logLevel: "info",
  minify: production,
  outfile: path.join(distDir, "main.js"),
  sourcemap: production ? false : "inline",
  target: "es2018",
});

fs.mkdirSync(distDir, { recursive: true });
fs.copyFileSync("manifest.json", path.join(distDir, "manifest.json"));

if (fs.existsSync(stylesPath)) {
  fs.copyFileSync(stylesPath, path.join(distDir, stylesPath));
} else {
  fs.rmSync(path.join(distDir, stylesPath), { force: true });
}
