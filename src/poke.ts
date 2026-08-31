import type { Config } from './config.js';

export class PokeClient {
  constructor(private readonly config: Config) {}

  async sendDeviceMessage(input: { deviceId: string; requestId: string; text: string }): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch('https://poke.com/api/v1/inbound/api-message', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.POKE_API_KEY}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          message: input.text,
          source: 'poke-device-bridge',
          routing: {
            deviceId: input.deviceId,
            requestId: input.requestId,
            replyTool: 'reply_to_device',
            instruction: 'After completing the user request, always call the reply_to_device MCP tool with the exact deviceId and requestId from this routing object. Send the final user-facing answer in text. Do not invent routing identifiers.'
          }
        }),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`Poke API HTTP ${response.status}`);
      const body = await response.json() as { success?: boolean; message?: string };
      if (!body.success) throw new Error(`Poke API rejected message: ${body.message ?? 'unknown error'}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}
