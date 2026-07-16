# Live AI "Thinking" Display — Design

Date: 2026-07-16
Status: Approved (chat conversation, 2026-07-16)

## Goal

While any AI request is in flight, the chat panel shows the model's real
reasoning tokens streaming live in a small muted window inside the pending
assistant bubble — like ChatGPT/Claude thinking indicators. When the answer
arrives, the thinking display disappears completely; nothing is persisted.

## Decisions (user-confirmed)

- **Content:** real model reasoning (`reasoning_content` from GLM via Z.ai),
  not derived narration. Providers/models without reasoning tokens (e.g.
  Ollama llama3.2) keep the current static placeholders.
- **Scope:** all AI chat calls — `/api/generate-circuit` (Implement),
  `/api/assist-circuit` (Plan/Ask), and `/api/clarify-circuit`.
- **After completion:** thinking disappears entirely; never stored in the
  chat store or localStorage.
- **Style:** muted block ~4 lines tall that auto-scrolls (pins to newest
  text), with a "Thinking" label and the existing pulsing dots.

## Architecture — unified NDJSON streaming

The generate endpoint already streams NDJSON events (`spice`, `complete`,
`error`). Extend that protocol with a `thinking` event and convert the assist
and clarify endpoints to the same protocol.

### Server

- `ollamaProvider.ts` gains a streaming OpenAI-compatible call: POST with
  `stream: true`, parse SSE `data:` lines, accumulate `delta.content` into
  the final text, and invoke callbacks for each `delta.reasoning_content`
  chunk (thinking) and each content chunk (enables live provisional SPICE for
  OpenAI-compatible providers too, which was previously Ollama-only).
  `data: [DONE]` terminates. A non-SSE (plain JSON) response is still
  accepted as a fallback.
- `callOpenAiCompatible` uses the streaming path whenever an `onThinking`
  callback is supplied; otherwise unchanged.
- `streamCircuitWithOllama` accepts `onThinking(delta, state)` alongside the
  existing `onContent`. The Ollama branch forwards `message.thinking` tokens
  if the model ever emits them (harmless no-op for llama3.2).
- `generateAssistReply` and `generateClarifyingQuestions` accept an optional
  `onThinking(delta)` and use the streaming call for OpenAI-compatible
  providers when it is provided.
- `server/index.ts`:
  - `/api/generate-circuit` writes `{type:'thinking', delta, attempt}` events
    alongside the existing `spice` events. Deltas are batched (~100 ms) so
    the wire and the client aren't flooded per-token.
  - `/api/assist-circuit` and `/api/clarify-circuit` become NDJSON streams:
    `thinking` events, then `{type:'complete', data}` (same payload shape as
    today's JSON body) or `{type:'error', code, error}`. Pre-validation
    failures (bad mode, empty prompt) still return plain JSON 4xx before the
    stream starts.

### Client

- `readGenerationStream` (already generic) is reused for assist and clarify;
  both handlers branch on the response `content-type` so a plain JSON error
  body still works.
- Fetch timeouts for assist/clarify become idle timeouts: each received
  stream event resets the abort timer (a long but visibly-progressing
  reasoning phase no longer aborts mid-flight).
- `App.jsx` holds `thinkingState = { chatId, attempt, text }` for the single
  in-flight request. `thinking` events append; an attempt change (generation
  correction retry) resets the text; `complete`/`error`/finally clears it.
  The text is passed to `ChatPanel` only when it belongs to the active chat.
- `ChatPanel.jsx` gains a `ThinkingWindow` component rendered inside all
  three pending bubbles (clarifying, assisting, generating). With no thinking
  text it renders nothing and the current placeholder shows unchanged. It
  auto-pins to the bottom as text streams in.
- `styles.css`: `.thinking-window` — muted color, small font, ~4-line
  max-height, subtle border, scrollable.

## Error handling

Mid-stream provider errors emit `error` events (generate already does this;
assist/clarify get the same). The client thinking state clears on any
terminal event or thrown error. An aborted clarify still falls back to
direct generation, as today.

## Testing

- Server: SSE parsing unit tests (reasoning deltas forwarded, content
  accumulated, `[DONE]`/blank/malformed lines handled, JSON fallback);
  assist/clarify provider tests for the onThinking path.
- Client: ThinkingWindow render test (appears with text, absent without).

## Out of scope

- Persisting or collapsing thinking after completion.
- Ollama `think: true` request support (llama3.2 rejects it); Ollama models
  keep placeholders unless the server ever receives thinking tokens.
