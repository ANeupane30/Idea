# Sources-First Maps: Design

**Status:** direction approved on 2026-10-25 ("Sources first", search with Tavily). Revised the same day with the user's four changes (summarised below). This written spec awaits review.
**Amends:** [2026-10-24-source-aware-onboarding-design.md](2026-10-24-source-aware-onboarding-design.md). Every map is now built from **vetted** sources. It isn't shown until those sources are read and matched. Wikipedia is only a fallback.

**The four changes from the first draft:**
1. **The map stays hidden** until its sources are read and matched, so it's ready for lessons when it appears.
2. **No "Try searching for" chips.** The system searches for sources that fit what the learner is trying to do.
3. **Every source is checked** for being on topic, credible and substantial before the map is designed.
4. **When the learner's own sources fail that check,** they're told first and choose what happens, before any automatic search.

## 1. Why

On staging, the goal "I would like to learn about simulating a growing plant from seed to big." went wrong in five ways:
- **The map misread the goal.** It came out as a botany course; the goal is about simulation and modelling.
- **The automatic sources were all off-topic** (Nutria, Astroturfing, BYD Auto).
- **Wikipedia isn't learning material.**
- **Every lesson asked for a source.**
- **Sources took minutes to read.**

**The cause:** the map was the AI's guess from the goal text. Sources were looked for afterwards, then never checked.

**Goal:**
- **A map built from vetted material:** every map comes from sources that are on topic for what the learner wants, credible, and substantial.
- **Ready when shown:** the map is shown only once those sources are read and matched, so every topic on it has a working lesson.
- **The learner decides about their own material:** if the learner's own material doesn't pass the check, they're told why, and they choose what happens next.

## 2. Terms

- **Intent:** what the learner is really trying to do. It's written down by one AI call from the goal, level and style.
  - Example: "build a simple computer simulation of a plant growing from a seed (procedural or L-system modelling), beginner level".
  - It's stored as `goals.intent`, together with a short `goals.search_subject` such as "plant growth simulation".
- **Vetted:** a source the **source check** (§5) accepted. Only vetted sources shape a map or a lesson.

## 3. Flow

```
                     ┌───────────── learner gave sources ─────────────┐
                     ▼                                                 │
pending ─► understanding ─► reading_sources ─► checking_sources ─┬─ all pass ─────────► building_map
             (intent)        (the learner's)                     ├─ some/all fail ─► awaiting_source_decision
                     │                                           │                     ├ "Find sources for me" ─► finding_sources
                     │                                           │                     └ "Use mine anyway" ─────► building_map
                     └─ no sources ─► finding_sources ─► reading_sources ─► checking_sources ─► building_map
                                                                                                       │
building_map ─► matching_sources ─► ready  (the map is shown only here)                               ◄┘
```

**Statuses** (`goals.map_status`):

| Status | What's happening | What the learner sees |
|---|---|---|
| `understanding` | The intent call | "Understanding your goal…" |
| `finding_sources` | Tavily search, then picking candidates | "Finding learning material for your goal…" |
| `reading_sources` | Fetch, extract and embed | "Reading your sources…", with each source's progress |
| `checking_sources` | The source check | "Checking your sources…" |
| `awaiting_source_decision` | The learner's own sources failed | §6 |
| `building_map` | The map call | "Designing your map…" |
| `matching_sources` | Vetted sources matched to the topics | "Preparing your lessons…" |
| `ready` | Done | The map |

The existing `clarifying` and `failed` stay.

**Shallow material** (from stage 2): the "Expand?" question is replaced by the source decision (§6). For a vetted but shallow user source, the map is built from it plus found sources.

## 4. Finding sources (no sources from the learner, or the learner chose "Find sources for me")

1. **Queries:**
   - **From the intent:** the intent call returns 2–3 Tavily queries aimed at learning material that fits the learner's style:
     - **Reading:** tutorials, guides, course notes and documentation.
     - **Hands-On:** worked examples and projects.
     - **Visual / Video:** video lessons, plus tutorials.
   - **Never the raw goal:** queries are built from the intent, not the raw goal sentence.
