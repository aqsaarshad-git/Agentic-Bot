import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuditActorType, ConversationState } from '@prisma/client';
import { LLM_PROVIDER, LlmProvider, LlmResponse } from '../../ai/llm/llm-provider.interface';
import {
  CustomerEmotion,
  Sentiment,
  Urgency,
  isCustomerEmotion,
  isSentiment,
  isUrgency,
} from '../../ai/tts/emotion-style-map';
import { AuthPrincipal } from '../../common/types/auth-principal';
import { AuditService } from '../audit/audit.service';
import { AgentsService } from '../agents/agents.service';
import { ConversationsService } from '../conversations/conversations.service';
import { ToolRegistryService } from '../tools/tool-registry.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { ContextBuilderService } from './context-builder.service';
import { CustomerMemoryService } from './customer-memory.service';

export interface HandleMessageParams {
  conversationId: string;
  customerId: string;
  content: string;
  requestId?: string;
  actor?: AuthPrincipal;
  /** DIAGNOSTIC ONLY (2026-09-17 phase, no behavior change) — the Call record this turn belongs
   *  to, when there is one (voice calls; absent for typed browser chat with no Call at all).
   *  Purely so 'latency.llm'/'latency.classification' audit rows can be filtered by call
   *  without a join through conversationId — those logs use entityType:'conversation' (an
   *  established, unchanged convention), so this rides along as an extra `result` field instead. */
  callId?: string;
  /**
   * BUG FIX (2026-09-17 latency pass — root cause of excessive generation on voice turns):
   * true only for voice calls (see CallsService.handleTurn), never set for typed browser chat.
   * When true, VOICE_STYLE_DIRECTIVE below is appended to context. Root cause this addresses,
   * confirmed live: with no channel awareness at all, Qwen defaulted to the SAME
   * markdown/bullet/bold-label data-table style for BOTH channels — reasonable for a chat UI a
   * customer reads on screen, but on a call every bit of that formatting is stripped by
   * stripMarkdownForSpeech before TTS ever sees it (see CallsService), so those tokens cost real
   * generation seconds for zero audible benefit. Confirmed live: a 3-transaction listing as
   * "*   **Transaction ID:** TXN-5510 | **Date:** ... | **Amount:** ..." (one bullet per
   * transaction, repeating 3 labels each) measured 142 output tokens / 4.85s of generation for
   * information a human agent would actually speak as one short sentence. This is intentionally
   * NOT a global "always be terse" instruction — chat customers reading on screen may genuinely
   * benefit from the existing structured style, and this project has separately worked to keep
   * replies feeling natural/warm, not clipped. Scoped narrowly to the channel where the
   * mismatch was actually measured.
   */
  isVoiceChannel?: boolean;
  /**
   * The language the customer actually spoke, already determined upstream by the voice
   * pipeline's own STT (dual-transcribe + LLM judge, with duration/hallucination safeguards
   * neither of which this class has any visibility into — see CallsService.resolveTranscript).
   * When given, this is authoritative and skips the raw-script heuristic below entirely; when
   * omitted (typed browser chat, which has no separate STT stage — the customer's own text IS
   * the ground truth), the heuristic still applies exactly as before.
   */
  knownLanguage?: 'en' | 'ar';
  /**
   * Called with each raw text delta as Qwen streams a response — usually the FINAL
   * customer-facing reply, but not always: this used to be documented as "never for a
   * tool-calling iteration," which turned out to be false (confirmed live, 2026-09-15). Qwen
   * can stream a few words of genuine natural-language preamble before its response resolves
   * to a tool call — this callback still fires for those words the moment they arrive, same as
   * any other delta, because the streaming layer has no way to know in advance that the
   * response will turn out to be a tool call. See onToolPreambleSpoken below for how callers
   * are told, after the fact, that a given burst of already-delivered deltas turned out to
   * belong to a tool-calling iteration rather than the final reply. Only fires when Qwen
   * streaming is available and succeeds; the caller must check
   * HandleMessageResult.replyWasStreamed rather than assuming this fired for the final reply.
   */
  onTextDelta?: (delta: string) => void;
  /**
   * BUG FIX (2026-09-15 — "heard something the transcript doesn't show"): fires once per tool-
   * calling iteration that streamed any non-empty text via onTextDelta before resolving to a
   * tool call (see the for-loop below) — i.e. text that was ALREADY spoken (onTextDelta already
   * pushed it to whatever's consuming deltas for speech) but would otherwise vanish from
   * `finalText`/the persisted conversation history, since only the final non-tool-calling
   * iteration's content ever becomes the customer-facing reply. Callers that turn deltas into
   * audio (see CallsService) should use this to also record that same text into whatever
   * transcript they keep, so it never ends up spoken-but-unrecorded. Never fires for an
   * iteration that streamed nothing, or that resolved to the final text reply (that text is
   * already in HandleMessageResult.reply / the persisted Message as usual).
   */
  onToolPreambleSpoken?: (text: string) => void;
}

export interface HandleMessageResult {
  reply: string;
  state: ConversationState;
  /** Synchronous, ALWAYS-neutral/neutral/low placeholder — the real transcript-based
   *  classification is not necessarily done yet when this returns (see `classification`
   *  below). Kept only so callers that just want to display something immediately never need
   *  to null-check; do not treat this as the real value. */
  emotion: CustomerEmotion;
  sentiment: Sentiment;
  urgency: Urgency;
  /** Resolves to the real transcript-based classification of the customer's latest turn (see
   *  classifyMessage) whenever the underlying Qwen call finishes — which, as of 2026-09-14, is
   *  deliberately NOT awaited before this method returns (a customer-approved latency fix: the
   *  reply itself must never wait on tone-styling for the same turn). Never rejects — internal
   *  defaults to neutral/neutral/low on any failure, same as the emotion/sentiment/urgency
   *  fields above. Callers that need the real value for something that CAN wait (e.g. styling
   *  TTS chunks not yet dispatched — see CallsService) should `.then()`/await this instead of
   *  using the synchronous defaults above. */
  classification: Promise<ClassifiedMessage>;
  /** True if onTextDelta was actually invoked one or more times for this turn's final reply.
   *  When true, the caller must NOT synthesize `reply` itself from scratch — it was already
   *  delivered incrementally via the callback. False whenever Qwen streaming wasn't available
   *  or fell back to non-streaming for this turn — the caller handles TTS for the full `reply`
   *  exactly as it did before this feature existed. */
  replyWasStreamed: boolean;
}

