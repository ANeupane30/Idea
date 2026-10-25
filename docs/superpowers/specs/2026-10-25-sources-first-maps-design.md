# Sources-First Maps: Design

**Status:** direction approved in conversation on 2026-10-25 ("Sources first", search with Tavily). This written spec awaits review.
**Amends:** [2026-10-24-source-aware-onboarding-design.md](2026-10-24-source-aware-onboarding-design.md). A goal without the learner's own sources no longer builds its map from the goal alone. It finds learning material first and builds the map from that. Wikipedia becomes a fallback.

## 1. Why

On staging, the goal "I would like to learn about simulating a growing plant from seed to big." went wrong in five ways:
- **The map misread the goal.** It came out as a botany course, when the goal is about simulation and modelling. Nothing checked the map against real material.
- **The automatic sources were all off-topic** (Nutria, Astroturfing, BYD Auto). Discovery searched Wikipedia with the whole sentence.
- **Wikipedia is reference material, not learning material.**
- **Every lesson asked for a source,** because no source covered any topic.
- **Sources took minutes to read,** partly because the worker re-downloaded its embedding model.

**Goal:** a learner who gives no sources gets a map built from real learning material, such as tutorials, courses, documentation and videos, that matches what they asked for. Every topic on that map starts with at least one source, so its lesson works.

## 2. Flow for a goal without the learner's own sources

The flow with the learner's own sources (links or outline) is unchanged.

```
pending ──► finding_sources ──► reading_sources ──► building_map ──► ready ──► (discovery for gaps)
                 │ no key / no results / search failed
                 └──────────────────────────────► building_map (goal only, as today) ──► ready ──► (discovery)
```

1. **New goals.** `create_goal_with_sources` with no links and no outline creates the goal in a new status, **`finding_sources`**, and queues a new job, **`find_sources`**, instead of `topic_map`.
2. **The search plan: one AI call, fast tier.**
   - **Input:** the goal, the level and the learning style.
   - **Output:**
     - `subject`: a short search subject, for example "plant growth simulation".
     - `queries`: 2–3 web search queries for learning material that suits the learner's style. Tutorials and guides for Reading; worked examples and projects for Hands-On; video lessons plus tutorials for Visual / Video.
   - **Storage:** `subject` goes in **`goals.search_subject`**. Discovery and the web's "Try searching for" chips both use it, replacing today's raw goal title.
3. **Search.**
   - **Request:** each query goes to Tavily with `search_depth=basic`, `max_results=8`, and an `exclude_domains` list of low-value sites (`pinterest.com`, `facebook.com`, `instagram.com`, `tiktok.com`, `x.com`, `twitter.com`, `quora.com`, `amazon.com`).
   - **Merge:** results are de-duplicated by normalised URL, with at most 1 per domain except `youtube.com` (at most 2), and ranked by Tavily score.
4. **Pick.**
   - **What gets picked:** the top **4** results. For Visual / Video learners, that's the top 3 non-video results plus up to **2** YouTube videos.
   - **What happens to them:** they're inserted as sources with `origin = 'auto'`, which skips the learner's limits, and **`found_for_goal = true`**.
   - **Status:** the goal moves to `reading_sources`, with `reading_started_at = now()`.
5. **Read.**
   - **The pipeline:** the existing reading pipeline runs, including the safe fetcher, paywall detection and structure extraction.
   - **What counts:** `finish_reading` and the map step now count every non-failed source of a goal in `reading_sources`, whether `user` or found-for-goal.
   - **No shallow question for found sources.** The learner didn't choose them, so the map always uses the **Expand** rule: it's designed from the goal, using the sources' structure and content.
   - **New prompt rule:** keep the topics to what the sources cover.
6. **Map.** As in stage 2. On `ready`, the found sources are matched like any waiting source.
7. **Gaps.**
   - **When:** after matching, `discover_sources` runs for uncovered topics, as today.
   - **How it searches:** **Tavily**, one query per uncovered topic: `"<topic> <subject>"`, with the style's word ("tutorial" or "video lesson"). It falls back to Wikipedia only when there's no Tavily key.
   - **Caps** are unchanged: 4 web pages and 2 videos per goal in total, counting the found sources.
