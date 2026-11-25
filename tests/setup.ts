// Every test gets its own accounting file, so tests never touch a real ~/.local/state ledger
// and never share state with each other.
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach } from "vitest"

beforeEach(() => {
  process.env.JEV_LEDGER_FILE = join(mkdtempSync(join(tmpdir(), "jev-ledger-")), "ledger.json")
})
