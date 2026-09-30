import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

/**
 * Password hashing with scrypt from Node's standard library.
 *
 * scrypt is memory-hard and built in, which avoids a native-compilation
 * dependency (argon2 needs node-gyp and fails on clean Windows installs)
 * without weakening the hash. Parameters follow the OWASP scrypt guidance of
 * N=2^17, r=8, p=1.
 */

const KEY_LENGTH = 64;
const SALT_BYTES = 16;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH);
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;

  const salt = Buffer.from(parts[1]!, 'base64');
  const expected = Buffer.from(parts[2]!, 'base64');
  if (expected.length !== KEY_LENGTH) return false;

  const derived = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH);
  // Constant-time compare so a wrong password cannot be narrowed by timing.
  return timingSafeEqual(derived, expected);
}

/**
 * Burns roughly the same CPU as a real verification. Used on the login path
 * when the email does not exist, so response timing does not disclose whether
 * an account is registered.
 */
export async function fakeVerify(): Promise<void> {
  await scrypt('placeholder', randomBytes(SALT_BYTES), KEY_LENGTH);
}
