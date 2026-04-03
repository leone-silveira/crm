import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../config/database'
import { authenticate } from '../../middleware/authenticate'
import { notFound, forbidden } from '../../utils/errors'
import { getPaginationParams, buildPaginatedResult } from '../../utils/pagination'
import { canSeeAllConversations } from '../../utils/roles'
import { normalizePhone } from '../../utils/phone'

export async function conversationsRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticate] }

  app.get('/', auth, async (req) => {
    const query = req.query as any
    const { page, limit, skip } = getPaginationParams(query)

    const where: any = {}
    if (query.status) where.status = query.status
    if (query.assignedToId) where.assignedToId = query.assignedToId
    if (query.instanceId) where.instanceId = query.instanceId

    // Scope filtering
    if (req.user.role === 'SUPER_ADMIN') {
      if (query.clientAdminId) where.clientAdminId = query.clientAdminId
    } else if (req.user.role === 'CLIENT_ADMIN') {
      where.clientAdminId = req.user.id
    } else if (req.user.role === 'WORKER_TRUST') {
      where.clientAdminId = req.scope
    } else {
      // WORKER: sees own assigned + OPEN unassigned in scope
      where.clientAdminId = req.scope
      where.OR = [
        { assignedToId: req.user.id },
        { assignedToId: null, status: 'OPEN' },
      ]
    }

    const [conversations, total] = await prisma.$transaction([
      prisma.conversation.findMany({
        where,
        skip,
        take: limit,
        include: {
          contact: { include: { tags: { take: 10, include: { tag: true } } } },
          assignedTo: { select: { id: true, name: true } },
          instance: { select: { id: true, name: true, displayName: true } },
          messages: {
            take: 1,
            orderBy: { timestamp: 'desc' },
            select: { body: true, type: true, direction: true, timestamp: true },
          },
        },
        orderBy: { lastMessageAt: 'desc' },
      }),
      prisma.conversation.count({ where }),
    ])

    return buildPaginatedResult(conversations, total, page, limit)
  })

  // ─── Start a new conversation with a contact ────────────────────────────
  app.post('/start', auth, async (req, reply) => {
    const body = z
      .object({
        phone: z.string().min(1),
        instanceId: z.string().optional(),
      })
      .parse(req.body)

    // Find or create the contact — normalize phone to match Baileys format
    const phone = normalizePhone(body.phone)
    const contact = await prisma.contact.upsert({
      where: { phone },
      update: {},
      create: { phone },
    })

    // Find an instance to use — prefer the specified one, else pick the first connected
    let instance
    if (body.instanceId) {
      instance = await prisma.whatsAppInstance.findUnique({ where: { id: body.instanceId } })
    }
    if (!instance) {
      const scopeWhere: any = { isActive: true }
      if (req.user.role === 'CLIENT_ADMIN') scopeWhere.clientAdminId = req.user.id
      else if (req.user.role !== 'SUPER_ADMIN') scopeWhere.clientAdminId = req.scope
      instance = await prisma.whatsAppInstance.findFirst({ where: scopeWhere, orderBy: { createdAt: 'asc' } })
    }
    if (!instance) return reply.status(400).send({ error: 'No active WhatsApp instance found' })

    // Find or create the conversation
    const conversation = await prisma.conversation.upsert({
      where: { contactId_instanceId: { contactId: contact.id, instanceId: instance.id } },
      update: {},
      create: {
        contactId: contact.id,
        instanceId: instance.id,
        clientAdminId: instance.clientAdminId,
        status: 'OPEN',
        lastMessageAt: new Date(),
        unreadCount: 0,
      },
      include: {
        contact: { include: { tags: { include: { tag: true } } } },
        assignedTo: { select: { id: true, name: true, email: true } },
        instance: { select: { id: true, name: true, displayName: true } },
      },
    })

    return reply.status(201).send(conversation)
  })

  app.get('/:id', auth, async (req) => {
    const { id } = req.params as { id: string }
    const conv = await prisma.conversation.findUnique({
      where: { id },
      include: {
        contact: { include: { tags: { include: { tag: true } } } },
        assignedTo: { select: { id: true, name: true, email: true } },
        instance: true,
      },
    })
    if (!conv) throw notFound('Conversation')

    // Scope check
    if (req.user.role !== 'SUPER_ADMIN') {
      if (conv.clientAdminId !== req.scope) throw forbidden()
      if (req.user.role === 'WORKER') {
        if (conv.assignedToId && conv.assignedToId !== req.user.id && conv.status !== 'OPEN') {
          throw forbidden()
        }
      }
    }

    // Reset unread count
    await prisma.conversation.update({ where: { id }, data: { unreadCount: 0 } })
    return { ...conv, unreadCount: 0 }
  })

  app.patch('/:id/assign', auth, async (req) => {
    const { id } = req.params as { id: string }
    const { assignedToId } = z
      .object({ assignedToId: z.string().nullable() })
      .parse(req.body)

    const conv = await prisma.conversation.findUnique({ where: { id } })
    if (!conv) throw notFound('Conversation')

    // Scope check
    if (req.user.role !== 'SUPER_ADMIN' && conv.clientAdminId !== req.scope) {
      throw forbidden()
    }

    // Workers can only self-assign unassigned conversations
    if (req.user.role === 'WORKER') {
      if (assignedToId !== req.user.id) throw forbidden('Workers can only self-assign')
      if (conv.assignedToId && conv.assignedToId !== req.user.id) throw forbidden('Already assigned to another worker')
    }

    // Verify target worker is in the same scope
    if (assignedToId) {
      const targetUser = await prisma.user.findUnique({ where: { id: assignedToId } })
      if (!targetUser) throw notFound('Target user')
      if (req.user.role !== 'SUPER_ADMIN') {
        const targetScope = targetUser.role === 'CLIENT_ADMIN' ? targetUser.id : targetUser.clientAdminId
        if (targetScope !== req.scope) throw forbidden('Cannot assign to user outside your team')
      }
    }

    const updated = await prisma.conversation.update({
      where: { id },
      data: {
        assignedToId,
        status: assignedToId ? 'IN_PROGRESS' : 'OPEN',
      },
      include: {
        contact: true,
        assignedTo: { select: { id: true, name: true } },
      },
    })

    // Broadcast via socket — scoped + global for SUPER_ADMIN
    app.io.to(`conversation:${id}`).emit('conversation:updated', updated)
    if (conv.clientAdminId) {
      app.io.to(`scope:${conv.clientAdminId}`).emit('conversations:refresh')
    }
    app.io.to('scope:global').emit('conversations:refresh')

    return updated
  })

  app.patch('/:id/status', auth, async (req) => {
    const { id } = req.params as { id: string }
    const { status } = z
      .object({
        status: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']),
      })
      .parse(req.body)

    const existing = await prisma.conversation.findUnique({ where: { id } })
    if (!existing) throw notFound('Conversation')

    // Scope check
    if (req.user.role !== 'SUPER_ADMIN' && existing.clientAdminId !== req.scope) {
      throw forbidden()
    }

    const conv = await prisma.conversation.update({
      where: { id },
      data: { status },
      include: { contact: true, assignedTo: { select: { id: true, name: true } } },
    })

    app.io.to(`conversation:${id}`).emit('conversation:updated', conv)
    if (existing.clientAdminId) {
      app.io.to(`scope:${existing.clientAdminId}`).emit('conversations:refresh')
    }
    app.io.to('scope:global').emit('conversations:refresh')

    return conv
  })

  // Stats — available to all authenticated users, scoped appropriately
  app.get('/stats/summary', auth, async (req) => {
    const scopeWhere: any = {}

    if (req.user.role === 'SUPER_ADMIN') {
      // Global stats — optionally filter by clientAdminId
      const query = req.query as any
      if (query.clientAdminId) scopeWhere.clientAdminId = query.clientAdminId
    } else if (req.user.role === 'CLIENT_ADMIN') {
      scopeWhere.clientAdminId = req.user.id
    } else {
      // WORKER / WORKER_TRUST — stats for their scope
      scopeWhere.clientAdminId = req.scope
    }

    const [statusGroups, totalMessages] = await prisma.$transaction([
      prisma.conversation.groupBy({
        by: ['status'],
        where: scopeWhere,
        _count: { _all: true },
        orderBy: { status: 'asc' },
      }),
      prisma.message.count({
        where: {
          createdAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) },
          ...(Object.keys(scopeWhere).length > 0 ? { conversation: scopeWhere } : {}),
        },
      }),
    ])

    const countMap = new Map(statusGroups.map((r: any) => [r.status, r._count._all]))
    return {
      open: countMap.get('OPEN') ?? 0,
      inProgress: countMap.get('IN_PROGRESS') ?? 0,
      resolved: countMap.get('RESOLVED') ?? 0,
      closed: countMap.get('CLOSED') ?? 0,
      totalMessages,
    }
  })
}