const DEFAULT_SYSTEM_INSTRUCTIONS =
  'You are a helpful, concise customer support assistant. Ask clarifying questions when needed, ' +
  'use the available tools to look up real information rather than guessing, and offer to connect ' +
  'the customer with a human agent if you cannot resolve their request. ' +
  // BUG FIX (2026-09-14, confirmed live): "ask clarifying questions when needed" alone was
  // being read too liberally — a customer asking about "my recent transactions" or "my
  // transactions" with no count/range mentioned got a clarifying question ("the last 5, or
  // more?") instead of an answer, even though get_transactions already has a sensible default.
  // Call it immediately with that default; only actually ask when the tool genuinely cannot
  // resolve the request on its own (a specific transaction referenced ambiguously, or a choice
  // between clearly different actions).
  'If a request can be answered directly by calling a tool that has a sensible default (for example, ' +
  '"what are my transactions" or "my recent transactions" with no specific count, date range, or ' +
  'transaction mentioned), call that tool immediately using its default rather than first asking the ' +
  'customer how many or which ones they want. Only ask a clarifying question first when the tool ' +
  'genuinely cannot resolve the request without more information (e.g. they reference "that ' +
  'transaction" without saying which one, or are choosing between clearly different actions). ' +
  'You are ALWAYS talking to exactly one already-authenticated customer — the one you are in this ' +
  'conversation with — and every account/balance/transaction/ticket tool you have only ever ' +
  "returns or affects THIS customer's own data; there is no way for you to look up or act on any " +
  'other person\'s account, and you must never imply otherwise. If the customer asks about "my ' +
  'account", "my balance", or "my transactions", that always means their own account — never ask ' +
  'them to confirm whose account you mean, never ask for "a customer ID" to look someone else up, ' +
  'and never offer to check a different named person\'s account. If speech-to-text produced a name ' +
  'or phrase that seems unrelated to the request (a likely mishearing), do not build a whole line ' +
  "of questioning around that name — briefly note you may not have understood correctly and ask " +
  "the customer to repeat what THEY need, still assuming it's about their own account. " +
  'Always reply in the same language as the customer\'s most recent message (English or Arabic) — ' +
  'match whatever they just wrote or said, even if it differs from earlier in the conversation. ' +
  'If the customer switches languages during the conversation, follow the language of their latest ' +
  'message, not earlier ones. Do not translate the customer\'s own message back to them unless they ' +
  'explicitly ask for a translation. Do not mix Arabic and English within a single reply unless a ' +
  'term genuinely has no natural equivalent (e.g. a reference/transaction ID). Keep confirmations, ' +
  'clarifying questions, account/transaction details, and error or apology messages in that same ' +
  'language too — never switch languages partway through a reply. ' +
  'On a phone call, when the customer indicates they are done — e.g. "thanks, that\'s all", ' +
  '"okay bye", confirming their issue is resolved, or otherwise signaling the conversation is ' +
  'over — call the end_call tool, then give a brief, friendly goodbye, so the call closes out ' +
  'properly instead of being left open. ' +
  // ADDED (2026-09-15 latency pass): confirmed live that generation time for THIS turn's own
  // output — not GPU load, not the tool call itself (a few milliseconds) — is the dominant
  // cost of a tool turn, and that cost scales directly with how many tokens get generated.
  // These two lines target the two places real turns were measured spending tokens on
  // something other than the actual answer: (1) a tool-calling iteration occasionally
  // streaming a spoken preamble before its tool_calls — already made safe (see
  // CallsService.recordSpokenPreamble) but still costs real generation time every time it
  // happens, so preventing it is strictly better than just handling it; (2) a reflexive
  // closing offer ("is there anything else...") tacked onto nearly every reply regardless of
  // whether it added anything. Deliberately does NOT tell the model to be terse in general —
  // only to drop these two specific, identified sources of pure overhead — so it doesn't
  // undercut the natural, warm tone this project has separately worked to preserve.
  'When you decide to call a tool, output ONLY the tool call itself — no introductory or ' +
  'narrating sentence ("let me check that", "sure, one moment") before or instead of it; the ' +
  'system already lets the customer know a lookup is happening. Keep every reply focused on ' +
  'directly answering what was actually asked, without a reflexive closing offer of further ' +
  'help ("is there anything else you\'d like to know?") tacked onto the end by habit — only ' +
  'include one when it is genuinely natural for that specific reply, not as a routine sign-off.';

// BUG FIX (2026-09-15 latency pass): the main-response call was previously left with NO
// maxTokens at all ("genuinely needs an open-ended budget" — see LlmGenerateOptions' old
// comment) specifically so a real reply never got truncated. In practice, every real reply in
// this domain — including a full default-5 transaction listing — measures well under 150
// output tokens; this is a generous ~4x safety margin above that, not a real limit on normal
// replies. It exists purely to bound the WORST case (a rambling/degenerate generation, or a
// tool-calling iteration that streams unnecessary preamble before its tool_calls — see the
// system-instructions addition below) rather than letting it run unbounded. Was previously a
// no-op for the streaming path specifically — see QwenProvider.generateStream's own fix note.
const MAIN_RESPONSE_MAX_TOKENS = 600;

// BUG FIX (2026-09-17 latency pass) — see HandleMessageParams.isVoiceChannel's doc comment for
// the measured root cause this targets. Deliberately concrete (explicit "do this / don't do
// that" pairs, not just "be concise" — the earlier 2026-09-15 attempt at a softer, general
// "keep replies concise... only include a closing offer when genuinely natural" instruction
// measurably failed to stop it: the exact same closing-offer pattern it named still appeared in
// a live reply after that instruction had been in place for two days). Only ever appended for
// voice calls (see extraContext below) — chat is completely unaffected.
const VOICE_STYLE_DIRECTIVE =
  'This reply will be SPOKEN aloud over a phone call, not displayed as text — the customer ' +
  'cannot see formatting, so it must read as something a person would naturally SAY, not a ' +
  'written document. Concretely: ' +
  'Never use markdown — no **bold**, no bullet points ("*" or "-" lists), no "|" separators, ' +
  'no field labels like "Transaction ID:" or "Amount:" repeated line by line. Describe each ' +
  'fact in one flowing spoken sentence instead (e.g. say "a completed payment of 150 SAR on ' +
  'September 8th" rather than listing "Transaction ID: TXN-5510 | Date: September 8th | ' +
  'Amount: 150 SAR"). ' +
  'For a simple factual answer (a balance, a status, a yes/no), reply in exactly ONE short ' +
  'sentence stating the fact — nothing before it, nothing after it. ' +
  'For multiple items (e.g. several transactions), summarize them together in one or two short ' +
  'spoken sentences rather than one bullet/line per item — mention the most relevant one or ' +
  'two by name if that answers what was asked, not an exhaustive field-by-field recitation of ' +
  'every one. ' +
  'Do not open a plain greeting ("hello", "hi") with a list of things you could help with — a ' +
  'simple "Hello! How can I help you today?" is enough; only mention specific topics if the ' +
  "customer's own message was already about one. " +
  'Do not add a closing offer of further help ("is there anything else...", "let me know if...") ' +
  'to a reply that already fully answered the question — end the reply the moment the answer is ' +
  'given. ' +
  'Do not add "let me check that for you" or any other narration of what you are about to do — ' +
  'just give the answer once you have it.';

// ============================================================================================
// DETERMINISTIC ACCOUNT-DATA TOOL ENFORCEMENT (2026-09-17 correctness pass)
// ============================================================================================
// Confirmed live (see the investigation this fixes): Qwen skips its own tool call for plain,
// zero-history questions like "what is my current balance?" or "tell me about my account
// status" often enough to be a real production correctness bug, not just an occasional
// prompt-quality issue — fabricating "0 SAR" or "200 SAR" against a real balance of 2,430.5,
// and inventing vague account claims instead of calling get_account. A stronger prompt cannot
// be the fix (this was reproduced with zero conversation history and a completely unambiguous
// question) — the customer's own words used below is the LLM interpreting language, not it
// deciding business policy, exactly the split described in the fix this implements.
//
// Deliberately narrow and domain-specific — NOT a general intent classifier, and NOT another
// LLM/model: this system has exactly 3 read-only account-data tools, so keyword/phrase matching
// on the customer's own (already STT-resolved, for voice) text is enough to guarantee the
// business rule "an account-data question is answered from a fresh tool call, never from
// conversation memory or model knowledge" — see detectRequiredAccountTools below and its use in
// handleIncomingMessage, which executes the matched tool(s) BEFORE Qwen ever gets a chance to
// generate a final answer, then removes tool-calling ability entirely for that one response
// (toolSchemas: []) so there is nothing left for Qwen to skip. This also removes a whole Qwen
// round-trip (the "should I call a tool?" decision) for these matched cases — a latency win on
// top of the correctness fix, not a tradeoff against it.
type AccountDataTool = 'get_balance' | 'get_account' | 'get_transactions';

const BALANCE_PATTERNS_EN = [/\bbalance\b/i, /how\s+much\s+(money|is|do\s+i\s+have)/i, /how\s+much.*(in|on)\s+my\s+account/i];
const BALANCE_PATTERNS_AR = [/رصيد/];

// Covers: "account status/details/information/info", "status of my account", "is my (payment)
// account active" — the exact phrasings called out as unreliable (see ACCOUNT STATUS
// SPECIFICALLY in the fix this implements). Intentionally NOT matched when the same message
// already hit balance/transaction (see detectRequiredAccountTools) so "my account balance"
// still routes to get_balance alone, not both tools.
const ACCOUNT_STATUS_PATTERNS_EN = [
  /account\s+(status|details|information|info)\b/i,
  /status\s+of\s+my\s+account/i,
  /is\s+my\s+(payment\s+)?account\s+active/i,
];
const ACCOUNT_STATUS_PATTERNS_AR = [/حساب/];

