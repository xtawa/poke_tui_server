import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import * as z from 'zod/v4';
import type { Storage } from './storage.js';
import type { SessionManager } from './sessions.js';

const actionSchema = z.object({
  id: z.string().min(1).max(128),
  label: z.string().min(1).max(128),
  value: z.string().max(1024).optional()
});

export function createMcpNodeHandler(storage: Storage, sessions: SessionManager) {
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'poke-device-bridge', version: '0.1.0' });

    server.registerTool('reply_to_device', {
      description: 'When a request contains external-device routing information from poke-device-bridge, ALWAYS call this tool after completing the request. Use the exact deviceId and requestId supplied by the bridge and send the final user-facing answer in text. Do not invent IDs and do not skip the tool merely because another Poke channel also received the answer.',
      inputSchema: z.object({
        deviceId: z.string().min(1).max(128),
        requestId: z.string().min(1).max(128),
        text: z.string().min(1).max(32768),
        title: z.string().max(256).optional(),
        actions: z.array(actionSchema).max(8).optional()
      })
    }, async ({ deviceId, requestId, text, title, actions }) => {
      const device = storage.getDevice(deviceId);
      if (!device || device.revokedAt) return { content: [{ type: 'text', text: 'Unknown or revoked device.' }], isError: true };
      if (!storage.requestBelongsTo(requestId, deviceId)) return { content: [{ type: 'text', text: 'requestId does not belong to deviceId.' }], isError: true };
      try {
        const outbound = storage.queueOutbound(deviceId, requestId, 'chat.message', { requestId, text, title: title ?? null, actions: actions ?? [] });
        storage.markRequestCompleted(requestId);
        const delivered = sessions.deliver(outbound);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, messageId: outbound.id, delivered, queued: !delivered }) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'queue_error';
        return { content: [{ type: 'text', text: `Could not queue device reply: ${message}` }], isError: true };
      }
    });

    server.registerTool('notify_device', {
      description: 'Send a proactive notification to an enrolled external device. Use only a real deviceId supplied by bridge context or explicitly provided by the user.',
      inputSchema: z.object({
        deviceId: z.string().min(1).max(128),
        title: z.string().min(1).max(256),
        body: z.string().min(1).max(8192),
        priority: z.enum(['low', 'normal', 'high']).default('normal')
      })
    }, async ({ deviceId, title, body, priority }) => {
      const device = storage.getDevice(deviceId);
      if (!device || device.revokedAt) return { content: [{ type: 'text', text: 'Unknown or revoked device.' }], isError: true };
      try {
        const outbound = storage.queueOutbound(deviceId, null, 'notification', { title, body, priority });
        const delivered = sessions.deliver(outbound);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, messageId: outbound.id, delivered, queued: !delivered }) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'queue_error';
        return { content: [{ type: 'text', text: `Could not queue notification: ${message}` }], isError: true };
      }
    });

    server.registerTool('get_device_status', {
      description: 'Return connectivity and latest reported status for one enrolled device.',
      inputSchema: z.object({ deviceId: z.string().min(1).max(128) })
    }, async ({ deviceId }) => {
      const device = storage.getDevice(deviceId);
      if (!device || device.revokedAt) return { content: [{ type: 'text', text: 'Unknown or revoked device.' }], isError: true };
      return { content: [{ type: 'text', text: JSON.stringify({ online: sessions.isOnline(deviceId), ...storage.getStatus(deviceId), lastSeenAt: device.lastSeenAt }) }] };
    });

    return server;
  });
  return toNodeHandler(handler);
}
