# Source-Aware Onboarding and Source-Led Maps: Design

**Status:** approved in conversation on 2026-10-24, awaiting review of this written spec.
**Amends:** [2026-10-07-adaptive-learning-platform-design.md](2026-10-07-adaptive-learning-platform-design.md). It moves "Automatic web search to fill coverage gaps" (out of scope) and "Suggested sources" (future item 6) into the first release, limited to Wikipedia and YouTube. It also replaces "the map is generated from the goal before any sources are added" with the source-led flow below.

## 1. Problem and goal

Today a learner enters a goal and gets a topic map. But lessons and quizzes need sources, and nothing prompts the learner to add any, so the first lesson they open is empty.

**Goal:** a new learner, guest or signed in, can open a lesson with real, cited content within a few minutes of entering a goal, without hunting for links. A learner who already has material (a course, a book, a playlist or a syllabus) can give it during onboarding, and the map follows its structure.

**Success criteria:**
- **"Pick for me":** a goal created this way gets automatic sources for its uncovered topics, and its first topic's lesson has content.
- **A pasted outline:** a goal created from an outline has a map whose top-level topics follow the outline's order and names.
- **Grounding is unchanged:** lessons and quizzes use only sources, cite every section, and say so when sources are thin (main spec §6).

**Delivered in two stages, both in the first release.** Each stage can be shipped and tested on staging on its own.
- **Stage 1: onboarding and automatic sources.** The new start form, learning styles, the user's links on the form, the "pick for me" button and the `discover_sources` job.
- **Stage 2: source-led maps.** The `reading_sources` stage, pasted outlines, maps built from the structure of the user's sources, `primary_ref`, the shallow-source question and paywall detection.

**Out of scope (project 3, after the first release):** EPUB and Markdown uploads, YouTube playlists, expanding links within a site, PDF upload on the start form, general web search, and languages other than English.

## 2. The learner's flow

### 2.1 Start form (one page, progressive disclosure)

1. **"What do you want to master?"** The goal text field (1–120 characters, as today) and the level chips: Beginner, Intermediate, Advanced.
2. **"How do you like to learn?"** Three single-choice filter chips. The default is Documentation & Reading.

   | Chip | `learning_style` | Default lesson format | Discovery looks for |
   |---|---|---|---|
   | Visual / Video | `visual_video` | `visual` | Wikipedia and YouTube |
   | Documentation & Reading | `reading` | `text` | Wikipedia |
   | Hands-On / Building | `hands_on` | `examples` | Wikipedia |

3. **"Where do you want to learn from?"** This section starts collapsed, behind a disclosure button. The helper text reads: *"Have a specific course, book, or playlist? Paste it here and we'll map it out. Otherwise, leave blank and we'll find the best materials for your style."* It has two tabs:
   - **Links:** up to 3 URLs, one per field, for web pages or YouTube videos. Each is checked by the existing link validation as it's typed.
   - **Paste an outline:** a textarea of 1–20,000 characters, for a syllabus, a book's contents or a lecture schedule.
   - **"I don't have sources, pick the best ones for me":** a subtle text button. It appears only while the section is expanded. It submits the form with no sources, ignoring anything typed in the section.

**Buttons:**
- **Primary:** stays **"Build my learning map"**.
- **Section collapsed:** the primary button submits with no sources.
- **Section expanded:** it submits with whatever is filled in. Empty link fields and a blank outline are ignored.

**Preferences:** the chosen style and level are saved to `learning_prefs`. The onboarding step after sign-up keeps the level, but no longer asks for the format: the style sets it. Every lesson can still switch between all four formats.

**Guest limit:** the user's own links and outline count toward a guest's 3 sources. If a guest enters more than they have left, the form says so before submitting.

### 2.2 After submitting

- **No sources:**
  1. The map is built from the goal, as today.
  2. Once it's `ready`, the goal page shows the map immediately, with a small "Finding sources for your topics…" status.
  3. Automatic sources appear in the source list, and on their topics' coverage chips, as each one finishes ingesting.
- **With sources:**
  1. The goal page shows **"Reading your sources…"**, with the existing per-source stepper for each source.
  2. When reading has finished, the map is built following the sources (§4).
  3. Discovery then fills topics the sources don't cover.
