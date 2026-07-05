import os from 'node:os';
import path from 'node:path';

export const HOME = os.homedir();
export const LIBRARIAN_ROOT = path.join(HOME, '.librarian');
export const DATA_DIR = path.join(LIBRARIAN_ROOT, 'data');
export const DIAGNOSTICS_DIR = path.join(LIBRARIAN_ROOT, 'diagnostics');
export const MACHINE_ID_PATH = path.join(LIBRARIAN_ROOT, 'machine-id');
export const CONFIG_PATH = path.join(LIBRARIAN_ROOT, 'config.json');
