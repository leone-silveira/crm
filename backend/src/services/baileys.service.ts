import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
  WASocket,
  proto,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import * as fs from 'fs'
import * as path from 'path'
import pino from 'pino'
import QRCode from 'qrcode'
import { randomUUID } from 'crypto'
import { prisma } from '../config/database'
import { redis } from '../config/redis'
import { logger } from '../utils/logger'
import { env } from '../config/env'
import { downloadProfilePic } from '../utils/downloadProfilePic'

const SESSIONS_DIR = path.join(process.cwd(), 'baileys-sessions')
const UPLOADS_DIR = path.join(process.cwd(), 'uploads')
const baileysLogger = pino({ level: 'warn' })

interface SessionInfo {
  socket: WASocket
}

class BaileysManager {
  private sessions = new Map<string, SessionInfo>()
  private io: any = null
  // Maps LID user (e.g. "48584804286714") → phone (e.g. "5592915553338")
  private lidToPhone = new Map<string, string>()

  setIO(io: any) {
    this.io = io
  }

  async createSession(instanceName: string): Promise<void> {
    if (this.sessions.has(instanceName)) return

    const sessionDir = path.join(SESSIONS_DIR, instanceName)
    fs.mkdirSync(sessionDir, { recursive: true })

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir)
    const { version } = await fetchLatestBaileysVersion()

    logger.info({ instanceName, version }, 'Starting Baileys session')

