import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

/** Locate preinstalled tools only. Relative PATH entries cannot select the cwd. */
export function localExecutable(name: 'docker' | 'openssl' | 'certutil'): string {
  const filename = process.platform === 'win32' ? `${name}.exe` : name;
  const directories = (process.env.PATH ?? '').split(delimiter).filter(isAbsolute);
  if (process.platform === 'win32' && name === 'openssl' && process.env.ProgramFiles
      && isAbsolute(process.env.ProgramFiles)) directories.push(join(process.env.ProgramFiles, 'Git', 'mingw64', 'bin'));
  for (const directory of directories) {
    try {
      const path = realpathSync.native(join(directory, filename));
      if (!statSync(path).isFile()) continue;
      accessSync(path, constants.X_OK);
      return path;
    } catch { /* Try the next local installation, never download a tool. */ }
  }
  throw new Error('Required local executable is not installed.');
}