const TRANSACTION_PATTERNS_EN = [
  /\btransactions?\b/i,
  /\bpayment\s+(status|failure|failed)\b/i,
  /why\s+did\s+my\s+payment\s+fail/i,
  /what\s+did\s+i\s+spend/i,
  /\bpurchases?\b/i,
];
const TRANSACTION_PATTERNS_AR = [/معامل/, /عمليات/, /مشتريات/];

function detectRequiredAccountTools(content: string, isArabic: boolean): AccountDataTool[] {
  const tools: AccountDataTool[] = [];
  const balanceHit = (isArabic ? BALANCE_PATTERNS_AR : BALANCE_PATTERNS_EN).some((p) => p.test(content));
  const txHit = (isArabic ? TRANSACTION_PATTERNS_AR : TRANSACTION_PATTERNS_EN).some((p) => p.test(content));
  const accountHit =
    !balanceHit && !txHit && (isArabic ? ACCOUNT_STATUS_PATTERNS_AR : ACCOUNT_STATUS_PATTERNS_EN).some((p) => p.test(content));
  if (balanceHit) tools.push('get_balance');
  if (txHit) tools.push('get_transactions');
  if (accountHit) tools.push('get_account');
  return tools;
}

// ============================================================================================
// AMBIGUOUS ACCOUNT-DATA SAFETY BOUNDARY (2026-09-21 real-call hallucination fix)
// ============================================================================================
// Confirmed live: "ما هو الـ CD الحالية" (garbled — the real word was almost certainly "الرصيد",
// balance, misheard as the Latin letters "CD") didn't match BALANCE_PATTERNS_AR above (no
// "رصيد" in the text), so it fell all the way through to Qwen's own unconstrained judgment,
// which fabricated "420 SAR" against a real balance of 2430.5. detectRequiredAccountTools is
// deliberately narrow (exact-noun matching) and MUST stay that way — broadening it to catch
// this case risks the opposite failure (an unrelated "thanks, bye" spuriously triggering
// get_transactions, already fixed once before — see the fresh-tool-call directive below). The
// gap isn't detectRequiredAccountTools's precision, it's that everything BELOW it assumed
// "didn't match" means "definitely not an account question" — false for a garbled one.
//
// This is the missing middle case: NOT a confident match (don't force a tool) and NOT
// confidently unrelated either (don't let Qwen answer freely) — genuinely ambiguous, plausibly
// account-related. Deliberately two independent, narrow, non-broadening signals rather than a
// wider keyword net:
//   1. A "current state" framing word ("current"/"currently"/"right now", "الحالي"/"الآن") —
//      in this support domain that framing overwhelmingly attaches to a balance/status
//      question, not general conversation.
//   2. A short (1-4 letter) Latin-script fragment embedded inside otherwise-Arabic text — a
//      structural STT-transcription-artifact signal (genuine Arabic speech doesn't naturally
//      produce an isolated Latin acronym mid-sentence), not a topic guess.
// Either alone is enough to withhold a free-form Qwen answer — see isAmbiguousAccountQuery's
// only call site (handleIncomingMessage) for how that's enforced: a fixed, localized
// clarification is used instead, with NO Qwen call at all for this turn, so there is nothing
// left that could invent a number. No LLM/classifier added — this is the same
// deterministic-regex approach as detectRequiredAccountTools, one narrow step further.
const ACCOUNT_ADJACENT_HINT_EN = [/\bcurrent(ly)?\b/i, /\bright now\b/i];
const ACCOUNT_ADJACENT_HINT_AR = [/الحالي/, /الآن/];
const EMBEDDED_LATIN_GLITCH = /[؀-ۿ][^a-zA-Z]*\b[a-zA-Z]{1,4}\b[^؀-ۿ]*[؀-ۿ]/;

function isAmbiguousAccountQuery(content: string, isArabic: boolean): boolean {
  const hints = isArabic ? ACCOUNT_ADJACENT_HINT_AR : ACCOUNT_ADJACENT_HINT_EN;
  if (hints.some((p) => p.test(content))) return true;
  return isArabic && EMBEDDED_LATIN_GLITCH.test(content);
}

// Deliberately hardcoded, not Qwen-generated — the entire point of this path is that NOTHING
// with fabrication risk sits between "STT output" and "what the customer hears" for this case.
const AMBIGUOUS_ACCOUNT_CLARIFICATION_EN =
  "Sorry, I didn't catch that. Are you asking about your balance, account status, or transactions?";
const AMBIGUOUS_ACCOUNT_CLARIFICATION_AR = 'عذراً، لم أفهم ذلك بوضوح. هل تسأل عن رصيدك، حالة حسابك، أم معاملاتك؟';

/** Builds the trusted-data block injected as system context once required tools have actually
 *  run this turn — see PRIMARY OBJECTIVE. Explicit about what Qwen may NOT add (unsupported
 *  account facts, an invented name) since the whole point is that this block, not Qwen's own
 *  judgment or conversation memory, is the only source of truth for this reply. */
function formatTrustedAccountData(results: Partial<Record<AccountDataTool, unknown>>): string {
  const lines: string[] = [];
  if (results.get_balance) lines.push(`Balance: ${JSON.stringify(results.get_balance)}`);
  if (results.get_account) lines.push(`Account: ${JSON.stringify(results.get_account)}`);
  if (results.get_transactions) lines.push(`Transactions: ${JSON.stringify(results.get_transactions)}`);
  return (
    'TRUSTED CURRENT ACCOUNT DATA (fetched fresh for this exact turn — the ONLY source of truth ' +
    'for any account/balance/transaction fact in your reply):\n' +
    lines.join('\n') +
    '\n\nUse ONLY the values above. Do not state any account fact not listed here (e.g. do not ' +
    'describe account standing, activity, or history beyond what is shown). Do not attach any ' +
    'personal name to this data as the account holder\'s identity, even if a name appeared ' +
    'earlier in this conversation or in the customer\'s own words — refer to "you"/"your account" only.'
  );
}

/** Deterministic safety net for the "Dennis" attribution bug (see FIX "DENNIS" ATTRIBUTION
 *  HALLUCINATION): this is a single-authenticated-customer system, so a reply should never
 *  attribute account/balance/transaction data to a possessive personal name — the only place
 *  such a name could come from is a garbled STT transcript or the customer's own words, never
 *  trusted account data (loadCustomerAccountData returns no name field at all). Cheap regex,
 *  not a second LLM call — applied to every final reply, not just the forced-tool path, since
 *  the same hallucination can in principle occur on the model-decision path too. */
