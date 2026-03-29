import { create } from 'zustand'
import type { Conversation, Message, ConversationStatus } from '../types'

interface ConversationFilters {
  status?: ConversationStatus
  assignedToId?: string
  search?: string
}

interface ConversationState {
  conversations: Conversation[]
  activeConversationId: string | null
  filters: ConversationFilters
  setConversations: (conversations: Conversation[]) => void
  upsertConversation: (conversation: Conversation) => void
  setActiveConversation: (id: string | null) => void
  setFilters: (filters: ConversationFilters) => void
  incrementUnread: (conversationId: string) => void
  clearUnread: (conversationId: string) => void
  appendMessage: (conversationId: string, message: Message) => void
}

export const useConversationStore = create<ConversationState>((set) => ({
  conversations: [],
  activeConversationId: null,
  filters: {},

  setConversations: (conversations) => set({ conversations }),

  upsertConversation: (conversation) =>
    set((state) => {
      const index = state.conversations.findIndex((c) => c.id === conversation.id)
      if (index === -1) {
        return { conversations: [conversation, ...state.conversations] }
      }
      const updated = [...state.conversations]
      updated[index] = { ...updated[index], ...conversation }
      // Re-sort by lastMessageAt
      updated.sort((a, b) => {
        const aTime = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0
        const bTime = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0
        return bTime - aTime
      })
      return { conversations: updated }
    }),

  setActiveConversation: (id) => set({ activeConversationId: id }),

  setFilters: (filters) => set({ filters }),

  incrementUnread: (conversationId) =>
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === conversationId ? { ...c, unreadCount: c.unreadCount + 1 } : c,
      ),
    })),

  clearUnread: (conversationId) =>
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === conversationId ? { ...c, unreadCount: 0 } : c,
      ),
    })),

  appendMessage: (conversationId, message) =>
    set((state) => {
      const updated = state.conversations.map((c) =>
        c.id === conversationId
          ? { ...c, lastMessageAt: message.timestamp, messages: [message] }
          : c,
      )
      // Re-sort by lastMessageAt so newest conversation goes to top
      updated.sort((a, b) => {
        const aTime = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0
        const bTime = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0
        return bTime - aTime
      })
      return { conversations: updated }
    }),
}))
