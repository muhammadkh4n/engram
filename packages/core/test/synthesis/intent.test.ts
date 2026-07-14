import { describe, it, expect } from 'vitest'
import { classifyComputeIntent, isPreferenceRequest } from '../../src/synthesis/intent.js'

describe('classifyComputeIntent — temporal (incl. the families B\'s spec missed)', () => {
  const temporal = [
    'How many days passed between my visit to the MoMA and the exhibit at the Met?',
    'How many weeks ago did I meet up with my aunt and receive the crystal chandelier?',
    'How many months have passed since I last visited a museum with a friend?',
    'Which three events happened in the order from first to last: the nursery day, the baby shower day, and the phone case day?',
    'What is the order of the trips I took, from earliest to latest?',
    'Which event happened first, the concert or the conference?',
    'Which bike did I service a week ago?',              // singular unit
    'Which restaurant did I visit most recently?',        // most recently
    'When did I first mention my sourdough starter?',
    'How long did the kitchen renovation take?',
    'What year did I adopt my dog?',
    'Did I visit the dentist before or after the wedding?',
  ]
  for (const q of temporal) {
    it(`temporal: ${q.slice(0, 60)}`, () => expect(classifyComputeIntent(q)).toBe('temporal'))
  }
})

describe('classifyComputeIntent — aggregation (bare "how many <noun>" included)', () => {
  const aggregation = [
    'How many model kits have I worked on or bought?',
    'How many different airlines have I flown with this year?',
    'How often do I go to the gym?',
    'What is the total number of concerts I attended?',
    'List all the books I mentioned reading.',
  ]
  for (const q of aggregation) {
    it(`aggregation: ${q.slice(0, 60)}`, () => expect(classifyComputeIntent(q)).toBe('aggregation'))
  }
  it('precedence: "how many days between" is temporal, not aggregation', () => {
    expect(classifyComputeIntent('How many days between my two trips?')).toBe('temporal')
  })
})

describe('classifyComputeIntent — none (no grounding/arithmetic/counting demand)', () => {
  const none = [
    'What did I say about the hotel in Barcelona?',
    'What is the name of my sister\'s cat?',
    'Where did I leave my passport?',
  ]
  for (const q of none) {
    it(`none: ${q.slice(0, 60)}`, () => expect(classifyComputeIntent(q)).toBe('none'))
  }
})

describe('isPreferenceRequest', () => {
  const positive = [
    'I\'m planning a trip to Denver soon. Any suggestions on what to do there?',
    'I\'ve got some free time tonight, any documentary recommendations?',
    'I was thinking about rearranging the furniture in my bedroom this weekend. Any tips?',
    'What should I cook for the dinner party?',
    'I\'m trying to decide whether to buy a NAS device now or wait. What do you think?',
    'Can you recommend video-editing resources?',
  ]
  for (const q of positive) {
    it(`preference: ${q.slice(0, 60)}`, () => expect(isPreferenceRequest(q)).toBe(true))
  }
  const negative = [
    'What did you recommend for my trip to Denver?',   // past-assistant retrieval
    'Which restaurant did you suggest last week?',
    'How many days passed between my two trips?',
    'What did I say about the hotel?',
  ]
  for (const q of negative) {
    it(`not preference: ${q.slice(0, 60)}`, () => expect(isPreferenceRequest(q)).toBe(false))
  }
})
