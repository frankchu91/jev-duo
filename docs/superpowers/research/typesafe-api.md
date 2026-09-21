# TypeSafe Jev API — client author's reference

Compiled 2026-09-21 from the official docs (docs.typesafe.ai, Markdown sources),
the official JS SDK source at tag v0.6.0, the npm registry, the OpenRouter docs,
and a few live probes without a key. Every fact below cites its source. Items
marked UNVERIFIED could not be confirmed from a primary source.

## 1. Endpoint and auth

| Item | Value | Source |
|---|---|---|
| Base URL | `https://api.typesafe.ai` | docs.typesafe.ai/api |
| Evaluate | `POST /v1/systemone` | docs.typesafe.ai/api |
| List models | `GET /v1/models` → `{ "models": [{ "name", "description", "release_date" }] }` | docs.typesafe.ai/models |
| Auth | `Authorization: Bearer <API_KEY>` (keys at console.typesafe.ai/keys) | docs.typesafe.ai/api |
| Content type | `Content-Type: application/json` | docs.typesafe.ai/api |
| Request id | response header `x-typesafe-request-id` | SDK `api-promise.ts` |
| Replaced | `POST /preview/evaluation` (old, breaking) | docs.typesafe.ai/migrating-to-v1 |

SDK-sent headers (client.ts): `Authorization`, `Accept: application/json`,
`User-Agent: typesafe-sdk/0.6.0`, `X-TypeSafe-SDK`, `X-TypeSafe-Runtime`,
`Content-Type`, and `X-TypeSafe-Retry-Count` on retries.

## 2. Request body

```json
{
  "model": "jev-latest",
  "state": "<string> | <object> | <array>",
  "questions": {
    "<your_key>": { "type": "noul", "instructions": "The message conveys urgency or time-sensitivity" },
    "<your_key2>": { "type": "choice", "instructions": "Which team should handle this",
                     "criteria": { "billing": "Payment or subscription issues", "technical": "Bugs or integration problems", "sales": null } },
    "<your_key3>": { "type": "score", "instructions": "How frustrated the customer appears",
                     "criteria": ["Calm, just stating facts", "Frustrated but civil", "Very angry, strong language"] }
  }
}
```

- `state` required: string, object or array. Text only. (docs/api, docs/concepts/state)
- `model` required string. (docs/api)
- `questions` required map keyed by caller-chosen ids; keys are not sent to the model and not used in inference. (docs/api, docs/primitives)
- Noul: `type`, `instructions` (string|object|array), optional `criteria: { true?, false? }`. (docs/api)
- Choice: `criteria` required map option → description or `null`; max 255 options. (docs/api, docs/primitives/choice)
- Score: `criteria` required ordered array low → high; at least 2, up to 10 levels. Must be an array (v0.6.0 breaking change). (docs/api, docs/primitives/score, SDK changelog)
- Structured instructions: an object with the question in one field and data in others, referenced with backticks. Nested state paths like `` `ticket.messages[0].text` ``. (docs/api, docs/primitives)
- Discrepancy: the SDK types `instructions` as optional; the HTTP reference marks it required. Always send it.

## 3. Response body

```json
{
  "model": "jev-1.13.0",
  "answers": {
    "department": { "type": "choice", "choice": "technical", "confidence": 0.78,
                    "probabilities": { "technical": 0.85, "sales": 0.0, "billing": 0.15 } },
    "frustration": { "type": "score", "score": 1.0, "confidence": 1.0,
                     "legend": { "0": "Calm, just stating facts", "1": "Frustrated but civil", "2": "Very angry, strong language" },
                     "probabilities": { "0": 0.0, "1": 1.0, "2": 0.0 } },
    "is_urgent": { "type": "noul", "noul": 1.0 }
  },
  "usage": { "input_tokens": 392, "output_tokens": 65 }
}
```

(verbatim from docs.typesafe.ai/introduction/quickstart)

- Noul answer: `{ "type": "noul", "noul": 0..1 }`, no confidence field. (docs/api, docs/confidence)
- Choice answer: `choice` = argmax option, `probabilities` sum to 1, `confidence` 0..1. (docs/api)
- Score answer: `score` = probability-weighted mean of level indices (0..n-1, fractional), `legend` keyed by index strings, `probabilities` keyed by index strings, `confidence`. (docs/api, docs/primitives/score)
- Key order inside `probabilities` is not stable.

SDK wire types (types.ts v0.6.0):

```ts
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type EntryType = string | { [key: string]: JsonValue } | JsonValue[] | null;
export interface NoulQuestion { type: "noul"; instructions?: EntryType; criteria?: { true?: EntryType; false?: EntryType } | null; }
export interface ChoiceQuestion { type: "choice"; instructions?: EntryType; criteria: { [label: string]: EntryType }; }
export interface ScoreQuestion { type: "score"; instructions?: EntryType; criteria: readonly [EntryType, EntryType, ...EntryType[]]; }
export interface NoulResponse { type: "noul"; noul: number; }
export interface ChoiceResponse { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number>; }
export interface ScoreResponse { type: "score"; score: number; confidence: number; legend: Record<string, EntryType>; probabilities: Record<string, number>; }
export interface Usage { input_tokens: number; output_tokens: number; }
export interface SystemOneRequest { state: EntryType; questions: Record<string, NoulQuestion | ChoiceQuestion | ScoreQuestion>; model?: string; }
export interface SystemOneResult { model: string; answers: Record<string, NoulResponse | ChoiceResponse | ScoreResponse>; usage: Usage; }
```

## 4. Limits

