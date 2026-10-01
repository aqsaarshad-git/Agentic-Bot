import { ConfigService } from '@nestjs/config';
import { QwenProvider } from './qwen.provider';

describe('QwenProvider.warmUp', () => {
  afterEach(() => jest.restoreAllMocks());

  it('requests the same num_ctx as real calls so the ping never reloads the model at a different context size', async () => {
    const config = { get: (k: string) => ({ 'llm.qwenBaseUrl': 'http://x', 'llm.qwenModel': 'qwen3.5:4b' } as Record<string, string>)[k] } as unknown as ConfigService;
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({}) } as Response);

    await new QwenProvider(config).warmUp();

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.messages).toEqual([]);
    expect(body.keep_alive).toBe(-1);
    expect(body.options).toEqual({ num_ctx: 16384 });
  });
});
