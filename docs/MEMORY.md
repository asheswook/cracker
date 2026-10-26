# Memory as a Tree of Thought: Hierarchical Knowledge Organisation and Layered Retrieval for a Single-Conversation Assistant

*Cracker design note — October 2026*

<p align="center"><img src="assets/memory-tree.svg" alt="A knowledge tree growing from conversations: topics split into branches and branches link to each other" width="760"></p>

## Abstract

A personal assistant with one endless conversation has no chat boundaries to separate work, so memory has to do it. We organise every past exchange into a workspace-wide **knowledge tree** whose topic nodes are created, summarised, merged, split, linked and given parent overviews by small, validated model decisions in the background. At question time a **layered retrieval** recalls candidate topics with BM25 and bge-m3 dense search, fuses them by reciprocal rank, lets **Clef**, a fast decision model that returns a probability, pick a topic, and calls a light LLM only when Clef is unsure. The answering model then receives the original exchanges of the chosen topics, not summaries. On a chronological replay of 316 real user turns with 103 graded questions, the deployed configuration (**H-rrf-clef**) raised nDCG@5 from 0.474 to 0.831 and top-3 hit rate from 0.592 to 0.932 over the previous production retrieval, while cutting median question-time latency from 15–19 s to about 0.9 s and the evidence packet from 42.8 KB to 13.3 KB.

## 1. Introduction

Cracker has a single conversation. There is no separate chat for a contract, a trip or a weekly report; everything arrives in one stream. If memory and knowledge are managed well, work separates itself. If they are not, a single conversation becomes a pile, and every answer is either missing context or drowning in it.

What a personal assistant falls short on most is not the model that answers but **what the model is shown**. The previous retrieval in Cracker grouped messages into flat semantic contexts and asked a general LLM, several times per question, to judge which context a message belonged to. It found the right material most of the time (any-hit 0.99) but ranked it poorly (nDCG@5 0.47), sent 40–70 KB of evidence, and took 15–19 seconds before the answer could even start.

This note describes what replaced it: a knowledge tree that is grown off the answer path, and a retrieval path that is cheap when it can be and careful when it has to be.

## 2. Why a tree

We chose a tree because it is closest to how people take notes and think. A thought starts as one topic, becomes more specific, splits in two, and the new branch turns out to touch something you were thinking about last week. Notes and mind-maps grow tail-to-head in the same way.

A flat set of contexts cannot express that. In our first replay (v2), the model was given the tree operations but left to decide on its own when to restructure: it produced 76 nodes, all at the root, with no merges, no splits and three links. The model does not restructure unless the structure is made explicit. Version 3 therefore makes every structural move a separate, code-proposed and model-confirmed step (§3.2), and the tree it produced is hierarchical: 89 live nodes over four levels, 26 parent–child edges and 36 cross links.

## 3. Knowledge tree

### 3.1 Data model

| Element | Definition |
| --- | --- |
| Exchange | A user message and the assistant's reply. The unit of memory. |
| Node | `kind` ∈ {`topic`, `rule`, `event`}; `title`, `aliases` and `entities` in the words the user actually used; `summary` of up to 24 facts, each citing an exact quote from an exchange; `status` ∈ {`active`, `archived`, `merged`}. |
| Membership | Each exchange has exactly one **owner** node and any number of **mention** nodes. |
| Link | `part_of` (sub-topic), `reference` (mutual mention), `governs` (a rule node over the topics it applies to), with evidence and confidence. |
| Operation | Every change is a logged operation that can be inspected and replayed. |

Rules ("always cc the team lead", "calendar entries go to the company calendar") are nodes of their own so they can be delivered in a separate slot regardless of ranking.

### 3.2 Growth

After an answer is delivered the exchange is queued, and a per-workspace worker grows the tree in order, only while no conversation is being answered. For one exchange:

<p align="center"><img src="assets/memory-growth.svg" alt="Growth: attach or create, summarise, merge, split, link, and periodic parents" width="760"></p>

