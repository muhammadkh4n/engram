import { describe, it, expect } from 'vitest'
import { scoreSalience } from '../../src/ingestion/salience.js'

describe('scoreSalience', () => {
  const msg = (content: string, role = 'user') => ({ role, content })

  describe('explicit flag signal (0.95)', () => {
    it('scores "remember this" at 0.95', () => {
      expect(scoreSalience(msg('Please remember this for later'))).toBe(0.95)
    })

    it('scores "important" at 0.95', () => {
      expect(scoreSalience(msg('This is important: always validate input'))).toBe(0.95)
    })

    it('scores "note:" at 0.95', () => {
      expect(scoreSalience(msg('Note: the deadline is Friday'))).toBe(0.95)
    })
  })

  describe('decision signal (0.90)', () => {
    it('scores "let\'s go with" at 0.90', () => {
      expect(scoreSalience(msg("Let's go with PostgreSQL for the database"))).toBe(0.90)
    })

    it('scores "we decided" at 0.90', () => {
      expect(scoreSalience(msg('We decided to use TypeScript for everything'))).toBe(0.90)
    })

    it('scores "the plan is" at 0.90', () => {
      expect(scoreSalience(msg('The plan is to ship by end of month'))).toBe(0.90)
    })
  })

  describe('correction signal (0.85)', () => {
    it('scores "no actually" at 0.85', () => {
      expect(scoreSalience(msg('No, actually that approach will not work'))).toBe(0.85)
    })

    it('scores "that\'s wrong" at 0.85', () => {
      expect(scoreSalience(msg("That's wrong, we need to use async/await"))).toBe(0.85)
    })

    it('scores "not like that" at 0.85', () => {
      expect(scoreSalience(msg('Not like that, try a different approach'))).toBe(0.85)
    })
  })

  describe('preference signal (0.85)', () => {
    it('scores "I prefer" at 0.85', () => {
      expect(scoreSalience(msg('I prefer using tabs over spaces'))).toBe(0.85)
    })

    it('scores "I always" at 0.85', () => {
      expect(scoreSalience(msg('I always run prettier before committing'))).toBe(0.85)
    })

    it('scores "I never" at 0.85', () => {
      expect(scoreSalience(msg('I never use var in modern JavaScript'))).toBe(0.85)
    })
  })

  describe('emotional signal (0.80)', () => {
    it('scores "frustrated" at 0.80', () => {
      expect(scoreSalience(msg('I am frustrated with these type errors'))).toBe(0.80)
    })

    it('scores "critical" at 0.80', () => {
      expect(scoreSalience(msg('This is a critical bug in production'))).toBe(0.80)
    })

    it('scores "urgent" at 0.80', () => {
      expect(scoreSalience(msg('Urgent: the server is down'))).toBe(0.80)
    })

    it('scores "excited" at 0.80', () => {
      expect(scoreSalience(msg('I am excited about this new approach'))).toBe(0.80)
    })
  })

  describe('question signal (0.60)', () => {
    it('scores a message ending with ? at 0.60', () => {
      expect(scoreSalience(msg('What is the best way to handle authentication?'))).toBe(0.60)
    })

    it('scores a simple question at 0.60', () => {
      expect(scoreSalience(msg('Can you explain how this works?'))).toBe(0.60)
    })

    it('does not score a non-question at 0.60', () => {
      expect(scoreSalience(msg('This is a statement.'))).not.toBe(0.60)
    })
  })

  describe('code block signal (0.50)', () => {
    it('scores a message with triple backticks at 0.50', () => {
      const content = 'Here is some code:\n```typescript\nconst x = 1\n```'
      expect(scoreSalience(msg(content))).toBe(0.50)
    })
  })

  describe('long message signal (0.40)', () => {
    it('scores a message longer than 200 chars at 0.40', () => {
      const content = 'a'.repeat(201)
      expect(scoreSalience(msg(content))).toBe(0.40)
    })

    it('does not score a 200-char message at 0.40 via this signal alone', () => {
      const content = 'a'.repeat(200)
      // Exactly 200 chars is not > 200, so this signal does not fire
      expect(scoreSalience(msg(content))).toBe(0.30)
    })
  })

  describe('default score (0.30)', () => {
    it('returns 0.30 for a plain normal message', () => {
      expect(scoreSalience(msg('The weather is nice today'))).toBe(0.30)
    })

    it('returns 0.30 for a short neutral assistant message', () => {
      expect(scoreSalience({ role: 'assistant', content: 'Here is the result' })).toBe(0.30)
    })
  })

  describe('acknowledgment score (0.10)', () => {
    it('scores "ok" alone at 0.10', () => {
      expect(scoreSalience(msg('ok'))).toBe(0.10)
    })

    it('scores "thanks" alone at 0.10', () => {
      expect(scoreSalience(msg('thanks'))).toBe(0.10)
    })

    it('scores "sure" alone at 0.10', () => {
      expect(scoreSalience(msg('sure'))).toBe(0.10)
    })

    it('scores "okay" alone at 0.10', () => {
      expect(scoreSalience(msg('okay'))).toBe(0.10)
    })

    it('scores "got it" alone at 0.10', () => {
      expect(scoreSalience(msg('got it'))).toBe(0.10)
    })

    it('scores "sounds good" alone at 0.10', () => {
      expect(scoreSalience(msg('sounds good'))).toBe(0.10)
    })

    it('does not score a longer message containing "ok" at 0.10', () => {
      expect(scoreSalience(msg('ok, I think we should refactor this module'))).not.toBe(0.10)
    })
  })

  describe('combination rule', () => {
    it('combines decision + preference: max(0.90, 0.85) + 0.05 * 1 = 0.95', () => {
      // "we decided" (0.90) + "I prefer" (0.85) => max = 0.90, count = 2, bonus = 0.05
      const content = "We decided to use this approach but I prefer to refactor first"
      const score = scoreSalience(msg(content))
      expect(score).toBe(0.95)
    })

    it('combines explicit flag + decision: max(0.95, 0.90) + 0.05 = 0.99 (capped)', () => {
      // "important" (0.95) + "we decided" (0.90) => max = 0.95, count = 2, result = 1.00 -> capped at 0.99
      const content = 'Important: we decided to use PostgreSQL as our primary database'
      const score = scoreSalience(msg(content))
      expect(score).toBe(0.99)
    })

    it('never exceeds 0.99 even with many signals', () => {
      // Packs multiple signals: explicit flag, decision, emotional, preference, question
      const content = "Important: we decided and I prefer this but I'm frustrated. Should we proceed?"
      const score = scoreSalience(msg(content))
      expect(score).toBeLessThanOrEqual(0.99)
    })

    it('combines question + code block: max(0.60, 0.50) + 0.05 = 0.65', () => {
      // Message contains a code block AND ends with ? so both signals fire
      const content = '```js\nconsole.log(1)\n``` Does this work?'
      const score = scoreSalience(msg(content))
      expect(score).toBe(0.65)
    })
  })

  describe('repetition signal (0.75)', () => {
    it('scores 0.75 when the same topic appears 3+ times in recent messages', () => {
      const recentMessages = [
        { content: 'We should refactor the authentication module' },
        { content: 'The authentication flow needs updating' },
        { content: 'Authentication is broken in production' },
      ]
      const score = scoreSalience(
        msg('We need to fix the authentication system'),
        { recentMessages },
      )
      expect(score).toBe(0.75)
    })

    it('does not score repetition with fewer than 3 matching recent messages', () => {
      const recentMessages = [
        { content: 'The authentication module has issues' },
        { content: 'Something else entirely' },
      ]
      const score = scoreSalience(
        msg('We need to fix the authentication system'),
        { recentMessages },
      )
      // Should not trigger repetition signal, so falls to default 0.30
      expect(score).toBe(0.30)
    })

    it('returns default when no context is provided', () => {
      const score = scoreSalience(msg('Some neutral message'))
      expect(score).toBe(0.30)
    })
  })
})
