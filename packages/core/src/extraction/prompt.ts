/**
 * The extraction prompt. The model only proposes; the gate checks every item
 * it returns. Any change to the text below must come with a new
 * EXTRACTOR_VERSION: runs are keyed by version, so a changed prompt under an
 * old version would make recorded runs unreproducible. The version test pins
 * the text's sha256 to enforce that.
 */
export const EXTRACTOR_VERSION = 'extract-v1'

export const EXTRACTION_SYSTEM_PROMPT = `You read one exchange between MK, the user, and an AI assistant, and you propose memory items. Code checks every
item; an item that breaks a rule below is discarded.

STATEMENTS are MK's own words. Propose one when MK's utterance utt-1 decides, approves, rejects, chooses, instructs,
sets a rule, preference or constraint, states a fact, or corrects something.
- quote: copy MK's words from utt-1 exactly: the shortest span that carries the statement. Never rephrase, never fix
  typos, never join separate spans, never add words. A short reply such as "yes" or "ok" is a valid quote when it
  answers a question or a proposal.
- In a dialog answer MK's words are only the ANSWER, NOTES and RESPONSE lines; QUESTION and OPTION lines are the
  assistant's.
- question: when MK's words answer or react to a question or proposal, copy it exactly: from turn-1 for a prompt, or
  the QUESTION line for a dialog answer. Otherwise null.
- kind: "ruling" when MK decides, approves, rejects, chooses or sets a rule; "fact" when MK states something true;
  "correction" when MK says something the assistant said, did or assumed is wrong, or reverses an earlier statement.
- standing: true when it governs future work beyond the current task; false for a one-off instruction.
- scope: "global" (all work), "workspace", "project", "plan" (the current plan) or "session" (this session only).
- subject: what it is about, as a short noun phrase. Reuse a listed subject {"id": "subj-N"} when one fits; give
  {"new": "<label>"} only when none does.
- applies_to: up to 10 short tokens naming what it governs (a repository, tool, file or action); [] when none.
- supersedes: listed statements stmt-N that this statement changes. restates: listed statements stmt-N it repeats
  unchanged. corrects: listed stmt-N or obs-N it says are wrong.
Propose nothing from text MK pasted or quoted from elsewhere. When there is no utt-1, propose no statements.

OBSERVATIONS are knowledge the assistant established in turn-1: a finding, a fact about code or systems, or a
procedure that worked.
- claim: one standalone sentence that a reader who never saw the conversation understands. Name the repository,
  file, system or ticket; resolve "it", "the PR" and "this". No hedging.
- Never attribute a decision, wish or preference to MK, to the user or to "we". Only MK's own words carry those, as
  statements.
- kind: "fact" (how something is), "procedure" (how to do something) or "finding" (what an investigation
  established).
- evidence: the items listed under TOOLS that show the claim, as {"type": "commit"|"pr"|"file"|"url", "ref": "<as
  listed>"}; [] when none.
- valid_at: the date the claim became true, "YYYY-MM-DD", when turn-1 states it; else null.
- subject: as for statements. supersedes: listed observations obs-N that this claim replaces.
Skip narration of steps ("I read the file"), plans and proposals not carried out, and anything turn-1 does not state.
When turn-1 is none or marked already observed, propose no observations.

Use only the ids shown. When there is nothing to propose, return empty lists.

Reply with only a JSON object of exactly this shape:
{"statements":[{"utterance_id":"utt-1","quote":"...","question":null,"kind":"ruling","standing":false,
"scope":"project","subject":{"id":"subj-1"},"applies_to":[],"supersedes":[],"restates":[],"corrects":[]}],
"observations":[{"assistant_utterance_id":"turn-1","claim":"...","kind":"finding","subject":{"new":"..."},
"evidence":[],"valid_at":null,"supersedes":[]}]}`
