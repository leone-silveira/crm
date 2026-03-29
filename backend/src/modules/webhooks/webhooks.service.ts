import { FastifyInstance } from 'fastify'
import { prisma } from '../../config/database'
import { evolutionApi } from '../../services/evolution-api.service'
import { logger } from '../../utils/logger'
import { redis } from '../../config/redis'
import { categorizeMessage } from '../../services/categorization.service'
import { calculateSlaDeadline, getPriorityFromVip } from '../../services/sla.service'

interface EvolutionWebhookPayload {
  event: string
  instance: string
  data: any
  destination?: string
  date_time?: string
  sender?: string
  server_url?: string
  apikey?: string
}

export async function processWebhookEvent(app: FastifyInstance, payload: EvolutionWebhookPayload) {
  const { event, instance: instanceName, data } = payload

  logger.info({ event, instanceName, dataKeys: Object.keys(data ?? {}) }, 'Webhook received')

  switch (event) {
    case 'messages.upsert':
      await handleMessageUpsert(app, instanceName, data)
      break
    case 'messages.update':
      await handleMessageUpdate(app, instanceName, data)
      break
    case 'connection.update':
      await handleConnectionUpdate(app, instanceName, data)
      break
    case 'qrcode.updated':
      await handleQRUpdate(app, instanceName, data)
      break
    default:
      logger.debug({ event }, 'Unhandled webhook event')
  }
}

async function handleMessageUpsert(app: FastifyInstance, instanceName: string, data: any) {
  const messages = Array.isArray(data) ? data : [data]

  for (const msg of messages) {
    if (!msg?.key?.remoteJid) continue
    // Skip group messages and status updates
    if (msg.key.remoteJid.endsWith('@g.us') || msg.key.remoteJid === 'status@broadcast') continue
    // Skip protocol/system messages that have no actual content
    if (msg.message?.protocolMessage || msg.message?.reactionMessage || msg.message?.senderKeyDistributionMessage) continue

    const phone = msg.key.remoteJid.replace('@s.whatsapp.net', '')
    const fromMe = msg.key.fromMe ?? false
    const evolutionId = msg.key.id

    // Skip messages from the instance's own number (avoid self-contact)
    if (fromMe) {
      // Still process outbound messages but check if phone is the instance's own number
      const instanceRecord = await prisma.whatsAppInstance.findFirst({ where: { name: instanceName } })
      if (instanceRecord?.phone && instanceRecord.phone === phone) continue
    }

    // Upsert contact
    const contact = await prisma.contact.upsert({
      where: { phone },
      update: {
        pushName: msg.pushName ?? undefined,
      },
      create: {
        phone,
        name: msg.pushName ?? undefined,
        pushName: msg.pushName ?? undefined,
      },
    })

    // Fetch profile picture if not set
    if (!contact.profilePic) {
      const pic = await evolutionApi.getProfilePicture(instanceName, phone).catch(() => undefined)
      if (pic) {
        await prisma.contact.update({ where: { id: contact.id }, data: { profilePic: pic } })
      }
    }

    // Get or create instance record
    const instance = await prisma.whatsAppInstance.upsert({
      where: { name: instanceName },
      update: {},
      create: { name: instanceName, displayName: instanceName },
    })

    // Extract message content early for categorization
    const msgContent = extractMessageContent(msg)
    if (!msgContent) continue  // Skip unsupported message types silently

    // Determine priority and category for new conversations
    const priority = getPriorityFromVip(contact.isVip)
    const category = categorizeMessage(msgContent.body ?? '')
    const slaDeadline = calculateSlaDeadline(priority)

    // Upsert conversation (inherit clientAdminId from instance)
    const conversation = await prisma.conversation.upsert({
      where: { contactId_instanceId: { contactId: contact.id, instanceId: instance.id } },
      update: {
        lastMessageAt: new Date(),
        status: fromMe ? undefined : 'OPEN',
        unreadCount: fromMe ? undefined : { increment: 1 },
      },
      create: {
        contactId: contact.id,
        instanceId: instance.id,
        clientAdminId: instance.clientAdminId,
        status: 'OPEN',
        category,
        priority,
        slaDeadline,
        lastMessageAt: new Date(),
        unreadCount: fromMe ? 0 : 1,
      },
      include: {
        contact: true,
        assignedTo: { select: { id: true, name: true } },
        instance: { select: { id: true, name: true } },
      },
    })

    // Upsert message (avoid duplicates from Evolution retries)
    const message = await prisma.message.upsert({
      where: { evolutionId },
      update: { status: fromMe ? 'SENT' : 'READ' },
      create: {
        conversationId: conversation.id,
        evolutionId,
        direction: fromMe ? 'OUTBOUND' : 'INBOUND',
        type: msgContent.type as any,
        body: msgContent.body,
        mediaUrl: msgContent.mediaUrl,
        mimeType: msgContent.mimeType,
        fileName: msgContent.fileName,
        timestamp: new Date((msg.messageTimestamp ?? Date.now() / 1000) * 1000),
        status: fromMe ? 'SENT' : 'DELIVERED',
      },
    })

    // Broadcast via Socket.io — scoped
    const conversationWithMessage = { ...conversation, messages: [message] }
    app.io.to(`conversation:${conversation.id}`).emit('message:new', message)
    if (conversation.clientAdminId) {
      app.io.to(`scope:${conversation.clientAdminId}`).emit('conversation:updated', conversationWithMessage)
      app.io.to(`scope:${conversation.clientAdminId}`).emit('conversations:refresh')
    } else {
      app.io.emit('conversation:updated', conversationWithMessage)
      app.io.emit('conversations:refresh')
    }

    logger.info({ conversationId: conversation.id, phone, fromMe }, 'Message processed')
  }
}

