import * as fs from 'fs'
import * as path from 'path'
import * as https from 'https'
import * as http from 'http'
import { randomUUID } from 'crypto'
import { logger } from './logger'

const UPLOADS_DIR = path.join(process.cwd(), 'uploads')

/**
 * Downloads a profile picture from a remote URL and saves it to the uploads directory.
 * Returns the local path (e.g. /uploads/abc123.jpg) so it never expires.
 * Returns undefined if download fails.
 */
export async function downloadProfilePic(url: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      fs.mkdirSync(UPLOADS_DIR, { recursive: true })
      const ext = url.includes('.png') ? '.png' : '.jpg'
      const fileName = `profile_${randomUUID()}${ext}`
      const filePath = path.join(UPLOADS_DIR, fileName)

      const transport = url.startsWith('https') ? https : http
      const req = transport.get(url, (res) => {
        if (res.statusCode !== 200) {
          res.resume()
          resolve(undefined)
          return
        }
        const fileStream = fs.createWriteStream(filePath)
        res.pipe(fileStream)
        fileStream.on('finish', () => {
          fileStream.close()
          resolve(`/uploads/${fileName}`)
        })
        fileStream.on('error', () => resolve(undefined))
      })
      req.on('error', () => resolve(undefined))
      req.setTimeout(10000, () => { req.destroy(); resolve(undefined) })
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'downloadProfilePic failed')
      resolve(undefined)
    }
  })
}
