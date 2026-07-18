import { resolveMentionNames, InboundMapperCtx } from './baileys-inbound-mapper';

function ctxWith(store: { displayName(id: string): string; resolvePhone(id: string): string | null }): InboundMapperCtx {
  return { sessionStore: store } as unknown as InboundMapperCtx;
}

describe('resolveMentionNames', () => {
  it('replaces a known mention with the display name', () => {
    const ctx = ctxWith({ displayName: id => (id === '111@c.us' ? 'Alice' : '111'), resolvePhone: () => null });
    expect(resolveMentionNames(ctx, 'hi @111', ['111@c.us'])).toBe('hi @Alice');
  });

  it('resolves an unnamed @lid mention via lid->phone and names it from the phone JID', () => {
    const ctx = ctxWith({
      displayName: id => (id === '84396422018@s.whatsapp.net' ? 'N.K.Cuong' : '61998440124575'),
      resolvePhone: id => (id === '61998440124575@lid' ? '84396422018' : null),
    });
    expect(resolveMentionNames(ctx, 'hi @61998440124575', ['61998440124575@lid'])).toBe('hi @N.K.Cuong');
  });

  it('leaves an unresolvable @lid mention untouched', () => {
    const ctx = ctxWith({ displayName: id => id.split('@')[0], resolvePhone: () => null });
    expect(resolveMentionNames(ctx, 'hi @222', ['222@lid'])).toBe('hi @222');
  });
});
