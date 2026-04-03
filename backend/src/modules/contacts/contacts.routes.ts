import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../config/database'
import { authenticate } from '../../middleware/authenticate'
import { notFound } from '../../utils/errors'
import { getPaginationParams, buildPaginatedResult } from '../../utils/pagination'
import { baileysManager } from '../../services/baileys.service'
import { downloadProfilePic } from '../../utils/downloadProfilePic'
import { normalizePhone } from '../../utils/phone'

export async function contactsRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticate] }

  app.get('/', auth, async (req) => {
    const query = req.query as any
    const { page, limit, skip } = getPaginationParams(query)
    const search = query.search as string | undefined

    const where: any = {}

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' as const } },
        { phone: { contains: search } },
        { email: { contains: search, mode: 'insensitive' as const } },
      ]
    }

    // Scope filtering: non-super-admins only see contacts with conversations in their scope
    if (req.user.role !== 'SUPER_ADMIN') {
      where.conversations = { some: { clientAdminId: req.scope } }
    }

    const [contacts, total] = await prisma.$transaction([
      prisma.contact.findMany({
        where,
        skip,
        take: limit,
        include: { tags: { include: { tag: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.contact.count({ where }),
    ])

    return buildPaginatedResult(contacts, total, page, limit)
  })

  app.get('/:id', auth, async (req) => {
    const { id } = req.params as { id: string }
    const contact = await prisma.contact.findUnique({
      where: { id },
      include: {
        tags: { include: { tag: true } },
        conversations: {
          take: 10,
          orderBy: { lastMessageAt: 'desc' },
          include: { assignedTo: { select: { id: true, name: true } } },
        },
      },
    })
    if (!contact) throw notFound('Contact')
    return contact
  })

  app.post('/', auth, async (req, reply) => {
    const body = z
      .object({
        phone: z.string().min(1),
        name: z.string().optional(),
        email: z.string().email().optional(),
        notes: z.string().optional(),
        isVip: z.boolean().optional(),
      })
      .parse(req.body)

    const normalized = { ...body, phone: normalizePhone(body.phone) }
    const contact = await prisma.contact.upsert({
      where: { phone: normalized.phone },
      update: normalized,
      create: normalized,
    })
    return reply.status(201).send(contact)
  })

  app.patch('/:id', auth, async (req) => {
    const { id } = req.params as { id: string }
    const body = z
      .object({
        name: z.string().optional(),
        email: z.string().email().optional(),
        notes: z.string().optional(),
        isVip: z.boolean().optional(),
        tagIds: z.array(z.string()).optional(),
      })
      .parse(req.body)

    const { tagIds, ...data } = body

    const contact = await prisma.contact.update({
      where: { id },
      data: {
        ...data,
        ...(tagIds !== undefined && {
          tags: {
            deleteMany: {},
            create: tagIds.map((tagId) => ({ tagId })),
          },
        }),
      },
      include: { tags: { include: { tag: true } } },
    })
    return contact
  })

  // Refresh profile picture for a contact
  app.post('/:id/refresh-pic', auth, async (req, reply) => {
    const { id } = req.params as { id: string }
    const contact = await prisma.contact.findUnique({ where: { id } })
    if (!contact) throw notFound('Contact')

    // Try to get pic from all active instances in parallel — take first success
    const instances = await prisma.whatsAppInstance.findMany({ where: { isActive: true, status: 'open' } })
    const pic = await Promise.any(
      instances.map(inst =>
        baileysManager.getProfilePicture(inst.name, contact.phone).then(p => p ?? Promise.reject())
      )
    ).catch(() => undefined)

    if (pic) {
      const localPic = await downloadProfilePic(pic)
      const saved = localPic ?? pic
      await prisma.contact.update({ where: { id }, data: { profilePic: saved } })
      return { profilePic: saved }
    }
    return reply.status(404).send({ error: 'Profile picture not available' })
  })

  app.delete('/:id', { preHandler: [authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    await prisma.contact.delete({ where: { id } })
    return reply.status(204).send()
  })
}
