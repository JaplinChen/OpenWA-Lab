import { z } from 'zod';

/** Shared session-id input schema for every message tool. */
export const sessionId = z.string().min(1).describe('Session UUID (the session id, not the name)');
