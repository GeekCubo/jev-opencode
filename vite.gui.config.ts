import { defineConfig } from "vite"
import { gui } from "@opencode/plugin/gui/vite"

export default defineConfig({ plugins: [gui({ entry: "plugin/gui.tsx", outFile: "plugin/dist/gui-experimental.cjs" })] })
