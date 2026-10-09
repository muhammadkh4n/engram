/**
 * The variables a server with POST /capture/events enabled cannot start
 * without: both bearer tokens, the project registry, the scrubber's sources,
 * the store and the embedder. The server checks them at startup; the secret
 * scan requires them too, because the registry masks the credentials of the
 * process it runs in, and a scan missing one of the server's credentials
 * would count none of its stored copies.
 */
export const CAPTURE_SERVER_REQUIRED_ENV = [
  'BEARER_TOKEN',
  'ENGRAM_CAPTURE_TOKEN',
  'ENGRAM_PROJECT_REGISTRY_FILE',
  'ENGRAM_SECRET_SOURCES_FILE',
  'SUPABASE_URL',
  'SUPABASE_KEY',
  'OPENAI_API_KEY',
] as const

/** Names from CAPTURE_SERVER_REQUIRED_ENV that are unset or empty in `env`, in list order. */
export function missingCaptureServerEnv(env: NodeJS.ProcessEnv): string[] {
  return CAPTURE_SERVER_REQUIRED_ENV.filter((name) => !env[name])
}
