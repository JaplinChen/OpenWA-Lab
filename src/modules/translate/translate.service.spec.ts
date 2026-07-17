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

  it('applies the sender override to the @mention before sending the prompt to Ollama', async () => {
    service.addSender('200859128434777', '總經理');
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

  it('falls back to the next model when the primary model call fails', async () => {
    Object.assign(service as unknown as Record<string, unknown>, {
      provider: 'ollama',
      endpoint: 'http://x/api/chat',
      model: 'primary',
      fallbackModels: ['backup'],
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
    // Poke private fields directly — updateConfig() would persist to the shared data/translate-config.json.
    Object.assign(service as unknown as Record<string, unknown>, {
      provider: 'openai',
      endpoint: 'https://api.openai.com/v1/chat/completions',
      apiKey: 'sk-x',
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
