import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export const ids = {
  device: () => `dev_${randomUUID()}`,
  request: () => `req_${randomUUID()}`,
  message: () => `msg_${randomUUID()}`
};

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function constantTimeEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