- **Shallow material:** if the user's sources are shallow (§4.4), the reading view asks:

  > This looks like a single article rather than a full curriculum. Expand this topic with related guides?

  It offers two buttons:
  - **Expand:** a full map built from the goal, using the sources as supporting material, then discovery.
  - **Keep it small:** a map that follows the material only. Discovery still fills any gaps.
- **Partial failure:** if some user sources fail, the map is built from the ones that worked, and each failed source shows its reason. If every user source fails, the map is built from the goal alone and discovery runs. The failure messages stay visible in the source list.
- **Paywall or login page:** the source fails with *"We can't read this page, it needs a login. Paste the course's syllabus or table of contents instead."*, followed by a **Paste an outline** link that opens the Add source dialog on its outline tab. The failure doesn't count toward any limit. The Add source dialog gets the same **Paste an outline** tab in stage 2, which adds an `outline` source to a `ready` goal like any other source.

### 2.3 Lessons with no sources

When a topic has no usable source because discovery found nothing or failed, the lesson's empty state keeps its current behaviour: no lesson is generated from the model's general knowledge. It gains two direct actions:
- **"Add a source"**, which opens the dialog.
- **The topic's suggested searches**, which already exist.

## 3. Stages and data

### 3.1 Map status

`goals.map_status`:

```
pending ──(user sources?)──► reading_sources ──► building_map ──► ready
   │                               │
   │                               └──(shallow)──► awaiting_expand ──(answer)──► building_map
   └──(no user sources)──────────────────────────────────────────────► building_map
clarifying and failed: unchanged. clarifying can follow building_map, as today.
```

- **New values:** `reading_sources`, `awaiting_expand` and `building_map`.
- **`goals.expand`:** a boolean, null until answered. It holds the learner's answer to the shallow-material question.
- **Reading time limit:** if user sources are still being read **5 minutes** after the goal was created, the goal moves on to `building_map` with whatever has been read.

### 3.2 Discovery status

`goals.discovery_status` is `none`, `running` or `done`, and starts as `none`.
- **Running:** discovery runs after `ready` and never blocks the map.
- **Done:** it's `done` when the job finishes, including when it finds nothing.
- **Display:** the "Finding sources…" note shows while `running`.

### 3.3 Sources

- **`sources.origin`:** `user` (the default) or `auto`. Automatic sources skip the guest and daily source limits in `sources_enforce_rules`.
- **Outline type:** `sources.type` gains `outline`. Its text is stored in `sources.outline_text`, capped at 20,000 characters, and is never fetched. It goes through the cleaning, chunking and embedding steps like any other source.
- **Early sources:** user sources may be inserted while the goal is `pending` or `reading_sources`, but only by the goal-creation RPC. `goal_not_ready` still applies to the Add source dialog until the goal is `ready`.
- **Source status:** gains `awaiting_map`. A source reaches it after embedding if its goal's map isn't `ready` yet. The existing matching step runs for these sources when the map becomes `ready`.
- **Failed automatic sources:** these are deleted, along with their jobs, and never shown. The learner only ever sees automatic sources that worked.

### 3.4 Subtopics

`subtopics.primary_ref` (`source_chunk_id`, nullable) is the chunk that best represents the topic. It's shown on the topic card's detail panel as *"Main reference: {source title}, {chapter, page or timestamp label}"*, linking to that place.
- **Source-led maps:** it's set from the map model's `ref` (§4.2).
- **Goal-only maps:** after matching, it's set to the topic's highest-relevance chunk, if it has one.

### 3.5 Preferences

`learning_prefs.learning_style` is `visual_video`, `reading` or `hands_on`, with `reading` as the default. Setting it also sets `preferred_format`, using the table in §2.1.

### 3.6 Goal creation

A single RPC, `create_goal_with_sources(title, level, learning_style, links text[], outline text)`:
- **Inserts:** the goal, its sources and the prefs, in one transaction.
- **Status:** sets `map_status` to `reading_sources` if there are sources, or `pending` if not.
- **Limits:** applies the guest and daily source limits to the user's sources, raising the existing errors.

The web form calls it instead of today's goal insert.

### 3.7 Jobs

