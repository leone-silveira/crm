import axios from 'axios'
import { useAuthStore } from '../store/auth.store'

// In dev, use relative path so requests go through Vite proxy.
// In production (static build), use the real backend URL.
const backendUrl = import.meta.env.DEV ? '' : (import.meta.env.VITE_API_URL || '')

export const api = axios.create({
  baseURL: `${backendUrl}/api`,
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
})

// Attach access token
api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().accessToken
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

// Auto-refresh on 401
let isRefreshing = false
let failedQueue: Array<{ resolve: (v: string) => void; reject: (e: unknown) => void }> = []

api.interceptors.response.use(
  (res) => res,
  async (error) => {
    const original = error.config
    if (error.response?.status === 401 && !original._retry) {
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject })
        }).then((token) => {
          original.headers.Authorization = `Bearer ${token}`
          return api(original)
        })
      }
      original._retry = true
      isRefreshing = true
      try {
        const refreshUrl = `${backendUrl}/api/auth/refresh`  // backendUrl is '' in dev → goes through proxy
        const { data } = await axios.post(refreshUrl, {}, { withCredentials: true })
        useAuthStore.getState().setToken(data.accessToken)
        failedQueue.forEach((p) => p.resolve(data.accessToken))
        failedQueue = []
        original.headers.Authorization = `Bearer ${data.accessToken}`
        return api(original)
      } catch {
        failedQueue.forEach((p) => p.reject(error))
        failedQueue = []
        useAuthStore.getState().logout()
        window.location.href = '/login'
        return Promise.reject(error)
      } finally {
        isRefreshing = false
      }
    }
    return Promise.reject(error)
  },
)
