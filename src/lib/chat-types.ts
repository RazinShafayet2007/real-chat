export type MessageKind = "text" | "sticker" | "gif";

export interface ChatMessage {
  id: string;
  user: string;
  text: string;
  at: number;
  kind?: MessageKind;
  imageUrl?: string;
  room?: string;
  expiresAt?: number | null;
}

export interface DmHistory {
  room: string;
  peer: { id?: string; sid?: string; name: string; email?: string; picture?: string };
  messages: ChatMessage[];
}

export const TTL_CHOICES = [
  { label: "Keep", seconds: 0 },
  { label: "10s", seconds: 10 },
  { label: "1m", seconds: 60 },
  { label: "1h", seconds: 3600 },
  { label: "24h", seconds: 86400 },
];

export interface TypingPayload {
  user: string;
  isTyping: boolean;
}

export interface ChatUser {
  id: string;
  username: string;
}

export interface ChatRoom {
  id: string;
  name: string;
  membersId: string[];
}

export type ChatEvent = 
  | { type: "message"; message: ChatMessage }
  | { type: "typing"; payload: TypingPayload }
  | { type: "read"; receipt: ReadReceipt };

export type MessageStatus = "sent" | "deliverd" | "read" | "failed";

export interface ReadReceipt {
  messageId: string;
  userId: string;
  readAt: number;
};

export interface ChatAttachment {
  id: string;
  name: string;
  url: string;
  mimeType: string;
  size: number;
};

export interface UserPresence {
  userId: string;
  status: "online" | "away" | "offline";
  lastSeenAt: number | null;
};