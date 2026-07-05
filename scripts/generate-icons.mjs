import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
execSync(`python3 scripts/generate-icons.py`, { cwd: root, stdio: 'inherit' });