| Job | When | What it does |
|---|---|---|
| `ingest_source` (changed) | Each user source at creation, and every later source | As today. If the goal isn't `ready`, it stops at `awaiting_map` after embedding. When the last user source of a goal in `reading_sources` finishes or fails, it runs the shallow check (§4.4) and moves the goal to `awaiting_expand` or `building_map`, enqueuing `topic_map`. |
| `topic_map` (changed) | Goal in `pending` or `building_map` | Builds the map from the goal, plus the structure summary when there are user sources (§4). On `ready`: enqueues matching for `awaiting_map` sources and enqueues `discover_sources`. |
| `discover_sources` (new) | After `ready` | §5. |
| `reading_timeout` (new, periodic) | Each worker poll | Moves goals stuck in `reading_sources` for 5 minutes or more on to `building_map`. |

## 4. Maps built from the user's sources (stage 2)

### 4.1 Structure summary

Built from every user source that was read (`awaiting_map`), in the order the learner gave them, and capped at about 8,000 tokens in total:
- **Outline:** the pasted text as given, trimmed to fit. Its top-level items are lines that aren't indented and are numbered, bulleted or headed. Each item gets an id, `O1`, `O2` and so on.
- **Web pages and PDFs:** the headings in document order, using H1–H3 for pages and outline or font-size headings for PDFs. Each heading has the first sentence of its section and an id such as `S2.H3`.
- **YouTube:** the chapters from the description, with their timestamps, if it has them. Otherwise the title and the first ~300 words of the transcript, as one item.

Each id maps to the chunk where that item starts, which `primary_ref` uses.

### 4.2 Map prompt and output

**What the call gets:**
- The goal, level and learning style.
- The structure summary, delimited as untrusted data.
- One of two rules:
  - **Follow** (sources given, no expansion): use the sources' structure. Keep their order and their names, which may be shortened to 120 characters. Don't invent top-level topics. Group items into children where the source nests them.
  - **Expand** (the learner chose Expand): design the map from the goal as today, use the sources' structure where it fits, and add topics the sources don't cover.

**Output:** today's `TopicMapResponse`, plus an optional `ref` (a summary item id) on each subtopic and child.

**Validation:**
- **Topic count:** as today, except a map built with the Follow rule may have **3–12** top-level topics. Today's 5–12 still applies otherwise.
- **References:** an unknown `ref` is dropped. It isn't an error.
- **Clarifying questions:** only for maps built from the goal alone. With sources, the model must not ask one.

### 4.3 After the map

1. On `ready`, every `awaiting_map` source runs the existing matching step against the new map.
2. `primary_ref` is set: from `ref`, otherwise from the best match.
3. Discovery fills topics that are still uncovered.

### 4.4 Shallow material

After reading, the user's sources are **shallow** if either:
- **Too short:** they have fewer than **1,500 words** in total, *or*
- **Too little structure:** they yield fewer than **3 top-level summary items** across all sources.

**An exception:** an outline with 3 or more top-level items is never shallow.

### 4.5 Paywall and login detection

A web source fails permanently with the paywall message (§2.2) and is **not counted** toward limits when either:
- **A known course host returns too little:** its host is in a known course-platform list, initially `udemy.com`, `coursera.org`, `edx.org`, `linkedin.com/learning`, `oreilly.com`, `skillshare.com` and `pluralsight.com`, and the extracted text has fewer than 300 words, *or*
- **The page is mostly a sign-in form:** it has a password field, and the extracted text has fewer than 300 words.

## 5. Finding sources automatically (stage 1)

### 5.1 `discover_sources`

**Selection:**
1. Load the goal's map and coverage.
2. Take the top-level topics that are still uncovered, in map order. A top-level topic counts as covered if it or any of its children has coverage.

**Wikipedia, for every style, up to 4 articles per goal:**
1. For each uncovered topic, call `action=query&list=search` on `en.wikipedia.org/w/api.php` with `srsearch="{topic title} {goal title}"` and `srlimit=5`, sending our `FETCH_USER_AGENT`.
2. Take the first result that isn't already a source URL for this goal, isn't a disambiguation page (`pageprops.disambiguation`), and has `wordcount` ≥ 300.
3. Add it as a `web` source with `origin = auto` and the URL `https://en.wikipedia.org/wiki/{title}`.