function stripNameAttribution(text: string): string {
  return text.replace(/\b[A-Z][\p{L}]*'s\s+(account|balance|transaction|payment)/gu, (_match, noun: string) => `Your ${noun}`);
}

// ============================================================================================
// FORCED-TOOL VERBALIZATION INTEGRITY GUARD (2026-09-21 real-call fix)
// ============================================================================================
// Confirmed live: on a turn where get_transactions had ALREADY run and the correct trusted
// data ({"amount":150}) was ALREADY injected into context, Qwen still produced:
//   "Your most recent transaction was two hundred fifty SAR. (Note: The data shows 150 SAR on
//    September 8th, but I am describing the value as heard by speech-to-text if there is a
//    mismatch; however based strictly on the provided JSON {"amount":150}... Let me re-verify
//    your data.) Your most recent transaction was one hundred and fifty SAR completed on
//    September 8th..."
// — a wrong number stated FIRST, followed by its own visible self-correction monologue leaking
// into the spoken reply, before landing on the right number. Confirmed via the real PSTN
// worker log this was also why the customer only heard a few words: they barge-in reacted to
// the wrong number mid-sentence — that is the EXISTING barge-in feature working correctly on
// bad content, not a TTS/chunking bug, and is not touched here.
//
// This is a DIFFERENT gap than the ambiguous-query one above: the tool DID run and the trusted
// data WAS correct — this is Qwen's own verbalization of already-correct data occasionally
// going wrong. Deliberately detects the STRUCTURE of a leaked self-correction (a parenthetical
// aside, or self-referential "let me reconsider" language) rather than trying to numerically
// parse spelled-out-in-words numbers ("two hundred fifty") against digits — a forced-tool
// reply should never contain a parenthetical at all (VOICE_STYLE_DIRECTIVE already asks for
// one flowing spoken sentence, no asides), so this is a structural tell, not a narrow phrase
// match for this one example. Only applied to the forced-tool path (see useForcedToolPath's
// only call site) — the one case where a fixed, correct, deterministic fallback actually exists
// to fall back to; the general model-decision path has no such trusted ground truth to build a
// fallback sentence from.
const SELF_CORRECTION_LEAK_PATTERN =
  /\(|let me (re-?verify|reconsider|check again)|based (on|strictly on) the (provided|given)|the data shows|i am describing|without error correction|internal logic|correct fact to state/i;

function containsLeakedReasoning(text: string): boolean {
  return SELF_CORRECTION_LEAK_PATTERN.test(text);
}

const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const AR_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const AR_STATUS_WORDS: Record<string, string> = { ACTIVE: 'نشط', INACTIVE: 'غير نشط', SUSPENDED: 'معلق', COMPLETED: 'مكتملة', PENDING: 'معلقة', FAILED: 'فاشلة' };

/** "2026-09-08" -> "September 8th" / "8 سبتمبر" — a raw ISO date read aloud by TTS digit-by-
 *  digit is not how a human agent would say it; this is the one piece of "phrasing" the
 *  deterministic path still does, and it never touches the trusted VALUES themselves. */
function formatDateSpoken(isoDate: string, isArabic: boolean): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return isoDate;
  const day = parseInt(m[3], 10);
  const monthIdx = parseInt(m[2], 10) - 1;
  if (isArabic) return `${day} ${AR_MONTHS[monthIdx] ?? m[2]}`;
  const suffix = day % 10 === 1 && day !== 11 ? 'st' : day % 10 === 2 && day !== 12 ? 'nd' : day % 10 === 3 && day !== 13 ? 'rd' : 'th';
  return `${EN_MONTHS[monthIdx] ?? m[2]} ${day}${suffix}`;
}

/**
 * DETERMINISTIC RESPONSE — the actual fix for "why wait for Qwen at all" (2026-09-21,
 * architecture pass). See ISSUE 1 in the investigation this implements: waiting for a complete
 * Qwen response before TTS was the safe fix, but it left a whole Qwen round-trip (the dominant
 * cost of these turns, per the earlier latency breakdown) on the critical path for a reply that
 * only ever needs to state 1-3 fields already sitting in `results`. Every value below is read
 * directly from the trusted tool result with no LLM in between — not "validated after Qwen
 * generates it," genuinely never generated by an LLM at all for this path. This is what makes
 * PRIMARY OBJECTIVE's rule ("Qwen must never be considered the source of truth for account-
 * specific factual data") a structural guarantee rather than a check that could in principle
 * miss something.
 *
 * Deliberately narrow phrasing, not a general response generator — see DO NOT OVERENGINEER in
 * the investigation this implements: this only ever fires for the 3 known forced-tool cases
 * (balance/account/transactions), each with one clear, obvious way to say it. A message that
 * doesn't map cleanly to one of these already takes a completely different path
 * (isAmbiguousAccountQuery's clarification, or full Qwen conversation) — this function is never
 * asked to handle anything it wasn't built for.
 */
function formatSafeAccountSentence(results: Partial<Record<AccountDataTool, unknown>>, isArabic: boolean): string {
  const sentences: string[] = [];
  const balance = results.get_balance as { balance?: number; currency?: string } | undefined;
  if (balance?.balance !== undefined) {
    sentences.push(
      isArabic
        ? `رصيدك الحالي هو ${balance.balance} ${balance.currency ?? 'SAR'}.`
        : `Your current balance is ${balance.balance} ${balance.currency ?? 'SAR'}.`,
    );
  }
  const account = results.get_account as { status?: string; openedDate?: string } | undefined;
  if (account?.status) {
    const statusWord = isArabic ? AR_STATUS_WORDS[account.status] ?? account.status : account.status.toLowerCase();
    const datePart = account.openedDate ? formatDateSpoken(account.openedDate, isArabic) : undefined;
    sentences.push(
      isArabic
        ? `حسابك ${statusWord}${datePart ? `، وتم فتحه في ${datePart}` : ''}.`
        : `Your account is ${statusWord}${datePart ? `, opened on ${datePart}` : ''}.`,
    );
  }
  const transactions = results.get_transactions as
    | { transactions?: { amount: number; currency: string; date: string; status: string; reason?: string }[] }
    | undefined;
  if (transactions?.transactions?.length) {
    const [latest, ...rest] = transactions.transactions;
    const date = formatDateSpoken(latest.date, isArabic);
    if (latest.status === 'FAILED') {
      sentences.push(
        isArabic
          ? `أحدث معاملة بقيمة ${latest.amount} ${latest.currency} فشلت${latest.reason ? ` بسبب ${latest.reason}` : ''}.`
          : `Your most recent transaction of ${latest.amount} ${latest.currency} failed${latest.reason ? ` because of ${latest.reason}` : ''}.`,
      );
    } else {
      const statusWord = isArabic ? AR_STATUS_WORDS[latest.status] ?? latest.status : latest.status.toLowerCase();
      sentences.push(
        isArabic
          ? `أحدث معاملة لك كانت ${latest.amount} ${latest.currency} (${statusWord}) بتاريخ ${date}.`
          : `Your most recent transaction was ${latest.amount} ${latest.currency}, ${statusWord}, on ${date}.`,
      );
    }
    if (rest.length > 0) {
      sentences.push(
        isArabic
          ? `لديك أيضاً ${rest.length} معاملة أخرى مؤخراً.`
          : `You also have ${rest.length} other recent transaction${rest.length > 1 ? 's' : ''}.`,
      );
    }
  }
  return sentences.join(' ') || (isArabic ? 'تم جلب بياناتك بنجاح.' : 'Your data was retrieved successfully.');
}

const TERMINAL_TOOL_STATES: Partial<Record<string, ConversationState>> = {
  transfer_to_human: 'ESCALATING',
  escalate_ticket: 'ESCALATING',
  schedule_callback: 'CALLBACK_REQUESTED',
  end_call: 'CALL_ENDED',
};

@Injectable()
export class OrchestratorService {
  private readonly logger = new Logger(OrchestratorService.name);
  private readonly MAX_TOOL_ITERATIONS = 4;

  constructor(
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    private readonly toolRegistry: ToolRegistryService,
    private readonly conversations: ConversationsService,
    private readonly agentsService: AgentsService,
    private readonly contextBuilder: ContextBuilderService,
    private readonly customerMemory: CustomerMemoryService,
    private readonly knowledgeService: KnowledgeService,
    private readonly auditService: AuditService,
  ) {}

  async handleIncomingMessage(params: HandleMessageParams): Promise<HandleMessageResult> {
    const { conversationId, customerId, content, requestId, actor, callId, isVoiceChannel, onTextDelta, onToolPreambleSpoken, knownLanguage } = params;
    const startedAt = Date.now();
    // Drives every language decision below (the injected per-message directive AND which
    // language the hardcoded fallback/error strings use) — computed once, so every
    // reply-language decision this turn agrees with the language the customer was actually
    // just written/spoken in, no matter which code path handles the actual reply.
    //
    // BUG FIX (2026-09-11, confirmed live): this used to ALWAYS re-derive language from raw
    // Arabic-script detection on `content` itself, even for voice turns where CallsService had
    // already determined the spoken language far more carefully (dual-transcribe + LLM judge,
    // with duration/hallucination checks — see resolveTranscript/pickSpokenLanguage). A single
    // mis-transcribed word or stray glyph containing 2+ Arabic characters anywhere in an
    // otherwise-English STT transcript was enough to flip the ENTIRE reply to Arabic here,
    // silently overriding a correct upstream detection — confirmed live: an English-speaking
    // customer got an Arabic reply mid-call with `call.language` never actually changing.
    // `knownLanguage`, when given, is that upstream decision and takes priority; the raw-script
    // check remains the right tool for typed chat, which has no STT stage to defer to.
    const customerWroteArabic = knownLanguage ? knownLanguage === 'ar' : /[؀-ۿ]{2,}/.test(content);

    await this.transition(conversationId, 'LISTENING', requestId, actor);
    await this.conversations.addMessage(conversationId, 'CUSTOMER', content);
    await this.transition(conversationId, 'PROCESSING', requestId, actor);

    // Kicked off now, in parallel with the whole reply-generation flow below (DB/config
    // lookups, the tool-calling loop, potentially several LLM round-trips) rather than
    // sequentially after it — classifying only needs the customer's own text, not the
    // agent's reply, so there's no reason to make the customer wait for both in sequence.
    // This was previously the single biggest latency addition from the emotion feature;
    // running it concurrently hides nearly all of it behind work that was happening anyway.
    // 2026-09-14 Qwen-contention audit: a controlled test confirmed concurrent classification
    // CAN cause both it and the main response to slow down together (one clean run with
    // classification disabled showed 0 spikes across 6 samples; the normal concurrent run
    // showed 1 clear spike out of ~8). Left AS-IS deliberately rather than serializing —
    // classification only ever styles chunks not yet dispatched (see below), and running it
    // strictly after the reply would mean it NEVER finishes in time to style any of THIS turn's
    // audio, permanently disabling tone-styling for voice calls. That's a real tradeoff needing
    // an explicit decision, not a silent one — see the investigation report for the numbers.
    // Not awaited here, and no longer awaited before the reply is persisted/returned either
    // (see below) — only its eventual RESULT is exposed, via HandleMessageResult.classification,
    // for callers that want to style not-yet-dispatched TTS chunks once it resolves (see
    // CallsService). Explicit customer-approved tradeoff (2026-09-14): several real seconds of
    // customer-facing wait must never be spent on tone-styling for the SAME turn.
    const classificationPromise = this.classifyMessage(content, conversationId, requestId, callId);
    // Same idea as classification above: this only needs customerId (already known from
    // params), not the conversation/agent-config lookups below, so there's no reason to make
    // it wait in line behind them — kicked off now, awaited only once actually needed.
    const memoryContextPromise = this.customerMemory.buildMemoryContext(customerId);

    const conversation = await this.conversations.findOne(conversationId);

    let allowedTools: string[] = [];
    let systemInstructions = DEFAULT_SYSTEM_INSTRUCTIONS;
    let knowledgeBaseAccess = false;
    if (conversation.aiAgentId) {
      try {
        const { config } = await this.agentsService.getActiveConfig(conversation.aiAgentId);
        allowedTools = (config.allowedTools as string[]) ?? [];
        systemInstructions = config.systemInstructions;
        knowledgeBaseAccess = config.knowledgeBaseAccess;
      } catch (error) {
        this.logger.warn(`Falling back to default agent config: ${error instanceof Error ? error.message : error}`);
      }
    }

    // DETERMINISTIC ACCOUNT-DATA TOOL ENFORCEMENT (see block above): matched purely off the
    // customer's own text, filtered to tools this agent config actually allows — an agent
    // without get_balance in its allowlist must still fall through to the normal model-decision
    // path below rather than forcing a call ToolRegistryService would reject anyway.
    const detectedTools = detectRequiredAccountTools(content, customerWroteArabic).filter((t) => allowedTools.includes(t));
    const forcedToolResults: Partial<Record<AccountDataTool, unknown>> = {};
    if (detectedTools.length > 0) {
      for (const toolName of detectedTools) {
        try {
          forcedToolResults[toolName] = await this.toolRegistry.validateAndExecute(toolName, {}, {
            requestId,
            actor,
            customerId,
            conversationId,
            allowedTools,
          });
        } catch (error) {
          this.logger.warn(
            `Deterministic tool routing: forced call to ${toolName} failed, falling back to model-decision path: ${error instanceof Error ? error.message : error}`,
          );
        }
      }
      await this.auditService.log({
        requestId,
        actorType: AuditActorType.SYSTEM,
        action: 'tool_routing.forced',
        entityType: 'conversation',
        entityId: conversationId,
        result: {
          callId,
          requiredTools: detectedTools,
          executedTools: Object.keys(forcedToolResults),
          source: 'deterministic_policy',
          qwenRequestedTool: false,
        },
        success: true,
      });
    }
    // Only skip Qwen's own tool-calling ability (toolSchemas: []) when EVERY detected tool
    // actually succeeded — a partial failure falls back to the normal model-decision loop below
    // (with real toolSchemas) rather than leaving Qwen unable to call anything with incomplete
    // data. See DO NOT CREATE A LOOP: this is the one deterministic recovery path per turn —
    // there is no retry-forced-then-retry-again cycle.
    const useForcedToolPath = detectedTools.length > 0 && Object.keys(forcedToolResults).length === detectedTools.length;

    const extraContext: string[] = [];
    if (isVoiceChannel) extraContext.push(VOICE_STYLE_DIRECTIVE);
    if (Object.keys(forcedToolResults).length > 0) extraContext.push(formatTrustedAccountData(forcedToolResults));
    const memoryContext = await memoryContextPromise;
    if (memoryContext) extraContext.push(memoryContext);

    if (knowledgeBaseAccess) {
      const kbMatches = await this.knowledgeService.searchRelevant(content);
      if (kbMatches.length > 0) {
        extraContext.push(
          'Relevant knowledge base excerpts:\n' +
            kbMatches.map((m, i) => `${i + 1}) [${m.documentTitle}] ${m.content}`).join('\n'),
        );
      }
    }

    // Empty when useForcedToolPath: the required tool(s) already ran above with a trusted
    // result already injected into extraContext — offering Qwen tool schemas here would only
    // give it a chance to call one again (extra latency) or call something else instead of
    // answering (see PRESERVE TOOL-CALL LATENCY / DO NOT LET QWEN'S DECISION OVERRIDE BUSINESS
    // RULES). The loop below still runs exactly once in this case: with no tools to call,
    // iteration 0's response always has content, never toolCalls, so the loop's own
    // `finalText === undefined` condition ends it immediately — no separate code path needed.
    const toolSchemas = useForcedToolPath ? [] : this.toolRegistry.getSchemasFor(allowedTools);
    const messages = this.contextBuilder.build(conversation.messages, systemInstructions, extraContext);

    // A general "mirror the customer's language" rule in the system prompt, or even a fresh
    // system-role reminder placed a few messages back, wasn't reliably enough to overcome
    // several prior turns' worth of momentum in the OTHER language — confirmed live: it kept
    // replying in Arabic after a customer's own message switched to English. Attaching the
    // directive directly onto the last user message instead — the exact text the model
    // starts generating right after — is far harder to override with earlier context. Once
    // we have final text (post-STT for voice, typed directly for chat), its own script tells
    // us the language with total certainty, so no LLM judgment is needed for this part.
    const lastMessage = messages[messages.length - 1];
    if (lastMessage?.role === 'user') {
      const replyLanguage = customerWroteArabic ? 'Arabic' : 'English';
      // The account-scope reminder below exists for the exact same reason as the language
      // directive: confirmed live, a general "always assume it's the current customer's own
      // account" line in the system prompt was NOT enough once a wrong assumption (a
      // mis-transcribed name) entered the conversation history. Worse than the language case
      // — here the model's OWN prior replies (which had already asked about that wrong name
      // 1-2 times) sat in context too, reinforcing the wrong idea with every turn, so a
      // customer correcting it ("no, I mean MY account") got asked the same clarifying
      // question again on the very next turn, and the one after that (confirmed live: it took
      // three corrections before the agent let go of a misheard name and just answered the
      // real question). Re-stating the account-scope rule fresh on every single turn, attached
      // directly to the message the model is about to respond to, gives it far less room to
      // keep drifting back to something already in its own context.
      lastMessage.content =
        `${lastMessage.content}\n\n[Reply in ${replyLanguage} — this message is written in ${replyLanguage}, no ` +
        `matter what language earlier turns used. Keep your ENTIRE reply in ${replyLanguage} throughout — ` +
        'confirmations, clarifying questions, account/transaction details, and any error or apology included, ' +
        `not just the opening. Do not translate this message back to the customer into the other language unless ` +
        `they explicitly asked you to translate something. Do not mix ${replyLanguage} with the other language ` +
        'unless a term genuinely has no natural equivalent (e.g. a reference/transaction ID). ' +
        'Separately: this entire conversation is with exactly ONE authenticated account holder — this message is ' +
        'about THEIR OWN account, balance, or transactions, full stop. If any earlier message (including your own ' +
        'previous replies) mentioned a different name or asked to confirm whose account this is about, that was a ' +
        'mistake — most likely a speech-to-text mishearing, not a real second person — and you must drop it now: ' +
        'do not mention that name again, do not ask again whose account is meant, and do not ask for a customer ' +
        'ID. Just answer this message using the current account holder\'s own data via your tools.] ' +
        // 2026-09-14 latency/correctness investigation: a real call showed Qwen sometimes SKIPPING
        // the tool call and instead hallucinating a full natural-language answer from a figure
        // already sitting in conversation history (e.g. restating an old transaction, or inventing
        // new ones) — confirmed live and reproduced directly against Qwen: with 5+ turns of history
        // already containing a balance/transaction figure, a repeat question skipped the tool and
        // fabricated an answer ~25-38% of the time, generating 63-188 output tokens (vs. 14-30 for
        // a real tool call) — that generation cost, not GPU load, was the actual cause of an 11s
        // production outlier. Reproduced fix: 100% correct tool-call rate across 15+ trials, output
        // capped at 14-26 tokens, after adding this. Deliberately scoped to "THIS message is itself
        // a new question" (not just "this topic is nearby in history") — an earlier, broader wording
        // ("if this message asks about balance/transactions, call the tool") fixed the hallucination
        // but caused a NEW regression: a plain "thanks, that's all" follow-up started spuriously
        // calling get_transactions too, since the topic was still recent in context even though the
        // message itself asked for nothing. This tighter wording was verified NOT to reintroduce
        // that regression before being added here.
        // Not appended when useForcedToolPath: toolSchemas is empty for this call (the required
        // tool already ran deterministically — see the block above HandleMessageParams), so an
        // instruction to "call the matching tool" would refer to something Qwen has no ability
        // to do this turn. The trusted-data reinforcement below replaces it in that case.
        (useForcedToolPath
          ? ''
          : '[If THIS message is itself a new question asking for a balance, account status, or transaction ' +
            'figure, call the matching tool (get_balance/get_account/get_transactions) to get the CURRENT value — ' +
            'even if that same figure was already given earlier in this conversation, since account data can ' +
            'change; never restate an old figure from memory instead of calling the tool again. If this message is ' +
            'NOT asking for one of those (e.g. it just says thanks, confirms understanding, says goodbye, or asks ' +
            'about something unrelated), do not call any account/balance/transaction tool at all.]') +
        // DETERMINISTIC ACCOUNT-DATA TOOL ENFORCEMENT: short reinforcement of the full trusted-
        // data block already in extraContext, repeated here for the same reason as the
        // language/voice-style reinforcements above — this exact spot is the one already proven
        // to reliably override this model's default habits (see PRIMARY OBJECTIVE).
        (useForcedToolPath
          ? ' [The account data needed to answer this has ALREADY been fetched fresh this turn — ' +
            'see the trusted data above. Answer using ONLY that data; do not add any other account ' +
            'fact, and do not attach any personal name to it as the account holder\'s identity.]'
          : '') +
        // BUG FIX (2026-09-17 latency pass): short reinforcement of VOICE_STYLE_DIRECTIVE
        // (already stated in full via extraContext, see there for the measured root cause),
        // repeated here in the ONE spot in this codebase already proven to reliably override a
        // small model's default habits — everything else attached to this exact message
        // (language, fresh-tool-call) works reliably for that reason; a system-message-only
        // instruction stated once earlier in context does not, as reliably, per this same
        // project's own prior findings.
        (isVoiceChannel
          ? ' [This reply is SPOKEN, not read: one short natural sentence for a simple fact, no ' +
            'markdown/bullets/labels, no "anything else?" closing offer, no "let me check" narration.]'
          : '');
    }

    await this.transition(conversationId, 'UNDERSTANDING_REQUEST', requestId, actor);

    // ARCHITECTURE CHANGE (2026-09-21 latency+safety pass, Option B — see the investigation
    // this implements, which compared A/B/C/D and chose this one): pre-setting finalText here —
    // reusing the EXACT same short-circuit the ambiguous-query case below already relies on —
    // means a forced-tool turn now skips Qwen'S FINAL-RESPONSE CALL ENTIRELY, not just its
    // streaming. Rejected alternatives: (A) the previous fix — wait for a complete Qwen
    // response, then validate — was safe but left the single biggest cost of these turns (a
    // whole Qwen round trip, confirmed dominant in the earlier per-stage latency breakdown) on
    // the critical path just to produce a sentence with no real degrees of freedom once the
    // tool result is known. (C) constrained-Qwen-plus-validation has the same problem: any
    // architecture where Qwen still generates the factual sentence still needs a full Qwen call
    // before TTS. (D) a hybrid ("Qwen wraps a pre-computed fact string") still calls Qwen and
    // still needs to verify it didn't touch the wrapped numbers, i.e. still pays the same call
    // for no remaining safety benefit. (B) skips Qwen altogether for exactly the 3 narrow,
    // single-shape cases where the reply has no real wording freedom left to justify an LLM
    // call — see formatSafeAccountSentence's own doc comment. This is a STRUCTURAL guarantee
    // (nothing generates these values) rather than a check that could in principle miss
    // something, and it's also strictly faster: the removed Qwen call was the dominant cost of
    // these turns per the measurements in the investigation this implements.
    //
    // Gated on Object.keys(forcedToolResults).length === detectedTools.length, i.e. the SAME
    // condition useForcedToolPath already uses — a partial tool failure still falls through to
    // the model-decision loop below (with real toolSchemas), where the non-streaming +
    // containsLeakedReasoning guard further down remains as defense-in-depth for that rarer,
    // already-narrower case.
    let finalText: string | undefined = useForcedToolPath
      ? formatSafeAccountSentence(forcedToolResults, customerWroteArabic)
      : detectedTools.length === 0 && isAmbiguousAccountQuery(content, customerWroteArabic)
        ? customerWroteArabic
          ? AMBIGUOUS_ACCOUNT_CLARIFICATION_AR
          : AMBIGUOUS_ACCOUNT_CLARIFICATION_EN
        : undefined;
    if (useForcedToolPath) {
      await this.auditService.log({
        requestId,
        actorType: AuditActorType.SYSTEM,
        action: 'tool_routing.deterministic_response',
        entityType: 'conversation',
        entityId: conversationId,
        result: { callId, requiredTools: detectedTools, finalText, finalLanguage: customerWroteArabic ? 'ar' : 'en' },
        success: true,
      });
    } else if (finalText !== undefined) {
      await this.auditService.log({
        requestId,
        actorType: AuditActorType.SYSTEM,
        action: 'tool_routing.ambiguous_account_query',
        entityType: 'conversation',
        entityId: conversationId,
        result: { callId, content, finalLanguage: customerWroteArabic ? 'ar' : 'en' },
        success: true,
      });
    }
    let resultState: ConversationState = 'RESOLVING';
    let replyWasStreamed = false;

    for (let iteration = 0; iteration < this.MAX_TOOL_ITERATIONS && finalText === undefined; iteration++) {
      let llmResponse: LlmResponse;
      const llmStartedAt = Date.now();
      // Streaming state for THIS iteration only.
      //
      // CORRECTION (2026-09-15): this comment used to claim "a tool-calling decision never
      // streams any content first, so streamedThisIteration only ever ends up true for a
      // genuine final customer-facing reply" — confirmed LIVE that this is false. Qwen can and
      // sometimes does stream a few words of natural-language preamble before a response
      // resolves to a tool call (observed: 49 characters streamed and spoken, ~300ms before
      // the same iteration's tool_calls arrived). streamedThisIteration/partialContent can both
      // be non-empty on an iteration that still ends up calling a tool — see the
      // onToolPreambleSpoken call below, which exists specifically to handle that case rather
      // than assuming it can't happen.
      let streamedThisIteration = false;
      let firstTokenLoggedAt: number | null = null;
      let partialContent = '';
      const onDelta = (delta: string) => {
        if (firstTokenLoggedAt === null) {
          firstTokenLoggedAt = Date.now();
          this.auditService
            .log({
              requestId,
              actorType: AuditActorType.SYSTEM,
              action: 'latency.llm_first_token',
              entityType: 'conversation',
              entityId: conversationId,
              result: { durationMs: firstTokenLoggedAt - llmStartedAt, iteration },
              success: true,
            })
            .catch(() => {});
        }
        streamedThisIteration = true;
        partialContent += delta;
        onTextDelta?.(delta);
      };

      try {
        // VERBALIZATION INTEGRITY GUARD (2026-09-21): forced-tool turns never stream — see
        // containsLeakedReasoning's doc comment for the real-call failure this closes. Streaming
        // would dispatch audio for the FIRST sentence the instant it's complete, before there is
        // any complete response left to validate against the trusted data; by the time a bad
        // sentence could be detected, it may already be playing. These replies are short, single-
        // fact sentences by construction (the trusted-data block + VOICE_STYLE_DIRECTIVE both
        // already constrain them to that), so waiting for the complete response costs at most
        // the last sentence's own generation time — not a second full round trip.
        if (!useForcedToolPath && typeof this.llm.generateStream === 'function') {
          try {
            llmResponse = await this.llm.generateStream(messages, toolSchemas, onDelta, { label: 'main-response', maxTokens: MAIN_RESPONSE_MAX_TOKENS });
          } catch (streamError) {
            if (streamedThisIteration) {
              // Some of this iteration's text was ALREADY streamed to the customer (audio may
              // already be playing for it) — retrying with a fresh non-streaming call would
              // risk sending a second, different, contradictory reply on top of it. Use the
              // partial text as the best-effort reply instead of silently replacing it.
              this.logger.warn(
                `Qwen streaming failed mid-response (after partial output) — using the partial text rather than risking duplicate audio: ${streamError instanceof Error ? streamError.message : streamError}`,
              );
              llmResponse = { content: partialContent };
            } else {
              this.logger.warn(
                `Qwen streaming failed before producing any output — falling back to the non-streaming call for this turn: ${streamError instanceof Error ? streamError.message : streamError}`,
              );
              llmResponse = await this.llm.generate(messages, toolSchemas, { label: 'main-response', maxTokens: MAIN_RESPONSE_MAX_TOKENS });
            }
          }
        } else {
          llmResponse = await this.llm.generate(messages, toolSchemas, { label: useForcedToolPath ? 'main-response-forced-tool' : 'main-response', maxTokens: MAIN_RESPONSE_MAX_TOKENS });
        }
        if (useForcedToolPath && llmResponse.content && containsLeakedReasoning(llmResponse.content)) {
          this.logger.warn(
            `Forced-tool reply failed the verbalization-integrity check (leaked self-correction/reasoning) — replacing with a deterministic sentence built from trusted data: ${JSON.stringify(llmResponse.content)}`,
          );
          await this.auditService.log({
            requestId,
            actorType: AuditActorType.SYSTEM,
            action: 'tool_routing.verbalization_rejected',
            entityType: 'conversation',
            entityId: conversationId,
            result: { callId, rejectedContent: llmResponse.content },
            success: true,
          });
          llmResponse = { content: formatSafeAccountSentence(forcedToolResults, customerWroteArabic) };
        }
        await this.auditService.log({
          requestId,
          actorType: AuditActorType.SYSTEM,
          action: 'latency.llm',
          entityType: 'conversation',
          entityId: conversationId,
          // ...llmResponse.stats spread last (2026-09-14 latency investigation — see
          // LlmResponseStats's doc comment): Ollama's own load/prompt-eval/eval timings,
          // persisted on every call so a future contention spike is diagnosed from this table
          // instead of another ad-hoc reproduction.
          //
          // callId/requestType added (2026-09-17 diagnostic-only phase): requestType is derived
          // from THIS iteration's own outcome — 'tool-decision' when it resolved to tool_calls,
          // 'final-response' otherwise — since that's the actual distinction the phase asked
          // for (not just "iteration 0 vs 1", which breaks down on a turn with 2+ tool calls in
          // a row).
          result: {
            durationMs: Date.now() - llmStartedAt,
            iteration,
            streamed: streamedThisIteration,
            callId,
            requestType: llmResponse.toolCalls?.length ? 'tool-decision' : 'final-response',
            // DETERMINISTIC ACCOUNT-DATA TOOL ENFORCEMENT (2026-09-17 correctness pass): lets a
            // future query separate "Qwen correctly decided to call a tool on its own" from
            // "the backend forced it deterministically" from "no account-data tool was relevant
            // this turn at all" — see PRIMARY OBJECTIVE and the LATENCY DIAGNOSTICS requirement.
            toolRouting: {
              source: useForcedToolPath ? 'deterministic_policy' : 'model_decision',
              requiredTools: detectedTools,
              qwenRequestedTool: Boolean(llmResponse.toolCalls?.length),
              forced: useForcedToolPath,
            },
            ...llmResponse.stats,
          },
          success: true,
        });
      } catch (error) {
        await this.auditService.log({
          requestId,
          actorType: AuditActorType.SYSTEM,
          action: 'llm.error',
          entityType: 'conversation',
          entityId: conversationId,
          result: { error: error instanceof Error ? error.message : String(error) },
          success: false,
        });
        // Customer-facing fallback text — must follow the same language policy as every other
        // reply this turn (see the injected directive above), not default to English.
        finalText = customerWroteArabic
          ? 'أواجه حاليًا مشكلة في معالجة طلبك — هل ترغب في أن أحوّلك إلى أحد موظفي الدعم البشري؟'
          : "I'm having trouble processing that right now — would you like me to connect you with a human agent?";
        resultState = 'ESCALATING';
        break;
      }

      if (llmResponse.toolCalls && llmResponse.toolCalls.length > 0) {
        // BUG FIX (2026-09-15 — "heard something the transcript doesn't show"): this iteration
        // streamed some text via onDelta below (streamedThisIteration/partialContent) before
        // Qwen's response resolved to a tool call — that text has ALREADY been forwarded to
        // onTextDelta and, on the caller's side, already spoken. It's about to be discarded
        // from this method's own point of view (finalText never gets set from a tool-calling
        // iteration), but the caller still needs to know it happened so it can be reflected
        // wherever it keeps a transcript — see onToolPreambleSpoken's doc comment.
        if (streamedThisIteration && partialContent.trim()) {
          onToolPreambleSpoken?.(partialContent.trim());
        }
        await this.transition(conversationId, 'WAITING_FOR_TOOL', requestId, actor);
        for (const call of llmResponse.toolCalls) {
          await this.transition(conversationId, 'EXECUTING_ACTION', requestId, actor);
          let resultPayload: unknown;
          // AUDIT INSTRUMENTATION ONLY (2026-09-11 latency study — no behavior change): tool
          // execution time wasn't separately measurable before — only the LLM call durations
          // that bracket it (the tool-decision iteration and the iteration after) were logged.
          const toolStartedAt = Date.now();
          try {
            resultPayload = await this.toolRegistry.validateAndExecute(call.name, call.arguments, {
              requestId,
              actor,
              customerId,
              conversationId,
              allowedTools,
            });
          } catch (error) {
            resultPayload = { error: "That action couldn't be completed right now." };
          }
          await this.auditService
            .log({
              requestId,
              actorType: AuditActorType.SYSTEM,
              action: 'latency.tool_execution',
              entityType: 'conversation',
              entityId: conversationId,
              result: { durationMs: Date.now() - toolStartedAt, iteration, toolName: call.name },
              success: true,
            })
            .catch(() => {});

          messages.push({
            role: 'tool',
            name: call.name,
            toolCallId: call.id,
            content: JSON.stringify(resultPayload),
          });

          if (TERMINAL_TOOL_STATES[call.name]) {
            resultState = TERMINAL_TOOL_STATES[call.name]!;
          }
        }
        continue;
      }

      finalText =
        (llmResponse.content?.trim() && stripNameAttribution(llmResponse.content.trim())) ||
        (customerWroteArabic
          ? 'لست متأكدًا حاليًا من كيفية مساعدتك في ذلك — هل ترغب في التحدث مع أحد موظفي الدعم البشري؟'
          : "I'm not sure how to help with that yet — would you like to speak with a human agent?");
      // Only true when the FINAL text-generating iteration actually streamed something (see
      // streamedThisIteration's doc comment above) — a tool-calling iteration never sets this,
      // and neither does a turn that fell back to non-streaming generate() for its final reply.
      replyWasStreamed = streamedThisIteration && Boolean(llmResponse.content?.trim());
    }

    if (finalText === undefined) {
      finalText = customerWroteArabic
        ? 'دعني أحوّلك إلى أحد موظفي الدعم البشري الذين يمكنهم تقديم مزيد من المساعدة.'
        : 'Let me connect you with a human agent who can help further.';
      resultState = 'ESCALATING';
    }

    // Persisting the reply and returning to the caller no longer waits on classification (see
    // below) — addMessage only ever needed `finalText`, never the emotion/sentiment/urgency/
    // intent classification produces, so there was never an actual data dependency forcing
    // this to happen after that join; it was purely code ordering. 2026-09-14 latency
    // investigation: this join was real, measured customer-facing wait with nothing behind it
    // for the customer to see — moving it off the return path is a pure latency win with zero
    // change to what gets persisted or when.
    await this.conversations.addMessage(conversationId, 'AI', finalText);
    await this.transition(conversationId, resultState, requestId, actor);

    await this.auditService.log({
      requestId,
      actorType: AuditActorType.SYSTEM,
      action: 'latency.total_response',
      entityType: 'conversation',
      entityId: conversationId,
      result: { durationMs: Date.now() - startedAt },
      success: true,
    });

    // Transcript-based emotion/sentiment/urgency/intent classification — a SEPARATE, small,
    // tool-free Qwen call (kicked off back at the top of this method, in parallel with
    // everything above), not folded into the reply itself. An earlier attempt asked the main
    // reply to always be a JSON envelope ({"intent",...,"response"}) so one call could do
    // both — live testing showed that measurably hurt tool-calling reliability (more turns
    // exhausted MAX_TOOL_ITERATIONS) and, worse, occasionally produced malformed JSON that
    // would have shown broken syntax to the customer instead of a real reply. Keeping the
    // customer-facing reply generation completely unchanged and asking a second, narrowly-
    // scoped question of the same model never touches (or risks corrupting) what the customer
    // actually sees or hears — defensive parsing with a safe neutral/neutral/low default
    // whenever the model doesn't comply.
    //
    // BEHAVIOR CHANGE (2026-09-14, customer-approved): this used to be awaited HERE, before
    // the reply was persisted/returned — meaning classification was a genuine, real customer-
    // facing wait on top of the reply itself despite running "concurrently" from the start.
    // classifyMessage() never rejects (internal try/catch defaults to neutral/neutral/low), so
    // this fire-and-forget continuation is safe; setIntent was already fire-and-forget before
    // this change. The promise itself is now exposed via HandleMessageResult.classification for
    // callers that still want the real values once ready (see CallsService — it updates
    // not-yet-dispatched TTS chunks' tone in place, exactly as before, just no longer gating
    // the customer's actual reply on it).
    classificationPromise.then((classification) => {
      if (classification.intent) {
        this.conversations.setIntent(conversationId, classification.intent).catch(() => {});
      }
    });

    // Fire-and-forget: the escalation summary is for the human agent picking this up
    // later, not something the customer needs before hearing their own reply — an
    // extra sequential LLM call here would otherwise add a full turn's worth of real
    // inference latency onto every escalation, on top of the turn already taken above.
    if (resultState === 'ESCALATING') {
      this.generateEscalationSummary(conversationId, messages);
    }

    // Safe defaults, not the real classification — that's still in flight (see above). Callers
    // that need the eventual real values await/`.then()` the `classification` promise below;
    // callers that only display something immediately (e.g. a chat UI's tone badge) get a
    // harmless neutral default instead of blocking, same default classifyMessage itself already
    // falls back to on failure.
    return {
      reply: finalText,
      state: resultState,
      emotion: 'neutral',
      sentiment: 'neutral',
      urgency: 'low',
      replyWasStreamed,
      classification: classificationPromise,
    };
  }

  private generateEscalationSummary(conversationId: string, messages: Parameters<LlmProvider['summarize']>[0]): void {
    this.llm
      .summarize(messages)
      .then((summary) => this.conversations.saveSummary(conversationId, summary))
      .catch((error) => {
        this.logger.warn(`Failed to generate escalation summary: ${error instanceof Error ? error.message : error}`);
      });
  }

  /**
   * Transcript-based emotion/sentiment/urgency/intent classification (Qwen 3.5, same model
   * and provider as everything else — no other LLM is introduced). Deliberately NOT acoustic
   * emotion detection from the customer's voice; Cohere Transcribe Arabic only ever produces
   * text, and this classifies that text after the fact, same as it would for typed chat.
   * A single malformed/non-JSON reply here just means neutral/neutral/low get used — this
   * never touches or risks corrupting the customer-facing reply itself.
   */
  private async classifyMessage(customerText: string, conversationId: string, requestId?: string, callId?: string): Promise<ClassifiedMessage> {
    const prompt =
      'Classify the CUSTOMER message below from a payment/banking support conversation. Base ' +
      "the classification only on the customer's own words — do not invent emotion that isn't " +
      'actually there, and do not carry emotion over from earlier in the conversation once it ' +
      'no longer applies (e.g. a customer who was angry but is now thanking you should be ' +
      'classified as happy/relieved, not angry). If there is no clear evidence of anything but ' +
      'a normal, calm interaction, use "neutral" and "low".\n\n' +
      `Customer message: ${JSON.stringify(customerText)}\n\n` +
      'Reply with ONLY a JSON object, no other text: {"intent": "<short label, e.g. ' +
      'payment_failure, balance_inquiry, account_status>", "emotion": "<one of: neutral, ' +
      'happy, frustrated, angry, sad, worried, confused, anxious, relieved, excited>", ' +
      '"sentiment": "<one of: positive, neutral, negative>", "urgency": "<one of: low, ' +
      'medium, high, critical>"}';

    const classificationStartedAt = Date.now();
    try {
      // maxTokens: a real JSON classification reply is short — same fix, same reasoning, as
      // CallsService.pickSpokenLanguage's identically-shaped judge call (see
      // LlmGenerateOptions doc comment for the live incident this addresses).
      const response = await this.llm.generate([{ role: 'user', content: prompt }], [], { maxTokens: 300, label: 'classification' });
      // Persisted (2026-09-14 latency investigation), not just console-logged as before — see
      // LlmResponseStats's doc comment. Lets a future spike here be correlated against the same
      // turn's 'latency.llm' entry from a DB query instead of grepping live console output.
      await this.auditService
        .log({
          requestId,
          actorType: AuditActorType.SYSTEM,
          action: 'latency.classification',
          entityType: 'conversation',
          entityId: conversationId,
          result: { durationMs: Date.now() - classificationStartedAt, callId, requestType: 'classification', ...response.stats },
          success: true,
        })
        .catch(() => {});
      const parsed = parseClassification(response.content ?? '');
      if (parsed) return parsed;
    } catch (error) {
      this.logger.warn(`Emotion classification call failed: ${error instanceof Error ? error.message : error}`);
    }
    return { emotion: 'neutral', sentiment: 'neutral', urgency: 'low' };
  }

  private async transition(
    conversationId: string,
    state: ConversationState,
    requestId?: string,
    actor?: AuthPrincipal,
  ): Promise<void> {
    await this.conversations.updateState(conversationId, state);
    await this.auditService.log({
      requestId,
      actorType: actor?.type === 'customer' ? AuditActorType.CUSTOMER : actor ? AuditActorType.USER : AuditActorType.SYSTEM,
      actorId: actor?.sub,
      action: `conversation.state.${state}`,
      entityType: 'conversation',
      entityId: conversationId,
      success: true,
    });
  }
}

export interface ClassifiedMessage {
  emotion: CustomerEmotion;
  sentiment: Sentiment;
  urgency: Urgency;
  intent?: string;
}

/** Defensive JSON extraction for classifyMessage()'s dedicated call — this one never feeds
 *  the customer, so on any failure it's fine to just return null and let the caller default
 *  to neutral/neutral/low. */
function parseClassification(raw: string): ClassifiedMessage | null {
  const unfenced = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  const match = unfenced.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    return {
      emotion: isCustomerEmotion(parsed.emotion) ? parsed.emotion : 'neutral',
      sentiment: isSentiment(parsed.sentiment) ? parsed.sentiment : 'neutral',
      urgency: isUrgency(parsed.urgency) ? parsed.urgency : 'low',
      intent: typeof parsed.intent === 'string' && parsed.intent.trim() ? parsed.intent.trim() : undefined,
    };
  } catch {
    return null;
  }
}
