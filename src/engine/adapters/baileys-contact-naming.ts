import type { Contact as BaileysContact } from '@whiskeysockets/baileys';
import { parseWaId, userPart } from '../identity/wa-id';

// Contact display-name resolution for BaileysSessionStore, over the store's contact/lid maps.

function contactDisplayName(contacts: Map<string, BaileysContact>, id: string): string | undefined {
  const c = contacts.get(id);
  return c ? (c.name ?? c.verifiedName ?? c.notify ?? undefined) : undefined;
}

/**
 * Best-known display name for a chat id when Baileys gave the chat no title (#369). Prefers the saved
 * contact name, then verifiedName, then pushName (`notify`); for a @lid chat it also tries the contact
 * behind the resolved phone. Falls back to the raw user-part so a number/lid is never shown as a JID.
 */
export function resolveContactName(
  contacts: Map<string, BaileysContact>,
  lidToPn: Map<string, string>,
  id: string,
): string {
  const direct = contactDisplayName(contacts, id);
  if (direct) {
    return direct;
  }
  const parsed = parseWaId(id);
  if (parsed.kind === 'lid') {
    const lidJid = `${parsed.userPart}@lid`;
    const pn = lidToPn.get(lidJid) ?? lidToPn.get(id) ?? (contacts.get(lidJid) ?? contacts.get(id))?.phoneNumber;
    if (pn) {
      const viaPhone =
        contactDisplayName(contacts, pn) ??
        contactDisplayName(contacts, `${userPart(pn)}@s.whatsapp.net`) ??
        contactDisplayName(contacts, `${userPart(pn)}@c.us`);
      if (viaPhone) {
        return viaPhone;
      }
    }
  }
  return userPart(id);
}