1. **Noise.** Greetings and acknowledgements of eight characters or fewer attach to the previous exchange's node without a model call (56 of 316 turns in the replay).
2. **Candidates by hierarchical descent.** Starting at the root, the exchange embedding is compared with child summary embeddings, keeping two branches at the root and then descending while the cosine stays above a depth-dependent threshold
   $$\theta(d) = \theta_0\, e^{\,r d / D},\qquad \theta_0 = 0.45,\; r = 0.5,\; D = 15,$$
   so deeper, more specific nodes must match more closely. Descent results are joined with BM25 over node text and with the previous exchange's node.
3. **Attach or create.** The model places the exchange under a candidate or opens a new node, giving title, kind, aliases and entities.
4. **Summaries.** The owner's facts are patched; up to three ancestors' overviews are rewritten from their children.
5. **Merge.** Code proposes pairs (summary cosine ≥ 0.80, or ≥ 0.70 with a shared entity); the model answers only *same topic: yes/no*.
6. **Split.** A node owning 12 or more exchanges is clustered by exchange embeddings; the model confirms and names the parts, which become children.
7. **Link.** Nodes sharing entities become `reference` candidates; rules get `governs` links; the model confirms.
8. **Sweep.** Every 25 exchanges, stray pairs are swept (cosine ≥ 0.75) and close clusters (≥ 0.70) receive a parent overview, as in recursive summarisation trees.

**Validation.** Each step emits operations (`create_node`, `patch_summary`, `merge`, `split`, `create_parent`, `add_link`, …). The server applies a batch atomically only if the tree's invariants hold and every cited quote occurs verbatim in an exchange whose retention is allowed. An optional step that fails validation is skipped; it is never half-applied. Forgetting an exchange removes it as owner, mention and evidence everywhere and drops facts left without evidence.

## 4. Layered retrieval

Retrieval runs before every answer, so it must be fast. It is layered: broad and cheap signals first, a fast judge next, and a slower model only when the judge is unsure.

<p align="center"><img src="assets/memory-retrieval.svg" alt="Retrieval layers: BM25 and bge-m3 fused by rank, Clef judges with a probability, a light model only when unsure" width="760"></p>

