import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import jwt from '@fastify/jwt'
import cookie from '@fastify/cookie'
import rateLimit from '@fastify/rate-limit'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import * as path from 'path'
import * as fs from 'fs'
import swagger from '@fastify/swagger'
import swaggerUI from '@fastify/swagger-ui'
import { Server } from 'socket.io'
import { ZodError } from 'zod'

import { env } from './config/env'
import { redis } from './config/redis'
import { logger } from './utils/logger'
import { AppError } from './utils/errors'

// Routes
import { authRoutes } from './modules/auth/auth.routes'
import { usersRoutes } from './modules/users/users.routes'
import { contactsRoutes } from './modules/contacts/contacts.routes'
import { conversationsRoutes } from './modules/conversations/conversations.routes'
import { messagesRoutes } from './modules/messages/messages.routes'
import { tagsRoutes } from './modules/tags/tags.routes'
import { instancesRoutes } from './modules/instances/instances.routes'
import { webhooksRoutes } from './modules/webhooks/webhooks.routes'
import { registerSocketHandlers } from './socket/socket.handlers'
import { baileysManager } from './services/baileys.service'

export async function buildServer() {
  const app = Fastify({
    logger: { level: env.LOG_LEVEL },
    trustProxy: true,
  })

  // ─── Security ──────────────────────────────────────────────────────────────
  await app.register(helmet, { contentSecurityPolicy: false })
  const allowedOrigins = [env.FRONTEND_URL.replace(/\/+$/, ''), 'http://localhost:5173']
  console.log('✅ CORS allowed origins:', allowedOrigins)
  await app.register(cors, {
    origin: (origin, cb) => {
      console.log('🔍 CORS request from origin:', origin)
      if (!origin || allowedOrigins.includes(origin)) {
        cb(null, true)
      } else {
        console.log('❌ CORS blocked origin:', origin)
        cb(null, false)
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  })
  await app.register(cookie)

  // ─── Rate limiting ─────────────────────────────────────────────────────────
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    redis,
  })

  // ─── JWT ───────────────────────────────────────────────────────────────────
  await app.register(jwt, {
    secret: env.JWT_SECRET,
    sign: { expiresIn: env.JWT_EXPIRES_IN },
  })

  // ─── Multipart ─────────────────────────────────────────────────────────────
  await app.register(multipart, { limits: { fileSize: 16 * 1024 * 1024 } })

  // ─── Static files (uploads) ────────────────────────────────────────────────
  const uploadsDir = path.join(process.cwd(), 'uploads')
  fs.mkdirSync(uploadsDir, { recursive: true })
  await app.register(fastifyStatic, { root: uploadsDir, prefix: '/uploads/', decorateReply: false })

  // ─── Swagger ───────────────────────────────────────────────────────────────
  await app.register(swagger, {
    openapi: {
      info: { title: 'CRM WhatsApp API', version: '1.0.0' },
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
      security: [{ bearerAuth: [] }],
    },
  })
  await app.register(swaggerUI, { routePrefix: '/docs' })

  // ─── Body parser fallback ──────────────────────────────────────────────────
  // Parseia JSON mesmo quando o Content-Type está ausente ou é text/plain
  app.addContentTypeParser(
    ['text/plain', 'text/json'],
    { parseAs: 'string' },
    (req, body, done) => {
      try {
        done(null, JSON.parse(body as string))
      } catch {
        done(null, {})
      }
    },
  )

  // ─── Global error handler ──────────────────────────────────────────────────
  app.setErrorHandler((error, _req, reply) => {
    // Erros de validação do Zod → 400 com detalhes dos campos
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: 'VALIDATION_ERROR',
        message: 'Invalid request data',
        fields: error.flatten().fieldErrors,
      })
    }
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({ error: error.code, message: error.message })
    }
    // Erro de parse do body do Fastify (JSON malformado)
    if (error.statusCode === 400) {
      return reply.status(400).send({ error: 'BAD_REQUEST', message: error.message })
    }
    logger.error(error)
    return reply.status(500).send({
      error: 'INTERNAL_ERROR',
      message: env.NODE_ENV === 'production' ? 'Internal server error' : error.message,
    })
  })

  // ─── Health check ──────────────────────────────────────────────────────────
  app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }))

  // ─── Routes ────────────────────────────────────────────────────────────────
  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.register(usersRoutes, { prefix: '/api/users' })
  await app.register(contactsRoutes, { prefix: '/api/contacts' })
  await app.register(conversationsRoutes, { prefix: '/api/conversations' })
  await app.register(messagesRoutes, { prefix: '/api/messages' })
  await app.register(tagsRoutes, { prefix: '/api/tags' })
  await app.register(instancesRoutes, { prefix: '/api/instances' })
  await app.register(webhooksRoutes, { prefix: '/api/webhooks' })

  // ─── Socket.io ─────────────────────────────────────────────────────────────
  // Cria o io SEM servidor para poder decorar antes do ready()
  // (Fastify não permite decorators após ready/listen)
  const io = new Server({
    cors: { origin: [env.FRONTEND_URL, 'http://localhost:5173'], credentials: true },
    transports: ['websocket', 'polling'],
  })
  app.decorate('io', io)

  // Agora sim pode chamar ready()
  await app.ready()

  // Anexa ao HTTP server interno do Fastify após ready
  io.attach(app.server)
  registerSocketHandlers(io)

  // Initialize Baileys with Socket.io for real-time events
  baileysManager.setIO(io)

  return { app, io }
}

declare module 'fastify' {
  interface FastifyInstance {
    io: Server
  }
}