8. **Fallback.** With no `TAVILY_API_KEY`, a failed search, or no usable results, the goal goes straight to `building_map`. The map is built from the goal alone, and discovery runs afterwards. That's today's behaviour, but with `search_subject` in the queries.

**Off-topic automatic sources** (relevance below 0.40) are removed after matching, so the learner never sees them. This was already decided in PR #20.

## 3. What the learner sees

- **"Finding learning material for your goal…"** while the goal is `finding_sources`. It's then followed by the existing "Reading your sources…" view, which lists the found sources with their progress.
- **On the map,** the found sources sit in the source list like any other.
- **A lesson whose topic has no source yet,** while the goal still has sources being read or discovery running, says **"Sources for this topic are still being read. This takes a minute or two."** It refreshes when they're ready. It no longer says "None of your sources cover this topic yet."
- **"Try searching for" chips** use `search_subject`, for example "Seed structure plant growth simulation", instead of the raw sentence.

## 4. Limits and cost

- **Tavily:** the free tier gives 1,000 credits a month, and a basic search costs 1 credit. A new goal uses 2–3 credits for the search plan, plus up to 4 for gaps. That's about 7 at most, so roughly **140 new goals a month** on the free tier.
  - **Budget guard:** if Tavily reports the quota exhausted (HTTP 432 or 429), the goal falls back as in §2.8.
- **OpenRouter:** one more AI call per goal, the search plan. It's covered by the existing quota floor.
- **The learner's limits:** found and discovered sources never count toward them.

## 5. Speed

- **Embedding model:** the fastembed model (`BAAI/bge-small-en-v1.5`) is downloaded into the worker image at build time, with `FASTEMBED_CACHE_PATH` set. The worker no longer downloads it at run time.
- **Embedder lifetime:** one embedder instance per worker process, reused by every job.

## 6. Safety

- **Search results are untrusted URLs.** They're fetched only through the existing safe fetcher (private addresses are blocked, with size and time limits). They also go through paywall detection, and the per-goal caps apply.
- **The goal is untrusted input** to the search-plan prompt. It's delimited as data, and the response is structured and validated: `subject` is 1–80 characters, there are 1–3 queries, and each is 1–120 characters.
- **Secrets:** `TAVILY_API_KEY` is a Fly secret, and is never logged or sent anywhere except Tavily.

## 7. Validating the map

- **Grounded by design:** the map is built from the found sources' structure and content, with the "keep to what the sources cover" rule.
- **Measured after matching:** the share of top-level topics with coverage of at least 0.40 is logged per goal (`map coverage: 7/9 topics`). It's the signal for tuning queries and prompts. Uncovered topics get gap discovery.

## 8. Testing

- **Worker (pytest, fake AI, recorded Tavily responses):**
  - The search plan's prompt and validation.
  - Tavily request parameters.
  - De-duplication, domain caps, picking and the video split.
  - `find_sources` → `reading_sources`, and the fallback on no key, an error, no results or quota.
  - `finish_reading` counting found sources and always using Expand.
  - Gap discovery through Tavily.
  - Off-topic removal.
  - The single shared embedder.
- **Database (pgTAP):** `finding_sources`, `found_for_goal`, `search_subject`, and the RPC creating `finding_sources` goals.
- **Browser (Playwright):**
  - The fixture server gets a fake Tavily endpoint.
  - **"Pick for me"** shows "Finding learning material…", then "Reading your sources…". It ends with a map whose topics come from the fixture sources, and whose first lesson has content.
  - **A lesson opened while sources are still being read** shows the new message, not the "add a source" one.
- **Live check on staging:**
  - The plant-simulation goal gives a map about simulation and modelling, with on-topic sources and working lessons.
  - One reading goal and one video goal.

## 9. Out of scope

- Tavily's `raw_content`: pages are fetched by our own pipeline.
- Re-ranking sources with the AI.
- Building maps from more than 4–5 sources.
- Languages other than English.
