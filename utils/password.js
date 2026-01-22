const crypto = require('crypto');

const ITERATIONS = 100000;
const KEY_LEN = 64;
const DIGEST = 'sha512';

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64');
  const hash = crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LEN, DIGEST).toString('base64');
  return `pbkdf2$${ITERATIONS}$${salt}$${hash}`;
}

function isHashed(value) {
  return typeof value === 'string' && value.startsWith('pbkdf2$');
}

function verifyPassword(password, stored) {
  if (!isHashed(stored)) return false;
  const parts = stored.split('$');
  if (parts.length !== 4) return false;
  const iterations = Number(parts[1]);
  const salt = parts[2];
  const hash = parts[3];
  if (!iterations || !salt || !hash) return false;

  const derived = crypto
    .pbkdf2Sync(password, salt, iterations, KEY_LEN, DIGEST)
    .toString('base64');
  return crypto.timingSafeEqual(Buffer.from(hash, 'base64'), Buffer.from(derived, 'base64'));
}

module.exports = { hashPassword, verifyPassword, isHashed };

