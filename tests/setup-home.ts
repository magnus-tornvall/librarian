import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point HOME at a throwaway dir so paths.ts (INDEX_DIR/CONFIG_PATH default to
// os.homedir()/.librarian) and every spawned CLI resolve into isolated storage
// instead of the developer's real ~/.librarian. node --test runs each test file
// in its own process, so this runs once per file → per-file isolation, which is
// what keeps parallel drains off one shared SQLite index (#143).
// ponytail: no cleanup — os.tmpdir() is ephemeral and the rest of the suite
//           leaks mkdtemp dirs the same way; add an exit hook if it ever matters.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian-test-home-'));
