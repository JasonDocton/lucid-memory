import { resolve } from "node:path"
import { finishLegacyUpdate } from "../src/upgrade.ts"

await finishLegacyUpdate(resolve(import.meta.dir, ".."))
