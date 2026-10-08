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