async function handleMessageUpdate(app: FastifyInstance, _instanceName: string, data: any) {
  const updates = Array.isArray(data) ? data : [data]
  for (const update of updates) {
    const evolutionId = update?.key?.id
    if (!evolutionId) continue

    const statusMap: Record<string, string> = {
      PENDING: 'PENDING',
      SERVER_ACK: 'SENT',
      DELIVERY_ACK: 'DELIVERED',
      READ: 'READ',
      PLAYED: 'READ',
    }

    const newStatus = statusMap[update.update?.status] ?? 'SENT'
    const message = await prisma.message.updateMany({
      where: { evolutionId },
      data: { status: newStatus as any },
    })

    if (message.count > 0) {
      app.io.emit('message:status', { evolutionId, status: newStatus })
    }
  }
}

async function handleConnectionUpdate(app: FastifyInstance, instanceName: string, data: any) {
  const state = data?.state ?? data?.connection
  const statusReason = data?.statusReason
  await prisma.whatsAppInstance.updateMany({
    where: { name: instanceName },
    data: { status: state ?? 'unknown' },
  })
  app.io.emit('instance:status', { instanceName, state })
  logger.info({ instanceName, state, statusReason }, 'Instance connection updated')
}

async function handleQRUpdate(app: FastifyInstance, instanceName: string, data: any) {
  logger.info({ instanceName, dataRaw: JSON.stringify(data) }, 'QR webhook payload')
  const qrBase64 = data?.qrcode?.base64 ?? data?.base64
  if (qrBase64) {
    await redis.setex(`qr:${instanceName}`, 60, qrBase64)
    app.io.emit('instance:qr', { instanceName, qrCode: qrBase64 })
    logger.info({ instanceName }, 'QR cached and emitted via socket')
  } else {
    logger.warn({ instanceName, data }, 'QR webhook received but no base64 found')
  }
}

function extractMessageContent(msg: any) {
  let content = msg.message ?? {}

  // Unwrap ephemeral, viewOnce, and edited message wrappers
  if (content.ephemeralMessage) content = content.ephemeralMessage.message ?? content
  if (content.viewOnceMessage) content = content.viewOnceMessage.message ?? content
  if (content.viewOnceMessageV2) content = content.viewOnceMessageV2.message ?? content
  if (content.editedMessage) content = content.editedMessage.message ?? content
  if (content.documentWithCaptionMessage) content = content.documentWithCaptionMessage.message ?? content

  if (content.conversation || content.extendedTextMessage) {
    return {
      type: 'TEXT',
      body: content.conversation ?? content.extendedTextMessage?.text ?? '',
      mediaUrl: undefined,
      mimeType: undefined,
      fileName: undefined,
    }
  }

  if (content.imageMessage) {
    return {
      type: 'IMAGE',
      body: content.imageMessage.caption,
      mediaUrl: content.imageMessage.url,
      mimeType: content.imageMessage.mimetype,
      fileName: undefined,
    }
  }

  if (content.videoMessage) {
    return {
      type: 'VIDEO',
      body: content.videoMessage.caption,
      mediaUrl: content.videoMessage.url,
      mimeType: content.videoMessage.mimetype,
      fileName: undefined,
    }
  }

  if (content.audioMessage || content.pttMessage) {
    const audio = content.audioMessage ?? content.pttMessage
    return {
      type: 'AUDIO',
      body: undefined,
      mediaUrl: audio.url,
      mimeType: audio.mimetype,
      fileName: undefined,
    }
  }

  if (content.documentMessage) {
    return {
      type: 'DOCUMENT',
      body: content.documentMessage.caption,
      mediaUrl: content.documentMessage.url,
      mimeType: content.documentMessage.mimetype,
      fileName: content.documentMessage.fileName,
    }
  }

  if (content.stickerMessage) {
    return { type: 'STICKER', body: undefined, mediaUrl: content.stickerMessage.url, mimeType: 'image/webp', fileName: undefined }
  }

  // Handle button/list responses as text
  if (content.buttonsResponseMessage) {
    return { type: 'TEXT', body: content.buttonsResponseMessage.selectedDisplayText ?? '', mediaUrl: undefined, mimeType: undefined, fileName: undefined }
  }
  if (content.listResponseMessage) {
    return { type: 'TEXT', body: content.listResponseMessage.title ?? '', mediaUrl: undefined, mimeType: undefined, fileName: undefined }
  }
  if (content.templateButtonReplyMessage) {
    return { type: 'TEXT', body: content.templateButtonReplyMessage.selectedDisplayText ?? '', mediaUrl: undefined, mimeType: undefined, fileName: undefined }
  }

  // Contact and location messages
  if (content.contactMessage || content.contactsArrayMessage) {
    const name = content.contactMessage?.displayName ?? 'Contact'
    return { type: 'TEXT', body: `📇 ${name}`, mediaUrl: undefined, mimeType: undefined, fileName: undefined }
  }
  if (content.locationMessage || content.liveLocationMessage) {
    return { type: 'TEXT', body: '📍 Location', mediaUrl: undefined, mimeType: undefined, fileName: undefined }
  }

  // Skip unknown types silently instead of creating [Unsupported] messages
  return null
}
