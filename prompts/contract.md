## Output contract

This part is fixed and always applies, whatever the instructions above say.

When you are done, your final message must be one JSON object and nothing else, with exactly these fields:

```json
{
  "decision": "safe or needs_human",
  "risk": "low, medium or high",
  "confidence": "a whole number from 1 to 5, written as a number",
  "summary": "One or two sentences on what the PR does. At most 300 characters.",
  "reasons": ["1 to 6 short, concrete reasons for your decision"],
  "risk_areas": ["short tags like auth, data-migration, public-api; can be empty"],
  "files_reviewed": ["every changed file you reviewed, by its path in the repo"],
  "affected_code": [{ "location": "path:line", "why": "one sentence on how this unchanged code is affected" }]
}
```

Rules:

- `confidence` is a whole number from 1 to 5, never a percentage.
- `"safe"` with `"high"` risk is not allowed.
- `files_reviewed` must list every changed file you were asked to review.
- `affected_code` lists at most 10 places. It can be empty only when the change cannot reach other code, for example docs, comments or a new test.
- No other fields. No text before or after the JSON.
