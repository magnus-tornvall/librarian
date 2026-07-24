// Entry for the packaged single-executable (#149). The CLI's own auto-run guard
// keys off `import.meta.main`, which the CJS bundle produced for SEA can't honour
// — so the bundle enters through here instead and invokes `main` directly.
import { main } from './cli.ts';

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`librarian: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