2. **Tavily request:**
   - Each query uses `search_depth=basic` and `max_results=8`.
   - **Excluded domains:** `pinterest.com`, `facebook.com`, `instagram.com`, `tiktok.com`, `x.com`, `twitter.com`, `quora.com`, `amazon.com`, `medium.com/tag`.
3. **Candidates:**
   - Results are de-duplicated by normalised URL, with at most 1 per domain except YouTube (at most 2), and ranked by Tavily score.
   - The top **8** become candidates. For Visual / Video learners, up to 3 of them may be videos.
   - They're inserted as sources with `origin = 'auto'` and `found_for_goal = true`, and then read.
4. **Picking for the map:**
   - After the check, the **best 4 vetted** candidates, including up to 2 videos for Visual / Video, build the map.
   - Every other candidate is deleted, so the learner sees only the sources the map uses.
5. **Too few:** if fewer than **2** candidates pass, one more round of queries runs from the intent, with different wording. If that still gives fewer than 2, the goal falls back (§8).

## 5. The source check

**When:** once a goal's sources are read, before any map. **One AI call, fast tier, for all of the goal's sources together.**

**Input per source:**
- Its title, URL or domain, and type.
- Its headings (the structure).
- About its first 1,500 characters of text.

All of it is delimited as untrusted data.

**Output per source:**
- `on_topic` (true / false): does it teach what the intent describes? Matching words aren't enough; it has to teach that.
- `credible` (true / false):
  - **Credible:** an educational, official, academic or established publisher, or a reputable author or channel.
  - **Not credible:** spam, SEO filler, shopping or landing pages, forums with no substance, or content farms.
- `substantial` (true / false): does it explain or teach something, rather than being a stub, an index, a sign-in page or a teaser?
- `reason`: one plain sentence for the learner (at most 160 characters).

**Rules:**
- **Vetted** means all three are true.
- **Results are stored** on the source as `sources.vetted` (boolean) and `sources.vet_reason`.
- **Unvetted found sources** are deleted, and the next candidates are used.
- **Unvetted user sources** are never deleted. They lead to the learner's decision (§6).
- **If the check call fails** after retries, sources fall back to the existing relevance rule after matching. The fallback is logged.

## 6. When the learner's own sources don't pass

The goal waits in `awaiting_source_decision`. The page shows:

> **Some of your sources don't look right for this goal.**
> - *(each failing source)* **Title**: *reason* (for example "This page is a course sign-up page, not course content.")
>
> [**Find sources for me**] [**Use mine anyway**]

- **"Find sources for me":**
  - The failing sources are kept in the learner's list, marked "Not used" with the reason, and they aren't used for the map or lessons.
  - Finding sources (§4) runs, and the map is built from the learner's vetted sources plus the vetted found ones.
- **"Use mine anyway":** the map is built from all of the learner's sources that were read, vetted or not.
- **When none of the learner's sources could be read** (failed fetch, paywall): the same screen, listing those failures.
- **When every source passes:** no screen. The map is built straight away.

## 7. Building the map and preparing lessons

- **Map prompt:**
  - **Input:** the vetted sources' structure summary, plus the intent, level and style. The raw goal sentence isn't used.
  - **Rules:**
    - With the learner's own vetted sources only, the stage 2 **Follow** rule applies: keep their structure.
    - Otherwise, the **Expand** rule applies: design the map for the intent from the sources' structure and content.
  - **Keep to the material:** both rules add **"Every topic must be taught by at least one of the sources."**
- **Matching before showing:**
  - The map's topics are saved, and the goal moves to **`matching_sources`**. Every vetted source is matched.
  - The goal becomes `ready` only once matching is done. That's when the map first appears.
- **Topics left uncovered:**
  - **Gap search:** one Tavily search per uncovered topic, in the form `"<topic> <search_subject>"` plus the style's word. Each candidate is read and checked.
  - **Rule:** a candidate that passes and matches is added. This runs before `ready`, capped at 4 extra sources, and only up to the 5-minute reading limit.
  - **Still uncovered:** the topic keeps its Gap chip, and its lesson says "We couldn't find good material for this topic yet. Add a source if you have one." **No search chips.**
