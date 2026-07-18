// Filters only apply to message.* events (the wildcard subscribes to them too).
export const supportsFilters = (events: string[]) => events.some(e => e === '*' || e.startsWith('message.'));

// Must stay aligned with the backend WEBHOOK_EVENTS: the API now rejects unknown
// event names, so offering e.g. the never-emitted 'session.connected' would 400 on save.
export const availableEventNames = [
  'message.received',
  'message.sent',
  'message.ack',
  'message.failed',
  'message.revoked',
  'message.reaction',
  'session.status',
  'session.qr',
  'session.authenticated',
  'session.disconnected',
  'group.join',
  'group.leave',
  'group.update',
  '*',
] as const;
