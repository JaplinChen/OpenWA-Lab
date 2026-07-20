import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TranslateService } from './translate.service';
import { HookManager } from '../../core/hooks';
import { MessageService } from '../message/message.service';
import { IncomingMessage } from '../../engine/interfaces/whatsapp-engine.interface';

describe('TranslateService glossary', () => {
  let glossaryPath: string;
  let sendersPath: string;
  let sent: { chatId: string; text: string }[];
  let service: TranslateService;

  const makeMsg = (body: string): IncomingMessage =>
    ({ chatId: 'g@g.us', from: 'u@c.us', author: 'u@c.us', body, type: 'text', isGroup: true, fromMe: false } as IncomingMessage);

  beforeEach(() => {
    glossaryPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gloss-')), 'glossary.json');
    process.env.TRANSLATE_GLOSSARY_PATH = glossaryPath;
    sendersPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'send-')), 'senders.json');
    process.env.TRANSLATE_SENDERS_PATH = sendersPath;
    process.env.TRANSLATE_CONFIG_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tcfg-')), 'translate-config.json');
    sent = [];
    const messageService = {
      sendText: (_s: string, dto: { chatId: string; text: string }) => {
        sent.push(dto);
        return Promise.resolve({} as never);
      },
    } as unknown as MessageService;
    service = new TranslateService(new HookManager(), messageService);
    service.onModuleInit(); // loads (absent) glossary from the temp path
  });

  // Poke private runtime config directly — cheaper than updateConfig() persisting to the temp path.
  const poke = (patch: Record<string, unknown>): void => {
    Object.assign((service as unknown as { cfg: Record<string, unknown> }).cfg, patch);
  };

  const cmd = (body: string): Promise<void> =>
    (service as unknown as { handleGlossaryCommand: (s: string, m: IncomingMessage, r: string) => Promise<void> })
      .handleGlossaryCommand('sess', makeMsg(body), body);

  it('add writes both directions and persists', async () => {
    await cmd('/glossary add 出貨 = giao hàng');
    const saved = JSON.parse(fs.readFileSync(glossaryPath, 'utf8'));
    expect(saved['zh-tw:vi']['出貨']).toBe('giao hàng');
    expect(saved['vi:zh-tw']['giao hàng']).toBe('出貨');
  });

  it('del removes the pairing named from either side', async () => {
    await cmd('/glossary add 出貨 = giao hàng');
    await cmd('/glossary del giao hàng'); // name the Vietnamese side
    const saved = JSON.parse(fs.readFileSync(glossaryPath, 'utf8'));
    expect(saved['zh-tw:vi']['出貨']).toBeUndefined();
    expect(saved['vi:zh-tw']['giao hàng']).toBeUndefined();
  });

  it('/g alias strips the short token and routes to the glossary', async () => {
    await cmd('/g 出貨 = giao hàng');
    const saved = JSON.parse(fs.readFileSync(glossaryPath, 'utf8'));
    expect(saved['zh-tw:vi']['出貨']).toBe('giao hàng');
  });

  it('detects zh and vi source directions', () => {
    const detect = (service as unknown as { detectPair: (t: string) => { key: string } | null }).detectPair.bind(service);
    expect(detect('今天出貨')?.key).toBe('zh-tw:vi');
    expect(detect('giao hàng hôm nay')?.key).toBe('vi:zh-tw');
    expect(detect('12345')).toBeNull();
  });

  it('mixed script decides by dominant text, not first CJK char', () => {
    const detect = (service as unknown as { detectPair: (t: string) => { key: string } | null }).detectPair.bind(service);
    // A Vietnamese message @-mentioning a Chinese name must still translate TO Chinese.
    expect(detect('Báo cáo Giám đốc @VPIC1 陳嘉元, phòng 201 đã hoạt động.')?.key).toBe('vi:zh-tw');
    // A Chinese message quoting a Vietnamese place name stays Chinese→Vietnamese.
    expect(detect('我下週去 Đà Nẵng 出差三天談合約事宜')?.key).toBe('zh-tw:vi');
  });

  it('translates an image caption (media with text is not skipped)', async () => {
    const fetchMock = jest.fn(async () => ({ ok: true, json: async () => ({ message: { content: '報告主管' } }) }) as never);
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
    poke({
      enabled: true, llmProvider: 'ollama', llmEndpoint: 'http://x/api/chat', llmModel: 'qwen3:8b',
      groupIds: new Set(['g@g.us']), minSendIntervalMs: 0,
    });
    const msg = { ...makeMsg('Báo cáo Sếp'), type: 'image' } as IncomingMessage;
    await (service as unknown as {
      onMessage: (c: unknown, s: boolean) => Promise<unknown>;
    }).onMessage({ data: msg, sessionId: 'sess' }, false);
    await (service as unknown as { queue: Promise<unknown> }).queue;

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('報告主管');
  });

  it('applies the sender override to the @mention before sending the prompt to Ollama', async () => {
    service.senderStore.add('200859128434777', '總經理');
    let promptSent = '';
    const fetchMock = jest.fn(async (_url: string, init: { body: string }) => {
      promptSent = JSON.parse(init.body).messages[0].content as string;
      return { ok: true, json: async () => ({ message: { content: '報告總經理' } }) } as never;
    });
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;

    const translate = (service as unknown as {
      translate: (t: string, p: { key: string }) => Promise<string>;
    }).translate.bind(service);
    await translate('報告給@200859128434777以及其他同事', { key: 'zh-tw:vi' } as never);

    expect(fetchMock).toHaveBeenCalled();
    expect(promptSent).toContain('@總經理');
    expect(promptSent).not.toContain('@200859128434777');
  });

  it('strips a reasoning model <think> block so the group gets only the translation', async () => {
    poke({ llmProvider: 'ollama', llmEndpoint: 'http://x/api/chat', llmModel: 'qwen3:8b' });
    const fetchMock = jest.fn(async () =>
      ({ ok: true, json: async () => ({ message: { content: '<think>越文翻成中文\n判斷語氣</think>\n\n報告總經理，會議已開始' } }) }) as never,
    );
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
    const translate = (service as unknown as { translate: (t: string, p: { key: string }) => Promise<string> }).translate.bind(service);
    expect(await translate('Báo cáo Giám đốc', { key: 'vi:zh-tw' } as never)).toBe('報告總經理，會議已開始');
  });

  it('lists models from the right URL per provider (keeps Groq /openai/v1 prefix)', async () => {
    const urls: string[] = [];
    const fetchMock = jest.fn(async (url: string) => {
      urls.push(String(url));
      return { ok: true, json: async () => ({ models: [{ name: 'm' }], data: [{ id: 'm' }] }) } as never;
    });
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
    const svc = service as unknown as {
      listModels: (p: { provider: string; endpoint: string; apiKey: string }) => Promise<string[]>;
    };
    await svc.listModels({ provider: 'ollama', endpoint: 'http://192.168.40.168:11434/api/chat', apiKey: '' });
    await svc.listModels({ provider: 'groq', endpoint: 'https://api.groq.com/openai/v1/chat/completions', apiKey: 'k' });
    await svc.listModels({ provider: 'openai', endpoint: 'https://api.openai.com/v1/chat/completions', apiKey: 'k' });

    expect(urls[0]).toBe('http://192.168.40.168:11434/api/tags');
    expect(urls[1]).toBe('https://api.groq.com/openai/v1/models'); // prefix preserved
    expect(urls[2]).toBe('https://api.openai.com/v1/models');
  });

  it('backfills the stored key only when the probe targets the saved endpoint (no key exfil on a changed endpoint)', async () => {
    poke({ llmProvider: 'groq', llmEndpoint: 'https://api.groq.com/openai/v1/chat/completions', llmApiKey: 'secret' });
    const auth: (string | undefined)[] = [];
    const fetchMock = jest.fn(async (_url: string, init?: { headers?: Record<string, string> }) => {
      auth.push(init?.headers?.authorization);
      return { ok: true, json: async () => ({ data: [{ id: 'm' }] }) } as never;
    });
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
    const svc = service as unknown as {
      listModels: (p: { provider: string; endpoint: string; apiKey: string }) => Promise<string[]>;
    };
    // Same endpoint, blank key → stored key is backfilled.
    await svc.listModels({ provider: 'groq', endpoint: 'https://api.groq.com/openai/v1/chat/completions', apiKey: '' });
    // Attacker-controlled endpoint, blank key → key must NOT be sent.
    await svc.listModels({ provider: 'groq', endpoint: 'https://evil.example/v1/chat/completions', apiKey: '' });
    expect(auth[0]).toBe('Bearer secret');
    expect(auth[1]).toBeUndefined();
  });

  it('falls back to the next model when the primary model call fails', async () => {
    poke({
      llmProvider: 'ollama',
      llmEndpoint: 'http://x/api/chat',
      llmModel: 'primary',
      llmFallbackModels: ['backup'],
    });
    const tried: string[] = [];
    const fetchMock = jest.fn(async (_url: string, init: { body: string }) => {
      const model = JSON.parse(init.body).model as string;
      tried.push(model);
      if (model === 'primary') return { ok: false, status: 500 } as never;
      return { ok: true, json: async () => ({ message: { content: 'dịch xong' } }) } as never;
    });
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;

    const translate = (service as unknown as {
      translate: (t: string, p: { key: string }) => Promise<string>;
    }).translate.bind(service);
    const out = await translate('你好', { key: 'zh-tw:vi' } as never);

    expect(tried).toEqual(['primary', 'backup']);
    expect(out).toBe('dịch xong');
  });

  it('routes to the OpenAI-compatible shape and parses choices when provider=openai', async () => {
    poke({
      llmProvider: 'openai',
      llmEndpoint: 'https://api.openai.com/v1/chat/completions',
      llmApiKey: 'sk-x',
    });
    let authHeader = '';
    const fetchMock = jest.fn(async (_url: string, init: { headers: Record<string, string> }) => {
      authHeader = init.headers.authorization;
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'xin chào' } }] }) } as never;
    });
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;

    const translate = (service as unknown as {
      translate: (t: string, p: { key: string }) => Promise<string>;
    }).translate.bind(service);
    const out = await translate('你好', { key: 'zh-tw:vi' } as never);

    expect(out).toBe('xin chào');
    expect(authHeader).toBe('Bearer sk-x');
  });
});
