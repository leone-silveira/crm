import { io, Socket } from 'socket.io-client'

let socket: Socket | null = null

const socketUrl = import.meta.env.DEV ? '' : (import.meta.env.VITE_API_URL || '')

export function getSocket(): Socket {
  if (!socket) {
    socket = io(socketUrl, {
      autoConnect: false,
      transports: ['websocket', 'polling'],
      withCredentials: true,
    })
  }
  return socket
}

export function connectSocket(token: string) {
  const s = getSocket()
  s.auth = { token }
  s.connect()
  return s
}

export function disconnectSocket() {
  socket?.disconnect()
  socket = null
}
