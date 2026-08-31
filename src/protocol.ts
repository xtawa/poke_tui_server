import { z } from 'zod';

export const clientEnvelopeSchema = z.object({
  id: z.string().min(1).max(128),
  type: z.enum(['chat.send', 'ack', 'device.status', 'ping']),
  timestamp: z.number().int().optional(),
  payload: z.unknown()
});

export const chatSendSchema = z.object({ text: z.string().min(1).max(16384) });
export const ackSchema = z.object({ messageId: z.string().min(1).max(128) });
export const deviceStatusSchema = z.object({
  battery: z.number().int().min(0).max(100).optional(),
  charging: z.boolean().optional(),
  screenOn: z.boolean().optional(),
  wifiRssi: z.number().int().min(-150).max(0).optional(),
  appVersion: z.string().max(64).optional(),
  androidVersion: z.string().max(64).optional()
});

export type ServerEnvelope = {
  id: string;
  type: 'hello' | 'chat.accepted' | 'chat.message' | 'notification' | 'error' | 'pong';
  timestamp: number;
  payload: unknown;
};