**YouTube, for `visual_video` only, up to 2 videos per goal:**
- **When it runs:** only when `YOUTUBE_API_KEY` is set.
- **Search:** for the first two uncovered topics, call `search.list` with `q="{topic title} {goal title}"`, `type=video`, `videoCaption=closedCaption`, `videoDuration=medium`, `relevanceLanguage=en`, `safeSearch=strict` and `maxResults=5`.
- **Pick:** take the first result that isn't already a source.
- **Add:** as a `youtube` source with `origin = auto`.
- **No key:** video search is skipped and Wikipedia fills the topics.

**After adding:**
1. Each added source goes through the existing pipeline: safe fetch, the limits on video length and page count, extraction, embedding and matching.
2. An automatic YouTube source that fails, such as a transcript blocked from cloud servers, is deleted. If the Wikipedia cap allows, Wikipedia is tried for that topic instead.

**Single pass:** discovery doesn't recheck gaps after each source. One article may cover several topics, and the cap keeps the cost bounded.

### 5.2 AI quota floor

**Before adding each source,** discovery checks OpenRouter's `GET /api/v1/key`, using its `free_model_daily_requests` remaining count, and stops if **fewer than 5** requests are left today. That way, the learner's own map, lessons and quizzes keep priority. The check only applies when `LLM_PROVIDER=openrouter`.

### 5.3 Quota exhaustion message

When OpenRouter returns 429 with a daily-limit error, the job queue keeps its retries. If the job still fails, it shows *"Our AI is busy right now. Try again later."* rather than the generic failure. This applies to maps, sources, lessons and quizzes.

## 6. Safety

- **Fetching:** automatic sources are fetched only from `en.wikipedia.org` and YouTube, through the existing safe fetcher. There's no general web search.
- **Untrusted text:** the pasted outline and the structure summary are untrusted. They're delimited in prompts as data, and the map's output is structured and validated.
- **Grounding:** unchanged (main spec §6). No lesson or quiz is generated without sources.
- **Licensing:** Wikipedia text is CC BY-SA. Lessons cite Wikipedia sources by title with a link, which meets attribution.
- **New secret:** `YOUTUBE_API_KEY`, optional, set on both Fly apps.

## 7. Testing

**Worker (pytest, fake AI):**
- **Structure summary:** for each kind of source, including ids and the token cap.
- **Map prompt:** the Follow and Expand rules, the 3–12 topic validation, and unknown `ref` values being dropped.
- **Shallow check:** both thresholds and the outline exception.
- **Paywall detection:** the course-host list and the sign-in form check.
- **Discovery,** against recorded Wikipedia and YouTube responses in fixtures, with no live calls in CI:
  - The caps, the duplicate skip, the disambiguation skip, the word-count floor and the YouTube parameters.
  - No key means no videos.
  - A failed automatic source is deleted and Wikipedia is tried instead.
- **Quota floor:** with a stubbed `/key` response.
- **The 429 message.**
- **`reading_timeout`.**

**Database (pgTAP):**
- The new `map_status` and `discovery_status` values and their transitions.
- `origin = auto` skipping the limits, while user links and outlines count.
- `create_goal_with_sources`: limits, the single transaction, and errors.
- Early user sources being allowed only through the RPC.
- `awaiting_map`.

**Browser (Playwright, fake AI, fixture pages):**
- **"Pick for me":** the map, then automatic sources, then a lesson with content.
- **Outline:** a pasted outline gives a map whose top-level topics follow it.
- **Shallow source:** one short link shows the Expand question, and both answers work.
- **Paywalled link:** shows the paste-outline message.
- **Partial failure:** with 2 links where 1 fails, the map is still built and the failure is shown.
- **Guest limit:** a guest with 3 links has used their limit.

**Live check on staging after each stage's deploy:** one goal of each kind, with real OpenRouter and Wikipedia, and YouTube once the key is set.

## 8. Open items for the plan

- **Stage 1 can ship without stage 2.**
  - **Includes:** `create_goal_with_sources` (links only), `origin`, `awaiting_map` and matching on `ready`.
  - **Leaves out:** the outline tab, the `reading_sources` and `awaiting_expand` stages, the structure summary, the shallow check and paywall detection.
  - **With stage 1 alone,** the map is built from the goal while the user's links are read in parallel, and they're matched when it's `ready`.

  The plan should order its tasks so stage 1 is complete and deployable first.
- **YouTube from Fly's Tokyo region:** whether transcripts download from there is unverified. The fallback to Wikipedia (§5.1) covers a failure, but staging QA should record the result.
