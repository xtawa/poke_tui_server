import { describe, expect, it } from 'vitest';
import { ackSchema, chatSendSchema, deviceStatusSchema } from '../src/protocol.js';
import { constantTimeEqual, hashToken, newToken } from '../src/crypto.js';

describe('security primitives', () => {
  it('generates high-entropy device tokens and hashes them deterministically', () => {
    const token = newToken();
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(hashToken(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashToken(token)).toBe(hashToken(token));
  });

  it('uses equality semantics without throwing on different lengths', () => {
    expect(constantTimeEqual('same', 'same')).toBe(true);
    expect(constantTimeEqual('a', 'different')).toBe(false);
  });
});

describe('device protocol schemas', () => {
  it('rejects empty chat messages', () => {
    expect(chatSendSchema.safeParse({ text: '' }).success).toBe(false);
  });

  it('accepts ACK and bounded status payloads', () => {
    expect(ackSchema.safeParse({ messageId: 'msg_1' }).success).toBe(true);
    expect(deviceStatusSchema.safeParse({ battery: 101 }).success).toBe(false);
  });
});