- **Lessons:** they stay grounded: they use only vetted sources, or every read source if the learner chose "Use mine anyway". Nothing is written from the AI's general knowledge.
- **Map coverage:** the share of topics covered is logged per goal (`map coverage: 7/9 topics`).

## 8. Fallback

**When:** there's no `TAVILY_API_KEY`, Tavily fails or reports its quota exhausted (HTTP 429 or 432), or too few sources pass (§4.5).

**What happens:**
1. Wikipedia search using `search_subject`, read and checked the same way.
2. If that also gives no vetted sources, a map from the intent alone. It's shown only after the gap search, and a notice on the goal page says **"We couldn't find good learning material for this goal, so this map is a starting point. Add your own sources to improve it."**

## 9. What changes for the learner

- **No map until it's ready.** While the goal is being prepared, the goal page shows the current stage (§3), with each source's progress.
- **The "Try searching for" chips are removed** from lessons and the map's suggestions.
- **The source list shows:**
  - Found sources like any other.
  - The learner's unvetted sources marked "Not used", with the reason.
- **Later additions:** a source the learner adds after `ready` (the Add source dialog) is checked too. If it fails, it's listed as "Not used" with the reason, and the learner can choose **Use it anyway**.

## 10. Limits, cost and speed

- **Tavily** (free tier, 1,000 credits a month; a basic search costs 1):
  - **Per new goal:** 2–3 credits, plus up to 3 for a retry round, plus up to 4 for gaps. That's about 10 at most, so roughly **100 new goals a month** on the free tier.
- **OpenRouter:** per goal, 1 intent call, 1–2 check calls and the map call, plus matching. All of it is covered by the existing quota floor.
- **The learner's limits:** found sources never count toward them.
- **Speed:**
  - **Embedding model:** the fastembed model is built into the worker image (`FASTEMBED_CACHE_PATH`), with one embedder per process.
  - **Time limit:** reading still has its 5-minute cap.
  - **Expected time to a ready map:** about 2–4 minutes on free models, with progress shown throughout.

## 11. Safety

- **Search results are untrusted URLs:**
  - They're fetched only through the safe fetcher (private addresses blocked, size and time limits) and checked for paywalls.
  - Every page's text is untrusted input to the check and map prompts. It's delimited as data, and the responses are structured and validated.
- **The intent call takes the goal as untrusted data.** Its output is validated: intent 1–300 characters, subject 1–80, 1–3 queries of 1–120 characters each.
- **Secrets:** `TAVILY_API_KEY` is a Fly secret. It's sent only to Tavily and never logged.

## 12. Testing

- **Worker (pytest, fake AI, recorded Tavily responses):**
  - The intent prompt and validation.
  - The Tavily request.
  - Candidate de-duplication and caps.
  - Check verdicts:
    - Vetted versus unvetted.
    - Unvetted found sources replaced.
    - Unvetted user sources leading to `awaiting_source_decision`.
  - Both decisions.
  - Matching before `ready`, and gap search before `ready`.
  - The fallback paths: no key, quota, too few sources.
  - The shared embedder.
- **Database (pgTAP):**
  - The new statuses and columns (`intent`, `search_subject`, `vetted`, `vet_reason`, `found_for_goal`).
  - An `answer_source_decision(goal, choice)` RPC: owner only, and only from `awaiting_source_decision`.
- **Browser (Playwright, fixture site with a fake Tavily endpoint):**
  - **"Pick for me"** goes through the stage messages, and the map appears with a source on every topic. Its first lesson has content.
  - **A sign-in-wall link given by the learner** shows the decision screen.
    - "Find sources for me" ends in a ready map.
    - "Use mine anyway" ends in a ready map.
  - **No "Try searching for" chips** anywhere.
- **Live check on staging:** the plant-simulation goal gives a map about simulation and modelling, with credible on-topic sources and working lessons. Also one reading goal and one video goal.

## 13. Out of scope

- Tavily `raw_content`.
- Re-ranking with paid models.
- Scoring credibility beyond the AI check, such as domain reputation lists.
- Languages other than English.
