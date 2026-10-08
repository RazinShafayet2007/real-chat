export interface ChatMessage {
  id: string;
  user: string;
  text: string;
  at: number;
}

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