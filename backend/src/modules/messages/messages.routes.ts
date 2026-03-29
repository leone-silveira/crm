import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../config/database'
import { authenticate } from '../../middleware/authenticate'
import { notFound } from '../../utils/errors'
import { baileysManager } from '../../services/baileys.service'
import { getPaginationParams } from '../../utils/pagination'
import { env } from '../../config/env'
import * as fs from 'fs'
import * as path from 'path'
import { pipeline } from 'stream/promises'
import { randomUUID } from 'crypto'

export async function messagesRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticate] }

  // Get messages for a conversation (paginated, newest first)
  app.get('/conversation/:conversationId', auth, async (req) => {
    const { conversationId } = req.params as { conversationId: string }
    const query = req.query as any
    const { limit, skip } = getPaginationParams({ page: query.page, limit: query.limit ?? 50 })

    const conv = await prisma.conversation.findUnique({ where: { id: conversationId } })
    if (!conv) throw notFound('Conversation')

    const [messages, total] = await prisma.$transaction([
      prisma.message.findMany({
        where: { conversationId },
        skip,
        take: limit,
        orderBy: { timestamp: 'desc' },
      }),
      prisma.message.count({ where: { conversationId } }),
    ])

    return { messages: messages.reverse(), total, hasMore: skip + limit < total }
  })

  // Upload file
  app.post('/upload', auth, async (req, reply) => {
    const file = await req.file()
    if (!file) return reply.status(400).send({ message: 'No file uploaded' })

    const ext = path.extname(file.filename) || ''
    const fileName = `${randomUUID()}${ext}`
    const uploadsDir = path.join(process.cwd(), 'uploads')
    fs.mkdirSync(uploadsDir, { recursive: true })
    const filePath = path.join(uploadsDir, fileName)

    await pipeline(file.file, fs.createWriteStream(filePath))

    const backendUrl = env.BACKEND_URL ?? `http://localhost:${env.PORT ?? 3000}`
    const url = `${backendUrl}/uploads/${fileName}`

    return reply.status(201).send({
      url,
      fileName: file.filename,
      mimeType: file.mimetype,
    })
  })

  // Send message
  app.post('/send', auth, async (req, reply) => {
    const body = z
      .object({
        conversationId: z.string(),
        text: z.string().optional(),
        mediaUrl: z.string().optional(),
        fileName: z.string().optional(),
        mimeType: z.string().optional(),
        type: z.enum(['TEXT', 'IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT']).default('TEXT'),
      })
      .parse(req.body)

    const conv = await prisma.conversation.findUnique({
      where: { id: body.conversationId },
      include: { contact: true, instance: true },
    })
    if (!conv) throw notFound('Conversation')

    const instanceName = conv.instance?.name ?? 'default'
    let evolutionId: string | undefined

    try {
      if (body.type === 'TEXT') {
        const response = await baileysManager.sendText(
          instanceName,
          conv.contact.phone,
          body.text ?? '',
        )
        evolutionId = response?.key?.id ?? undefined
      } else if (body.mediaUrl) {
        const response = await baileysManager.sendMedia(instanceName, conv.contact.phone, {
          type: body.type as 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT',
          url: body.mediaUrl,
          caption: body.text,
          fileName: body.fileName,
          mimeType: body.mimeType,
        })
        evolutionId = response?.key?.id ?? undefined
      }
    } catch (err) {
      console.error('Baileys send failed:', err)
    }

    const message = await prisma.message.create({
      data: {
        conversationId: body.conversationId,
        direction: 'OUTBOUND',
        type: body.type as any,
        body: body.text,
        mediaUrl: body.mediaUrl,
        mimeType: body.mimeType,
        fileName: body.fileName,
        evolutionId,
        status: evolutionId ? 'SENT' : 'PENDING',
        timestamp: new Date(),
      },
    })

    const updatedConv = await prisma.conversation.update({
      where: { id: body.conversationId },
      data: { lastMessageAt: new Date() },
      include: {
        contact: true,
        assignedTo: { select: { id: true, name: true } },
        instance: { select: { id: true, name: true } },
      },
    })

    // Broadcast to room
    app.io.to(`conversation:${body.conversationId}`).emit('message:new', message)
    // Notify conversation list so preview updates for other users
    const scope = updatedConv.clientAdminId
    const convWithMessage = { ...updatedConv, messages: [message] }
    if (scope) {
      app.io.to(`scope:${scope}`).emit('conversation:updated', convWithMessage)
    } else {
      app.io.emit('conversation:updated', convWithMessage)
    }

    return reply.status(201).send(message)
  })
}
