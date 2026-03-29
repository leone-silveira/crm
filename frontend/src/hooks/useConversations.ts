import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { conversationsService } from '../services/conversations.service'
import type { ConversationStatus } from '../types'
import { useConversationStore } from '../store/conversation.store'
import { useEffect } from 'react'

export function useConversations(params?: {
  status?: ConversationStatus
  assignedToId?: string
  page?: number
}) {
  const setConversations = useConversationStore((s) => s.setConversations)
  const qc = useQueryClient()

  const query = useQuery({
    queryKey: ['conversations', params],
    queryFn: () => conversationsService.list(params),
    refetchInterval: 30000,
  })

  useEffect(() => {
    if (query.data?.data) setConversations(query.data.data)
  }, [query.data])

  // Listen for real-time refresh events (new conversations from webhooks)
  useEffect(() => {
    const handler = () => qc.invalidateQueries({ queryKey: ['conversations'] })
    window.addEventListener('conversations:refresh', handler)
    return () => window.removeEventListener('conversations:refresh', handler)
  }, [qc])

  return query
}

export function useConversation(id: string) {
  return useQuery({
    queryKey: ['conversation', id],
    queryFn: () => conversationsService.get(id),
    enabled: !!id,
  })
}

export function useAssignConversation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, assignedToId }: { id: string; assignedToId: string | null }) =>
      conversationsService.assign(id, assignedToId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['conversations'] }),
  })
}

export function useUpdateConversationStatus() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: ConversationStatus }) =>
      conversationsService.updateStatus(id, status),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['conversations'] }),
  })
}
