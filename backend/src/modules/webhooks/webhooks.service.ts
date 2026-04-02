import { FastifyInstance } from 'fastify'
import { prisma } from '../../config/database'
import { evolutionApi } from '../../services/evolution-api.service'
import { logger } from '../../utils/logger'
import { redis } from '../../config/redis'
import { isLidUser } from '@whiskeysockets/baileys'
import { categorizeMessage } from '../../services/categorization.service'
import { calculateSlaDeadline, getPriorityFromVip } from '../../services/sla.service'
import { downloadProfilePic } from '../../utils/downloadProfilePic'

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
    // Skip status updates
    if (msg.key.remoteJid === 'status@broadcast') continue
    // Skip protocol/system messages that have no actual content
    if (msg.message?.protocolMessage || msg.message?.reactionMessage || msg.message?.senderKeyDistributionMessage) continue

    const isGroup = msg.key.remoteJid.endsWith('@g.us')
    const isLid = isLidUser(msg.key.remoteJid)
    let rawPhone = isGroup
      ? msg.key.remoteJid
      : msg.key.remoteJid.replace(/@s\.whatsapp\.net$/, '').replace(/@lid$/, '')
    // LID JIDs can have a `:agent` or `:device` suffix (e.g. "5511999@lid:23:0") — strip it
    if (!isGroup) rawPhone = rawPhone.split(':')[0]
    // Resolve LID to real phone number
    if (isLid) {
      const resolved = await redis.get(`lid:${rawPhone}`).catch(() => null)
      if (resolved) {
        rawPhone = resolved
      } else {
        logger.info({ lid: rawPhone, remoteJid: msg.key.remoteJid }, 'LID not yet resolved — using LID as temporary phone')
      }
    }
    // Normalize: strip +, leading zeros, whitespace, dashes
    const phone = isGroup ? rawPhone : rawPhone.replace(/[\s\-\+]/g, '').replace(/^0+/, '')
    const fromMe = msg.key.fromMe ?? false
    const evolutionId = msg.key.id

    // Deduplicate: if another handler (e.g. Baileys) is already processing
    // this exact message, skip to avoid race conditions creating duplicate conversations.
    const lockKey = `msg-lock:${evolutionId}`
    const acquired = await redis.set(lockKey, 'webhook', 'EX', 30, 'NX')
    if (!acquired) {
      logger.debug({ instanceName, evolutionId }, 'Message already being processed by another handler — skipping')
      continue
    }

    // Skip messages from the instance's own number (avoid self-contact) — only for 1-on-1
    if (fromMe && !isGroup) {
      const instanceRecord = await prisma.whatsAppInstance.findFirst({ where: { name: instanceName } })
      if (instanceRecord?.phone && instanceRecord.phone === phone) continue
    }

    // For groups, try to get the group name from the message or use JID as fallback
    // (msg.pushName in group messages is the SENDER's name, not the group name)
    let groupName: string | undefined
    if (isGroup) {
      groupName = msg.groupName ?? msg.subject ?? undefined
    }

    // Upsert contact (for groups, use the group JID as phone)
    // When fromMe is true, msg.pushName is the SENDER's (our) name, not the contact's.
    // Only use pushName for inbound messages where it represents the contact.
    const inboundPushName = !fromMe ? (msg.pushName ?? undefined) : undefined
    const contactData = isGroup
      ? { phone, name: groupName ?? phone, isGroup: true }
      : { phone, name: inboundPushName, pushName: inboundPushName }

    const contact = await prisma.contact.upsert({
      where: { phone },
      update: isGroup ? { name: groupName ?? undefined } : (inboundPushName ? { pushName: inboundPushName } : {}),
      create: contactData,
    })

    // Fetch and locally cache profile picture if not set (CDN URLs expire)
    if (!contact.profilePic) {
      const cdnUrl = await evolutionApi.getProfilePicture(instanceName, phone).catch(() => undefined)
      if (cdnUrl) {
        const localPic = await downloadProfilePic(cdnUrl)
        if (localPic) {
          await prisma.contact.update({ where: { id: contact.id }, data: { profilePic: localPic } })
        }
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

    // Check existing conversation to avoid resetting IN_PROGRESS/RESOLVED status
    const existingConv = await prisma.conversation.findUnique({
      where: { contactId_instanceId: { contactId: contact.id, instanceId: instance.id } },
    })
    const shouldSetOpen = !fromMe && (!existingConv || existingConv.status === 'CLOSED')

    // Upsert conversation (inherit clientAdminId from instance)
    const conversation = await prisma.conversation.upsert({
      where: { contactId_instanceId: { contactId: contact.id, instanceId: instance.id } },
      update: {
        lastMessageAt: new Date(),
        status: shouldSetOpen ? 'OPEN' : undefined,
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

    // Broadcast via Socket.io — scoped + global for SUPER_ADMIN
    const conversationWithMessage = { ...conversation, messages: [message] }
    app.io.to(`conversation:${conversation.id}`).emit('message:new', message)
    if (conversation.clientAdminId) {
      app.io.to(`scope:${conversation.clientAdminId}`).emit('conversation:updated', conversationWithMessage)
      app.io.to(`scope:${conversation.clientAdminId}`).emit('conversations:refresh')
    }
    // Always emit to global scope so SUPER_ADMIN gets updates
    app.io.to('scope:global').emit('conversation:updated', conversationWithMessage)
    app.io.to('scope:global').emit('conversations:refresh')

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
