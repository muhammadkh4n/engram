/**
 * Lightweight Entity Extraction.
 *
 * Extracts person names, technologies, and project names from message text
 * using regex patterns (no LLM call). Returns a flat deduplicated array of
 * entity strings for storage in episode.entities[].
 */

/** Known technology keywords (25+ patterns) */
const TECH_PATTERNS: RegExp[] = [
  // Languages
  /\b(TypeScript|JavaScript|Python|Rust|Go|Java|Kotlin|Swift|Ruby|PHP|C\+\+|C#)\b/gi,
  // Frontend frameworks
  /\b(React|Vue|Angular|Next\.js|Nuxt|Svelte|SolidJS|Solid\.js|Qwik|Astro|Remix)\b/gi,
  // Backend frameworks
  /\b(Express|FastAPI|Django|Flask|Spring|NestJS|Fastify|Hono|Elysia)\b/gi,
  // Runtimes and deployment
  /\b(Node\.js|Deno|Bun|Docker|Kubernetes|Terraform|AWS|GCP|Azure|Vercel|Netlify|Cloudflare)\b/gi,
  // Databases
  /\b(PostgreSQL|MySQL|MongoDB|Redis|Supabase|Firebase|SQLite|DynamoDB|CockroachDB)\b/gi,
  // ORMs and query builders
  /\b(Prisma|Drizzle|TypeORM|Sequelize|Knex|Kysely|pg)\b/gi,
  // Version control and CI/CD
  /\b(Git|GitHub|GitLab|Bitbucket|CircleCI|GitHub Actions|Jenkins)\b/gi,
  // AI/ML tools
  /\b(OpenAI|Claude|GPT-[34o]|Anthropic|LLM|pgvector|Ollama|LangChain|LlamaIndex)\b/gi,
  // Build tools and testing
  /\b(Vitest|Jest|Mocha|Playwright|Cypress|ESLint|Prettier|Webpack|Vite|tsup|esbuild|Rollup|Parcel)\b/gi,
  // Networking and utilities
  /\b(Tailscale|tRPC|GraphQL|REST|gRPC|WebSocket|OAuth|JWT)\b/gi,
]

/** Project name patterns */
const PROJECT_PATTERNS: RegExp[] = [
  // "the X project", "our X project", "my X project"
  /(?:the|our|my)\s+(\w[\w-]*(?:\s+\w[\w-]*)?)\s+project/gi,
  // "working on X", "building X", "developing X"
  /(?:working on|building|developing)\s+(\w[\w-]*(?:-\w+)*)/gi,
  // kebab-case identifiers (e.g. my-project, open-claw-memory)
  /\b([a-z][\w]*-[a-z][\w]*(?:-[a-z][\w]*)*)\b/g,
]

/** Person name patterns (capitalized words, contextual) */
const PERSON_PATTERNS: RegExp[] = [
  // Explicit person references: "tell X", "ask X", "cc X", "ping X", "@X"
  /(?:(?:tell|ask|cc|ping)\s+|@)([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g,
  // Two capitalized words in sequence not at sentence start
  /(?:^|[.!?]\s+)(?!(?:The|This|That|These|Those|What|How|Why|When|Where|Who|I|We|He|She|It|They|You|My|Our|His|Her|Its|Their|Your)\b)([A-Z][a-z]+\s+[A-Z][a-z]+)/gm,
]

/** Common words that should not be classified as people */
const NAME_BLOCKLIST = new Set([
  'The', 'This', 'That', 'These', 'Those', 'What', 'How', 'Why',
  'When', 'Where', 'Who', 'Which', 'There', 'Here', 'Some', 'Any',
  'Each', 'Every', 'Both', 'All', 'Most', 'Many', 'Much', 'More',
  'Other', 'Another', 'Such', 'Same', 'Good', 'Great', 'Best',
  'New', 'Old', 'First', 'Last', 'Next', 'Previous', 'Note', 'True', 'False',
])

/** Common words that should not be classified as projects */
const PROJECT_BLOCKLIST = new Set([
  'the', 'our', 'my', 'this', 'that', 'some', 'will', 'have', 'been',
  'with', 'from', 'into', 'then', 'when', 'where', 'what', 'which',
  'node', 'next', 'null', 'true', 'false', 'void', 'type', 'enum',
])

function extractPeople(text: string): string[] {
  const names = new Set<string>()
  for (const pattern of PERSON_PATTERNS) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text)) !== null) {
      const name = match[1].trim()
      const firstName = name.split(/\s+/)[0]
      if (firstName !== undefined && !NAME_BLOCKLIST.has(firstName) && name.length > 1) {
        names.add(name)
      }
    }
  }
  return [...names]
}

function extractTechnologies(text: string): string[] {
  const techs = new Set<string>()
  for (const pattern of TECH_PATTERNS) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text)) !== null) {
      const tech = match[1]
      if (tech !== undefined) {
        techs.add(tech)
      }
    }
  }
  return [...techs]
}

function extractProjects(text: string): string[] {
  const projects = new Set<string>()
  for (const pattern of PROJECT_PATTERNS) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text)) !== null) {
      const name = match[1].trim()
      if (
        name.length > 3 &&
        !PROJECT_BLOCKLIST.has(name.toLowerCase())
      ) {
        projects.add(name)
      }
    }
  }
  return [...projects]
}

/**
 * Extract entities from text and return a flat deduplicated array.
 *
 * Extracts:
 * - People: capitalized names identified by context patterns
 * - Technologies: 25+ known tech keywords matched case-insensitively
 * - Projects: kebab-case identifiers and contextual project references
 */
export function extractEntities(text: string): string[] {
  const people = extractPeople(text)
  const technologies = extractTechnologies(text)
  const projects = extractProjects(text)

  // Combine all, deduplicate via Set, return flat array
  return [...new Set([...people, ...technologies, ...projects])]
}
