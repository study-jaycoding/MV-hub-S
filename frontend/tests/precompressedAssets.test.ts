import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { build, type Rollup } from "vite";
import { precompressedAssets } from "../vite.config";

it("compresses final JS/CSS bytes, including Vite's rewritten dynamic imports", async () => {
  const root = await mkdtemp(join(tmpdir(), "mvhub-compressed-"));
  try {
    const payload = Array.from({ length: 300 }, (_, i) => `payload-${i}`).join(" ");
    await writeFile(join(root, "index.html"), '<script type="module" src="/main.js"></script>');
    await writeFile(join(root, "main.js"), `import './main.css'; window.payload=${JSON.stringify(payload)}; window.load=()=>import('./lazy.js');`);
    await writeFile(join(root, "lazy.js"), `import './lazy.css'; export const payload=${JSON.stringify(payload)};`);
    await writeFile(join(root, "main.css"), Array.from({ length: 100 }, (_, i) => `.cell-${i}{color:red;padding:${i}px}`).join("\n"));
    await writeFile(join(root, "lazy.css"), ".lazy{color:blue}");
    const result = await build({
      root, configFile: false, logLevel: "silent", plugins: [precompressedAssets()],
      build: { sourcemap: true },
    }) as Rollup.RollupOutput;
    const packed = result.output.filter((entry) => entry.fileName.endsWith(".gz"));
    expect(packed.length).toBeGreaterThanOrEqual(3);
    for (const entry of packed) {
      const original = await readFile(join(root, "dist", entry.fileName.slice(0, -3)));
      const compressed = await readFile(join(root, "dist", entry.fileName));
      expect(gunzipSync(compressed)).toEqual(original);
      expect(compressed.length).toBeLessThan(original.length);
      expect(entry.fileName).toMatch(/\.(js|css)\.gz$/);
    }
    const smallCss = result.output.find((entry) => entry.fileName.startsWith("assets/lazy-") && entry.fileName.endsWith(".css"));
    expect(smallCss).toBeDefined();
    expect(packed.some((entry) => entry.fileName === `${smallCss!.fileName}.gz`)).toBe(false);
    expect(result.output.some((entry) => entry.fileName.endsWith(".map"))).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