| Limit | Value | Source |
|---|---|---|
| Context | 64k tokens per request (state + all questions); 32k for state + longest question | docs/models |
| Choice options | max 255 | docs/api |
| Score levels | 2..10 | docs/api |
| Questions per request | no documented cap (13 and 182 seen in docs); bounded by tokens. UNVERIFIED cap. | docs/cookbooks |
| Rate limits | 250,000 tokens/s, 1,200 requests/min, dynamic; 429 when exceeded | docs/models |
| SDK timeout | 10,000 ms per attempt | SDK config |
| Input | text only; English primary; CJK lower accuracy | docs/models |
| Accuracy note | "Accuracy falls as the state grows with content unrelated to the decision" | docs/model-jaggedness/jev-1.13 |

## 5. Models and pricing

- Current model Jev 1.13, versioned id `jev-1.13.0`. Aliases `jev-latest` and `jev-preview` both → `jev-1.13.0` today; aliases move on release; pin the versioned id once thresholds are tuned. (docs/models)
- Unknown model → `400 Unknown model: <name>`. (SDK integration test)
- Pricing $0.042 per million input tokens; output tokens free. (docs/models; OpenRouter listing agrees)

## 6. Errors

Documented: 401 (bad key), 422 (validation; body details the field), 429, 529 Overloaded; retry 429/529 with exponential backoff. SDK also maps 400/403/404/5xx. (docs/api, SDK errors.ts)

Bodies:
- 401 (live probe): `{"detail":{"error_type":"authentication_error","message":"Cannot authenticate with the server. Please check your API key and try again."}}`
- 422: FastAPI style `{"detail":[{"loc":["body","questions","q","criteria"],"msg":"..."}]}` (inferred from the SDK parser; verbatim UNVERIFIED)
- Non-JSON possible: a `503 text/plain no healthy upstream` was observed for about a minute during probing.
- Retry headers the SDKs honour: `retry-after-ms` (preferred) then `Retry-After`.

## 7. Official TypeScript SDK

`@typesafe-ai/sdk` 0.6.0 (MIT, node >= 20, ESM+CJS, zero dependencies).
`new TypeSafeClient({ apiKey, baseURL, defaultModel, timeout, retry, fetch, dangerouslyAllowBrowser })`,
`client.systemOne({ state, questions, model? })` → `{ model, answers, usage }`,
builders `noul(instructions, criteria?)`, `choice(instructions, criteria)`, `score(instructions, criteria)`.
Retry defaults: 2 retries, 500 ms doubling to 5 s, jitter 0.25, on 408/429/5xx and connection errors.
Env: `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`, `TYPESAFE_DEFAULT_MODEL`.

## 8. Browser and extension constraints (important)

- The SDK refuses to run in a page (`window` present) unless `dangerouslyAllowBrowser: true`; service workers have no `window`, so the guard does not trigger.
- **CORS (live probe 2026-09-21): `OPTIONS https://api.typesafe.ai/v1/systemone` from an arbitrary `Origin` returned `400 Disallowed CORS origin`.** Web pages cannot call the native API directly. Chrome extensions can: fetches from the extension service worker to an origin listed in `host_permissions` are exempt from CORS, so jev-duo lists `https://api.typesafe.ai/*` and only ever calls the API from `background.ts`, never from a content script.
- OpenRouter answers preflights with `access-control-allow-origin: *`.

## 9. OpenRouter

- Listing `typesafe/jev-1.13` (canonical `typesafe/jev-1.13-20260917`), alias `~typesafe/jev-latest`; $0.042/M in, $0 out; context 32K. Runs on the OpenRouter Decisions API, not chat completions.
- `POST https://openrouter.ai/api/v1/systemone` accepts the TypeSafe body verbatim with an OpenRouter key; bare `jev-1.13` maps to `typesafe/jev-1.13`, `jev-latest` to `~typesafe/jev-latest`.
- `POST https://openrouter.ai/api/alpha/decisions` is the same shape plus optional `provider`, `session_id`, `trace`, `user`.
- Response adds `id`, `provider`, `usage.cost`; `model` is the OpenRouter slug:

```json
{ "id": "gen-dec-1789738314-X5e5eKGQdvR9rblyX250", "model": "typesafe/jev-1.13-20260917", "provider": "TypeSafe",
  "answers": { "refund": { "type": "noul", "noul": 0.98 } },
  "usage": { "input_tokens": 275, "output_tokens": 20, "cost": 0.00003 } }
```

- Error shape `{ "error": { "code": 401, "message": "User not found." } }`; statuses 400, 401, 402, 403, 404, 413, 429, 5xx, 529.
- OpenAPI marks choice/score `confidence`, `probabilities`, `legend` optional; code defensively.

## 10. Batching and threshold guidance

- Put every question about one state in one request; questions are evaluated in parallel and independently. 13 questions in one call was 12.2x cheaper and 10x faster than 13 calls. (docs/patterns/fan-out, docs/cookbooks/parallel_questions)
- For many items with the same questions, the official cookbooks use one request per item with a small concurrency pool ("four at a time; the public endpoint rate-limits"). (docs/cookbooks/classifying_rag_passages)
- Noul thresholds: 0.5 when symmetric; move by cost of error; keep a middle band for a person or a slower model. Start conservative and test on your own data. Do not carry thresholds between question types. (docs/primitives/noul, docs/confidence)
- Model traits that shape client design: literal reading, no arithmetic or counting, context rot with irrelevant state, no text generation. (docs/model-jaggedness/jev-1.13)

## 11. Legacy field names that fail validation

`document` (→ `state`), `prompts` (→ `questions`), `options`/`levels` (→ `criteria`), `responses` (→ `answers`), `probability`/`chosen`/`expectation` (→ `noul`/`choice`/`score`). (docs/migrating-to-v1)
