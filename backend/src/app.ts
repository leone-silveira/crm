import 'dotenv/config'
import { buildServer } from './server'
import { env } from './config/env'
import { connectDatabase, disconnectDatabase } from './config/database'
import { connectRedis, disconnectRedis } from './config/redis'
import { logger } from './utils/logger'
import { baileysManager } from './services/baileys.service'

async function main() {
  await connectDatabase()
  logger.info('✅ Database connected')

  await connectRedis()
  logger.info('✅ Redis connected')

  const { app } = await buildServer()

  // app.listen usa o server interno do Fastify (o mesmo que o Socket.io está anexado)
  await app.listen({ port: env.PORT, host: '0.0.0.0' })
  logger.info(`🚀 Server running on port ${env.PORT}`)
  logger.info(`📚 Docs: http://localhost:${env.PORT}/docs`)

  // Restore WhatsApp sessions in background (non-blocking)
  baileysManager.restoreAllSessions().catch((err) => {
    logger.error(err, 'Failed to restore WhatsApp sessions')
  })

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`)
    await app.close()
    await disconnectDatabase()
    await disconnectRedis()
    process.exit(0)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((err) => {
  logger.error(err)
  process.exit(1)
})
