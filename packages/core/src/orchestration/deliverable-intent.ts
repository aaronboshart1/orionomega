/**
 * @module orchestration/deliverable-intent
 *
 * Pure, dependency-free heuristics for the "I'll write it now" stall fix
 * (Task #221). Two separate concerns share this module:
 *
 *  1. `impliesWrittenDeliverable(task)` — decides whether a worker AGENT
 *     node's task (or a direct-mode user request) clearly asks for a
 *     written file deliverable (spec / report / synthesis / etc). Used to
 *     decide whether "the node finished but wrote zero files" should be a
 *     visible failure rather than a silent success.
 *
 *  2. `matchesImminentWriteIntent(text)` — detects the failure mode where
 *     the assistant narrates an imminent write ("I'll write the spec now")
 *     but then ends the turn without ever calling the write tool.
 *
 * Both are intentionally conservative: they only fire on clear cues so we
 * don't turn benign chit-chat into spurious retries.
 */

/**
 * Matches clear cues that a task expects a written file deliverable. The
 * heuristic is deliberately conservative because the worker enforcement path
 * HARD-FAILS a node when this fires but no file is produced — so a false
 * positive turns an ordinary prose/analysis node into a spurious retry. We
 * therefore require an explicit pairing of a *production verb* with a
 * *deliverable noun*, or an explicit file/extension cue. We do NOT trigger on
 * bare "synthesize", bare "spec", or vague nouns like "summary"/"analysis"
 * that frequently denote in-chat prose rather than a file.
 *
 * Examples that match: "synthesize a spec", "write the report",
 * "produce a comprehensive markdown plan", "deliver a design brief",
 * "create a report file", "write the analysis to spec.md".
 * Examples that do NOT match: "synthesize key findings", "summarize the
 * findings", "compare implementation to spec and report gaps", "generate a
 * summary in chat", "investigate the bug", "run the tests".
 */
const DELIVERABLE_TASK_RE =
  /\bdeliverable\b|\bwrite\s+(?:the|a|an|out)\b|\b(?:synthes(?:i[sz]e|is)|produce|deliver|create|draft|prepare|generate|compose|author)\b[^.]*\b(spec(?:ification)?s?|report|markdown|document|doc|plan|brief|write[- ]?up)\b|\b(spec(?:ification)?s?|report|document|plan|brief|write[- ]?up)\b[^.]*\b(file|\.md|\.txt|\.json|\.csv|\.pdf)\b/i;

/**
 * Returns true when the given task text clearly implies the worker should
 * produce a written file deliverable.
 */
export function impliesWrittenDeliverable(...parts: Array<string | undefined>): boolean {
  const text = parts.filter(Boolean).join('\n').trim();
  if (!text) return false;
  return DELIVERABLE_TASK_RE.test(text);
}

/**
 * Matches an assistant turn that announces an imminent file write.
 * Examples that match: "I'll write the spec now", "Let me write the file",
 * "writing it now", "creating the file", "about to write the report",
 * "I'll create spec.md now".
 *
 * Deliberately requires both a write/create verb AND a near-term cue so
 * that retrospective phrasing ("I wrote the file") does not match.
 */
const IMMINENT_WRITE_RE =
  /\b(i'?ll|i\s+will|let\s+me|going\s+to|about\s+to|now\s+i'?ll|i'?m\s+going\s+to)\b[^.!?\n]{0,80}\b(write|writing|create|creating|draft|drafting|produce|producing|generate|generating|save|saving|put\s+together)\b|\b(writing|creating|drafting|generating|saving)\b[^.!?\n]{0,40}\b(the\s+)?(file|spec|report|document|markdown|deliverable|it\s+now|now)\b/i;

/**
 * Returns true when the assistant's turn text announces an imminent write
 * (the precondition for a stall when no write tool was actually called).
 */
export function matchesImminentWriteIntent(text: string | undefined): boolean {
  if (!text || !text.trim()) return false;
  return IMMINENT_WRITE_RE.test(text);
}
