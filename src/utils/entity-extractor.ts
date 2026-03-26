/**
 * Lightweight Entity Extraction.
 *
 * Extracts person names, technologies, and project names from message text
 * using regex patterns (no LLM call). Stores as metadata tags on episodes.
 */

export interface ExtractedEntities {
  people: string[];
  technologies: string[];
  projects: string[];
}

/** Known technology keywords (extensible) */
const TECH_PATTERNS = [
  // Languages
  /\b(TypeScript|JavaScript|Python|Rust|Go|Java|Kotlin|Swift|Ruby|PHP|C\+\+|C#)\b/gi,
  // Frameworks/tools
  /\b(React|Vue|Angular|Next\.js|Nuxt|Svelte|Express|FastAPI|Django|Flask|Spring)\b/gi,
  /\b(Node\.js|Deno|Bun|Docker|Kubernetes|Terraform|AWS|GCP|Azure)\b/gi,
  /\b(PostgreSQL|MySQL|MongoDB|Redis|Supabase|Firebase|Prisma|Drizzle)\b/gi,
  /\b(Git|GitHub|GitLab|Bitbucket|Vercel|Netlify|Cloudflare)\b/gi,
  /\b(OpenAI|Claude|GPT-[34o]|Anthropic|LLM|pgvector|Tailscale)\b/gi,
  /\b(Vitest|Jest|Mocha|ESLint|Prettier|Webpack|Vite|tsup|esbuild)\b/gi,
];

/** Project name patterns */
const PROJECT_PATTERNS = [
  // "the X project", "working on X", "building X"
  /(?:the|our|my)\s+(\w[\w-]*(?:\s+\w[\w-]*)?)\s+project/gi,
  /(?:working on|building|developing)\s+(\w[\w-]*(?:-\w+)*)/gi,
  // kebab-case or camelCase identifiers that look like project names
  /\b([a-z][\w]*-[a-z][\w]*(?:-[a-z][\w]*)*)\b/g,
];

/** Person name patterns (capitalized words, not at sentence start) */
const PERSON_PATTERNS = [
  // "tell X", "ask X", "X said", "@X"
  /(?:(?:tell|ask|cc|ping)\s+|@)([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g,
  // Two capitalized words together (likely a full name)
  /(?:^|[.!?]\s+)(?!(?:The|This|That|These|Those|What|How|Why|When|Where|Who|I|We|He|She|It|They|You|My|Our|His|Her|Its|Their|Your)\b)([A-Z][a-z]+\s+[A-Z][a-z]+)/gm,
];

/** Common words that aren't people */
const NAME_BLACKLIST = new Set([
  'The', 'This', 'That', 'These', 'Those', 'What', 'How', 'Why',
  'When', 'Where', 'Who', 'Which', 'There', 'Here', 'Some', 'Any',
  'Each', 'Every', 'Both', 'All', 'Most', 'Many', 'Much', 'More',
  'Other', 'Another', 'Such', 'Same', 'Good', 'Great', 'Best',
  'New', 'Old', 'First', 'Last', 'Next', 'Previous',
]);

export class EntityExtractor {
  /**
   * Extract entities from text.
   */
  extract(text: string): ExtractedEntities {
    return {
      people: this.extractPeople(text),
      technologies: this.extractTechnologies(text),
      projects: this.extractProjects(text),
    };
  }

  /**
   * Extract and return as flat metadata tags.
   */
  extractAsTags(text: string): Record<string, string[]> {
    const entities = this.extract(text);
    const tags: Record<string, string[]> = {};
    if (entities.people.length > 0) tags.people = entities.people;
    if (entities.technologies.length > 0) tags.technologies = entities.technologies;
    if (entities.projects.length > 0) tags.projects = entities.projects;
    return tags;
  }

  private extractPeople(text: string): string[] {
    const names = new Set<string>();
    for (const pattern of PERSON_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const name = match[1].trim();
        const firstName = name.split(/\s+/)[0];
        if (!NAME_BLACKLIST.has(firstName) && name.length > 1) {
          names.add(name);
        }
      }
    }
    return [...names];
  }

  private extractTechnologies(text: string): string[] {
    const techs = new Set<string>();
    for (const pattern of TECH_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        techs.add(match[1]);
      }
    }
    return [...techs];
  }

  private extractProjects(text: string): string[] {
    const projects = new Set<string>();
    for (const pattern of PROJECT_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const name = match[1].trim();
        // Filter out common words and very short names
        if (name.length > 3 && !name.match(/^(the|our|my|this|that|some|will|have|been|with)$/i)) {
          projects.add(name);
        }
      }
    }
    return [...projects];
  }
}