1. **Recall.** BM25 over node title, aliases and summary, and **bge-m3** (1024-d) dense search in PostgreSQL/pgvector, in parallel. A third list holds the previous exchange's node and its parent, children and linked nodes, so a short follow-up ("and the second one?") stays on topic even with no shared words.
2. **Fusion.** Reciprocal rank fusion, $\text{score}(n) = \sum_{l} 1/(61 + \text{rank}_l(n))$, keeps the top 24. RRF needs no weights, which matters with a small evaluation set.
3. **Judge.** **Clef** sees the question (≤ 4,000 chars), the last two exchanges as recent turns (600 chars per message) and compact cards (≤ 320 chars: title, aliases, parent, first facts) for the top 12 candidates, and chooses one option or *uncertain*, with a probability.
4. **Escalation.** A light LLM starts **in parallel** with Clef. If Clef picked a node with confidence ≥ 0.35, its choice is used and the light model is cancelled. Otherwise the light model, which sees slightly richer cards and is told to separate a return to an older subject from a short follow-up and to prefer the most specific node, returns up to three nodes or none. It has 5 s (Claude-class) or 8 s (GPT-class) and may only return supplied ids. If both fail, the top three fused candidates are used.
5. **Delivery.** For each selected node, its exchanges (including descendants') are ordered by in-node BM25 against the question: best three, then the two most recent, then the rest; the previous exchange is inserted early and the last two exchanges appended; rules occupy a separate slot (≤ 8). Exchanges are cut to the user turn plus the head of the reply (2,400 chars) and the packet keeps the longest prefix within 32 KB. The answering model reads original text, marked as reference data rather than instructions.

### 4.1 Why Clef as the judge

Choosing a topic is a small judgement, neither a ranking nor an essay.

- **Richer base knowledge than a ranker.** A reranker scores similarity; a decision model can tell that two differently worded mentions refer to the same thing.
- **Faster than a general LLM.** Server-side p50 619 ms (p95 1,665 ms) against several seconds for a general model.
- **It outputs a probability.** That number is what makes the layering possible: trust Clef when it is sure, escalate when it is not.

We also evaluated its smaller sibling, Clef-flash. It was not faster in our measurements (p50 730 ms) and was clearly worse at judging (§6.2), and Clef's Korean understanding was markedly better, so Clef was kept.

## 5. Evaluation design

**Data.** A chronological replay of our own conversation history: 316 user turns (752 messages), from which 105 questions were graded and 103 had at least one relevant exchange. Questions are tagged *known follow-up* (72), *return to an older subject* (31), *short return* (6) and further by alias, typo and mixed Korean/English. The data and gold labels are private.

**No leakage.** Each question is asked against the tree **as it was before that exchange was processed**. Gold files (anchors, queries, corrections, aliases) are read only by the scorer; they are never given to growth or retrieval.

**Metrics.** R@24 (recall of relevant exchanges in the first 24 delivered), nDCG@5, top-3 hit, MRR, any-hit, and packet size (KB, p50). Tree quality is measured as homogeneity, completeness and V-measure of the owner-node clustering against gold topic labels.

**Overfitting control.** Questions are split by date into a first half (tuning) and a second half (confirmation). Only the Clef confidence threshold was tuned, on the first half; θ₀ and the merge, sweep and parent thresholds were fixed in advance. The tables in §6 use the threshold chosen that way (0.5).

**Baseline (BASE).** The previous production retrieval: flat semantic contexts (top-4 contexts, recent exchanges of the primary and alternatives) combined with a BM25 fast path.

**Variants.**

| Name | Candidates | Selection |
| --- | --- | --- |
| T-kw | BM25 over nodes | none (top nodes) |
| T-llm | BM25 over nodes | general LLM picks nodes |
| T-llm-dense | BM25 ∪ dense | general LLM |
| T-clef | BM25 ∪ dense | Clef |
| T-clef-flash | BM25 ∪ dense | Clef-flash |
| T-clef-llm | BM25 ∪ dense | Clef if confident, else LLM |
| H-union | BM25 ∪ dense ∪ previous node ∪ structural neighbours | LLM |
| H-fuse | weighted sum of BM25 and dense scores (weights fit on the first half) | none |
| H-agree | as T-clef | Clef if it agrees with BM25 top-1, else LLM |
| H-vote | as T-clef | Clef and LLM both; agreement → one node, disagreement → both |
| H-route | by question type: follow-up → previous node; typo / mixed / short return → dense-weighted; else H-union | — |
| H-split | dense for nodes, BM25 for exchanges inside a node | none |
| H-rrf | RRF of BM25, dense and structural neighbours | none (top nodes) |
| **H-rrf-clef** | RRF top 24 | **Clef if confident, else light LLM** |

## 6. Results

### 6.1 Retrieval quality and cost (v3 tree, all 103 questions)

| Variant | R@24 | nDCG@5 | top-3 | MRR | any-hit | KB p50 | latency p50 / p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| BASE (previous) | 0.912 | 0.474 | 0.592 | 0.533 | 0.990 | 42.8 | 15–19 s |
| T-kw | 0.805 | 0.575 | 0.641 | 0.612 | 0.932 | 24.8 | 5 ms / 12 ms |
| H-rrf | 0.924 | 0.727 | 0.816 | 0.743 | 0.951 | 23.9 | 0.27 s / 0.94 s |
| T-clef | 0.865 | 0.788 | 0.883 | 0.824 | 0.942 | 10.3 | 0.89 s / 2.6 s |
| H-vote | 0.923 | 0.803 | 0.903 | 0.835 | 0.990 | 12.2 | 5.9 s / 8.8 s |
| T-llm | 0.932 | 0.829 | 0.932 | 0.869 | 0.990 | 13.3 | 5.8 s / 9.1 s |
| **H-rrf-clef** | **0.932** | **0.831** | **0.932** | **0.874** | **0.990** | **13.3** | **0.9 s / 4.1 s**¹ |

¹ With the light LLM started in parallel (Claude-class); 8.4 s p95 with a GPT-class light model. Latencies are estimates composed from measured server-side model times and local CPU, not end-to-end guarantees.

H-rrf-clef matches the general-LLM selector's quality while answering most questions at Clef speed: when Clef is confident (most known follow-ups), retrieval finishes in under a second; only uncertain questions wait for the light model. Fusion alone (H-rrf) recalls well but ranks returns poorly (return nDCG@5 0.367), which is exactly what the judge fixes.

**By question type (nDCG@5).**

| Variant | known follow-up | return | short return |
| --- | ---: | ---: | ---: |
| BASE | 0.458 | 0.511 | 0.362 |
| H-rrf | 0.882 | 0.367 | 0.192 |
| T-clef | 0.882 | 0.568 | 0.521 |
| T-llm | 0.904 | 0.653 | 0.599 |
| **H-rrf-clef** | **0.908** | **0.653** | **0.599** |

**Confirmation half (52 questions, not used for tuning).** H-rrf-clef: R@24 0.952, nDCG@5 0.784, top-3 0.904, any-hit 1.000, against BASE 0.912 / 0.520 / 0.635 / 0.981. The ordering of variants holds on the held-out half.

**Lowering the gate to 0.35.** After deployment we looked at where waiting for the light model was spent. Lowering the threshold from 0.5 to 0.35 lets Clef decide alone on 74 of 105 questions instead of 52; in the 22 added questions Clef's pick equals the light model's in 21. Quality is unchanged, and about a fifth more turns skip the light model. The deployed gate is 0.35.

### 6.2 Candidate and selector ablations (v2 tree, all questions)

| Variant | R@24 | nDCG@5 | top-3 | any-hit |
| --- | ---: | ---: | ---: | ---: |
| T-llm | 0.940 | 0.835 | 0.922 | 0.990 |
| T-llm-dense | 0.926 | 0.824 | 0.913 | 0.981 |
| T-clef | 0.888 | 0.805 | 0.922 | 0.971 |
| T-clef-flash | 0.789 | 0.715 | 0.786 | 0.903 |
| T-clef-llm | 0.917 | 0.826 | 0.913 | 0.981 |
| H-agree | 0.904 | 0.813 | 0.903 | 0.981 |
| H-fuse / H-split / T-kw | 0.804 | 0.584 | 0.699 | 0.942 |
| H-route | 0.801 | 0.560 | 0.602 | 0.942 |
| H-rrf-clef | 0.931 | 0.832 | 0.922 | 0.990 |

Observations: adding dense candidates in front of a general LLM did not help; it gave the model more distractors. Weighted score fusion and question-type routing, both of which need tuning, did no better than plain BM25 on this data, whereas RRF did. Clef-flash lost about 0.1 nDCG@5 against Clef, and most of it on returns to older subjects (return R@24 0.591 vs 0.781).

### 6.3 Choice of the light model

All behind the same Clef gate, started in parallel, on the same v3 snapshot and RRF candidates.

| Light model | nDCG@5 | top-3 | R@24 | standalone p50 / p95 | end-to-end p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| general LLM (reference) | 0.831 | 0.932 | 0.932 | 5.9 s / 8.3 s | 8.5 s |
| GPT-class, fast | 0.825 | 0.932 | 0.928 | 5.2 s / 8.1 s | 8.4 s |
| GPT-class, medium reasoning | 0.813 | 0.922 | 0.911 | 5.4 s / 7.2 s | 8.1 s |
| **Claude Haiku-class** | **0.816** | **0.922** | **0.937** | **2.1 s / 3.9 s** | **4.1 s** |

The light models lose little against the general LLM, and the Haiku-class model halves the tail latency. The deployed system follows the workspace's provider: a Haiku-class model with Claude credentials, a GPT-class model with OpenAI credentials.

### 6.4 Tree quality

| | v2 (model decides when to restructure) | v3 (explicit steps) |
| --- | ---: | ---: |
| Live nodes | 76 | 89 |
| Depth distribution | all at root | 63 / 14 / 10 / 2 (depth 0–3) |
| Parent–child edges | 2 | 26 |
| Cross links (`reference` / `governs`) | 30 | 36 (19 / 17) |
| Merges / splits applied | 0 / 0 | 10 asked / 7 splits into 14 children |
| Rejected operations | — | 0 |

**Clustering against gold topics (256 non-noise exchanges).**

| Clustering | Homogeneity | Completeness | V-measure |
| --- | ---: | ---: | ---: |
| v2 nodes | 0.936 | 0.941 | 0.939 |
| v3 owner nodes (leaves) | 0.972 | 0.938 | 0.955 |
| v3 top-level roots | 0.894 | 0.969 | 0.930 |

Leaves are purer than v2's nodes, and roots gather each gold topic more completely, which is the intended division of labour: leaves for precise evidence, roots and parents for overview questions. In case studies, a multi-day onboarding thread of 26 exchanges ended up with 96% of its exchanges under one root, and three related product topics that the user discussed separately were kept apart but linked to each other.

### 6.5 Growth cost

Growth is off the answer path. In the replay it took p50 22.9 s and p95 50.7 s per non-noise exchange (688 uncached model calls for 260 exchanges: attach 250, summary patch 249, link confirm 111, ancestor rewrite 54, split confirm 10, same-topic 10, parent theme 4). The worker yields to any conversation being answered.

## 7. Related ideas we drew on

- **Hybrid retrieval with rank fusion.** Multiple retrievers in parallel fused by RRF ($1/(60+\text{rank})$), with models normalising what gets embedded and full text kept for exact matching; we embed node cards and search exchanges inside a node with BM25.
- **Score combination versus RRF** (Bruch et al., 2022): convex combination often beats RRF when weights can be fit; with ~100 questions we found RRF more robust (§6.2).
- **Temporal knowledge graphs** that combine BM25, vectors and graph distance and track validity over time: the basis for structural-neighbour candidates and for corrections superseding facts.
- **Recursive summarisation trees** (RAPTOR) and **evolving agentic memory** (A-MEM): parent overview nodes and links that are revised as memory grows.
- **Hierarchical memory insertion** by top-down descent with a depth-dependent threshold.

## 8. Limitations

- One person's history, 103 graded questions. Subsets such as short returns (6 questions) are too small to compare variants reliably.
- Some gold labels were drafted with model assistance and then reviewed; they are not fully independent.
- The replay was run once; model outputs are cached, so it is reproducible but not resampled.
- Clef chooses a single node; questions spanning two topics usually escalate to the light model and pay its latency.
- Selection sees node cards, not exchanges, so a node with a weak summary is harder to choose.
- The open question is scale: how the tree behaves after a year of conversation, and whether the thresholds hold as it grows.

## 9. Memory around the tree

| Layer | What | Selection |
| --- | --- | --- |
| Explicit memories | Facts the user asked to keep, with corrections and validity windows | All current ones in scope; corrections supersede |
| Recent work | Last 8 tasks of the conversation, as short excerpts | Recency |
| Knowledge tree | Every past exchange, by topic | §4 |
| Archive | Every message, file and indexed document | On demand, through search tools |

## Code map

| Concern | Files |
| --- | --- |
| Tree rules: descent, fusion, Clef choice, invariants | `packages/knowledge-tree/core.ts`, `schema.ts` |
| Evidence ordering and budget | `packages/knowledge-tree/deliver.ts` |
| Storage, validated apply, forget | `packages/knowledge-tree/store.ts`, `forget.ts`, `infra/migrations/064_knowledge_tree.sql` |
| Background growth | `services/daemon/knowledge-tree-growth.ts`, `knowledge-tree.ts` |
| Question-time retrieval | `services/daemon/knowledge-tree-retrieval.ts`, `auxiliary-model.ts` |
| Explicit memories | `packages/memory/` |

`KNOWLEDGE_TREE_MODE=on` enables the tree; `shadow` grows it without using it, to build it from existing conversations before switching over.
