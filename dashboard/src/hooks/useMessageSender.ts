import { useState, useEffect, useRef } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { messageApi, type Chat } from '../services/api';
import { type ChatMessageView } from '../utils/chatMessages';
import { messagesQueryKey } from './useChatMessages';
import { messageTypeFromMime } from '../components/chats/chatMedia';

export interface PendingAttachment {
  file: File;
  base64: string;
  mimetype: string;
  filename: string;
}

interface UseMessageSenderParams {
  selectedSessionId: string;
  activeChat: Chat | null;
  queryClient: QueryClient;
  appendMessage: (sessionId: string, chatId: string, msg: ChatMessageView) => void;
  updateMessage: (
    sessionId: string,
    chatId: string,
    msgId: string,
    patch: Partial<ChatMessageView>,
  ) => void;
  onMessageAppended: (direction: 'incoming' | 'outgoing') => void;
  setChats: React.Dispatch<React.SetStateAction<Chat[]>>;
  showErrorToast: (title: string, detail?: string) => void;
  t: (key: string) => string;
}

export function useMessageSender({
  selectedSessionId,
  activeChat,
  queryClient,
  appendMessage,
  updateMessage,
  onMessageAppended,
  setChats,
  showErrorToast,
  t,
}: UseMessageSenderParams) {
  const [messageInput, setMessageInput] = useState<string>('');
  const [sending, setSending] = useState<boolean>(false);
  const [attachment, setAttachment] = useState<PendingAttachment | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<ChatMessageView | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Revoke the object URL created for an image-attachment preview once it is replaced, cleared, or
  // the page unmounts. The cleanup runs with the previous value on every change, so this single
  // effect covers all paths (new file, remove, session switch) — otherwise each preview leaks a
  // blob held for the lifetime of the document.
  useEffect(() => {
    if (!previewUrl) return;
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const clearAttachment = () => {
    setAttachment(null);
    setPreviewUrl(null);
  };

  // Handle file selection & base64 conversion
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.type.startsWith('image/')) {
      setPreviewUrl(URL.createObjectURL(file));
    } else {
      setPreviewUrl(null);
    }

    const reader = new FileReader();
    reader.onload = event => {
      const dataUrl = event.target?.result as string;
      const base64Data = dataUrl.split(',')[1];
      setAttachment({ file, base64: base64Data, mimetype: file.type, filename: file.name });
    };
    reader.readAsDataURL(file);
  };

  const handleRemoveAttachment = () => {
    clearAttachment();
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const triggerFileSelect = () => {
    fileInputRef.current?.click();
  };

  // Handle sending a message / media
  const handleSend = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!selectedSessionId || !activeChat || sending) return;

    const textToSend = messageInput.trim();
    if (!textToSend && !attachment) return;

    setMessageInput('');
    setSending(true);

    const tempId = `temp_${Date.now()}`;
    const tempMessage: ChatMessageView = {
      id: tempId,
      chatId: activeChat.id,
      from: 'me',
      to: activeChat.id,
      body: attachment
        ? attachment.mimetype.startsWith('image/') ||
          attachment.mimetype.startsWith('video/') ||
          attachment.mimetype.startsWith('audio/')
          ? textToSend
          : attachment.filename
        : textToSend,
      type: attachment ? messageTypeFromMime(attachment.mimetype) : 'text',
      direction: 'outgoing',
      status: 'pending',
      createdAt: new Date().toISOString(),
      metadata: attachment
        ? {
            media: {
              mimetype: attachment.mimetype,
              filename: attachment.filename,
              data: attachment.base64,
            },
          }
        : replyingTo
          ? {
              quotedMessage: {
                id: replyingTo.waMessageId || replyingTo.id,
                body: replyingTo.type !== 'text' ? `[${replyingTo.type}]` : replyingTo.body,
              },
            }
          : undefined,
    };

    appendMessage(selectedSessionId, activeChat.id, tempMessage);
    onMessageAppended('outgoing');

    const currentAttachment = attachment;
    const currentReplyingTo = replyingTo;
    handleRemoveAttachment();
    setReplyingTo(null);

    try {
      let result;

      if (currentAttachment) {
        let mediaType: 'image' | 'video' | 'audio' | 'document' = 'document';
        const mime = currentAttachment.mimetype;
        if (mime.startsWith('image/')) mediaType = 'image';
        else if (mime.startsWith('video/')) mediaType = 'video';
        else if (mime.startsWith('audio/')) mediaType = 'audio';

        result = await messageApi.sendMedia(selectedSessionId, activeChat.id, mediaType, {
          base64: currentAttachment.base64,
          mimetype: currentAttachment.mimetype,
          filename: currentAttachment.filename,
          caption: mediaType !== 'audio' ? textToSend : undefined,
        });
      } else if (currentReplyingTo) {
        result = await messageApi.reply(selectedSessionId, {
          chatId: activeChat.id,
          quotedMessageId: currentReplyingTo.waMessageId || currentReplyingTo.id,
          text: textToSend,
        });
      } else {
        result = await messageApi.sendText(selectedSessionId, activeChat.id, textToSend);
      }

      // Race guard: the realtime `message.sent` echo can arrive before this response and already
      // append the message by its real WA id (the dedup at receive time misses because the
      // optimistic placeholder still carries the temp id). If so, drop the placeholder instead of
      // renaming it — otherwise both the echo and the renamed temp render as duplicate bubbles.
      const sendKey = messagesQueryKey(selectedSessionId, activeChat.id);
      queryClient.setQueryData<ChatMessageView[]>(sendKey, (prev = []) => {
        const echoAlreadyAdded = prev.some(
          m => m.id === result.messageId || m.waMessageId === result.messageId,
        );
        if (echoAlreadyAdded) {
          return prev.filter(m => m.id !== tempId);
        }
        return prev.map(m =>
          m.id === tempId
            ? { ...m, id: result.messageId, waMessageId: result.messageId, status: 'sent' }
            : m,
        );
      });

      // Update sidebar chat list (move active chat to the top with the new snippet)
      setChats(prevChats => {
        const chatIndex = prevChats.findIndex(c => c.id === activeChat.id);
        if (chatIndex === -1) return prevChats;
        const updatedChats = [...prevChats];
        const target = { ...updatedChats[chatIndex] };
        target.lastMessage = currentAttachment
          ? `[${currentAttachment.mimetype.split('/')[0]}]`
          : textToSend;
        target.timestamp = Math.floor(Date.now() / 1000);
        updatedChats.splice(chatIndex, 1);
        updatedChats.unshift(target);
        return updatedChats;
      });
    } catch (err) {
      showErrorToast(t('chats.errors.send'), err instanceof Error ? err.message : undefined);
      updateMessage(selectedSessionId, activeChat.id, tempId, { status: 'failed' });
    } finally {
      setSending(false);
    }
  };

  return {
    messageInput,
    setMessageInput,
    sending,
    attachment,
    previewUrl,
    replyingTo,
    setReplyingTo,
    fileInputRef,
    clearAttachment,
    handleFileChange,
    handleRemoveAttachment,
    triggerFileSelect,
    handleSend,
  };
}
