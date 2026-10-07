/**
 * The extraction prompts. The model only proposes; code checks every item and
 * every decision it returns. Any change to the texts or the reply schema below
 * must come with a new EXTRACTOR_VERSION: runs are keyed by version, so a
 * changed prompt under an old version would make recorded runs
 * unreproducible. The version test pins the sha256 of all three to enforce
 * that.
 */
export const EXTRACTOR_VERSION = 'extract-v4'

export const EXTRACTION_SYSTEM_PROMPT = `You read one exchange between MK, the user, and an AI assistant, and you propose memory items. Code checks every
item; an item that breaks a rule below is discarded. The assistant's turns are turn-1, turn-2, ..., oldest first; MK's
utterance utt-1, when there is one, follows the last of them.

STATEMENTS are MK's own words. Propose one when MK's utterance utt-1 decides, approves, rejects, chooses, instructs,
sets a rule, preference or constraint, states a fact, or corrects something.
- quote: copy MK's words from utt-1 exactly: the shortest span that carries the statement. Never rephrase, never fix
  typos, never join separate spans, never add words. A short reply such as "yes" or "ok" is a valid quote when it
  answers a question or a proposal.
- In a dialog answer MK's words are only the ANSWER, NOTES and RESPONSE lines; QUESTION and OPTION lines are the
  assistant's.
- question: when MK's words answer or react to a question or proposal, copy it exactly: from a turn for a prompt, or
  the QUESTION line for a dialog answer. Otherwise null.
- kind: "ruling" when MK decides, approves, rejects, chooses or sets a rule; "fact" when MK states something true;
  "correction" when MK says something the assistant said, did or assumed is wrong, or reverses an earlier statement.
- standing: true when it governs future work beyond the current task; false for a one-off instruction.
- scope: "global" (all work), "workspace", "project", "plan" (the current plan) or "session" (this session only).
- subject: what it is about, as a short noun phrase. Reuse a listed subject {"id": "subj-N"} when one fits; give
  {"new": "<label>"} only when none does.
- applies_to: up to 10 short tokens naming what it governs (a repository, tool, file or action); [] when none.
- supersedes: listed statements stmt-N that this statement changes. restates: listed statements stmt-N it repeats
  unchanged. corrects: listed stmt-N or obs-N, or shown items shown-N, that MK's words say are wrong.
Propose nothing from text MK pasted or quoted from elsewhere. When there is no utt-1, propose no statements.

SHOWN items (shown-N) are memories the assistant was shown before it wrote the turns, so the turns may rest on them.
When MK says something a turn relied on is wrong, stale or out of date and it matches a shown item, propose a
statement of kind "correction" with MK's words and name that shown-N in corrects. Name a shown-N only in corrects.

OBSERVATIONS are knowledge the assistant established in a turn: a finding, a fact about code or systems, or a
procedure that worked.
- assistant_utterance_id: the turn-N that establishes the claim. A claim a later turn revises comes from that later
  turn, as it ends up.
- claim: one standalone sentence that a reader who never saw the conversation understands. Name the repository,
  file, system or ticket; resolve "it", "the PR" and "this". No hedging.
- Never attribute a decision, wish or preference to MK, to the user or to "we". Only MK's own words carry those, as
  statements.
- kind: "fact" (how something is), "procedure" (how to do something) or "finding" (what an investigation
  established).
- evidence: the items listed under TOOLS of that turn that show the claim, as {"type": "commit"|"pr"|"file"|"url",
  "ref": "<as listed>"}; [] when none.
- valid_at: the date the claim became true, "YYYY-MM-DD", when the turn states it; else null.
- subject: as for statements. supersedes: listed observations obs-N that this claim replaces.
Skip narration of steps ("I read the file"), plans and proposals not carried out, and anything the turn does not
state. Propose no observation from a turn marked already observed; when TURNS is none, propose no observations.

Use only the ids shown. When there is nothing to propose, return empty lists.

Reply with only a JSON object of exactly this shape:
{"statements":[{"utterance_id":"utt-1","quote":"...","question":null,"kind":"ruling","standing":false,
"scope":"project","subject":{"id":"subj-1"},"applies_to":[],"supersedes":[],"restates":[],"corrects":[]}],
"observations":[{"assistant_utterance_id":"turn-1","claim":"...","kind":"finding","subject":{"new":"..."},
"evidence":[],"valid_at":null,"supersedes":[]}]}`


/**
 * The second call of a window: each new item that will be stored is weighed
 * against the current items on its subject, which the first call's window may
 * not have listed. Aliases c-N name the candidates; code maps them back and
 * drops any that is not a candidate of the item it is given for.
 */
export const DECISION_SYSTEM_PROMPT = `You compare new memory items with the items already stored on the same subject and decide, for each new item,
how it relates to them. Code checks every decision; a decision that breaks a rule below is discarded.

Each NEW ITEM lists its CANDIDATES, newest first: the current items on its subject that are no newer than it. A
statement is MK's own words, an observation is knowledge an AI assistant established, and a register entry is a
recorded standing ruling.

Give one decision per new item:
- relation "supersedes": the new item changes, replaces or reverses what the targets say, so they stop being
  current. Targets are candidates of the same type as the new item (a statement for a statement, an observation for
  an observation), or register entries for a statement.
- relation "restates": the new item says what the targets already say and adds nothing. Targets are candidates of the
  same type as the new item, or register entries for a statement.
- relation "independent": the new item neither changes nor repeats any candidate; targets is [].
- corrects: for a new statement, the observation candidates MK's words say are wrong; [] otherwise. A correction is
  recorded for MK to review; it does not end the observation.
A new item about a different detail of the subject is independent of the candidates about other details. When unsure,
choose "independent": a wrong supersession hides something still true. Use only the candidate ids listed under that
item.

Reply with only a JSON object of exactly this shape, one decision per new item:
{"decisions":[{"item":0,"relation":"independent","targets":[],"corrects":[]}]}`

/** The decision reply's schema; the decision parser enforces exactly this. */
export const DECISION_REPLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['decisions'],
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['item', 'relation', 'targets', 'corrects'],
        properties: {
          item: { type: 'integer', minimum: 0 },
          relation: { enum: ['supersedes', 'restates', 'independent'] },
          targets: { type: 'array', items: { type: 'string' } },
          corrects: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const
