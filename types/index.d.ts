export type VoicePhase = 'idle' | 'setup' | 'starting' | 'downloading' | 'listening' | 'stopping' | 'cleaning'

declare module 'claude-code' {
  interface PluginState {
    'voice': { phase: VoicePhase; level: number }
  }
}
