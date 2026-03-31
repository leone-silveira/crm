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

const SESSIONS_DIR = path.join(process.cwd(), 'baileys-sessions')
const UPLOADS_DIR = path.join(process.cwd(), 'uploads')
const baileysLogger = pino({ level: 'silent' })

interface SessionInfo {
  socket: WASocket
}

class BaileysManager {
  private sessions = new Map<string, SessionInfo>()
  private io: any = null

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
      generateHighQualityLinkPreview: true,
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
  }

  private async handleIncomingMessage(instanceName: string, msg: proto.IWebMessageInfo) {
    if (!msg.key?.remoteJid) return
    if (msg.key.remoteJid === 'status@broadcast') return
    // Skip protocol/system messages
    if (msg.message?.protocolMessage || msg.message?.reactionMessage || msg.message?.senderKeyDistributionMessage) return

    const isGroup = msg.key.remoteJid.endsWith('@g.us')
    const rawPhone = isGroup
      ? msg.key.remoteJid
      : msg.key.remoteJid.replace('@s.whatsapp.net', '').replace('@lid', '')
    // Normalize: strip +, leading zeros, whitespace, dashes
    const phone = isGroup ? rawPhone : rawPhone.replace(/[\s\-\+]/g, '').replace(/^0+/, '')
    const fromMe = msg.key.fromMe ?? false
    const messageId = msg.key.id ?? `msg_${Date.now()}`

    // Skip messages from the instance's own number — only for 1-on-1
    if (fromMe && !isGroup) {
      const instanceRecord = await prisma.whatsAppInstance.findFirst({ where: { name: instanceName } })
      if (instanceRecord?.phone && instanceRecord.phone === phone) return
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

    const contactData = isGroup
      ? { phone, name: groupName ?? phone, isGroup: true }
      : { phone, name: msg.pushName ?? undefined, pushName: msg.pushName ?? undefined }

    const contact = await prisma.contact.upsert({
      where: { phone },
      update: isGroup ? { name: groupName ?? undefined } : { pushName: msg.pushName ?? undefined },
      create: contactData,
    })

    // Fetch profile picture if not set
    if (!contact.profilePic) {
      const pic = await this.getProfilePicture(instanceName, phone).catch(() => undefined)
      if (pic) {
        await prisma.contact.update({ where: { id: contact.id }, data: { profilePic: pic } })
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
          fs.mkdirSync(UPLOADS_DIR, { recursive: true })
          const ext = this.mimeToExtension(msgContent.mimeType)
          const fileName = `${randomUUID()}${ext}`
          const filePath = path.join(UPLOADS_DIR, fileName)
          fs.writeFileSync(filePath, buffer)
          const backendUrl = env.BACKEND_URL ?? `http://localhost:${env.PORT ?? 3000}`
          msgContent.mediaUrl = `${backendUrl}/uploads/${fileName}`
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

    // Broadcast via Socket.io — scoped
    const conversationWithMessage = { ...conversation, messages: [message] }
    this.io?.to(`conversation:${conversation.id}`).emit('message:new', message)
    if (conversation.clientAdminId) {
      this.io?.to(`scope:${conversation.clientAdminId}`).emit('conversation:updated', conversationWithMessage)
      this.io?.to(`scope:${conversation.clientAdminId}`).emit('conversations:refresh')
    } else {
      this.io?.emit('conversation:updated', conversationWithMessage)
      this.io?.emit('conversations:refresh')
    }
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

  async sendText(instanceName: string, phone: string, text: string) {
    const session = this.sessions.get(instanceName)
    if (!session) throw new Error(`Instance "${instanceName}" is not connected`)
    if (!session.socket.user) throw new Error(`Instance "${instanceName}" is still connecting — wait for QR scan to complete`)
    const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`
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
    const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`

    let msg: any
    switch (media.type) {
      case 'IMAGE':
        msg = { image: { url: media.url }, caption: media.caption, mimetype: media.mimeType }
        break
      case 'VIDEO':
        msg = { video: { url: media.url }, caption: media.caption, mimetype: media.mimeType }
        break
      case 'AUDIO':
        msg = { audio: { url: media.url }, mimetype: media.mimeType ?? 'audio/ogg; codecs=opus', ptt: true }
        break
      case 'DOCUMENT':
        msg = { document: { url: media.url }, mimetype: media.mimeType, fileName: media.fileName, caption: media.caption }
        break
    }

    return session.socket.sendMessage(jid, msg)
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
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
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
