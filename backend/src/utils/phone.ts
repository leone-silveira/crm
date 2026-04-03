/**
 * Normalize a phone number to the same format Baileys uses when processing
 * incoming WhatsApp messages. This ensures consistent DB lookups.
 *
 * Baileys strips +, spaces, dashes, and leading zeros from remoteJid.
 * Any phone stored differently will produce a different contact/conversation.
 */
export function normalizePhone(phone: string): string {
  return phone.replace(/[\s\-\+\(\)]/g, '').replace(/^0+/, '')
}
