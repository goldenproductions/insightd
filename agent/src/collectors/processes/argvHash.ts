import { createHash } from 'crypto';

export function joinArgv(argv: string[]): string {
  return argv.join(' ');
}

export function hashArgv(argv: string[]): string {
  return createHash('sha256').update(joinArgv(argv)).digest('hex').slice(0, 16);
}
