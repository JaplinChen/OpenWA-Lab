import { resolveSenderName } from './baileys-inbound-mapper';
import type { InboundMapperCtx } from './baileys-inbound-mapper';
import type { IncomingMessage } from '../interfaces/whatsapp-engine.interface';

const ctxWith = (name: string): Pick<InboundMapperCtx, 'sessionStore'> =>
  ({ sessionStore: { displayName: () => name } } as unknown as Pick<InboundMapperCtx, 'sessionStore'>);

const msg = (over: Partial<IncomingMessage>): Pick<IncomingMessage, 'isGroup' | 'fromMe' | 'contact'> =>
  ({ isGroup: true, fromMe: false, ...over } as IncomingMessage);

describe('resolveSenderName', () => {
  it('falls back to the store name when the message carried no pushName', () => {
    expect(resolveSenderName(ctxWith('陳嘉元'), msg({}), '84900000001@s.whatsapp.net')).toBe('陳嘉元');
  });

  it('keeps the message pushName (returns undefined so the caller does not override)', () => {
    expect(resolveSenderName(ctxWith('陳嘉元'), msg({ contact: { pushName: 'Alice' } }), '111@x')).toBeUndefined();
  });

  it('returns undefined for non-group, fromMe, unknown sender, or when the store only echoes digits', () => {
    expect(resolveSenderName(ctxWith('x'), msg({ isGroup: false }), '111@x')).toBeUndefined();
    expect(resolveSenderName(ctxWith('x'), msg({ fromMe: true }), '111@x')).toBeUndefined();
    expect(resolveSenderName(ctxWith('x'), msg({}), undefined)).toBeUndefined();
    // store returns the raw digits (nothing known) -> not a real name
    expect(resolveSenderName(ctxWith('111'), msg({}), '111@x')).toBeUndefined();
  });
});
