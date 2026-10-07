/** The tokenizer a model was trained with, as its file states it. */
export interface TokenizerId {
  vocabSize: number | null
  tokenizerModel?: string | null
  tokenizerPre?: string | null
}

/**
 * Whether a model can draft for another, or why not: a draft is checked
 * token by token, so the two have to share a tokenizer exactly. Null when
 * they do, as far as their files say.
 */
export function canDraftFor(draft: TokenizerId, target: TokenizerId): string | null {
  if (draft.vocabSize !== null && target.vocabSize !== null && draft.vocabSize !== target.vocabSize) {
    return `its vocabulary has ${draft.vocabSize.toLocaleString()} tokens and the model's ${target.vocabSize.toLocaleString()}`
  }
  if (draft.tokenizerModel && target.tokenizerModel && draft.tokenizerModel !== target.tokenizerModel) return 'it uses a different tokenizer'
  if (draft.tokenizerPre && target.tokenizerPre && draft.tokenizerPre !== target.tokenizerPre) return `it splits text differently (${draft.tokenizerPre}, not ${target.tokenizerPre})`
  return null
}