    const socket = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
      },
      printQRInTerminal: false,
      logger: baileysLogger,
      browser: ['CRM WhatsApp', 'Chrome', '22.0'],
      generateHighQualityLinkPreview: false,
      getMessage: async () => undefined,
    })

    this.sessions.set(instanceName, { socket })

    socket.ev.on('creds.update', saveCreds)

    socket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        try {
          const qrBase64 = await QRCode.toDataURL(qr)
          await redis.setex(`qr:${instanceName}`, 60, qrBase64)
          this.io?.emit('instance:qr', { instanceName, qrCode: qrBase64 })
          await prisma.whatsAppInstance.updateMany({
            where: { name: instanceName },
            data: { status: 'qr', qrCode: qrBase64 },
          })
          logger.info({ instanceName }, 'QR code generated')
        } catch (err) {
          logger.error({ instanceName, err }, 'Failed to process QR code')
        }
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut

        logger.info({ instanceName, statusCode, shouldReconnect }, 'Connection closed')

        this.sessions.delete(instanceName)
        await prisma.whatsAppInstance.updateMany({
          where: { name: instanceName },
          data: { status: 'disconnected', qrCode: null },
        })
        await redis.del(`qr:${instanceName}`)
        this.io?.emit('instance:status', { instanceName, state: 'disconnected' })

        if (shouldReconnect) {
          setTimeout(() => this.createSession(instanceName), 3000)
        }
      }

      if (connection === 'open') {
        const phone = socket.user?.id?.split(':')[0] ?? null
        await prisma.whatsAppInstance.updateMany({
          where: { name: instanceName },
          data: { status: 'open', phone, qrCode: null },
        })
        await redis.del(`qr:${instanceName}`)
        this.io?.emit('instance:status', { instanceName, state: 'open' })
        logger.info({ instanceName, phone }, 'Connected to WhatsApp')
      }
    })

    socket.ev.on('messages.upsert', async ({ messages: msgs, type }) => {
      if (type !== 'notify') return
      for (const msg of msgs) {
        await this.handleIncomingMessage(instanceName, msg).catch((err) => {
          logger.error({ instanceName, err: err.message }, 'Failed to process message')
        })
      }
    })

    // Log delivery receipts — tells us if WhatsApp actually received the message
    socket.ev.on('messages.update', (updates) => {
      for (const update of updates) {
        logger.info({ instanceName, id: update.key?.id, to: update.key?.remoteJid, status: update.update?.status }, 'Message delivery update')
      }
    })

    // Build LID → phone mapping from contacts and phoneNumberShare events
    socket.ev.on('contacts.upsert', (contacts) => {
      for (const c of contacts) {
        if (c.lid && c.id && !c.id.endsWith('@lid')) {
          const lidUser = c.lid.replace(/@lid$/, '').split(':')[0]
          const phoneUser = c.id.replace(/@s\.whatsapp\.net$/, '').split(':')[0]
          this.storeLidMapping(lidUser, phoneUser)
        }
      }
    })

    socket.ev.on('chats.phoneNumberShare' as any, (data: { lid: string; jid: string }) => {
      if (data?.lid && data?.jid) {
        const lidUser = data.lid.replace(/@lid$/, '').split(':')[0]
        const phoneUser = data.jid.replace(/@s\.whatsapp\.net$/, '').split(':')[0]
        this.storeLidMapping(lidUser, phoneUser)
      }
    })
  }

  private async handleIncomingMessage(instanceName: string, msg: proto.IWebMessageInfo) {
    if (!msg.key?.remoteJid) return
    if (msg.key.remoteJid === 'status@broadcast') return
    // Skip protocol/system messages
    if (msg.message?.protocolMessage || msg.message?.reactionMessage || msg.message?.senderKeyDistributionMessage) return

    const isGroup = msg.key.remoteJid.endsWith('@g.us')
    const isLid = msg.key.remoteJid.endsWith('@lid')
    let rawPhone = isGroup
      ? msg.key.remoteJid
      : msg.key.remoteJid.replace(/@s\.whatsapp\.net$/, '').replace(/@lid$/, '')
    // LID JIDs can have a `:agent` or `:device` suffix (e.g. "5511999@lid:23:0") — strip it
    if (!isGroup) rawPhone = rawPhone.split(':')[0]
    // Resolve LID to real phone number if possible
    if (isLid) {
      const resolved = await this.resolveLid(rawPhone)
      if (resolved) {
        rawPhone = resolved
      } else {
        // Accept the message using the LID as temporary identifier — it will be
        // merged when the contacts.upsert event provides the real phone later.
        logger.info({ instanceName, lid: rawPhone, remoteJid: msg.key.remoteJid }, 'LID not yet resolved — using LID as temporary phone')
      }
    }
    // Normalize: strip +, leading zeros, whitespace, dashes
    const phone = isGroup ? rawPhone : rawPhone.replace(/[\s\-\+]/g, '').replace(/^0+/, '')
    let fromMe = msg.key.fromMe ?? false
    const messageId = msg.key.id ?? `msg_${Date.now()}`

    // Deduplicate: if another handler (e.g. Evolution webhook) is already processing
    // this exact message, skip to avoid race conditions creating duplicate conversations.
    const lockKey = `msg-lock:${messageId}`
    const acquired = await redis.set(lockKey, 'baileys', 'EX', 30, 'NX')
    if (!acquired) {
      logger.debug({ instanceName, messageId }, 'Message already being processed by another handler — skipping')
      return
    }

    // Cross-check fromMe using participant JID for groups (Baileys multi-device
    // doesn't always set fromMe correctly for messages sent from the phone)
    if (isGroup && !fromMe && msg.key.participant) {
      const session = this.sessions.get(instanceName)
      const myUser = session?.socket.user
      if (myUser?.id) {
        const myPhone = myUser.id.split(':')[0].split('@')[0]
        let participantId = msg.key.participant.replace(/@.*$/, '').split(':')[0]
        // If participant is a LID, try to resolve it to a real phone for comparison
        if (msg.key.participant.endsWith('@lid')) {
          const resolved = await this.resolveLid(participantId)
          if (resolved) participantId = resolved
        }
        // Also compare against our own LID if participant is a LID and we couldn't resolve
        const myLid = (myUser as any).lid?.replace(/@.*$/, '').split(':')[0]
        if (myPhone === participantId || (myLid && myLid === msg.key.participant.replace(/@.*$/, '').split(':')[0])) {
          fromMe = true
        }
      }
    }

    // Skip messages from the instance's own number — only for 1-on-1
    if (fromMe && !isGroup) {
      const instanceRecord = await prisma.whatsAppInstance.findFirst({ where: { name: instanceName } })
      if (instanceRecord?.phone && instanceRecord.phone === phone) return
    }

    // If this is a real phone (not LID), check if a LID-based contact exists for this
    // number and merge it — prevents duplicate conversations when inbound uses LID
    // but outbound (from cellphone) uses real phone.
    if (!isLid && !isGroup) {
      try {
        const lidForPhone = await redis.get(`lid-reverse:${phone}`).catch(() => null)
        if (lidForPhone) {
          const lidContact = await prisma.contact.findUnique({ where: { phone: lidForPhone } })
          if (lidContact) {
            const realContact = await prisma.contact.findUnique({ where: { phone } })
            if (realContact) {
              // Both exist — merge LID conversations into real contact
              const lidConversations = await prisma.conversation.findMany({ where: { contactId: lidContact.id } })
              if (lidConversations.length > 0) {
                const lidInstanceIds = lidConversations.map(c => c.instanceId).filter((id): id is string => id !== null)
                const realConvsByInstance = await prisma.conversation.findMany({
                  where: { contactId: realContact.id, instanceId: { in: lidInstanceIds } },
                  select: { id: true, instanceId: true },
                })
                const realConvMap = new Map(realConvsByInstance.map(c => [c.instanceId, c.id]))
                const conflicting = lidConversations.filter(c => c.instanceId && realConvMap.has(c.instanceId))
                const nonConflicting = lidConversations.filter(c => !c.instanceId || !realConvMap.has(c.instanceId))
                await prisma.$transaction([
                  // Move messages from conflicting LID convs to real convs first
                  ...conflicting.map(lidConv =>
                    prisma.message.updateMany({
                      where: { conversationId: lidConv.id },
                      data: { conversationId: realConvMap.get(lidConv.instanceId!)! },
                    })
                  ),
                  // Delete conflicting LID conversations
                  prisma.conversation.deleteMany({ where: { id: { in: conflicting.map(c => c.id) } } }),
                  // Reassign non-conflicting LID conversations to real contact
                  ...(nonConflicting.length > 0 ? [prisma.conversation.updateMany({
                    where: { id: { in: nonConflicting.map(c => c.id) } },
                    data: { contactId: realContact.id },
                  })] : []),
                ])
              }
              await prisma.contact.delete({ where: { id: lidContact.id } })
              logger.info({ lid: lidForPhone, phone }, 'Merged LID contact into real phone contact')
            } else {
              // Only LID contact exists — update its phone to the real number
              await prisma.contact.update({
                where: { id: lidContact.id },
                data: { phone },
              })
              logger.info({ lid: lidForPhone, phone }, 'Updated LID contact to real phone number')
            }
          }
        }
      } catch (err) {
        logger.error({ phone, err: (err as Error).message }, 'Failed to merge LID contact before upsert')
      }
    }

    // For groups, try to get the group subject as the name
    let groupName: string | undefined
    if (isGroup) {
      try {
        const session = this.sessions.get(instanceName)
        if (session) {
          const metadata = await session.socket.groupMetadata(msg.key.remoteJid)
          groupName = metadata?.subject
        }
      } catch { /* ignore — use JID as fallback */ }
    }

    // When fromMe is true, msg.pushName is the SENDER's (our) name, not the contact's.
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
      const cdnUrl = await this.getProfilePicture(instanceName, phone).catch(() => undefined)
      if (cdnUrl) {
        const localPic = await downloadProfilePic(cdnUrl)
        if (localPic) {
          await prisma.contact.update({ where: { id: contact.id }, data: { profilePic: localPic } })
        }
      }
    }

    const instance = await prisma.whatsAppInstance.upsert({
      where: { name: instanceName },
      update: {},
      create: { name: instanceName, displayName: instanceName },
    })

    // Check existing conversation to avoid resetting IN_PROGRESS/RESOLVED status
    const existingConv = await prisma.conversation.findUnique({
      where: { contactId_instanceId: { contactId: contact.id, instanceId: instance.id } },
    })
    // Only set status to OPEN for inbound messages if conversation doesn't exist yet
    // or is currently CLOSED (reopen it). Don't reset IN_PROGRESS/RESOLVED.
    const shouldSetOpen = !fromMe && (!existingConv || existingConv.status === 'CLOSED')

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
        lastMessageAt: new Date(),
        unreadCount: fromMe ? 0 : 1,
      },
      include: {
        contact: true,
        assignedTo: { select: { id: true, name: true } },
        instance: { select: { id: true, name: true } },
      },
    })

    const msgContent = this.extractMessageContent(msg)
    if (!msgContent) return  // Skip unsupported message types silently

    // Download media from WhatsApp and save locally (WhatsApp URLs are encrypted/temporary)
    if (msgContent.mediaUrl && ['IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT', 'STICKER'].includes(msgContent.type)) {
      try {
        const session = this.sessions.get(instanceName)
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
          logger: baileysLogger as any,
          reuploadRequest: session?.socket.updateMediaMessage ?? (async (m: any) => m),
        })
        if (buffer) {
          await fs.promises.mkdir(UPLOADS_DIR, { recursive: true })
          const ext = this.mimeToExtension(msgContent.mimeType)
          const fileName = `${randomUUID()}${ext}`
          const filePath = path.join(UPLOADS_DIR, fileName)
          await fs.promises.writeFile(filePath, buffer)
          msgContent.mediaUrl = `/uploads/${fileName}`
          logger.info({ instanceName, fileName, type: msgContent.type }, 'Media downloaded and saved')
        }
      } catch (err) {
        logger.error({ instanceName, err: (err as Error).message, type: msgContent.type }, 'Failed to download media')
      }
    }

    // Check if this message already exists (sent via API) to avoid duplicate broadcasts
    const existingMessage = await prisma.message.findUnique({ where: { evolutionId: messageId } })

    const message = await prisma.message.upsert({
      where: { evolutionId: messageId },
      update: { status: fromMe ? 'SENT' : 'READ' },
      create: {
        conversationId: conversation.id,
        evolutionId: messageId,
        direction: fromMe ? 'OUTBOUND' : 'INBOUND',
        type: msgContent.type as any,
        body: msgContent.body,
        mediaUrl: msgContent.mediaUrl,
        mimeType: msgContent.mimeType,
        fileName: msgContent.fileName,
        timestamp: new Date((msg.messageTimestamp as number ?? Date.now() / 1000) * 1000),
        status: fromMe ? 'SENT' : 'DELIVERED',
      },
    })

    // Skip broadcast for outbound messages that were already sent via API (avoid duplicates)
    if (existingMessage && fromMe) {
      logger.debug({ conversationId: conversation.id, messageId }, 'Skipping broadcast for already-sent message')
      return
    }

    // Broadcast via Socket.io — scoped + global for SUPER_ADMIN
    const conversationWithMessage = { ...conversation, messages: [message] }
    this.io?.to(`conversation:${conversation.id}`).emit('message:new', message)
    if (conversation.clientAdminId) {
      this.io?.to(`scope:${conversation.clientAdminId}`).emit('conversation:updated', conversationWithMessage)
      this.io?.to(`scope:${conversation.clientAdminId}`).emit('conversations:refresh')
    }
    // Always emit to global scope so SUPER_ADMIN gets updates
    this.io?.to('scope:global').emit('conversation:updated', conversationWithMessage)
    this.io?.to('scope:global').emit('conversations:refresh')
    logger.info({ conversationId: conversation.id, phone, fromMe }, 'Message processed')
  }

  private extractMessageContent(msg: proto.IWebMessageInfo) {
    let content: any = msg.message ?? {}

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
        mediaUrl: undefined, mimeType: undefined, fileName: undefined,
      }
    }
    if (content.imageMessage) {
      return {
        type: 'IMAGE',
        body: content.imageMessage.caption ?? undefined,
        mediaUrl: content.imageMessage.url ?? undefined,
        mimeType: content.imageMessage.mimetype ?? undefined,
        fileName: undefined,
      }
    }
    if (content.videoMessage) {
      return {
        type: 'VIDEO',
        body: content.videoMessage.caption ?? undefined,
        mediaUrl: content.videoMessage.url ?? undefined,
        mimeType: content.videoMessage.mimetype ?? undefined,
        fileName: undefined,
      }
    }
    if (content.audioMessage || content.pttMessage) {
      const audio = content.audioMessage ?? content.pttMessage
      return {
        type: 'AUDIO', body: undefined,
        mediaUrl: audio?.url ?? undefined,
        mimeType: audio?.mimetype ?? undefined,
        fileName: undefined,
      }
    }
    if (content.documentMessage) {
      return {
        type: 'DOCUMENT',
        body: content.documentMessage.caption ?? undefined,
        mediaUrl: content.documentMessage.url ?? undefined,
        mimeType: content.documentMessage.mimetype ?? undefined,
        fileName: content.documentMessage.fileName ?? undefined,
      }
    }
    if (content.stickerMessage) {
      return {
        type: 'STICKER', body: undefined,
        mediaUrl: content.stickerMessage.url ?? undefined,
        mimeType: 'image/webp', fileName: undefined,
      }
    }
    if (content.buttonsResponseMessage) {
      return { type: 'TEXT', body: content.buttonsResponseMessage.selectedDisplayText ?? '', mediaUrl: undefined, mimeType: undefined, fileName: undefined }
    }
    if (content.listResponseMessage) {
      return { type: 'TEXT', body: content.listResponseMessage.title ?? '', mediaUrl: undefined, mimeType: undefined, fileName: undefined }
    }
    if (content.contactMessage || content.contactsArrayMessage) {
      return { type: 'TEXT', body: `📇 ${content.contactMessage?.displayName ?? 'Contact'}`, mediaUrl: undefined, mimeType: undefined, fileName: undefined }
    }
    if (content.locationMessage || content.liveLocationMessage) {
      return { type: 'TEXT', body: '📍 Location', mediaUrl: undefined, mimeType: undefined, fileName: undefined }
    }
    return null
  }

  private mimeToExtension(mimeType?: string): string {
    if (!mimeType) return ''
    const map: Record<string, string> = {
      'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
      'video/mp4': '.mp4', 'video/3gpp': '.3gp',
      'audio/ogg': '.ogg', 'audio/ogg; codecs=opus': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/aac': '.aac',
      'application/pdf': '.pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
      'application/msword': '.doc',
      'text/plain': '.txt',
    }
    return map[mimeType] ?? ''
  }

  /** Store a LID → phone mapping in memory and Redis, and merge any temporary LID contact */
  private async storeLidMapping(lidUser: string, phoneUser: string) {
    this.lidToPhone.set(lidUser, phoneUser)
    redis.set(`lid:${lidUser}`, phoneUser).catch(() => {})
    redis.set(`lid-reverse:${phoneUser}`, lidUser).catch(() => {})
    logger.info({ lid: lidUser, phone: phoneUser }, 'LID → phone mapping stored')

    // If a temporary contact was created with the LID as phone, merge it
    try {
      const lidContact = await prisma.contact.findUnique({ where: { phone: lidUser } })
      if (lidContact) {
        const realContact = await prisma.contact.findUnique({ where: { phone: phoneUser } })
        if (realContact) {
          // Real contact already exists — move conversations from LID contact to real contact, then delete LID contact
          await prisma.conversation.updateMany({
            where: { contactId: lidContact.id },
            data: { contactId: realContact.id },
          })
          await prisma.contact.delete({ where: { id: lidContact.id } })
          logger.info({ lid: lidUser, phone: phoneUser }, 'Merged LID contact into existing phone contact')
        } else {
          // No real contact yet — just update the LID contact's phone
          await prisma.contact.update({
            where: { id: lidContact.id },
            data: { phone: phoneUser },
          })
          logger.info({ lid: lidUser, phone: phoneUser }, 'Updated LID contact phone to real number')
        }
      }
    } catch (err) {
      logger.error({ lid: lidUser, phone: phoneUser, err: (err as Error).message }, 'Failed to merge LID contact')
    }
  }

  /** Resolve a LID user to a real phone number, checking memory then Redis */
  private async resolveLid(lidUser: string): Promise<string | undefined> {
    // Check in-memory cache first
    const cached = this.lidToPhone.get(lidUser)
    if (cached) return cached
    // Check Redis
    const fromRedis = await redis.get(`lid:${lidUser}`).catch(() => null)
    if (fromRedis) {
      this.lidToPhone.set(lidUser, fromRedis)
      return fromRedis
    }
    return undefined
  }

  async sendText(instanceName: string, phone: string, text: string) {
    const session = this.sessions.get(instanceName)
    if (!session) throw new Error(`Instance "${instanceName}" is not connected`)
    if (!session.socket.user) throw new Error(`Instance "${instanceName}" is still connecting — wait for QR scan to complete`)
    const cleanPhone = phone.replace(/[\s\-\+]/g, '').replace(/^0+/, '')
    // If the stored phone is a LID (temporary identifier), resolve to real phone
    const resolvedPhone = await redis.get(`lid:${cleanPhone}`).catch(() => null)
    const finalPhone = resolvedPhone ?? cleanPhone
    const jid = finalPhone.includes('@') ? finalPhone : `${finalPhone}@s.whatsapp.net`
    logger.info({ instanceName, storedPhone: phone, jid, wasLid: !!resolvedPhone }, 'Sending text message')
    return session.socket.sendMessage(jid, { text })
  }

  async sendMedia(instanceName: string, phone: string, media: {
    type: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT'
    url: string
    caption?: string
    fileName?: string
    mimeType?: string
  }) {
    const session = this.sessions.get(instanceName)
    if (!session) throw new Error(`Instance "${instanceName}" is not connected`)
    if (!session.socket.user) throw new Error(`Instance "${instanceName}" is still connecting — wait for QR scan to complete`)
    const cleanPhone = phone.replace(/[\s\-\+]/g, '').replace(/^0+/, '')
    const resolvedPhone = await redis.get(`lid:${cleanPhone}`).catch(() => null)
    const finalPhone = resolvedPhone ?? cleanPhone
    const jid = finalPhone.includes('@') ? finalPhone : `${finalPhone}@s.whatsapp.net`

    // If the URL points to a local upload, read the file as a buffer.
    // Baileys can send buffers directly — avoids issues with Docker-internal URLs.
    const mediaSource = await this.resolveMediaSource(media.url)

    let msg: any
    switch (media.type) {
      case 'IMAGE':
        msg = { image: mediaSource, caption: media.caption, mimetype: media.mimeType }
        break
      case 'VIDEO':
        msg = { video: mediaSource, caption: media.caption, mimetype: media.mimeType }
        break
      case 'AUDIO':
        msg = { audio: mediaSource, mimetype: media.mimeType ?? 'audio/ogg; codecs=opus', ptt: true }
        break
      case 'DOCUMENT':
        msg = { document: mediaSource, mimetype: media.mimeType, fileName: media.fileName, caption: media.caption }
        break
    }

    return session.socket.sendMessage(jid, msg)
  }

  /** If url points to a local /uploads/ file, return the Buffer; otherwise return { url } for Baileys to fetch. */
  private async resolveMediaSource(url: string): Promise<Buffer | { url: string }> {
    try {
      const uploadsMatch = url.match(/\/uploads\/([^/?#]+)/)
      if (uploadsMatch) {
        const filePath = path.join(UPLOADS_DIR, uploadsMatch[1])
        return await fs.promises.readFile(filePath)
      }
    } catch (err) {
      logger.warn({ url, err: (err as Error).message }, 'Failed to read local file, falling back to URL')
    }
    return { url }
  }

  async getProfilePicture(instanceName: string, jid: string): Promise<string | undefined> {
    const session = this.sessions.get(instanceName)
    if (!session) return undefined
    try {
      const fullJid = jid.includes('@') ? jid : `${jid}@s.whatsapp.net`
      // Groups use @g.us, individuals use @s.whatsapp.net — both handled above
      return await session.socket.profilePictureUrl(fullJid, 'image') ?? undefined
    } catch {
      return undefined
    }
  }

  async getGroupMetadata(instanceName: string, groupJid: string) {
    const session = this.sessions.get(instanceName)
    if (!session) throw new Error(`Instance "${instanceName}" is not connected`)
    const jid = groupJid.includes('@') ? groupJid : `${groupJid}@g.us`
    const metadata = await session.socket.groupMetadata(jid)
    let profilePic: string | undefined
    try {
      profilePic = await session.socket.profilePictureUrl(jid, 'image') ?? undefined
    } catch { /* no pic */ }
    return {
      id: metadata.id,
      subject: metadata.subject,
      subjectOwner: metadata.subjectOwner,
      subjectTime: metadata.subjectTime,
      desc: metadata.desc,
      descOwner: metadata.descOwner,
      owner: metadata.owner,
      creation: metadata.creation,
      size: metadata.size ?? metadata.participants?.length ?? 0,
      restrict: metadata.restrict,
      announce: metadata.announce,
      profilePic,
      participants: metadata.participants?.map((p: any) => ({
        id: p.id,
        phone: p.id.replace(/@s\.whatsapp\.net$/, '').split(':')[0],
        admin: p.admin ?? null,
      })) ?? [],
    }
  }

  async fetchGroups(instanceName: string) {
    const session = this.sessions.get(instanceName)
    if (!session) throw new Error(`Instance "${instanceName}" is not connected`)
    const groups = await session.socket.groupFetchAllParticipating()
    return Object.values(groups).map((g: any) => ({
      id: g.id,
      subject: g.subject,
      owner: g.owner,
      creation: g.creation,
      size: g.size ?? g.participants?.length ?? 0,
      participants: g.participants?.map((p: any) => ({
        id: p.id,
        admin: p.admin ?? null,
      })) ?? [],
    }))
  }

  async getQR(instanceName: string): Promise<string | null> {
    return redis.get(`qr:${instanceName}`)
  }

  getStatus(instanceName: string): string {
    const session = this.sessions.get(instanceName)
    if (!session) return 'disconnected'
    // Check if the socket is actually usable (has user info = fully connected)
    return session.socket.user ? 'connected' : 'connecting'
  }

  async deleteSession(instanceName: string) {
    const session = this.sessions.get(instanceName)
    if (session) {
      try { await session.socket.logout() } catch { /* ignore */ }
      this.sessions.delete(instanceName)
    }
    const sessionDir = path.join(SESSIONS_DIR, instanceName)
    await fs.promises.rm(sessionDir, { recursive: true, force: true })
    await redis.del(`qr:${instanceName}`)
  }

  async restoreAllSessions() {
    const instances = await prisma.whatsAppInstance.findMany({ where: { isActive: true } })
    for (const inst of instances) {
      const sessionDir = path.join(SESSIONS_DIR, inst.name)
      const hasSession = fs.existsSync(sessionDir)
      logger.info({ instanceName: inst.name, hasSession }, 'Restoring session')
      // Always try to create session — if session files are missing (e.g. after deploy),
      // Baileys will generate a new QR code so the user can reconnect manually.
      await this.createSession(inst.name).catch((err) => {
        logger.error({ instanceName: inst.name, err: err.message }, 'Failed to restore session')
      })
    }
  }
}

export const baileysManager = new BaileysManager()
