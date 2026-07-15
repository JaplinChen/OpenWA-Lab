import type { MessageService } from '../../../modules/message/message.service';
import type { ToolDescriptor } from '../tool-descriptor';
import { messageReadTools } from './message-read.tools';
import { messageSendTools } from './message-send.tools';
import { messageActionTools } from './message-action.tools';

/**
 * All message agent-tools, grouped by responsibility across sibling files (read / send / action).
 * The order (read → send → action) is preserved so the registered tool list is unchanged.
 */
export function messageTools(message: MessageService): ToolDescriptor[] {
  return [...messageReadTools(message), ...messageSendTools(message), ...messageActionTools(message)];
}
