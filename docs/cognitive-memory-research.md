# Cognitive Memory Architecture Research for Engram

**Date**: 2026-03-27
**Purpose**: Exhaustive research on brain-mimicking memory architectures, cognitive architectures, and neuroscience-inspired patterns to differentiate Engram from commodity RAG wrappers.

---

## Table of Contents

1. [Cognitive Architectures](#1-cognitive-architectures)
   - [ACT-R](#11-act-r-adaptive-control-of-thoughtrational)
   - [SOAR](#12-soar-state-operator-and-result)
   - [CLARION](#13-clarion)
   - [Global Workspace Theory](#14-global-workspace-theory-gwt)
2. [Neuroscience Memory Models](#2-neuroscience-memory-models)
   - [Complementary Learning Systems](#21-complementary-learning-systems-cls)
   - [Memory Reconsolidation](#22-memory-reconsolidation)
   - [Hebbian Learning](#23-hebbian-learning)
   - [Ebbinghaus Forgetting Curve](#24-ebbinghaus-forgetting-curve--spaced-repetition)
   - [Emotional Tagging](#25-emotional-tagging-amygdala-model)
   - [Context-Dependent Memory](#26-context-dependent-memory)
3. [Recent AI Memory Research (2024-2026)](#3-recent-ai-memory-research-20242026)
   - [MemGPT / Letta](#31-memgpt--letta)
   - [Mem0](#32-mem0)
   - [Zep / Graphiti](#33-zep--graphiti)
   - [LangMem](#34-langmem)
   - [Generative Agents (Stanford)](#35-generative-agents-stanford-park-et-al-2023)
   - [Voyager](#36-voyager-wang-et-al-2023)
   - [Reflexion](#37-reflexion)
   - [A-MEM](#38-a-mem-agentic-memory)
   - [Benchmarks (LoCoMo, MemBench, OOLONG)](#39-benchmarks)
4. [Sleep and Consolidation Research](#4-sleep-and-consolidation-research)
5. [Implementable Patterns for Engram](#5-implementable-patterns-for-engram)
6. [Competitive Architecture Comparison](#6-competitive-architecture-comparison)
7. [Sources](#7-sources)

---

## 1. Cognitive Architectures

### 1.1 ACT-R (Adaptive Control of Thought--Rational)

**Origin**: John Anderson, Carnegie Mellon University
**Status**: The most mathematically precise cognitive architecture; 30+ years of empirical validation

#### 1.1.1 The Activation Equation

The total activation of a chunk i determines its retrievability:

```
A_i = B_i + sum_j(W_j * S_ji) + P_i + epsilon
```

Where:
- `B_i` = base-level activation (frequency/recency)
- `sum_j(W_j * S_ji)` = spreading activation from context
- `P_i` = partial matching penalty (mismatch cost)
- `epsilon` = stochastic noise (logistic distribution with parameter s)

#### 1.1.2 Base-Level Activation (Power Law of Forgetting)

```
B_i = ln( sum_{j=1}^{n} t_j^{-d} )
```

Where:
- `n` = number of times chunk i has been accessed
- `t_j` = time since the j-th access (in seconds)
- `d` = decay parameter (default: 0.5)

This is the most successful equation in the theory. Each new use adds a term that decays independently as a power function. The logarithmic transformation converts the sum into an activation level. This means:
- Recently accessed items have high activation
- Frequently accessed items accumulate activation
- Old, unused items decay but never fully reach zero
- The power law (not exponential) means early decay is fast but long-term retention is stubborn

**Engram implication**: Replace any linear decay with this power-law formula. Every access to a memory should add a new t_j term. Store access timestamps as an array, not just "last_accessed".

#### 1.1.3 Spreading Activation

```
S_ji = S - ln(fan_j)
```

Where:
- `S` = maximum associative strength (default: depends on model)
- `fan_j` = number of chunks associated with source j (the "fan effect")
- `W_j` = attentional weight of source j (total W sums to 1.0)

The fan effect is critical: the more facts associated with a concept, the weaker each individual association. If "Python" is associated with 50 knowledge entries, each gets diluted. If "Muhammad's deployment preference" is associated with 2 entries, each is strongly activated.

**Engram implication**: When computing association strength, divide by the fan (degree) of the source node. High-degree nodes should produce weaker individual activations. This naturally prioritizes specific, personal knowledge over generic facts.

#### 1.1.4 Retrieval Probability

```
P(retrieve_i) = 1 / (1 + e^{-(A_i - tau) / s})
```

Where:
- `tau` = retrieval threshold (default: -2.0, meaning chunks below this activation fail to retrieve ~50% of the time)
- `s` = noise parameter (default: varies, controls stochasticity)

This is a softmax/sigmoid over activation. It means retrieval is *probabilistic* -- even high-activation chunks can fail, and low-activation chunks can sometimes succeed. This prevents deterministic retrieval bias.

**Engram implication**: Add stochastic noise to retrieval scoring. Don't always return the top-k by raw score. Occasionally "surprise" the agent with a lower-ranked but relevant memory. This mimics serendipitous recall.

#### 1.1.5 Retrieval Latency

```
T_i = F * e^{-A_i}
```

Where:
- `F` = latency factor (default: 1.0)
- `A_i` = activation of chunk i

Higher activation = faster retrieval. This means familiar memories are retrieved almost instantly while rare memories take longer. In a real system, this maps to prioritizing fast-path retrieval for high-activation items and lazy-loading for low-activation items.

#### 1.1.6 Procedural Memory (Production Rules)

ACT-R's procedural memory uses IF-THEN production rules with utility learning:

```
U_i(n) = U_i(n-1) + alpha * [R_i(n) - U_i(n-1)]
```

Where:
- `U_i(n)` = utility of production i after n-th application
- `alpha` = learning rate
- `R_i(n)` = reward received on trial n

Productions compete via their utility values. The one with the highest utility fires. This is essentially reinforcement learning over production rules.

**Engram implication**: Procedural memories (tool preferences, coding patterns) should track a utility score. Each time a procedure is used successfully, its utility increases. Failed procedures get utility decreases. Over time, the system learns which procedures work best.

#### 1.1.7 Default Parameters

| Parameter | Symbol | Default | Description |
|-----------|--------|---------|-------------|
| Decay | d | 0.5 | Power law decay rate |
| Retrieval threshold | tau | -2.0 | Minimum activation for retrieval |
| Latency factor | F | 1.0 | Scales retrieval time |
| Noise | s | 0.25-0.5 | Logistic noise parameter |
| Max associative strength | S | varies | Cap on S_ji |

---

### 1.2 SOAR (State, Operator, And Result)

**Origin**: John Laird, University of Michigan
**Status**: Mature architecture with episodic + semantic long-term memories

#### 1.2.1 Memory Systems in SOAR

SOAR has four memory types:

1. **Working Memory**: Short-term buffer holding current state, goals, and operator applications. Organized as a graph of working memory elements (WMEs).

2. **Procedural Memory**: Long-term storage of production rules (IF-THEN). Rules fire when their conditions match working memory.

3. **Semantic Memory (SMEM)**: Long-term storage of factual knowledge as directed cyclic graphs. Data is stored/retrieved by rules that create commands in a reserved area of working memory. Essentially a persistent knowledge base.

4. **Episodic Memory (EPMEM)**: Automatically records snapshots of working memory at each decision cycle. The agent can deliberately query episodic memory to retrieve past states. Episodes are stored as temporal sequences of working memory snapshots.

#### 1.2.2 Chunking

SOAR's chunking mechanism is automatic learning. When the agent solves a subproblem (impasse), the processing that led to the result is compiled into new production rules. These rules bypass the subproblem on future encounters. Key properties:

- Automatic: triggers whenever a result is created in a substate
- Compiles multi-step reasoning into single-step rules
- Produces speed-up learning (familiar problems solved faster)
- Can lead to overgeneralization if conditions aren't properly captured

**Engram implication**: When an agent successfully completes a complex task, extract the successful pattern as a procedural memory. This is exactly what Engram's procedural system should do -- but triggered automatically, not manually.

#### 1.2.3 Forgetting in SOAR

The current episodic memory implementation does not implement forgetting. However, research has explored:

- **Base-level activation forgetting**: Similar to ACT-R, items not in active use (as determined by activation levels) can be removed
- **Working memory forgetting**: Items lose activation over time and are removed when below threshold
- **Procedural forgetting**: Rules that haven't fired recently can be removed, with the assumption they can be reconstructed if needed

**Engram implication**: SOAR's approach of "forgettable but reconstructable" is interesting. Rather than hard-deleting decayed memories, flag them as "dormant" and store enough metadata to reconstruct them from source material if needed.

---

### 1.3 CLARION

**Origin**: Ron Sun, RPI
**Status**: Most sophisticated dual-process cognitive architecture

#### 1.3.1 Dual-Process Theory

CLARION implements the psychological distinction between:

**Implicit (bottom level)**: Subsymbolic, distributed representations processed by neural networks. This is "knowing how" without being able to articulate it. Associative and holistic processing.

**Explicit (top level)**: Symbolic, rule-based representations using chunks and rules. This is "knowing that" -- articulable, declarative knowledge.

Both levels run in parallel and interact bidirectionally.

#### 1.3.2 Four Subsystems

1. **Action-Centered Subsystem (ACS)**: Controls actions. Implicit = neural network mapping states to actions. Explicit = action rules.
2. **Non-Action-Centered Subsystem (NACS)**: General knowledge. Implicit = associative memory network. Explicit = chunks and rules.
3. **Motivational Subsystem (MS)**: Drives and goals. Provides motivational context for decisions.
4. **Meta-Cognitive Subsystem (MCS)**: Monitors and regulates the other subsystems. Adjusts learning rates, selects strategies.

#### 1.3.3 Bottom-Up Learning (Critical for Engram)

CLARION's most distinctive feature: the Rule-Extraction-Refinement (RER) algorithm extracts explicit rules from implicit neural network knowledge.

Process:
1. Agent learns implicitly through reinforcement (neural network adjusts weights)
2. After sufficient implicit learning, the RER algorithm examines which input features consistently predict successful actions
3. These patterns are extracted as explicit IF-THEN rules
4. Rules are refined over time through further experience

This means CLARION can discover rules it was never explicitly taught. It learns patterns implicitly first, then makes them explicit.

**Engram implication**: This maps directly to Engram's consolidation cycles. During "deep sleep," the system should analyze episodic patterns and extract explicit semantic knowledge. The process is:
1. Episodic memories accumulate (implicit pattern)
2. Consolidation detects recurring patterns across episodes
3. Patterns are extracted as semantic knowledge entries (explicit rules)
4. Knowledge is refined as more episodes confirm or contradict it

#### 1.3.4 Top-Down Learning

The reverse also occurs: explicit rules can be "compiled down" into implicit neural network knowledge, speeding up processing. This is analogous to how a consciously learned skill becomes automatic with practice.

**Engram implication**: Frequently accessed semantic knowledge should be "compiled" into faster-access working memory patterns or cached retrieval paths.

---

### 1.4 Global Workspace Theory (GWT)

**Origin**: Bernard Baars, 1988
**Status**: Leading theory of consciousness; increasingly used in AI architecture design

#### 1.4.1 The Theater Metaphor

- **Stage** (bright spot) = working memory / conscious awareness (limited capacity)
- **Spotlight** = attention (selects what enters awareness)
- **Audience** = unconscious specialist modules (vast capacity, process in parallel)
- **Behind the scenes** = executive processes that direct the spotlight

#### 1.4.2 The Broadcasting Mechanism

The core insight: when information enters the global workspace (conscious awareness), it is *broadcast* to all unconscious modules simultaneously. This has several effects:

1. **Recruitment**: Specialist modules that find the broadcast relevant activate and contribute their expertise
2. **Binding**: Information from different modules gets integrated into a coherent experience
3. **Memory formation**: Broadcast information is more likely to be encoded into long-term memory
4. **Action selection**: Multiple modules compete to place content on the workspace; the winner gets broadcast

**Engram implication -- The Priming Broadcast**: When a memory is retrieved (enters the "workspace"), broadcast a signal to all memory subsystems simultaneously:
- Episodic system: activate related episodes
- Semantic system: activate related knowledge
- Procedural system: activate relevant procedures
- Association graph: strengthen edges to co-activated memories

This is what Engram's priming stage should implement. It's not just "find related memories" -- it's "alert all systems that this topic is currently active, and let them each contribute relevant information."

#### 1.4.3 Competition for Access

Multiple unconscious coalitions compete to place their content on the global workspace. Only the strongest coalition wins access. This prevents information overload.

**Engram implication**: When multiple memory results are retrieved, implement a competition mechanism. Results from different subsystems (episodic, semantic, procedural) compete for inclusion in the final context. Each subsystem "argues" for its results based on relevance, recency, and importance. Only the winners get included.

---

## 2. Neuroscience Memory Models

### 2.1 Complementary Learning Systems (CLS)

**Origin**: McClelland, McNaughton, O'Reilly (1995)
**Status**: The foundational theory explaining why brains need two memory systems

#### 2.1.1 The Core Insight

The brain requires two fundamentally different learning systems because of the **catastrophic interference problem**:

- **Hippocampus** (fast learner): Sparse, pattern-separated representations. Rapidly encodes individual episodes with minimal interference. Uses high learning rates and orthogonal representations to keep memories distinct.

- **Neocortex** (slow learner): Distributed, overlapping representations. Gradually integrates across many episodes to extract statistical regularities and semantic structure. Uses low learning rates to avoid catastrophic forgetting.

If the neocortex tried to learn quickly (like the hippocampus), new learning would overwrite old knowledge. If the hippocampus learned slowly (like the neocortex), it couldn't capture individual episodes.

#### 2.1.2 The Consolidation Transfer

1. New experience is rapidly encoded in hippocampus (episodic memory)
2. During sleep, hippocampus replays recent experiences
3. Each replay causes small synaptic changes in neocortex
4. Over many replay cycles, neocortex builds distributed representations
5. Eventually, the memory becomes hippocampus-independent (pure neocortex)

The transfer is gradual and interleaved -- new memories are replayed alongside old memories to prevent catastrophic forgetting of existing neocortical knowledge.

#### 2.1.3 Schema Assimilation

A critical update to CLS (Tse et al., 2007): when new information is **consistent with an existing schema** (knowledge structure), it can be rapidly integrated into the neocortex without extensive hippocampal replay. The neocortex has "slots" in its existing representations where compatible new information fits naturally.

**Engram implications -- What we are doing right**:
- Engram's episodic -> semantic consolidation mirrors hippocampus -> neocortex transfer
- Light sleep (session summaries) = initial hippocampal binding
- Deep sleep (knowledge extraction) = neocortical integration

**What we are missing**:
1. **Interleaved replay**: During consolidation, we should replay both recent AND old episodes. Simply processing recent episodes risks overwriting older semantic knowledge. Mix in random samples of older episodes.
2. **Schema-consistent fast-tracking**: If new episodic content matches an existing knowledge entry closely, skip the slow consolidation path and update the knowledge entry directly.
3. **Interference detection**: Before adding new semantic knowledge, check if it contradicts existing knowledge. If so, flag for reconsolidation rather than overwriting.
4. **Replay frequency**: Important episodes should be replayed more often. Weight replay probability by salience/importance scores.

---

### 2.2 Memory Reconsolidation

**Origin**: Nader, Schafe, LeDoux (2000) -- landmark study
**Status**: Well-established; transformed our understanding of memory stability

#### 2.2.1 The Discovery

When a consolidated memory is **reactivated** (recalled), it becomes temporarily **labile** (unstable, editable) for approximately 6 hours. During this reconsolidation window:

- New information can be integrated into the memory
- The memory can be strengthened, weakened, or modified
- If protein synthesis is blocked during the window, the memory can be impaired

This overturned the classical view that consolidated memories are permanent and fixed.

#### 2.2.2 The Reconsolidation Window

- **Trigger**: Active recall of the memory (not passive exposure)
- **Duration**: ~6 hours of lability after reactivation
- **Boundary conditions**: Very strong or very old memories may be resistant to reconsolidation
- **Prediction error**: Reconsolidation is more likely to occur when there is a mismatch between what the memory predicts and what actually happens (prediction error triggers updating)

#### 2.2.3 Functional Purpose

Reconsolidation allows memories to be **updated** with new information rather than simply adding new competing memories. This is adaptive because:
- The world changes; memories should reflect current reality
- New context can be added to old memories
- Emotional valence can be modified (basis of exposure therapy)

**Engram implementation -- Reconsolidation on Recall**:

When a memory is retrieved, Engram should:

1. **Mark as labile**: Set a `reconsolidation_window_until` timestamp (current_time + configurable window, e.g., 1 hour for faster AI cycles)
2. **Track co-occurring context**: Record what other information was present during recall
3. **Update on re-encounter**: If the same topic comes up again within the window with new information, update the original memory rather than creating a new one
4. **Strengthen on confirmation**: If the memory was accurately recalled and confirmed by the user, increase its confidence score
5. **Weaken on contradiction**: If the memory was recalled but contradicted by new information, decrease confidence and flag for review
6. **Prediction error detection**: Compare the retrieved memory content with the current context. Large mismatches trigger reconsolidation; perfect matches strengthen without modification.

---

### 2.3 Hebbian Learning

**Origin**: Donald Hebb, 1949, "The Organization of Behavior"
**Principle**: "Neurons that fire together wire together"

#### 2.3.1 Mathematical Formulation

**Basic Hebbian Rule**:
```
delta_w_ij = eta * x_i * x_j
```

Where:
- `delta_w_ij` = change in connection weight between neuron i and j
- `eta` = learning rate (typically 0.01 - 0.1)
- `x_i` = pre-synaptic activity (0 or 1, or continuous)
- `x_j` = post-synaptic activity

**Oja's Rule** (normalized Hebbian to prevent unbounded growth):
```
delta_w_ij = eta * x_j * (x_i - w_ij * x_j)
```

The subtraction term prevents weights from growing without bound.

**Anti-Hebbian** (neurons that fire out of sync weaken):
```
If x_i active and x_j inactive: delta_w_ij = -eta * x_i * (1 - x_j)
```

#### 2.3.2 Properties

- **Unsupervised**: No error signal or labels needed, only co-activation
- **Local**: Each synapse only needs information about its own pre/post activity
- **Bidirectional strengthening**: Symmetric co-activation strengthens both directions
- **Competition**: With normalization, strengthening some connections weakens others

**Engram implementation -- Association Strengthening**:

For the association graph, apply Hebbian learning to edge weights:

```typescript
function strengthenAssociation(memoryA: string, memoryB: string) {
  const edge = getOrCreateEdge(memoryA, memoryB);

  // Hebbian: co-activation strengthens
  const eta = 0.05; // learning rate
  const activation_A = getActivation(memoryA); // normalized 0-1
  const activation_B = getActivation(memoryB); // normalized 0-1

  // Oja's rule to prevent unbounded growth
  const delta = eta * activation_B * (activation_A - edge.weight * activation_B);
  edge.weight = Math.max(0, Math.min(1.0, edge.weight + delta));

  // Update co-recall counter
  edge.co_recall_count += 1;
  edge.last_co_activation = Date.now();
}
```

Apply this every time two memories are retrieved in the same context (co-recalled). Also apply during consolidation when two episodes from the same session reference the same entities.

---

### 2.4 Ebbinghaus Forgetting Curve & Spaced Repetition

#### 2.4.1 The Forgetting Curve

**Ebbinghaus Formula** (1885):
```
R = e^{-t/S}
```

Where:
- `R` = retention (probability of recall, 0 to 1)
- `t` = time since last review
- `S` = memory strength (higher = slower forgetting)

More precise empirical fit:
```
R = 0.9906 * t^{-0.07}
```

Where the exponent -0.07 is the decay constant. Note this is a **power law**, not exponential -- matching ACT-R's findings. Forgetting is fast initially but slows dramatically over time.

**Key insight**: When memories of different stability are mixed, the aggregate forgetting curve appears as a power law, even if individual memories follow exponential decay. This is important for Engram because our memory pool is heterogeneous.

#### 2.4.2 The SM-2 Algorithm (Spaced Repetition)

Used in Anki and SuperMemo. The core algorithm:

**Quality Scale** (0-5):
- 5: Perfect response
- 4: Correct after hesitation
- 3: Correct with serious difficulty
- 2: Incorrect, but correct answer seemed easy to recall
- 1: Incorrect, correct answer remembered upon seeing it
- 0: Complete blackout

**Easiness Factor Update**:
```
EF' = EF + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))
EF' = max(1.3, EF')
```

Where q is the quality score. At q=5, EF increases by 0.1. At q=4, no change. Below 4, EF decreases.

**Interval Calculation**:
```
if repetition == 0: interval = 1 day
if repetition == 1: interval = 6 days
if repetition >= 2: interval = previous_interval * EF
```

**On failure (q < 3)**:
- Reset repetition count to 0
- Reset interval to 1 day
- EF unchanged

**Engram implementation -- Adaptive Decay**:

Instead of uniform time-based decay, track an "easiness factor" per memory:

```typescript
interface MemoryStrength {
  easiness_factor: number;    // starts at 2.5, min 1.3
  repetition_count: number;   // successful recalls in a row
  interval_days: number;      // days until memory is "due"
  last_accessed: string;      // ISO timestamp
  access_quality: number;     // 0-5, how useful was this recall?
}
```

When a memory is retrieved and used successfully, increase its interval. When retrieved but not useful (wrong context, outdated), decrease interval. Memories "due" for review (interval expired) get priority in retrieval scoring.

This creates **adaptive decay** where important, frequently-confirmed memories decay slowly, while noisy or rarely-useful memories decay quickly.

---

### 2.5 Emotional Tagging (Amygdala Model)

#### 2.5.1 The Neural Mechanism

When the amygdala detects an emotionally significant event:
1. Triggers release of noradrenaline and adrenaline
2. These neurochemicals strengthen synaptic connections in the hippocampus
3. The result: emotionally arousing events are encoded more durably
4. This produces "flashbulb memories" -- vivid, detailed memories of high-emotion events

The amygdala acts as a "highlighter" that tags memories for enhanced consolidation. Patients with amygdalar damage show significantly diminished flashbulb memory quality.

#### 2.5.2 Valence-Arousal-Dominance (VAD) Model

Rather than simple positive/negative sentiment, emotions have three dimensions:

- **Valence**: Pleasure (positive) to displeasure (negative)
- **Arousal**: Active (excited, angry) to passive (calm, bored)
- **Dominance**: In-control to submissive/overwhelmed

For memory encoding, **arousal** is the key factor. Both strongly positive (excitement, joy) and strongly negative (anger, fear) high-arousal emotions enhance memory encoding. Low-arousal emotions (boredom, contentment) do not.

#### 2.5.3 Detection Approaches

Beyond keyword matching:

1. **VAD Lexicons**: NRC-VAD lexicon has 20,000+ entries mapping words to valence/arousal/dominance scores
2. **Transformer models**: Fine-tuned models (RoBERTa, BERT) can detect emotional arousal from context, not just keywords
3. **Contextual signals**: Exclamation marks, ALL CAPS, repetition, profanity, urgency markers
4. **Topic-based**: Certain topics inherently carry emotional weight (deadlines, errors, breakthroughs, personal matters)

**Engram implementation -- Emotional Salience Scoring**:

```typescript
interface EmotionalTag {
  arousal: number;    // 0.0 (calm) to 1.0 (intense)
  valence: number;    // -1.0 (negative) to 1.0 (positive)
  dominance: number;  // 0.0 (helpless) to 1.0 (in control)
}

function computeEmotionalSalience(content: string): number {
  // Combine multiple signals:
  const lexiconScore = vadLexiconScore(content);     // Word-level VAD
  const contextualScore = detectContextualArousal(content); // Punctuation, caps, urgency
  const topicScore = detectEmotionalTopics(content);  // Error, deadline, celebration

  // Arousal is the memory-enhancing dimension
  const arousal = weightedAverage(
    lexiconScore.arousal,
    contextualScore,
    topicScore
  );

  return arousal; // Use as multiplier on importance/salience
}
```

High-arousal memories get:
- Higher initial activation (base-level boost)
- Slower decay (higher easiness factor)
- More detailed storage (don't summarize away the details)
- Priority in consolidation replay

---

### 2.6 Context-Dependent Memory

#### 2.6.1 Encoding Specificity Principle

**Tulving & Thomson (1973)**: Recall is better when the context at retrieval matches the context at encoding. This has been demonstrated for:

- **Environmental context**: Words learned underwater recalled better underwater (Godden & Baddeley, 1975)
- **State-dependent memory**: Information learned in a particular mood recalled better in the same mood
- **Temporal context**: Memories grouped by when they occurred (temporal contiguity effect)

Context includes both external (environment, tools, project) and internal (mood, cognitive state, goals) factors.

#### 2.6.2 Context as Retrieval Cue

Context doesn't just improve recall probability -- it actively guides what is retrieved. The same query in different contexts should return different memories:

- "How do we handle authentication?" in the context of Project A should retrieve Project A's auth approach
- The same query in Project B's context should retrieve Project B's approach
- Without project context, it should retrieve general authentication knowledge

**Engram implementation -- Context Vectors**:

Encode context as a multi-dimensional vector stored with each memory:

```typescript
interface MemoryContext {
  session_id: string;
  project_tags: string[];       // Active project/repo
  active_entities: string[];     // People, tools, systems in scope
  temporal_window: string;       // Time period of conversation
  goal_context: string;          // What the user is trying to do
  emotional_state?: EmotionalTag;
}
```

During retrieval, compute similarity between the current context vector and stored context vectors as an additional scoring factor:

```
retrieval_score = alpha * semantic_similarity
               + beta * context_similarity
               + gamma * recency
               + delta * importance
```

This means the same memory can score differently depending on the current context, naturally implementing context-dependent recall.

---

## 3. Recent AI Memory Research (2024-2026)

### 3.1 MemGPT / Letta

**Paper**: "MemGPT: Towards LLMs as Operating Systems" (Packer et al., 2023)
**Current**: Letta framework (production system, as of 2024)

#### Architecture

Inspired by operating system virtual memory. The LLM's context window is treated as **RAM** (limited, fast) and external storage as **disk** (unlimited, slower).

**Three memory tiers**:

1. **Core Memory (In-Context)**: Fixed-size working context included in every prompt. Contains:
   - Static system prompt + function schemas
   - Dynamic working context (scratchpad)
   - FIFO message buffer (most recent turns)
   - The agent edits this via explicit tool calls (`memory_replace`, `memory_insert`, `memory_rethink`)

2. **Recall Memory**: Complete conversation history table. Searchable by date and text. Raw transcript, not processed.

3. **Archival Memory**: Vector database for long-term storage. Agent explicitly inserts and searches. Can contain external data sources.

**Key insight**: The agent itself decides what to store, retrieve, and forget via function calls. Memory management is an explicit cognitive task, not an automatic background process.

**Memory pressure**: When the FIFO buffer approaches ~70% capacity, an event-driven write-back cycle triggers the agent to summarize and archive older messages.

**Engram comparison**:
- Letta treats memory as a tool the agent uses; Engram treats it as an autonomous cognitive process
- Letta has no consolidation -- archival memory is static once written
- Letta has no decay or forgetting
- Letta's three tiers map roughly to: Core = working memory, Recall = episodes, Archival = knowledge
- Missing from Letta: consolidation, association graphs, emotional tagging, procedural memory

---

### 3.2 Mem0

**Paper**: "Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory" (2025)
**Status**: Production system with graph-based memory extension

#### Architecture

Two-phase pipeline: **Extraction** and **Update**.

**Extraction Phase**:
1. Ingest three context sources: latest exchange, rolling summary, m most recent messages
2. LLM extracts candidate memories as concise natural-language facts

**Update Phase**:
1. Each new fact compared to top-s similar entries in vector database
2. LLM decides operation: ADD, UPDATE, DELETE, or NOOP
3. Prevents duplicate facts and maintains consistency

**Graph Memory (Mem0-g)**:
- Entity Extractor identifies entities as graph nodes
- Relations Generator infers labeled edges between entities
- Embeddings stored in vector database
- Nodes and edges flow into a graph backend (Neo4j, Memgraph, etc.)

**Performance**:
- 26% relative accuracy gain over OpenAI on LoCoMo benchmark
- 91% lower p95 latency
- 90% fewer tokens
- Graph variant (Mem0-g): 68.4% accuracy with 0.48s p95 latency

**Engram comparison**:
- Mem0 stores atomic facts; Engram stores episodes, summaries, and knowledge with relationships
- Mem0's graph is entity-relationship focused; Engram's association graph connects memories to memories
- Mem0 has no consolidation or sleep cycles
- Mem0 has no emotional tagging or context-dependent retrieval
- Mem0 has no decay -- memories persist until explicitly deleted or updated
- **Steal from Mem0**: The four-operation update protocol (ADD/UPDATE/DELETE/NOOP) is clean and should inform Engram's reconsolidation logic

---

### 3.3 Zep / Graphiti

**Paper**: "Zep: A Temporal Knowledge Graph Architecture for Agent Memory" (2025)
**Status**: Most sophisticated temporal memory system in production

#### Architecture

Core innovation: **bi-temporal knowledge graph** `G = (N, E, phi)`

**Three subgraph layers**:

1. **Episode Subgraph (Ge)**: Raw, non-lossy input storage. Messages, text, JSON. Source material for extraction.

2. **Semantic Entity Subgraph (Gs)**: Extracted entities (nodes) and relationships (edges). Entities are deduplicated and resolved. Relationships are extracted by LLM.

3. **Community Subgraph (Gc)**: Highest abstraction. Uses label propagation to cluster strongly-connected entities. Provides high-level summarizations.

**Dual-Timestamp Model** (four timestamps per edge):
- `t'_created, t'_expired` -- transactional: when the system learned/invalidated this fact
- `t_valid, t_invalid` -- temporal: when this fact was actually true in the world

This enables: "We learned on March 15 that Muhammad changed jobs on March 1" -- distinguishing when we learned it from when it happened.

**Retrieval Algorithm**: `f(alpha) = chi(rho(phi(alpha))) = beta`
1. **Search (phi)**: Three parallel methods -- cosine similarity, BM25 full-text, breadth-first graph traversal
2. **Rerank (rho)**: Reciprocal Rank Fusion, MMR, episode-mention frequency, graph distance, cross-encoder scoring
3. **Construct (chi)**: Format results with temporal validity ranges

**Temporal versioning**: When new information contradicts old facts, the old edge's `t_invalid` is set to the new edge's `t_valid`. Complete history maintained.

**Performance** (LongMemEval):
- GPT-4o: 60.2% (baseline) -> 71.2% (+18.5%)
- Token reduction: 115k -> 1.6k
- Latency: 28.9s -> 2.58s

**Engram comparison**:
- Zep's temporal versioning is superior to Engram's current approach. **Steal this**.
- The three-subgraph hierarchy (episode -> semantic -> community) maps well to Engram's three tiers
- Zep's bi-temporal model solves the "when did we learn this vs when was it true" problem
- Missing from Zep: consolidation cycles, procedural memory, emotional tagging, decay
- Zep is retrieval-focused, not learning-focused. It doesn't get better over time like Engram aims to.
- **Key steal**: Dual timestamps. Add `event_time` and `ingestion_time` to all Engram memories.

---

### 3.4 LangMem

**Origin**: LangChain team (2025)
**Status**: Open-source SDK for agent long-term memory

#### Architecture

LangMem provides composable primitives, not an opinionated architecture:

**Memory Manager Core**: LLM-powered system that takes conversation transcripts as input and produces memory entries as output.

**Memory Types**:
- **Episodic**: Storing memories of past interactions
- **Semantic**: Extracted facts and knowledge
- **Procedural**: Updated instructions in the agent's prompt (key differentiator -- the agent's system prompt evolves based on experience)

**Key Tools**:
- `create_manage_memory_tool`: Write/update memories to LangGraph BaseStore
- `create_search_memory_tool`: Retrieve relevant memories

**Namespace isolation**: All memories scoped by namespace (typically user_id) to prevent cross-contamination.

**Engram comparison**:
- LangMem's procedural memory as "evolving system prompt" is a clever idea. Engram's procedural system should consider storing preferred patterns that get injected into prompts.
- LangMem is a toolkit, not a cognitive system. No consolidation, no decay, no association.
- Its simplicity is both its strength (easy to adopt) and limitation (no cognitive sophistication).

---

### 3.5 Generative Agents (Stanford, Park et al. 2023)

**Paper**: "Generative Agents: Interactive Simulacra of Human Behavior" (UIST 2023)
**Status**: The seminal work on agent memory architecture

#### Memory Stream

All perceptions, actions, and reflections stored in a single chronological stream. Each entry has: description, creation timestamp, last access timestamp, importance score.

#### Retrieval Scoring Function

```
score = alpha_recency * recency + alpha_importance * importance + alpha_relevance * relevance
```

All alpha values = 1 (equal weighting). Each component normalized to [0, 1] via min-max scaling.

**Recency**: Exponential decay function with decay factor 0.995 per hour.
```
recency(memory) = 0.995^(hours_since_last_access)
```

**Importance**: LLM-generated score (1-10, then normalized to 0-1). Prompt: "On a scale of 1 to 10, where 1 is purely mundane and 10 is extremely poignant, rate the likely poignancy of the following piece of memory."

**Relevance**: Cosine similarity between memory embedding and query embedding.

#### Reflection Mechanism

Triggered when the sum of importance scores of recent memories exceeds a threshold (roughly 2-3 times per simulated day). Process:

1. Identify the 100 most recent memories
2. Ask LLM: "Given only the information above, what are 3 most salient high-level questions we can answer about the subjects in the statements?"
3. For each question, retrieve relevant memories
4. Generate a reflection (insight) from retrieved memories
5. Store the reflection back in the memory stream with high importance

Reflections are **higher-level abstractions** that synthesize multiple lower-level memories. They participate in future retrievals and can themselves trigger further reflections (recursive abstraction).

#### Planning

Agents create day-level plans that are recursively decomposed into hour-level and then minute-level actions. Plans are stored in the memory stream and can be revised based on new observations.

**Engram implications**:
1. **Adopt the three-factor retrieval scoring** (recency + importance + relevance) but use ACT-R's power law instead of exponential decay for recency
2. **Implement reflection as a consolidation mechanism**: When importance accumulates above threshold, trigger a consolidation cycle that produces higher-level knowledge
3. **Store reflections as first-class memories**: Engram's semantic knowledge entries ARE reflections. They should participate in retrieval alongside episodes.
4. **Recursive reflection**: Knowledge can generate higher-level knowledge. Allow consolidation to operate on existing knowledge entries, not just episodes.

---

### 3.6 Voyager (Wang et al. 2023)

**Paper**: "Voyager: An Open-Ended Embodied Agent with Large Language Models"
**Status**: Landmark work on procedural memory for LLM agents

#### Skill Library as Procedural Memory

Skills are stored as **executable code** indexed by semantic embeddings of their descriptions. Key properties:

- **Storage**: Each skill = JavaScript function + natural language description + embedding
- **Retrieval**: Top-5 skills retrieved by embedding similarity to current task
- **Composition**: Complex skills compose simpler skills, compounding capability
- **Verification**: GPT-4 acts as critic, verifying skill correctness before library insertion
- **No forgetting**: Skills persist permanently (addresses catastrophic forgetting through accumulation rather than overwriting)

#### Automatic Curriculum

GPT-4 proposes tasks suited to the agent's current capability level, creating a self-directed learning trajectory. This is an "in-context form of novelty search."

**Performance**: 3.3x more unique items discovered, 15.3x faster progression, only agent to reach diamond level.

**Engram implications for procedural memory**:

```typescript
interface ProceduralMemory {
  id: string;
  description: string;           // Natural language: "User prefers TypeScript with strict mode"
  pattern: string;               // The actual pattern/procedure
  embedding: number[];           // For retrieval
  verification_count: number;    // Times this was confirmed correct
  utility_score: number;         // ACT-R style utility
  source_episodes: string[];     // Where we learned this
  created_at: string;
  last_used: string;
}
```

Key design decisions from Voyager:
1. **Verify before storing**: Don't add a procedural memory until it's been confirmed to work
2. **Compose, don't replace**: New procedures should build on existing ones
3. **Index by description embedding**: Natural language retrieval of procedures
4. **Never delete, only deprecate**: Old procedures might be useful in new contexts

---

### 3.7 Reflexion

**Paper**: "Reflexion: Language Agents with Verbal Reinforcement Learning" (Shinn et al., 2023)
**Status**: Influential framework for learning from failure

#### Architecture

Three components:
1. **Actor**: Generates text/actions based on state + memory
2. **Evaluator**: Scores the outcome (heuristic, LLM, or environment signal)
3. **Self-Reflection Model**: LLM generates verbal feedback explaining what went wrong

#### Memory Buffer

- Short-term: Current trajectory (actions taken in this trial)
- Long-term: Up to 3 reflections from previous trials, stored as natural language

The reflection is specific and actionable, e.g., "I failed because I searched for the wrong keyword. Next time, I should try alternative phrasings."

**Engram implications**:
- **Failure-driven learning**: When the agent makes errors, generate a reflection and store it as procedural memory (what NOT to do)
- **Verbal reinforcement**: Store "lessons learned" as first-class memories that get retrieved in similar future situations
- **Limited reflection buffer**: Keep only the most recent/relevant reflections to prevent context pollution

---

### 3.8 A-MEM (Agentic Memory)

**Paper**: "A-MEM: Agentic Memory for LLM Agents" (NeurIPS 2025)
**Status**: State-of-the-art on structured, self-organizing memory

#### Architecture (Zettelkasten-Inspired)

Each memory note contains seven components:
1. **Original content** (c_i): Raw interaction data
2. **Timestamp** (t_i): When it occurred
3. **Keywords** (K_i): LLM-generated key concepts
4. **Tags** (G_i): Categorical labels
5. **Contextual description** (X_i): LLM-generated rich semantic context
6. **Embedding** (e_i): Dense vector = f_enc(concat(c_i, K_i, G_i, X_i))
7. **Links** (L_i): Connections to related memories

#### Memory Evolution

When a new memory arrives:
1. Compute cosine similarity to find top-k candidate neighbors
2. LLM analyzes whether meaningful connections exist (not just embedding similarity)
3. Establish links where appropriate
4. **Trigger evolution of neighboring memories**: Update their contextual descriptions and attributes based on the new connection

This means existing memories *change* when new memories arrive. The memory network continuously refines its understanding.

#### Performance

Using GPT-4o-mini on Multi-Hop tasks:
- A-MEM: 45.85% F1
- MemGPT: 25.52% F1
- ReadAgent: 12.60% F1
- Token usage: ~1,200 (vs LoCoMo's 16,900)

**Engram implications**:
1. **Memory evolution on insertion**: When a new episode or knowledge entry is added, find neighboring memories and update their metadata. This is a form of ongoing reconsolidation.
2. **Structured attributes**: Augment Engram's memory types with keywords, tags, and contextual descriptions for richer retrieval
3. **Zettelkasten-style linking**: Our association graph already does this, but we should add LLM-verified link quality (not just embedding similarity)
4. **Embedding the full note**: Embed the concatenation of content + keywords + tags + context, not just the raw content

---

### 3.9 Benchmarks

#### LoCoMo (Long-term Conversational Memory)

- 32 sessions per dialogue, ~600 turns, ~16,000 tokens
- Tasks: QA, event summarization, multimodal dialog generation
- Human F1: ~88%
- Best systems: ~68% (Mem0-g)
- Tests temporal reasoning, multi-session coherence, personal facts

#### MemBench

- Evaluates effectiveness, efficiency, and capacity
- Two memory levels: factual memory and reflective memory
- Two scenarios: participation and observation
- Tests 7 memory mechanisms including GenerativeAgent, MemGPT, MemoryBank
- Published ACL 2025

#### OOLONG

- Tests long-context reasoning and aggregation (not just retrieval)
- Oolong-synth: synthetic distributed classification tasks
- Oolong-real: QA over D&D transcripts (50K-175K tokens)
- Even GPT-5 achieves <50% on both splits at 128K context
- Key finding: retrieval is easy; reasoning over retrieved content is hard

#### LongMemEval (ICLR 2025)

- Complex temporal reasoning tasks
- Better reflects enterprise use cases
- Zep achieves 71.2% (GPT-4o), best among memory systems

**Engram benchmark targets**: LoCoMo QA F1 > 70%, LongMemEval > 65%

---

## 4. Sleep and Consolidation Research

### 4.1 NREM vs REM Sleep Functions

#### NREM (Slow-Wave Sleep / Deep Sleep)

**Function**: Hippocampal-to-neocortical memory transfer

**Neural mechanism** -- Triple coupling:
1. **Slow oscillations** (0.5-1 Hz): Large neocortical waves alternating between "up states" (neurons firing) and "down states" (neurons silent). Generated in neocortex.
2. **Sleep spindles** (12-15 Hz): Bursts generated in the thalamus, reaching widespread neocortex. Hallmark of N2 stage. Gate plasticity in cortical neurons.
3. **Sharp-wave ripples (SWR)** (80-150 Hz, 20-100ms): Generated in hippocampus. Carry compressed replays of recent experiences.

The triple coupling sequence: Slow oscillation up-state -> nests sleep spindle -> spindle nests sharp-wave ripple -> ripple carries replay content -> neocortical synapses modified

This is the transfer mechanism: hippocampal content is "packaged" in ripples, "delivered" by spindles, and "installed" during slow oscillation up-states.

**Engram mapping -- Light Sleep / Deep Sleep**:

```
Light Sleep (NREM N2 equivalent):
  - "Spindle" = session summarization
  - Purpose: Bind related episodes within a session
  - Output: Digests (session summaries with key topics)

Deep Sleep (NREM N3 / SWS equivalent):
  - "Slow oscillation" = full consolidation cycle
  - "Ripple replay" = re-processing episodes from multiple sessions
  - Purpose: Extract cross-session patterns, update semantic memory
  - Output: Knowledge entries, updated association weights
```

#### REM Sleep

**Function**: Emotional processing, creative association formation, procedural memory consolidation

**Neural mechanism**: Theta oscillations (5-8 Hz) dominate. Acetylcholine levels high (promoting plasticity), noradrenaline low (allowing loose associations).

The unique neurochemical environment of REM allows:
- Remote associations between disparate memories
- Emotional regulation (reducing amygdala reactivity to emotional memories)
- Procedural skill consolidation
- Creative insight (connecting unrelated concepts)

**Engram mapping -- Dream Cycle**:

```
Dream Cycle (REM equivalent):
  - "Theta oscillation" = free-association walk across the graph
  - Low noradrenaline = relaxed similarity thresholds
  - Purpose: Find unexpected connections, creative associations
  - Algorithm:
    1. Select a random high-importance memory
    2. Walk the association graph with LOW threshold (explore weak links)
    3. For each pair of weakly-connected memories, ask: "Is there a meaningful connection?"
    4. If yes, create or strengthen the association edge
    5. If a surprising pattern emerges, create a new knowledge entry
```

### 4.2 Sleep Replay Consolidation (SRC) Algorithm

From the Nature Communications paper (Tadros et al., 2022):

**Algorithm for artificial neural networks**:
1. Convert network to spiking mode (binary activations)
2. Scale weights by maximum layer activation
3. Forward pass: propagate noisy input (Poisson noise based on historical input statistics)
4. Backward pass: apply Hebbian weight updates
   - Increase weights when both pre/post neurons active
   - Decrease weights when post active but pre silent
5. Repeat for multiple timesteps
6. Restore original activation functions

**Key finding**: Spontaneous replay of old patterns emerges naturally from noisy stimulation + Hebbian learning. No need to explicitly store and replay old examples.

**Engram implementation -- Consolidation Replay**:

```typescript
async function consolidationReplay(recentEpisodes: Episode[], allKnowledge: Knowledge[]) {
  // Mix recent episodes with random older samples (interleaved replay)
  const olderEpisodes = sampleRandom(allEpisodes, count: recentEpisodes.length * 0.3);
  const replayBatch = shuffle([...recentEpisodes, ...olderEpisodes]);

  for (const episode of replayBatch) {
    // Re-process episode against current knowledge
    const matchingKnowledge = await findRelatedKnowledge(episode);

    for (const knowledge of matchingKnowledge) {
      // Hebbian: strengthen association between co-activated items
      await strengthenAssociation(episode.id, knowledge.id);

      // Check for contradiction (prediction error)
      if (contradicts(episode, knowledge)) {
        await flagForReconsolidation(knowledge, episode);
      }

      // Check for schema extension (new detail for existing knowledge)
      if (extendsSchema(episode, knowledge)) {
        await updateKnowledge(knowledge, episode);
      }
    }

    // Check for novel patterns not in any existing knowledge
    const novelPatterns = await detectNovelPatterns(episode, allKnowledge);
    for (const pattern of novelPatterns) {
      await createKnowledge(pattern);
    }
  }
}
```

### 4.3 Active Systems Consolidation

**Key principle**: Memories are not just passively decaying -- they are actively reorganized during consolidation.

**Schema formation**: The neocortex builds schematic representations (abstract knowledge structures) that new memories can be rapidly assimilated into. The process:

1. Individual episodes are replayed during sleep
2. Statistical regularities across episodes are extracted
3. These regularities form schemas (abstract templates)
4. New episodes that fit existing schemas are rapidly integrated
5. Episodic memories that have been fully schematized lose their hippocampal dependency

**Engram implication -- Schema Detection**:

During deep sleep consolidation:
1. Cluster related knowledge entries by topic/entity
2. For each cluster, extract the common schema (shared pattern)
3. Store the schema as a high-confidence, high-abstraction knowledge entry
4. Future episodes that match the schema get fast-tracked into the schema (direct knowledge update, skip full consolidation)
5. Episodes that violate the schema trigger reconsolidation of the schema itself

---

## 5. Implementable Patterns for Engram

### Pattern 1: ACT-R Activation-Based Retrieval Scoring

**Source**: ACT-R (Anderson, CMU)
**Algorithm**:

```typescript
function computeActivation(memory: Memory): number {
  // Base-level activation (power law of forgetting)
  const baseLevelActivation = Math.log(
    memory.access_timestamps.reduce((sum, t_j) => {
      const timeSinceAccess = (Date.now() - t_j) / 1000; // seconds
      return sum + Math.pow(timeSinceAccess, -DECAY_D);
    }, 0)
  );

  // Spreading activation from current context
  const spreadingActivation = currentContextChunks.reduce((sum, chunk) => {
    const W_j = 1.0 / currentContextChunks.length; // attention weight
    const S_ji = MAX_ASSOCIATION_STRENGTH - Math.log(getFan(chunk));
    return sum + W_j * S_ji;
  }, 0);

  // Stochastic noise (logistic distribution)
  const noise = logisticNoise(NOISE_S);

  return baseLevelActivation + spreadingActivation + noise;
}

function retrievalProbability(activation: number): number {
  return 1.0 / (1.0 + Math.exp(-(activation - RETRIEVAL_THRESHOLD) / NOISE_S));
}

// Constants
const DECAY_D = 0.5;
const RETRIEVAL_THRESHOLD = -2.0;
const NOISE_S = 0.4;
const MAX_ASSOCIATION_STRENGTH = 2.0;
```

**Implementation**: Replace Engram's current similarity-only retrieval with this activation-based system. Store access timestamps as an array on each memory. Compute activation at retrieval time.

**Expected impact**: More human-like retrieval patterns. Frequently-used memories retrieved faster. Serendipitous recall of low-activation but relevant memories via noise. Natural power-law forgetting.

---

### Pattern 2: Three-Factor Retrieval (Generative Agents Style)

**Source**: Stanford Generative Agents (Park et al.)
**Algorithm**:

```typescript
function retrievalScore(memory: Memory, query: string, context: Context): number {
  // Recency: power law decay (ACT-R style, not exponential)
  const hoursSinceAccess = (Date.now() - memory.last_accessed) / 3600000;
  const recency = Math.pow(hoursSinceAccess + 1, -DECAY_D);

  // Importance: stored on memory (LLM-assigned 1-10, normalized)
  const importance = memory.importance / 10.0;

  // Relevance: cosine similarity of embeddings
  const relevance = cosineSimilarity(memory.embedding, queryEmbedding);

  // Context match: how well does the memory context match current context
  const contextMatch = contextSimilarity(memory.context, context);

  // Emotional salience: high-arousal memories get boost
  const emotionalBoost = memory.emotional_arousal * EMOTION_WEIGHT;

  return ALPHA_RECENCY * recency
       + ALPHA_IMPORTANCE * importance
       + ALPHA_RELEVANCE * relevance
       + ALPHA_CONTEXT * contextMatch
       + emotionalBoost;
}
```

**Implementation**: Add importance scoring to all memory entries. Score on ingest via LLM or heuristic. Use combined scoring for all retrieval operations.

**Expected impact**: More nuanced retrieval that balances what's recent, what's important, what's relevant, and what matches the current context.

---

### Pattern 3: Reconsolidation on Recall

**Source**: Nader, Schiller, LeDoux (neuroscience)
**Algorithm**:

```typescript
async function onMemoryRecalled(memory: Memory, currentContext: Context): Promise<void> {
  // Mark as labile
  memory.reconsolidation_window_until = Date.now() + RECONSOLIDATION_WINDOW_MS;
  memory.recall_context = currentContext;

  // Strengthen on successful recall
  memory.access_timestamps.push(Date.now());
  memory.recall_count += 1;

  // Check for prediction error
  const predictionError = computePredictionError(memory, currentContext);

  if (predictionError > PREDICTION_ERROR_THRESHOLD) {
    // Memory doesn't match current context -- flag for update
    memory.needs_reconsolidation = true;
    memory.reconsolidation_context = currentContext;
  }
}

async function onNewInformation(info: string, context: Context): Promise<void> {
  // Find labile memories (within reconsolidation window)
  const labileMemories = await findLabileMemories(context.session_id);

  for (const memory of labileMemories) {
    if (Date.now() < memory.reconsolidation_window_until) {
      if (contradicts(info, memory.content)) {
        // Update memory with new information
        await updateMemoryContent(memory, info);
        memory.confidence = Math.max(0.1, memory.confidence - 0.2);
      } else if (extends_(info, memory.content)) {
        // Enrich memory with additional detail
        await enrichMemory(memory, info);
        memory.confidence = Math.min(1.0, memory.confidence + 0.1);
      }
    }
  }
}

const RECONSOLIDATION_WINDOW_MS = 3600000; // 1 hour
const PREDICTION_ERROR_THRESHOLD = 0.3;
```

**Implementation**: Add `reconsolidation_window_until` and `recall_context` fields to memory types. On every retrieval, set the window. On every new input within the window, check for contradiction/extension.

**Expected impact**: Memories evolve over time. Outdated information gets corrected. The system adapts to changing truths rather than accumulating contradictory facts.

---

### Pattern 4: Hebbian Association Strengthening

**Source**: Hebb (1949), Oja's Rule
**Algorithm**:

```typescript
function hebbianUpdate(
  edgeWeight: number,
  activationA: number,  // 0 to 1
  activationB: number,  // 0 to 1
  learningRate: number = 0.05
): number {
  // Oja's rule (Hebbian with normalization)
  const delta = learningRate * activationB * (activationA - edgeWeight * activationB);
  return clamp(edgeWeight + delta, 0.0, 1.0);
}

function antiHebbianDecay(
  edgeWeight: number,
  activationA: number,
  activationB: number,
  decayRate: number = 0.01
): number {
  // If A is active but B is not, weaken the connection
  if (activationA > 0.5 && activationB < 0.2) {
    return Math.max(0, edgeWeight - decayRate * activationA);
  }
  return edgeWeight;
}
```

**Application points**:
- When two memories are co-retrieved in one query: Hebbian strengthen
- When one memory is retrieved but a connected memory is not: anti-Hebbian weaken
- During consolidation replay: strengthen associations between co-occurring episodes

**Expected impact**: Association graph becomes increasingly accurate. Meaningful connections strengthen; spurious connections decay. Graph topology reflects actual semantic relationships.

---

### Pattern 5: Adaptive Decay (SM-2 Inspired)

**Source**: SM-2 Algorithm (Wozniak, 1987)
**Algorithm**:

```typescript
interface MemoryStrength {
  easiness_factor: number;     // default 2.5, min 1.3
  repetition_count: number;    // successful recalls in sequence
  interval_days: number;       // days until "due" for review
  last_reviewed: number;       // timestamp
}

function updateStrength(strength: MemoryStrength, quality: number): MemoryStrength {
  // quality: 0-5 (0=useless, 5=perfect recall)
  const newEF = strength.easiness_factor +
    (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));

  if (quality >= 3) {
    // Successful recall
    let newInterval: number;
    if (strength.repetition_count === 0) newInterval = 1;
    else if (strength.repetition_count === 1) newInterval = 6;
    else newInterval = Math.ceil(strength.interval_days * strength.easiness_factor);

    return {
      easiness_factor: Math.max(1.3, newEF),
      repetition_count: strength.repetition_count + 1,
      interval_days: newInterval,
      last_reviewed: Date.now(),
    };
  } else {
    // Failed recall
    return {
      easiness_factor: Math.max(1.3, newEF),
      repetition_count: 0,
      interval_days: 1,
      last_reviewed: Date.now(),
    };
  }
}

function isOverdue(strength: MemoryStrength): boolean {
  const daysSinceReview = (Date.now() - strength.last_reviewed) / 86400000;
  return daysSinceReview > strength.interval_days;
}
```

**Implementation**: Add MemoryStrength to all knowledge entries. When knowledge is retrieved and used, rate quality. Overdue memories get slight retrieval boost (like spaced repetition reminding you to review).

**Expected impact**: Important, well-confirmed knowledge persists indefinitely. Noise and one-off observations fade naturally. The system builds a robust core of reliable knowledge.

---

### Pattern 6: Emotional Salience Detection

**Source**: Amygdala emotional tagging model
**Algorithm**:

```typescript
const AROUSAL_INDICATORS = {
  punctuation: /[!?]{2,}/g,           // "!!" or "???"
  caps: /\b[A-Z]{3,}\b/g,            // "URGENT", "CRITICAL"
  urgency: /\b(urgent|critical|emergency|asap|immediately|breaking)\b/i,
  negativeHigh: /\b(error|crash|fail|broken|blocked|stuck|furious|disaster)\b/i,
  positiveHigh: /\b(amazing|breakthrough|solved|eureka|finally|perfect|incredible)\b/i,
  personal: /\b(I feel|I'm worried|I'm excited|frustrated|love|hate)\b/i,
};

function detectArousal(content: string): number {
  let arousal = 0.3; // baseline

  for (const [category, pattern] of Object.entries(AROUSAL_INDICATORS)) {
    const matches = content.match(pattern);
    if (matches) {
      arousal += 0.1 * matches.length;
    }
  }

  // Cap at 1.0
  return Math.min(1.0, arousal);
}

function applyEmotionalTagging(memory: Memory): void {
  const arousal = detectArousal(memory.content);
  memory.emotional_arousal = arousal;

  if (arousal > 0.7) {
    // High arousal: boost initial activation and slow decay
    memory.importance = Math.min(10, memory.importance + 2);
    memory.strength.easiness_factor += 0.3; // slower forgetting
  }
}
```

**Implementation**: Run arousal detection on every ingested message. High-arousal content gets importance boost and decay resistance.

**Expected impact**: Critical events (errors, breakthroughs, decisions) naturally persist while mundane messages fade. System remembers what mattered.

---

### Pattern 7: Global Workspace Broadcasting (Priming)

**Source**: GWT (Baars)
**Algorithm**:

```typescript
async function globalWorkspaceBroadcast(
  retrievedMemory: Memory,
  allSystems: MemorySystem[]
): Promise<PrimingResult[]> {
  // When a memory enters "conscious awareness" (is retrieved),
  // broadcast to all systems in parallel
  const primingResults = await Promise.all(
    allSystems.map(system => system.onBroadcast(retrievedMemory))
  );

  // Each system returns its top associations
  // Episodic: "I recall similar episodes..."
  // Semantic: "This relates to these knowledge entries..."
  // Procedural: "For this topic, here are relevant procedures..."
  // Association graph: "These memories are connected..."

  // Competition: rank all primed results, select top-k
  const allPrimed = primingResults.flat();
  allPrimed.sort((a, b) => b.activation - a.activation);
  return allPrimed.slice(0, MAX_PRIMED_ITEMS);
}
```

**Implementation**: After initial retrieval, run a priming broadcast that activates memories across all subsystems. Include primed results in the final context alongside direct retrieval results.

**Expected impact**: Richer context that includes related episodes, knowledge, and procedures. The agent gets a holistic view of what the memory system knows about the current topic.

---

### Pattern 8: Dream Cycle (Creative Association Discovery)

**Source**: REM sleep neuroscience
**Algorithm**:

```typescript
async function dreamCycle(
  seedMemories: Memory[],
  associationGraph: AssociationGraph
): Promise<Discovery[]> {
  const discoveries: Discovery[] = [];

  for (const seed of seedMemories) {
    // Random walk with LOW threshold (explore weak links)
    const visited = new Set<string>();
    let current = seed;

    for (let step = 0; step < MAX_DREAM_STEPS; step++) {
      const neighbors = associationGraph.getNeighbors(current.id, {
        minWeight: 0.1,  // Very low threshold -- explore weak connections
        excludeVisited: visited,
      });

      if (neighbors.length === 0) break;

      // Weighted random selection (prefer weaker links for exploration)
      const weights = neighbors.map(n => 1.0 / (n.weight + 0.1));
      const next = weightedRandomSelect(neighbors, weights);

      visited.add(next.id);

      // Check if this remote connection is meaningful
      if (step >= 2) { // Only check after 2+ hops
        const connection = await assessConnection(seed, next);
        if (connection.isMeaningful) {
          discoveries.push({
            memoryA: seed.id,
            memoryB: next.id,
            insight: connection.description,
            hops: step + 1,
          });
          // Create new association edge
          await associationGraph.createEdge(seed.id, next.id, {
            weight: 0.3,
            type: 'dream_discovery',
            description: connection.description,
          });
        }
      }

      current = next;
    }
  }

  return discoveries;
}
```

**Implementation**: Run as part of the consolidation sleep cycle, after deep sleep. Select high-importance memories as seeds. Walk the graph with relaxed thresholds. Use LLM to assess whether discovered connections are meaningful.

**Expected impact**: Discovers non-obvious connections between memories. Can produce creative insights ("Your deployment issue might be related to that config change you discussed last week"). Strengthens the association graph with validated cross-domain links.

---

### Pattern 9: Dual-Timestamp Versioning

**Source**: Zep/Graphiti
**Algorithm**:

```typescript
interface TemporalMemory {
  // When this fact was actually true
  event_time: string;      // When it happened in the real world
  event_time_end?: string; // When it stopped being true (null = still true)

  // When the system learned about it
  ingestion_time: string;  // When we first stored this
  invalidated_at?: string; // When we learned it was no longer true

  // Version chain
  supersedes?: string;     // ID of the memory this replaces
  superseded_by?: string;  // ID of the memory that replaced this
}

async function addTemporalFact(
  newFact: Knowledge,
  existingFacts: Knowledge[]
): Promise<void> {
  // Find potentially contradicting facts
  const similar = await findSimilarFacts(newFact, existingFacts);

  for (const existing of similar) {
    if (contradicts(newFact, existing)) {
      // Don't delete -- mark as superseded
      existing.event_time_end = newFact.event_time;
      existing.invalidated_at = new Date().toISOString();
      existing.superseded_by = newFact.id;
      newFact.supersedes = existing.id;
      await updateMemory(existing);
    }
  }

  await insertMemory(newFact);
}
```

**Implementation**: Add temporal fields to Knowledge type. On contradiction detection, create version chains rather than overwriting. Support temporal queries ("What did we know about X in January?").

**Expected impact**: Complete audit trail of how knowledge evolves. No information loss. Ability to reason about changes over time.

---

### Pattern 10: Memory Evolution (A-MEM Style)

**Source**: A-MEM (NeurIPS 2025)
**Algorithm**:

```typescript
async function onMemoryInserted(newMemory: Memory): Promise<void> {
  // Generate structured attributes
  newMemory.keywords = await extractKeywords(newMemory.content);
  newMemory.tags = await generateTags(newMemory.content);
  newMemory.contextual_description = await generateDescription(newMemory.content);

  // Compute embedding from ALL attributes (not just content)
  newMemory.embedding = await embed(
    [newMemory.content, ...newMemory.keywords, ...newMemory.tags, newMemory.contextual_description].join(' ')
  );

  // Find neighbors
  const neighbors = await findSimilarMemories(newMemory.embedding, topK: 5);

  // Establish links (LLM-verified, not just embedding similarity)
  for (const neighbor of neighbors) {
    const connection = await assessConnection(newMemory, neighbor);
    if (connection.isMeaningful) {
      await createLink(newMemory.id, neighbor.id, connection.description);

      // EVOLUTION: Update neighbor's contextual description
      neighbor.contextual_description = await updateDescription(
        neighbor, newMemory, connection
      );
      neighbor.embedding = await embed(
        [neighbor.content, ...neighbor.keywords, ...neighbor.tags, neighbor.contextual_description].join(' ')
      );
      await updateMemory(neighbor);
    }
  }
}
```

**Implementation**: Enrich all memory entries with keywords, tags, and contextual descriptions. On insertion, find and update neighboring memories. Use full-attribute embedding.

**Expected impact**: Richer retrieval via multi-attribute embeddings. Memory network that self-organizes and improves over time. 2x performance on multi-hop reasoning tasks.

---

## 6. Competitive Architecture Comparison

### Feature Matrix

| Feature | Engram (Planned) | Letta/MemGPT | Mem0 | Zep | LangMem | Gen. Agents |
|---------|-----------------|--------------|------|-----|---------|-------------|
| **Memory Tiers** | 5 (sensory, episodic, semantic, procedural, association) | 3 (core, recall, archival) | 2 (flat facts + graph) | 3 (episode, semantic, community) | 3 (episodic, semantic, procedural) | 1 (memory stream) |
| **Consolidation** | Yes (light/deep/dream cycles) | No | No | No | No | Partial (reflection) |
| **Decay/Forgetting** | Yes (ACT-R power law) | No | No | No | No | Yes (exponential) |
| **Association Graph** | Yes (Hebbian-strengthened) | No | Yes (entity-relationship) | Yes (temporal KG) | No | No |
| **Temporal Versioning** | Planned | No | Partial (UPDATE op) | Yes (dual-timestamp) | No | No |
| **Emotional Tagging** | Planned | No | No | No | No | Yes (importance score) |
| **Reconsolidation** | Yes | No | No | No | No | No |
| **Procedural Memory** | Yes | No | No | No | Yes (prompt evolution) | No |
| **Context-Dependent Retrieval** | Planned | Partial | No | Partial (temporal) | Namespace scoping | No |
| **Sleep/Offline Processing** | Yes | No | No | No | No | No |
| **Schema Detection** | Planned | No | No | Yes (community clusters) | No | Yes (reflection) |
| **Zero-Config** | Yes (SQLite + BM25) | No (requires API keys) | No (requires API keys) | No (requires Neo4j) | No (requires LangGraph) | No (requires LLM) |

### What to Steal from Each

**From Letta/MemGPT**: The concept of "memory pressure" triggering consolidation. When working memory approaches capacity, automatically trigger light sleep.

**From Mem0**: The four-operation update protocol (ADD/UPDATE/DELETE/NOOP). Clean, deterministic memory management. The graph memory extension approach.

**From Zep**: Dual-timestamp temporal versioning. The three-layer retrieval algorithm (search -> rerank -> construct). Community subgraph abstraction.

**From LangMem**: Procedural memory as evolving system prompt instructions.

**From Generative Agents**: The three-factor retrieval score. The reflection mechanism as consolidation trigger. Importance scoring via LLM.

**From Voyager**: Skill library with verification before insertion. Compositional procedures.

**From A-MEM**: Memory evolution on insertion. Zettelkasten-style structured attributes. LLM-verified linking.

**From Reflexion**: Failure-driven procedural learning. Verbal reinforcement as memory.

### Engram's Unique Value Proposition

No existing system combines ALL of:
1. Brain-inspired five-system memory architecture
2. Consolidation sleep cycles with replay
3. ACT-R activation-based retrieval with power-law forgetting
4. Hebbian association strengthening
5. Reconsolidation on recall
6. Emotional tagging
7. Dream cycle creative association
8. Zero-config operation

This is what makes Engram a **cognitive engine** rather than a memory layer. The competition stores and retrieves. Engram **learns**.

---

## 7. Sources

### Cognitive Architectures
- [ACT-R - Wikipedia](https://en.wikipedia.org/wiki/ACT-R)
- [ACT-R Unit 4: Activation of Chunks](http://act-r.psy.cmu.edu/wordpress/wp-content/themes/ACT-R/tutorials/unit4.htm)
- [ACT-R Cognitive Architecture for Modeling Cognition](https://www.researchgate.net/publication/329493100_ACT-R_A_cognitive_architecture_for_modeling_cognition)
- [Comparison of Approximations for Base-Level Activation in ACT-R](https://link.springer.com/article/10.1007/s42113-018-0015-3)
- [Computationally Efficient Approximation of BLE in ACT-R](http://act-r.psy.cmu.edu/wordpress/wp-content/uploads/2012/12/652petrovAbstract.pdf)
- [Introduction to Soar (Laird, 2022)](https://arxiv.org/abs/2205.03854)
- [Soar - Wikipedia](https://en.wikipedia.org/wiki/Soar_(cognitive_architecture))
- [Soar Episodic Memory Manual](https://soar.eecs.umich.edu/soar_manual/07_EpisodicMemory/)
- [Soar Semantic Memory Manual](https://soar.eecs.umich.edu/soar_manual/06_SemanticMemory/)
- [Effective Forgetting in Soar](https://www.sciencedirect.com/science/article/abs/pii/S1389041712000563)
- [CLARION - Wikipedia](https://en.wikipedia.org/wiki/CLARION_(cognitive_architecture))
- [CLARION Tutorial (Sun)](https://homepages.hass.rpi.edu/rsun/folder-files/clarion-intro-slides.pdf)
- [Global Workspace Theory - Wikipedia](https://en.wikipedia.org/wiki/Global_workspace_theory)
- [GWT Update (Baars)](https://bernardbaars.com/wp-content/uploads/2021/04/Baars_-The-global-brainweb_-An-update-on-global-workspace-theory.pdf)

### Neuroscience
- [Complementary Learning Systems (McClelland et al., 1995)](https://stanford.edu/~jlmcc/papers/McCMcNaughtonOReilly95.pdf)
- [Complementary Learning Systems Update (O'Reilly, 2014)](https://onlinelibrary.wiley.com/doi/10.1111/j.1551-6709.2011.01214.x)
- [Reconsolidation and Dynamic Nature of Memory (PMC)](https://pmc.ncbi.nlm.nih.gov/articles/PMC4588064/)
- [Memory Reconsolidation (ScienceDirect)](https://www.sciencedirect.com/science/article/pii/S0960982213007719)
- [Hebbian Theory - Wikipedia](https://en.wikipedia.org/wiki/Hebbian_theory)
- [Neuronal Dynamics - Hebb Rule](https://neuronaldynamics.epfl.ch/online/Ch19.S1.html)
- [Forgetting Curve - Wikipedia](https://en.wikipedia.org/wiki/Forgetting_curve)
- [Replication of Ebbinghaus (PMC)](https://pmc.ncbi.nlm.nih.gov/articles/PMC4492928/)
- [SM-2 Algorithm Original](https://super-memory.com/english/ol/sm2.htm)
- [Amygdala Facilitating Memory (PMC)](https://pmc.ncbi.nlm.nih.gov/articles/PMC10034520/)
- [Emotional Memory - Temporal Dynamics Model (PMC)](https://pmc.ncbi.nlm.nih.gov/articles/PMC1906714/)
- [Encoding Specificity Principle - Wikipedia](https://en.wikipedia.org/wiki/Encoding_specificity_principle)
- [Context-Dependent Memory - Wikipedia](https://en.wikipedia.org/wiki/Context-dependent_memory)

### Sleep and Consolidation
- [System Consolidation During Sleep (PMC)](https://pmc.ncbi.nlm.nih.gov/articles/PMC3278619/)
- [Systems Memory Consolidation: Oscillations (PMC)](https://pmc.ncbi.nlm.nih.gov/articles/PMC12576410/)
- [Sleep Spindles and Slow Oscillations (PMC)](https://pmc.ncbi.nlm.nih.gov/articles/PMC6053241/)
- [SWR and Cortical Coupling (PNAS)](https://www.pnas.org/doi/10.1073/pnas.2012075118)
- [Autonomous Hippocampal-Neocortical Model (PNAS)](https://www.pnas.org/doi/10.1073/pnas.2123432119)
- [Sleep-Like Replay Reduces Catastrophic Forgetting (Nature)](https://www.nature.com/articles/s41467-022-34938-7)

### AI Memory Systems
- [MemGPT Paper (Packer et al., 2023)](https://arxiv.org/abs/2310.08560)
- [Letta Docs - Memory Management](https://docs.letta.com/advanced/memory-management/)
- [Letta Docs - MemGPT Concepts](https://docs.letta.com/concepts/memgpt/)
- [Mem0 Paper (2025)](https://arxiv.org/abs/2504.19413)
- [Mem0 Graph Memory Docs](https://docs.mem0.ai/open-source/features/graph-memory)
- [Zep Paper (2025)](https://arxiv.org/abs/2501.13956)
- [LangMem Docs](https://langchain-ai.github.io/langmem/)
- [LangMem SDK Launch](https://blog.langchain.com/langmem-sdk-launch/)
- [Generative Agents (Park et al., 2023)](https://arxiv.org/abs/2304.03442)
- [Voyager (Wang et al., 2023)](https://arxiv.org/abs/2305.16291)
- [Reflexion (Shinn et al., 2023)](https://arxiv.org/abs/2303.11366)
- [A-MEM (NeurIPS 2025)](https://arxiv.org/abs/2502.12110)

### Benchmarks
- [LoCoMo Benchmark](https://snap-research.github.io/locomo/)
- [MemBench (ACL 2025)](https://aclanthology.org/2025.findings-acl.989/)
- [OOLONG Benchmark](https://arxiv.org/abs/2511.02817)
- [LongMemEval (ICLR 2025)](https://github.com/xiaowu0162/LongMemEval)

### Surveys and Comparative Analyses
- [Human-Like Memory for LLM Agents: ACT-R-Inspired (HAI 2025)](https://dl.acm.org/doi/10.1145/3765766.3765803)
- [Cognitive LLMs: Integrating Architectures and LLMs](https://journals.sagepub.com/doi/10.1177/29498732251377341)
- [Memory in the Age of AI Agents: A Survey](https://github.com/Shichun-Liu/Agent-Memory-Paper-List)
- [Applying Cognitive Design Patterns to LLM Agents](https://arxiv.org/html/2505.07087v2)
- [Design Patterns for Long-Term Memory in LLM Architectures](https://serokell.io/blog/design-patterns-for-long-term-memory-in-llm-powered-architectures)
- [Mem0 vs Letta Comparison](https://vectorize.io/articles/mem0-vs-letta)
- [Survey of AI Agent Memory Frameworks (Graphlit)](https://www.graphlit.com/blog/survey-of-ai-agent-memory-frameworks)
- [ICLR 2026 Workshop: MemAgents](https://openreview.net/pdf?id=U51WxL382H)
