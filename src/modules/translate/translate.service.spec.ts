import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TranslateService } from './translate.service';
import { HookManager } from '../../core/hooks';
import { MessageService } from '../message/message.service';
import { IncomingMessage } from '../../engine/interfaces/whatsapp-engine.interface';

describe('TranslateService glossary', () => {
  let glossaryPath: string;
  let sent: { chatId: string; text: string }[];
  let service: TranslateService;

  const makeMsg = (body: string): IncomingMessage =>
    ({ chatId: 'g@g.us', from: 'u@c.us', author: 'u@c.us', body, type: 'text', isGroup: true, fromMe: false } as IncomingMessage);

  beforeEach(() => {
    glossaryPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gloss-')), 'glossary.json');
    process.env.TRANSLATE_GLOSSARY_PATH = glossaryPath;
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
});
