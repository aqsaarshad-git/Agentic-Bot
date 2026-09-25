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
import { InsufficientVerificationException } from '../tools/verification-level';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { VerificationService } from '../verification/verification.service';
import { TransfersService } from '../transfers/transfers.service';
import { StatementsService } from '../statements/statements.service';
import { PrismaService } from '../../database/prisma.service';
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
// DETERMINISTIC CONVERSATIONAL REPLY — greeting/thanks/closing/acknowledgement
// (2026-09-24, real-call latency fix)
// ============================================================================================
// CONFIRMED LIVE: a bare "Hello" or "Okay, thank you" — no banking content at all — was paying
// for a full real Qwen call (prompt-eval + first-token + streaming), the identical cost as a
// genuine open-ended banking question, for a reply that only ever needs to be one of a handful
// of fixed sentences. Same DO NOT OVERENGINEER philosophy, and the SAME safety mechanism, as
// DETERMINISTIC ACCOUNT-DATA TOOL ENFORCEMENT above (detectRequiredAccountTools): every pattern
// here is FULLY END-ANCHORED (^...$, reusing MAX_SHORT_REPLY_LENGTH's short-message cap the same
// way detectTransferReplyIntent already does) so this can only ever match a message that IS, in
// its entirety, a pleasantry — "Hello, what is my balance?" and "Thanks, can you also tell me my
// balance?" have real content after the pleasantry and so match NONE of these, falling through
// to the normal flow completely untouched (see this file's own unit tests for both directions).
// No LLM involved in the matching itself, and nothing here can ever intercept a message a
// pending-transfer/OTP check (forcedStateReply, checked first in the caller) already claimed —
// e.g. a bare "okay" confirming a pending transfer is resolved by that check first.
const GREETING_PATTERNS_EN = [
  /^(hello|hi|hey|hiya|howdy)[.!,\s]*$/i,
  /^good\s?(morning|afternoon|evening)[.!,\s]*$/i,
  /^as-?salamu?\s*(o\s+|wa\s+)?al[ae]ikum[.!,\s]*$/i,
  /^salam[.!,\s]*$/i,
];
const GREETING_PATTERNS_AR = [/^(السلام عليكم|مرحبا|مرحبًا|أهلا|اهلا|هلا|صباح الخير|مساء الخير)[.!,\s]*$/];

const THANKS_PATTERNS_AR = [/^(شكرا|شكراً|مشكور)[.!,\s]*$/];

const CLOSING_PATTERNS_EN = [
  /^(goodbye|bye(\s?bye)?|see\s?you(\s?later)?)[.!,\s]*$/i,
  /^that'?s all[,.\s]*(thanks?|thank\s?you)?[.!,\s]*$/i,
  /^no[,.\s]*thanks?[.!,\s]*$/i,
];
const CLOSING_PATTERNS_AR = [/^(مع السلامة|وداعا|وداعًا|إلى اللقاء)[.!,\s]*$/];

const ACK_PATTERNS_AR = [/^(تمام|طيب|أوكي|اوكي)[.!,\s]*$/];

// BUG FIX (2026-09-24, real PSTN call): the original rigid THANKS/ACK regexes required "okay"
// and "thanks" to be immediately adjacent — "Okay I got it. Thanks." has real filler ("I got
// it") in between and matched NEITHER, falling through to a full real Qwen call for something a
// human recognizes instantly as a plain acknowledgement. Rather than hand-enumerate every
// possible filler-word ordering (an unbounded, always-incomplete list), this instead treats the
// message as safe to answer deterministically only if EVERY word in it belongs to a small, fixed
// set of acknowledgement/filler words — any real content word (balance, transaction, card, what,
// when, ...) is never in this set and so immediately disqualifies the message, unchanged from
// before. This is strictly MORE conservative than a naive "contains thanks" substring check
// (which "thanks, also tell me my balance" would wrongly pass) while tolerating far more natural
// phrasing than the fixed-shape regex could.
//
// SAFETY NOTE: a bare "no" must NEVER be swallowed here — it's a real, meaningful answer to a
// genuine yes/no question (e.g. a pending confirmation) that just happens to also appear in "no
// thanks"/"no problem". "no" stays in the membership set (so those two phrases still pass the
// all-words check) but is deliberately EXCLUDED from ACK_TRIGGER_WORDS below, so it can only ever
// contribute a match alongside an actual "thanks" word, never on its own or paired with
// "problem" alone (also excluded, for the same reason — "no problem" answering "did you have an
// issue?" is real information, not small talk).
const ACKNOWLEDGEMENT_WORDS_EN = new Set([
  'ok', 'okay', 'alright', 'right', 'sure', 'got', 'it', 'no', 'problem', 'worries', 'worry',
  'great', 'perfect', 'cool', 'nice', 'awesome', 'thanks', 'thank', 'you', 'so', 'much', 'a',
  'lot', 'appreciate', 'appreciated', 'i',
]);
// Only these words are trusted to trigger a bare 'ack' (no "thanks" word present) — deliberately
// the smallest, least ambiguous subset of the membership set above.
const ACK_TRIGGER_WORDS_EN = new Set(['ok', 'okay', 'alright']);
// Looser than MAX_SHORT_REPLY_LENGTH (30, sized for the rigid greeting/closing patterns) — the
// bag-of-words check's safety comes from every word having to be a known filler word, not from
// message length, so a slightly longer all-filler phrase like "Alright, got it, thank you so
// much" (35 chars) is still safe to allow.
const MAX_ACKNOWLEDGEMENT_LENGTH = 60;

function normalizeToWords(content: string): string[] {
  return content
    .toLowerCase()
    .replace(/'/g, '') // contractions ("I've" -> "ive") collapse to one token rather than splitting oddly
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Returns 'thanks' or 'ack' if every word in `content` is a known acknowledgement/filler word
 *  (see ACKNOWLEDGEMENT_WORDS_EN's doc comment), else null. English only — Arabic keeps the
 *  fixed-phrase regex lists above, which already cover this file's real reported cases. */
function detectAcknowledgementBagOfWords(content: string): 'thanks' | 'ack' | null {
  const words = normalizeToWords(content);
  if (words.length === 0) return null;
  if (!words.every((w) => ACKNOWLEDGEMENT_WORDS_EN.has(w))) return null;
  if (words.some((w) => w === 'thanks' || w === 'thank')) return 'thanks';
  if (words.some((w) => ACK_TRIGGER_WORDS_EN.has(w))) return 'ack';
  return null;
}

export type ConversationalReplyKind = 'greeting' | 'thanks' | 'closing' | 'ack';

// Exported for direct unit testing — the false-negative direction ("Hello, what is my balance?"
// must NOT match) matters just as much as the true-positive direction here, given what this
// gates.
export function detectDeterministicConversationalReply(content: string, isArabic: boolean): ConversationalReplyKind | null {
  const trimmed = content.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_ACKNOWLEDGEMENT_LENGTH) return null;
  if ((isArabic ? GREETING_PATTERNS_AR : GREETING_PATTERNS_EN).some((p) => p.test(trimmed))) return 'greeting';
  if ((isArabic ? CLOSING_PATTERNS_AR : CLOSING_PATTERNS_EN).some((p) => p.test(trimmed))) return 'closing';
  if (isArabic) {
    if (trimmed.length > MAX_SHORT_REPLY_LENGTH) return null;
    if (THANKS_PATTERNS_AR.some((p) => p.test(trimmed))) return 'thanks';
    if (ACK_PATTERNS_AR.some((p) => p.test(trimmed))) return 'ack';
    return null;
  }
  return detectAcknowledgementBagOfWords(trimmed);
}

export function formatConversationalReply(kind: ConversationalReplyKind, isArabic: boolean): string {
  switch (kind) {
    case 'greeting':
      return isArabic ? 'مرحبًا! كيف يمكنني مساعدتك اليوم؟' : 'Hello! How can I help you today?';
    case 'thanks':
      return isArabic ? 'على الرحب والسعة! هل هناك شيء آخر يمكنني مساعدتك به؟' : "You're welcome! Is there anything else I can help you with?";
    case 'closing':
      return isArabic ? 'شكرًا لاتصالك بنا! أتمنى لك يومًا سعيدًا.' : 'Thank you for calling! Have a great day.';
    case 'ack':
      return isArabic ? 'تمام، أخبرني إذا احتجت أي شيء آخر.' : "Alright — let me know if you need anything else.";
  }
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

// ============================================================================================
// GENERAL-PATH POLICY-LEAK GUARD (2026-09-22, real-call fix)
// ============================================================================================
// CONFIRMED LIVE, real PSTN call: on "No, thanks," Qwen replied "No need to ask again. I'm done
// helping today and can end this call now if you confirm that's what you'd like. If the customer
// doesn't explicitly say they're done or want a different tool called, don't close unless there
// was an explicit signal earlier in the conversation (like 'thanks' confirming resolution)." The
// second sentence is Qwen narrating its OWN end_call decision policy in third person, verbatim
// bleeding into the spoken reply — the same failure family as SELF_CORRECTION_LEAK_PATTERN above,
// just on the free model-decision path, which that check never covers (useForcedToolPath only).
// Can't reuse that exact pattern here: it treats ANY parenthetical as a leak, safe only because a
// forced-tool reply is a fixed single-fact sentence with no legitimate reason to ever have one —
// a general chat/voice reply can legitimately contain a parenthetical aside. This is narrower and
// structural instead: a conditional clause built around "the customer" in the third person
// ("if the customer doesn't...", "unless there was an explicit signal...") — a customer-facing
// reply speaks TO the customer ("you"), never ABOUT "the customer" as a hypothetical third party.
// No deterministic trusted-data fallback exists for a free-form reply (unlike the forced-tool
// path), so the remedy is different too: strip the offending SENTENCE and keep the rest, rather
// than discarding or replacing the whole reply.
const POLICY_LEAK_PATTERN =
  /\bif the customer (doesn'?t|didn'?t|does not|did not)\b|\bunless there was an? explicit signal\b|\bunless (the customer|they) (explicitly|clearly)\b|\bdon'?t (close|end|proceed|confirm) unless\b/i;

// ============================================================================================
// GENERAL-PATH "PROMISED BUT NEVER CALLED" GUARD (2026-09-24, real-call fix)
// ============================================================================================
// CONFIRMED LIVE, real PSTN call: on a short customer reply ("Well, I guess not") that doesn't
// match detectRequiredAccountTools (so useForcedToolPath was false and the leaked-reasoning guard
// above never ran), Qwen's final-response reply was "Let me pull up your transaction history
// right away" with NO tool call at all (toolCalls empty, confirmed via the audit log's
// qwenRequestedTool: false and zero ToolExecution rows for the call) — the exact same "narrates
// the action instead of taking it" failure this file already guards against for verify_otp/
// confirm_transfer (see DETERMINISTIC CONVERSATIONAL-STATE-ACTION ENFORCEMENT above), just for
// account-data lookups on the free model-decision path instead of the forced one. The customer
// was left with a promise that was never followed up on for the rest of the call.
// Recovery reuses detectRequiredAccountTools against the REPLY'S OWN TEXT rather than the
// customer's message — the promise names exactly what it claims to be doing ("transaction
// history"), so the same trusted keyword matcher/tool-execution/formatSafeAccountSentence
// machinery the forced path already relies on applies here unchanged, just one step later and
// on different input text. If nothing matches (a promise about something other than the 3
// account-data tools), this deliberately leaves the reply alone rather than guessing.
const PROMISED_LOOKUP_PATTERN =
  /\b(let me |i'?ll |i will )(pull up|check|look into|look up|fetch|get|bring up|find out)\b.*\b(transaction|balance|account|history|cards?)/i;

// Exported for direct unit testing (orchestrator.service.spec.ts), same rationale as
// detectFabricatedFinancialClaim above — worth locking down against the real bug report in
// isolation from the tool-execution/recovery machinery around its one call site.
export function detectPromisedLookupWithoutToolCall(content: string): boolean {
  return PROMISED_LOOKUP_PATTERN.test(content);
}

const SENTENCE_SPLIT_RE = /(?<=[.!?؟])\s+/;

export function stripPolicyLeakSentences(text: string): string {
  const sentences = text.split(SENTENCE_SPLIT_RE).filter((s) => s.trim().length > 0);
  const kept = sentences.filter((s) => !POLICY_LEAK_PATTERN.test(s));
  if (kept.length === sentences.length) return text; // nothing stripped, avoid needless rejoin/whitespace drift
  return kept.join(' ').trim();
}

// ============================================================================================
// GENERAL-PATH LEAKED-TOOL-NAME GUARD (2026-09-24, real-call fix)
// ============================================================================================
// CONFIRMED LIVE, real PSTN call: asked about card status, Qwen's free-path reply ended with
// "...tell you its current state in one sentence as it reads from our records for this
// customer's account. (Then call get_cards)" — its own internal next-action note, spoken aloud
// as if it were part of the reply. Unlike POLICY_LEAK_PATTERN above (a specific, observed phrase
// shape), this doesn't try to match HOW a plan gets narrated — it matches WHAT no legitimate
// customer-facing sentence would ever contain: the literal snake_case name of a real tool this
// agent has. Exact membership check against the REAL allowed-tool list rather than a guessed
// regex, so it generalizes to any tool leaking this way, not just get_cards, with no plausible
// false positive (no genuine spoken sentence contains an identifier like "get_cards" or
// "confirm_transfer").
const TOOL_NAME_TOKEN_PATTERN = /\b[a-z]+(?:_[a-z]+)+\b/g;

export function stripLeakedToolNameSentences(text: string, knownToolNames: string[]): string {
  if (knownToolNames.length === 0) return text;
  const known = new Set(knownToolNames);
  const sentences = text.split(SENTENCE_SPLIT_RE).filter((s) => s.trim().length > 0);
  const kept = sentences.filter((s) => {
    const tokens = s.match(TOOL_NAME_TOKEN_PATTERN) ?? [];
    return !tokens.some((t) => known.has(t));
  });
  if (kept.length === sentences.length) return text;
  return kept.join(' ').trim();
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
export function formatSafeAccountSentence(results: Partial<Record<AccountDataTool, unknown>>, isArabic: boolean): string {
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
      // BUG FIX (2026-09-24, real-call correctness fix): this used to stop at a bare count
      // ("You also have 2 other recent transactions") with no way for the customer to ever get
      // the details — CONFIRMED LIVE: a customer asked "what are the other two transactions?
      // can you please give me details?" twice in a row and got the exact same count-only
      // sentence back both times, because detectRequiredAccountTools matches any message
      // containing "transaction(s)" and routes it straight back into this same deterministic
      // path — there was structurally no way to escalate to details. Every value the customer
      // actually gets is still read directly from the trusted tool result, same as `latest`
      // above — this doesn't reintroduce an LLM into the account-data path, it just finishes
      // describing the data this function was already handed.
      const restDescriptions = rest.map((tx) => {
        const txDate = formatDateSpoken(tx.date, isArabic);
        if (tx.status === 'FAILED') {
          return isArabic
            ? `${tx.amount} ${tx.currency} فشلت${tx.reason ? ` بسبب ${tx.reason}` : ''} بتاريخ ${txDate}`
            : `${tx.amount} ${tx.currency}, failed${tx.reason ? ` because of ${tx.reason}` : ''}, on ${txDate}`;
        }
        const statusWord = isArabic ? AR_STATUS_WORDS[tx.status] ?? tx.status : tx.status.toLowerCase();
        return isArabic ? `${tx.amount} ${tx.currency} (${statusWord}) بتاريخ ${txDate}` : `${tx.amount} ${tx.currency}, ${statusWord}, on ${txDate}`;
      });
      sentences.push(
        isArabic
          ? `لديك أيضاً ${rest.length} معاملة أخرى: ${restDescriptions.join('، ')}.`
          : `You also have ${rest.length} other recent transaction${rest.length > 1 ? 's' : ''}: ${restDescriptions.join('; ')}.`,
      );
    }
  }
  return sentences.join(' ') || (isArabic ? 'تم جلب بياناتك بنجاح.' : 'Your data was retrieved successfully.');
}

// ============================================================================================
// DETERMINISTIC CONVERSATIONAL-STATE-ACTION ENFORCEMENT (2026-09-21 reliability hardening pass)
// ============================================================================================
// Confirmed via a repeated-trial benchmark (scripts/banking-reliability-bench.ts, N=8): asked to
// submit a 6-digit verification code with a verification already in progress, Qwen skipped
// calling verify_otp entirely in 6/8 trials (narrating "I'm submitting your code..." with no
// tool call at all) and called the WRONG tool once — 13% success rate. Transfer confirmation
// scored 100% in the same isolated benchmark, but an earlier, longer live conversation surfaced
// the same class of failure there too (narrating "I will now complete the transfer" before
// actually calling confirm_transfer). Same fix as DETERMINISTIC ACCOUNT-DATA TOOL ENFORCEMENT
// above (detectRequiredAccountTools), applied to the two highest-stakes moments where a short
// customer reply is fully explained by DB state alone: a pending transfer exists and they just
// said yes/no, or a verification is mid-flight and they just gave a 6-digit number. Deliberately
// narrow and DB-gated, not just text-matched — this can never misfire on an unrelated "yes" or a
// coincidental 6-digit run of text, because it only ever fires when the matching pending state
// genuinely exists for THIS conversation. FULLY END-ANCHORED patterns (`^...$`, not a prefix
// regex) are deliberate — confirmed by this file's own unit tests that a prefix match
// ("^(yes|...)\b") is genuinely unsafe: it matched "yes but make it 700 instead please" (changes
// the request, must NOT be swallowed as a blind confirmation of the OLD amount) and "okay so how
// much do I have" (an unrelated question that merely happens to start with a filler word).
// Anchoring both ends means the ENTIRE (normalized) message must be one of a short, explicit list
// of known confirm/cancel phrasings, optionally with one trivial trailing clause baked directly
// into the same pattern — nothing is stripped generically. Anything else falls through to the
// normal model-decision path unchanged — missing a real confirmation here costs nothing (Qwen
// still handles it today), while a false-positive match would force an action the customer didn't
// actually just confirm.
const TRANSFER_CONFIRM_PATTERNS_EN = [
  /^yes[,.!\s]*(please|confirm(\s?it)?|go\s?ahead|do\s?it)?[.!]*$/i,
  /^(confirm(ed)?|go\s?ahead|do\s?it|proceed|sure|ok(ay)?)[.!]*$/i,
];
const TRANSFER_CANCEL_PATTERNS_EN = [
  /^no[,.!\s]*(please|cancel(\s?it)?|don'?t(\s?do\s?(it|that))?|stop)?[.!]*$/i,
  /^(cancel(\s?it)?|don'?t(\s?do\s?(it|that))?|stop|never\s?mind)[.!]*$/i,
];
const TRANSFER_CONFIRM_PATTERNS_AR = [/^نعم[.!؟\s]*$/, /^(أكد|تمام|اوكي|أوكي|ايوه)[.!؟\s]*$/];
const TRANSFER_CANCEL_PATTERNS_AR = [/^لا[.!؟\s]*$/, /^(إلغاء|كنسل)[.!؟\s]*$/];
const MAX_SHORT_REPLY_LENGTH = 30;

// Exported for direct unit testing (orchestrator.service.spec.ts) — pure, deterministic, and
// worth locking down in isolation given how easy a short-reply matcher is to subtly get wrong.
export function detectTransferReplyIntent(content: string, isArabic: boolean): 'confirm' | 'cancel' | null {
  const trimmed = content.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_SHORT_REPLY_LENGTH) return null;
  const normalized = trimmed.toLowerCase();
  const confirmPatterns = isArabic ? TRANSFER_CONFIRM_PATTERNS_AR : TRANSFER_CONFIRM_PATTERNS_EN;
  const cancelPatterns = isArabic ? TRANSFER_CANCEL_PATTERNS_AR : TRANSFER_CANCEL_PATTERNS_EN;
  if (confirmPatterns.some((p) => p.test(normalized))) return 'confirm';
  if (cancelPatterns.some((p) => p.test(normalized))) return 'cancel';
  return null;
}

// CONFIRMED LIVE (2026-09-22, statement-email delivery feature): reusing detectTransferReplyIntent
// as-is for the statement-email confirmation forcing missed a realistic phrasing — "yes, please
// send it" — because that detector's patterns are exact-anchored to bare "yes"/"confirm"/"go
// ahead" with no trailing verb, by design (kept intentionally narrow for TRANSFER confirmations,
// where broadening risks matching an unrelated "yes" that isn't about sending anything). Rather
// than loosen that carefully-tuned transfer-specific list (risking a regression there), this is a
// SEPARATE small pattern set for the "send/email it" phrasing a customer naturally uses to
// confirm DELIVERY specifically — same anchoring discipline (full-string match, short-message
// cap only), just a different, still narrow, vocabulary.
const SEND_CONFIRM_PATTERNS_EN = [
  /^yes[,.!\s]*(please)?[,.!\s]*(send|email)\s?it[.!]*$/i,
  /^(please\s+)?(send|email)\s?it[.!]*$/i,
  /^go\s?ahead\s+and\s+(send|email)\s?it[.!]*$/i,
];
const SEND_CONFIRM_PATTERNS_AR = [/^نعم[.!؟\s]*أرسل(ه)?[.!؟\s]*$/, /^أرسل(ه)?[.!؟\s]*$/];

export function detectSendConfirmIntent(content: string, isArabic: boolean): boolean {
  const trimmed = content.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_SHORT_REPLY_LENGTH) return false;
  const normalized = trimmed.toLowerCase();
  const patterns = isArabic ? SEND_CONFIRM_PATTERNS_AR : SEND_CONFIRM_PATTERNS_EN;
  return patterns.some((p) => p.test(normalized));
}

const MAX_OTP_MESSAGE_LENGTH = 60;

// CONFIRMED LIVE BUG (real PSTN call, 2026-09-22): a customer read a demo OTP aloud digit-by-
// digit ("It is zero zero zero zero zero zero.") — Cohere STT transcribed exactly that, as
// WORDS, never as the digit characters "000000". The plain \d{6} regex below never matched, so
// hasPendingCode's forced verify_otp path never fired despite a real pending VerificationSession,
// and the turn fell through to Qwen's own discretion — which fabricated "I have received your
// code and sent the new PIN to you" with zero tool call (confirmed against ToolExecution rows:
// verify_otp never ran, the session stayed VERIFICATION_IN_PROGRESS). This is the actual root
// cause of that fabrication, not a gap in the forcing logic itself. Word-boundary regex (`\b`) is
// deliberately NOT used for the Arabic map — `\b` in JS is defined relative to `\w`
// ([A-Za-z0-9_]), which Arabic letters are not part of, so `/\bصفر\b/` would never match Arabic
// text at all (no \w/\W transition ever occurs). Token-based matching sidesteps that pitfall.
const SPOKEN_DIGIT_WORDS_EN: Record<string, string> = {
  zero: '0', oh: '0', o: '0', one: '1', two: '2', three: '3', four: '4',
  five: '5', six: '6', seven: '7', eight: '8', nine: '9',
};
const SPOKEN_DIGIT_WORDS_AR: Record<string, string> = {
  'صفر': '0', 'واحد': '1', 'واحدة': '1', 'اثنان': '2', 'اثنين': '2',
  'ثلاثة': '3', 'ثلاث': '3', 'أربعة': '4', 'اربعة': '4', 'خمسة': '5', 'خمس': '5',
  'ستة': '6', 'ست': '6', 'سبعة': '7', 'سبع': '7', 'ثمانية': '8', 'ثمان': '8', 'تسعة': '9', 'تسع': '9',
};

/** Maps recognized digit-words to digit characters token-by-token, then collapses whitespace
 *  between two now-adjacent single-digit tokens so a spoken-out code ("zero zero zero...") reads
 *  the same as a typed one ("000000") before the 6-digit match below runs. A stray digit word far
 *  from any other digit word never merges with anything (nothing adjacent to collapse), so this
 *  can't manufacture a false 6-digit run out of unrelated text. */
function normalizeSpokenDigits(text: string, isArabic: boolean): string {
  const map = isArabic ? SPOKEN_DIGIT_WORDS_AR : SPOKEN_DIGIT_WORDS_EN;
  const tokens = text.split(/\s+/);
  const mapped = tokens.map((tok) => map[tok.toLowerCase().replace(/[.,!?؟]/g, '')] ?? tok);
  let result = mapped[0] ?? '';
  for (let i = 1; i < mapped.length; i++) {
    const bothSingleDigits = /^\d$/.test(mapped[i - 1]) && /^\d$/.test(mapped[i]);
    result += (bothSingleDigits ? '' : ' ') + mapped[i];
  }
  return result;
}

/** A bare or lightly-phrased 6-digit code ("123456", "the code is 123456"), typed OR spoken
 *  digit-by-digit ("zero zero zero zero zero zero", "صفر صفر صفر صفر صفر صفر") — capped at a
 *  short message length so an unrelated 6-digit run of digits buried in a longer message (an
 *  account number, an amount) is never mistaken for a code submission. */
export function extractOtpCode(content: string, isArabic = false): string | null {
  const trimmed = content.trim();
  if (trimmed.length > MAX_OTP_MESSAGE_LENGTH) return null;
  const normalized = normalizeSpokenDigits(trimmed, isArabic);
  const match = /\b(\d{6})\b/.exec(normalized);
  return match ? match[1] : null;
}

function formatTransferActionReply(toolName: 'confirm_transfer' | 'cancel_transfer', result: unknown, isArabic: boolean): string {
  const data = result as Record<string, unknown>;
  if (toolName === 'confirm_transfer') {
    const amount = data.amount as number;
    const currency = (data.currency as string) ?? 'SAR';
    const ref = data.transferReference as string;
    return isArabic
      ? `تم تنفيذ التحويل بنجاح. تم تحويل ${amount} ${currency}، رقم المرجع ${ref}.`
      : `Your transfer of ${amount} ${currency} has been completed. Reference: ${ref}.`;
  }
  const ref = data.transferReference as string | undefined;
  return isArabic
    ? `تم إلغاء التحويل${ref ? ` (المرجع ${ref})` : ''}.`
    : `Your transfer has been cancelled${ref ? ` (reference ${ref})` : ''}.`;
}

/** Every branch here maps a REAL TransfersService exception message to a safe, localized
 *  sentence — never passes a raw English exception message through into an Arabic reply, and
 *  never leaks anything beyond what the customer needs to know. */
function formatTransferActionFailureReply(error: unknown, isArabic: boolean): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/insufficient/i.test(message)) {
    return isArabic
      ? 'عذرًا، لا يوجد رصيد كافٍ لإتمام هذا التحويل الآن.'
      : "Sorry, there isn't enough available balance to complete this transfer right now.";
  }
  if (/expired/i.test(message)) {
    return isArabic
      ? 'انتهت صلاحية طلب التحويل. يرجى طلب تحويل جديد.'
      : 'That transfer request has expired — please ask again to start a new one.';
  }
  if (/no pending|already/i.test(message)) {
    return isArabic ? 'لا يوجد تحويل معلق حاليًا لتنفيذه.' : 'There is no pending transfer to act on right now.';
  }
  return isArabic
    ? 'تعذر إكمال العملية الآن. هل ترغب بالتحدث مع أحد الموظفين؟'
    : "I couldn't complete that just now — would you like to speak with a human agent?";
}

function formatVerifyOtpReply(isArabic: boolean): string {
  return isArabic ? 'تم تأكيد التحقق من هويتك بنجاح.' : 'Your identity has been verified successfully.';
}

function formatVerifyOtpFailureReply(error: unknown, isArabic: boolean): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/expired/i.test(message)) {
    return isArabic ? 'انتهت صلاحية الرمز. يرجى طلب رمز جديد.' : 'That verification code has expired — please ask for a new one.';
  }
  if (/invalid/i.test(message)) {
    return isArabic ? 'الرمز الذي أدخلته غير صحيح. يرجى المحاولة مرة أخرى.' : "That code doesn't match — please check it and try again.";
  }
  return isArabic
    ? 'تعذر التحقق الآن. هل ترغب بالتحدث مع أحد الموظفين؟'
    : "I couldn't verify that just now — would you like to speak with a human agent?";
}

// ============================================================================================
// GENERALIZED ZERO-ARGUMENT HIGH-RISK TOOL FORCING (2026-09-21, "first-ask" reliability pass)
// ============================================================================================
// Confirmed live: "I forgot my PIN, please reset it" sometimes produced ZERO tool calls and a
// fabricated "your PIN has been reset..." narrative — the exact failure category this whole
// forcing mechanism exists to close. Every tool below is genuinely zero-argument (or safely
// defaultable — see AccountsService/CardsService.resolveForCustomer), so — exactly like
// get_balance/get_account/get_transactions above — there is no argument-extraction risk that
// would justify leaving the decision to Qwen. This is a DATA TABLE (reusing the same
// force-and-skip-Qwen mechanism as the account-data block, not a new architecture), deliberately
// short and explicit rather than a general intent classifier — each entry is a small, disjoint
// set of phrasings for one specific tool.
interface ZeroArgForcedTool {
  toolName: string;
  patternsEn: RegExp[];
  patternsAr: RegExp[];
  formatReply: (result: unknown, isArabic: boolean) => string;
}

function formatCardIncidentReply(result: unknown, isArabic: boolean): string {
  const data = result as { card?: { cardNumberMasked?: string } };
  const masked = data.card?.cardNumberMasked ?? '';
  return isArabic
    ? `تم حظر بطاقتك${masked ? ` (${masked})` : ''} فورًا، وسيتم إصدار بطاقة بديلة لك.`
    : `Your card${masked ? ` (${masked})` : ''} has been blocked immediately, and a replacement has been requested.`;
}

function formatCardsStatusReply(result: unknown, isArabic: boolean): string {
  const data = result as { cards?: { cardNumberMasked: string; status: string }[] };
  const cards = data.cards ?? [];
  if (cards.length === 0) return isArabic ? 'لا توجد بطاقات مسجلة على حسابك.' : 'You have no cards on file.';
  return cards
    .map((c) => (isArabic ? `بطاقتك ${c.cardNumberMasked}: ${c.status}` : `Your card ${c.cardNumberMasked} is ${c.status.toLowerCase()}`))
    .join('. ') + '.';
}

function formatInitiateResetReply(kind: 'pin' | 'password', result: unknown, isArabic: boolean): string {
  const data = result as { expiresInMinutes?: number };
  const minutes = data.expiresInMinutes ?? 5;
  if (isArabic) {
    return kind === 'pin'
      ? `تم إرسال رمز التحقق لإعادة تعيين رقمك السري، وهو صالح لمدة ${minutes} دقائق — يرجى مشاركته معي لإتمام العملية.`
      : `تم إرسال رمز التحقق لإعادة تعيين كلمة المرور، وهو صالح لمدة ${minutes} دقائق — يرجى مشاركته معي لإتمام العملية.`;
  }
  return kind === 'pin'
    ? `I've sent a one-time code to reset your PIN — it expires in ${minutes} minutes. Please share it with me to continue.`
    : `I've sent a one-time code to reset your password — it expires in ${minutes} minutes. Please share it with me to continue.`;
}

function formatBeneficiariesReply(result: unknown, isArabic: boolean): string {
  const data = result as { beneficiaries?: { beneficiaryName: string }[] };
  const list = data.beneficiaries ?? [];
  if (list.length === 0) return isArabic ? 'لا يوجد لديك مستفيدون محفوظون حاليًا.' : "You don't have any saved beneficiaries yet.";
  const names = list.map((b) => b.beneficiaryName).join(isArabic ? '، ' : ', ');
  return isArabic ? `المستفيدون المحفوظون لديك: ${names}.` : `Your saved beneficiaries are: ${names}.`;
}

function formatCasesReply(result: unknown, isArabic: boolean): string {
  const data = result as { cases?: { caseId: string; status: string; category: string }[] };
  const [latest] = data.cases ?? [];
  if (!latest) return isArabic ? 'ليس لديك أي حالات أو شكاوى مسجلة حاليًا.' : "You don't have any support cases on file.";
  return isArabic
    ? `أحدث حالة لديك (${latest.caseId}) من نوع ${latest.category} وحالتها ${latest.status}.`
    : `Your most recent case (${latest.caseId}, ${latest.category}) is currently ${latest.status.toLowerCase()}.`;
}

/** Known-safe BadRequestException text (e.g. "this card is reported lost/stolen — request a
 *  replacement instead") from the tool handlers themselves passes through for English; anything
 *  else (or Arabic, since these messages aren't localized) falls back to a generic safe line. */
function formatGenericForcedFailureReply(error: unknown, isArabic: boolean): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!isArabic && /already|reported|cannot|no card|no account|not found/i.test(message)) {
    return message;
  }
  return isArabic
    ? 'تعذر إكمال هذا الطلب الآن. هل ترغب بالتحدث مع أحد الموظفين؟'
    : "I couldn't complete that just now — would you like to speak with a human agent?";
}

/** Mirrors formatTransferActionReply — built entirely from the REAL tool result, never from
 *  Qwen's own wording, and voice-concise per this feature's own "keep the response concise,
 *  don't read the statement contents" requirement. */
function formatStatementEmailReply(result: unknown, isArabic: boolean): string {
  const data = result as { success: boolean; alreadySent?: boolean; reason?: string };
  if (data.success && data.alreadySent) {
    return isArabic
      ? 'تم إرسال هذا الكشف بالفعل إلى بريدك الإلكتروني المسجل.'
      : "I've already sent that statement to your registered email address.";
  }
  if (data.success) {
    return isArabic
      ? 'تم إرسال كشف حسابك إلى بريدك الإلكتروني المسجل.'
      : 'Your bank statement has been sent to your registered email address.';
  }
  if (data.reason === 'NO_REGISTERED_EMAIL') {
    return isArabic
      ? 'لا يوجد بريد إلكتروني مسجل في حسابك، لذا لا يمكنني إرسال الكشف بهذه الطريقة حاليًا.'
      : "I don't have a registered email address on file for your account, so I can't send the statement that way right now.";
  }
  return isArabic
    ? 'تعذر إرسال كشف الحساب إلى بريدك الإلكتروني الآن. يرجى المحاولة مرة أخرى لاحقًا.'
    : "I wasn't able to send the statement to your registered email right now. Please try again later.";
}

function formatStatementEmailFailureReply(error: unknown, isArabic: boolean): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/no statement is ready/i.test(message)) {
    return isArabic
      ? 'ليس لدي كشف حساب جاهز حتى الآن — هل يمكنك تحديد الفترة التي تحتاجها؟'
      : "I don't have a statement ready to send yet — could you tell me which period you need?";
  }
  return isArabic
    ? 'تعذر إرسال كشف الحساب الآن. هل ترغب بالتحدث مع أحد الموظفين؟'
    : "I couldn't send the statement just now — would you like to speak with a human agent?";
}

const ZERO_ARG_FORCED_TOOLS: ZeroArgForcedTool[] = [
  {
    toolName: 'report_stolen_card',
    patternsEn: [/\bstolen\b/i, /someone (took|used|stole)/i],
    patternsAr: [/مسروق/, /سُرقت/, /سرقو/],
    formatReply: formatCardIncidentReply,
  },
  {
    toolName: 'report_lost_card',
    patternsEn: [/\blost\b[^.?!]*\bcard\b/i, /\bcard\b[^.?!]*\blost\b/i],
    patternsAr: [/ضيعت بطاقتي/, /فقدت بطاقتي/, /بطاقتي ضاعت/],
    formatReply: formatCardIncidentReply,
  },
  {
    toolName: 'get_cards',
    // BUG FIX (2026-09-24, real PSTN call): none of these matched "what's the status of my BANK
    // card?" — the inserted word "bank" broke the exact-adjacency `status\s+of\s+my\s+card`
    // pattern, same failure family as detectRequiredAccountTools' original "other transactions"
    // gap. Fell through to the free model-decision path twice in a row, which asked the customer
    // a nonsensical clarifying question ("how many cards do you think you have?") and then leaked
    // its own internal plan into the spoken reply ("...(Then call get_cards)") — see
    // stripLeakedToolNameSentences below for that half of the fix. `.{0,15}` tolerates a word or
    // two in between ("bank", "debit", "credit", ...) without matching an unrelated sentence that
    // happens to contain both words far apart.
    patternsEn: [
      /\bcard\b.{0,15}\b(status|details|info|information)\b/i,
      /\b(status|details|info|information)\b.{0,15}\bcard\b/i,
      /\bis\s+my\s+(\w+\s+)?card\s+(blocked|active|working)/i,
      /what.?s\s+wrong\s+with\s+my\s+(\w+\s+)?card/i,
    ],
    patternsAr: [/حالة.{0,10}بطاقتي/, /بطاقتي.{0,10}(معطلة|لا تعمل)/],
    formatReply: formatCardsStatusReply,
  },
  {
    toolName: 'initiate_pin_reset',
    patternsEn: [/forgot\s+(my\s+)?pin\b/i, /reset\s+my\s+pin\b/i, /change\s+my\s+pin\b/i],
    patternsAr: [/نسيت\s+الرقم\s+السري/, /نسيت\s+رقمي\s+السري/, /تغيير\s+الرقم\s+السري/],
    formatReply: (result, ar) => formatInitiateResetReply('pin', result, ar),
  },
  {
    toolName: 'initiate_password_reset',
    patternsEn: [/forgot\s+(my\s+)?password\b/i, /reset\s+my\s+password\b/i, /change\s+my\s+password\b/i],
    patternsAr: [/نسيت\s+كلمة\s+المرور/, /تغيير\s+كلمة\s+المرور/],
    formatReply: (result, ar) => formatInitiateResetReply('password', result, ar),
  },
  {
    toolName: 'get_beneficiaries',
    patternsEn: [/(show|list|see)\s+my\s+beneficiaries/i, /who\s+(can|do)\s+i\s+transfer\s+to/i],
    patternsAr: [/المستفيدين/, /قائمة\s+المستفيدين/],
    formatReply: formatBeneficiariesReply,
  },
  {
    toolName: 'get_customer_cases',
    patternsEn: [/status\s+of\s+my\s+(complaint|case|dispute)/i, /my\s+(previous\s+)?(complaint|case)s?\b/i],
    patternsAr: [/حالة\s+شكواي/, /قضيتي/],
    formatReply: formatCasesReply,
  },
];

// ============================================================================================
// ACTION-REQUIRED CATEGORY POST-CHECK (2026-09-21, same reliability pass)
// ============================================================================================
// For the handful of high-risk requests that genuinely need Qwen's own language understanding to
// extract free-form arguments (a transfer amount + beneficiary, which transaction a fraud report
// means, a new beneficiary's details) — full forcing above isn't possible without guessing at
// arguments. This is the backend's fallback guarantee for exactly those cases: detected via the
// SAME lightweight keyword matching as everything else here, checked AFTER Qwen's own turn
// completes (see the post-check further down in handleIncomingMessage) rather than replacing
// Qwen's decision outright — legitimate clarifying questions (which contain "?"/"؟") are left
// alone; a declarative reply with none of the category's tools actually called is treated as an
// undetected skip and replaced with a real clarification instead of trusted.
interface ActionRequiredCategory {
  name: string;
  patternsEn: RegExp[];
  patternsAr: RegExp[];
  requiredToolNames: string[];
  clarificationEn: string;
  clarificationAr: string;
}

const ACTION_REQUIRED_CATEGORIES: ActionRequiredCategory[] = [
  {
    name: 'transfer_creation',
    patternsEn: [/\btransfer\b[^.?!]*\bto\b/i, /\bsend\b\s+\d/i, /\bpay\b[^.?!]*\bto\b/i],
    patternsAr: [/حول/, /تحويل/, /ابعث/],
    requiredToolNames: ['create_transfer', 'get_beneficiaries'],
    clarificationEn: 'Could you confirm the exact amount and who you would like to transfer to?',
    clarificationAr: 'هل يمكنك تأكيد المبلغ الدقيق واسم الشخص الذي تريد التحويل إليه؟',
  },
  {
    name: 'fraud_report',
    patternsEn: [/don'?t recognize/i, /unauthorized/i, /report\s+fraud/i, /fraudulent/i],
    patternsAr: [/لا أعرف هذه المعاملة/, /عملية\s+احتيال/, /احتيال/],
    requiredToolNames: ['create_support_case', 'get_transactions', 'get_transaction'],
    clarificationEn: 'Which transaction are you referring to — can you tell me the date or amount so I can look it up?',
    clarificationAr: 'أي معاملة تقصد؟ يرجى تزويدي بالتاريخ أو المبلغ للتحقق منها.',
  },
  {
    name: 'add_beneficiary',
    patternsEn: [/add\s+(a\s+)?beneficiary/i, /add\s+.*\s+as\s+a\s+payee/i],
    patternsAr: [/إضافة\s+مستفيد/, /اضافة\s+مستفيد/],
    requiredToolNames: ['add_beneficiary'],
    clarificationEn: "What's the beneficiary's name and account number?",
    clarificationAr: 'ما اسم المستفيد ورقم حسابه؟',
  },
  {
    // CONFIRMED LIVE (2026-09-23, statement default-period feature): a genuine "I want my bank
    // statement" narrated "I'll create the request now" with no tool call at all this turn.
    // Statement requests were never covered by this safety net before (only transfer_creation/
    // fraud_report/add_beneficiary were) — same failure family, same fix. The clarification here
    // deliberately does NOT ask which period (that would defeat the whole point of the new
    // last-calendar-month default) — it's a plain yes/no nudge instead.
    name: 'statement_request',
    patternsEn: [/\bstatement\b/i],
    patternsAr: [/كشف\s*(حساب|الحساب)?/],
    requiredToolNames: ['request_statement'],
    clarificationEn: "I can prepare your statement for last month — would you like me to go ahead?",
    clarificationAr: 'يمكنني تجهيز كشف حسابك عن الشهر الماضي — هل ترغب أن أستمر؟',
  },
];

function detectActionRequiredCategory(content: string, isArabic: boolean): ActionRequiredCategory | null {
  for (const category of ACTION_REQUIRED_CATEGORIES) {
    const patterns = isArabic ? category.patternsAr : category.patternsEn;
    if (patterns.some((p) => p.test(content))) return category;
  }
  return null;
}

// ============================================================================================
// FABRICATED FINANCIAL-CLAIM GUARD (2026-09-22, real-call review)
// ============================================================================================
// CONFIRMED LIVE, real PSTN call: a customer proposed a transfer but never confirmed it (asked
// about their balance twice instead), then said a bare "Hello" — Qwen replied "I have updated
// your transaction history with the 500 SAR transfer to Ahmad and can confirm it has been
// processed," then on the NEXT bare "Hello" invented a specific wrong balance ("approximately
// 1930.57 SAR"). Checked against real DB/ToolExecution rows for that exact conversation: no
// Transfer row was EVER created (create_transfer never even ran), confirm_transfer never ran,
// get_balance was never called on either of those turns. Pure free-text fabrication, unconnected
// to any tool result — the existing ACTION_REQUIRED_CATEGORIES post-check above could not have
// caught this, since it's gated on the CURRENT message matching a category's own keyword
// patterns, and a bare "Hello" matches none of them.
//
// This is the same failure family as detectRequiredAccountTools/ACTION_REQUIRED_CATEGORIES
// (Qwen must never be trusted as the source of truth for a financial fact/action), applied to a
// different moment: not "did Qwen skip the right tool for THIS request" but "does Qwen's reply
// claim a mutating/definitive financial outcome that no tool actually produced THIS turn,
// regardless of what the request even was." Runs unconditionally on every model-decision-loop
// turn (see its call site) — deliberately broad wording, because it is fully gated on the
// relevant tool NOT having run this turn: a genuine, correct reply immediately following a real
// confirm_transfer/complete_pin_reset/get_balance call never reaches these checks at all (that
// tool name is already in toolsCalledThisTurn), so a broad pattern here only ever intercepts the
// unsafe case, never a legitimate one. Where a grounded correction is possible (balance), it is
// used instead of a flat refusal — the same "answer for real, don't just deflect" principle as
// the rest of this file.
// TIGHTENED (2026-09-22, same day, after a false-positive was caught by this file's own live
// regression script — see scripts/ regression runs in the review this implements): the first
// version matched a bare bag of single words ("completed", "executed", "updated"...) anywhere in
// the reply, independent of "transfer"/"balance"/"pin" also appearing anywhere. That fired on
// text that never claimed a completed action at all — "no other transaction will be executed
// UNLESS confirmed via confirm_transfer" (the OPPOSITE of a completion claim) and a reply that
// happened to mention an unrelated OLD transaction's real status ("TXN-9957 (completed, September
// 21)") alongside "Daily Transfer Limit" from a totally different part of the same multi-topic
// reply. Both real Qwen replies were legitimate; both were wrongly overridden. Fixed by requiring
// a genuine multi-word COMPLETION assertion ("has been processed", "sent you a new pin") rather
// than a single word that can describe anything — re-verified against both the real fabricated
// text from the original bug report (still matches) and these two false-positive texts (no
// longer match) before trusting this.
const TRANSFER_COMPLETION_CLAIM_EN = /\btransfer(red)?\b|\bpayment\b/i;
const TRANSFER_COMPLETION_VERBS_EN =
  /\b(has been (made|sent|processed|completed|executed|initiated|confirmed)|is now (complete|processed|initiated)|gone through|successfully (sent|transferred|processed|made|initiated|confirmed))\b/i;
const TRANSFER_COMPLETION_CLAIM_AR = /تحويل|حوّلت|حولت/;
const TRANSFER_COMPLETION_VERBS_AR = /(تم تنفيذ|تمت العملية|تم التحويل|تم إرسال|تم تحويل)/;

const RESET_COMPLETION_CLAIM_EN = /\bpin\b|\bpassword\b/i;
const RESET_COMPLETION_VERBS_EN = /\b(has been (reset|changed|updated)|sent (you|to you) (a |the )?new (pin|password))\b/i;
const RESET_COMPLETION_CLAIM_AR = /الرقم السري|كلمة المرور/;
const RESET_COMPLETION_VERBS_AR = /(تم تغيير|تم إعادة تعيين|تم إرسال)/;

const BALANCE_CHANGE_CLAIM_EN = /\bbalance\b/i;
const BALANCE_CHANGE_VERBS_EN = /\b(has been updated to reflect|now stands at|balance has changed|after (the |that )?deduction|stands at approximately)\b/i;
const BALANCE_CHANGE_CLAIM_AR = /رصيد/;
const BALANCE_CHANGE_VERBS_AR = /(بعد الخصم|انخفض)/;

// Statement delivery: SMS/text delivery is UNCONDITIONAL — no SMS integration exists at all
// (and none is planned for this phase), so ANY claim of having texted a document is always
// false, regardless of which tools ran. EMAIL delivery is different since send_statement_by_email
// was added (2026-09-22, statement-email delivery feature) — a genuine claim following a REAL
// successful send is not a fabrication, so that check is gated on tool success exactly like
// transfer/reset/balance above. Keeping these as two separate patterns (rather than the original
// combined one) is what makes that gating possible without also un-blocking the still-fake SMS
// case.
const STATEMENT_SMS_CLAIM_EN = /\b(i'?ve|i have)\s+(texted)\b.{0,30}\b(statement|pdf|document)\b|\b(statement|pdf|document)\b.{0,30}\b(texted to you|sent (it )?(to you )?(by|via) (sms|text))\b/i;
const STATEMENT_SMS_CLAIM_AR = /(أرسلت|ارسلت).{0,20}(كشف|البيان|الملف).{0,20}(رسالة نصية|واتساب)/;
const STATEMENT_EMAIL_CLAIM_EN = /\b(i'?ve|i have)\s+(emailed|e-?mailed)\b.{0,30}\b(statement|pdf|document)\b|\b(statement|pdf|document)\b.{0,30}\b(emailed|e-?mailed|sent (it )?(to you )?(by|via) email)\b/i;
const STATEMENT_EMAIL_CLAIM_AR = /(أرسلت|ارسلت).{0,20}(كشف|البيان|الملف).{0,20}(بريد)|(كشف|البيان).{0,20}(تم إرساله|أرسلناه)/;

type FabricatedClaim = 'transfer' | 'reset' | 'balance' | 'statement_sms_delivery' | 'statement_email_delivery' | 'transaction_summary';

// CONFIRMED LIVE, real PSTN call (2026-09-24): asked an unclear follow-up ("Okay, be like-"),
// Qwen re-summarized transaction data it had ALREADY stated correctly two turns earlier — but
// got the arithmetic and dates wrong: "completed transactions totaling 345.5 SAR from August
// 21st and September 1st" against a real 250 SAR (Aug 29th) + 45.5 SAR (Aug 21st) = 295.5 SAR
// (September 1st was the PENDING transaction's date, not a completed one's). A second turn then
// invented unwitnessed procedural detail ("scheduled for today... within today's operational
// hours") about that same pending transaction — nothing in the real data says that. Unlike the
// other claim types above, this isn't "claims an action happened that didn't" — it's Qwen freely
// re-deriving a TOTAL/summary from data already sitting in conversation history instead of
// treating the original tool result as the only source of truth, which PRIMARY OBJECTIVE (see
// formatSafeAccountSentence) exists specifically to prevent. Same detection shape as the other
// claims (topic+aggregation-verb proximity, gated on the tool NOT having been (re-)called this
// turn) rather than trying to parse and verify arbitrary arithmetic, which would be far more
// fragile than reusing the same proven pattern already used above.
const TRANSACTION_SUMMARY_CLAIM_EN = /\btransactions?\b|\bpayments?\b|\bpending\b/i;
const TRANSACTION_SUMMARY_VERBS_EN = /\btotal(?:ing|s|led)?\b|\bcombined\b|\baltogether\b|\bsumm(?:ed|ing)?\b|\bscheduled for (today|later)\b|\boperational hours\b/i;
const TRANSACTION_SUMMARY_CLAIM_AR = /معامل|عمليات|دفع|معلق/;
const TRANSACTION_SUMMARY_VERBS_AR = /إجمالي|مجموع|بمجموع/;

/** Every (0-based) start index where `pattern` matches in `text` — used by nearMatch below. */
function matchIndices(text: string, pattern: RegExp): number[] {
  const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  const indices: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = global.exec(text))) {
    indices.push(match.index);
    if (match[0].length === 0) global.lastIndex++;
  }
  return indices;
}

// PROXIMITY-BOUND MATCHING (2026-09-22, same day, third false positive caught by this file's own
// live regression run): checking "does the topic word appear ANYWHERE" and "does the completion
// phrase appear ANYWHERE" as two fully independent tests — even with a tight multi-word phrase
// list — still isn't enough. A real Qwen reply said "...code has been sent to your registered
// email address... proceed with your transfer request" — "has been sent" (about the OTP code)
// and "transfer" (about a future, unconfirmed request) are both genuinely present, just over 100
// characters apart and about two different things entirely. This requires the two to actually
// occur near each other — close enough to plausibly be the SAME clause — before treating it as
// one combined claim. Re-verified against every real case collected so far: the two confirmed
// real fabrications (topic and completion phrase sit within ~40-65 characters of each other, same
// clause — realistic phrasing inserts a recipient name/amount in between, so this needs headroom
// beyond the bare minimum) still match at this window; all three false positives caught during
// live testing (unrelated "has been sent" 100+ characters from an unrelated "transfer" mention,
// "will be executed" being the wrong tense entirely, and an old transaction's real "completed"
// status sitting in a different sentence) do not — the false-positive cases sit well outside this
// window, with real headroom to spare, not right at the boundary.
const CLAIM_PROXIMITY_WINDOW = 70;

// CONFIRMED LIVE (2026-09-23, statement default-period feature): asked for a statement with no
// registered-email lookup having run, Qwen's reply included "for example: jane.doe@example.com"
// — an entirely invented email address, unconnected to the real customer record. The reply also
// happened to end in a genuine question ("Would you like me to go ahead...?"), which is exactly
// why the ACTION_REQUIRED_CATEGORIES post-check's "contains a question mark = trust it" heuristic
// let it through — that heuristic is about whether Qwen is legitimately asking for missing info,
// not a general safety net for unrelated fabrications riding along in the same reply. Separate,
// narrow, and DB-grounded: any email-looking substring in the reply that ISN'T the customer's own
// real registered address (fetched fresh) is always wrong to say out loud, in any context, not
// just statements — there is no legitimate reason for a reply to ever state an email address
// other than the customer's own.
const EMAIL_LIKE_PATTERN = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;

/** Returns the fabricated email substring found in `text`, or null if none/all mentioned emails
 *  match the customer's real registered address (case-insensitive). Pure and unit-testable —
 *  the real address is looked up fresh at the call site, never guessed here. */
export function findFabricatedEmailMention(text: string, registeredEmail: string | null): string | null {
  const matches = text.match(EMAIL_LIKE_PATTERN);
  if (!matches) return null;
  const real = registeredEmail?.toLowerCase();
  const fake = matches.find((m) => m.toLowerCase() !== real);
  return fake ?? null;
}

function nearMatch(text: string, topicPattern: RegExp, verbPattern: RegExp): boolean {
  const topicIndices = matchIndices(text, topicPattern);
  if (topicIndices.length === 0) return false;
  const verbIndices = matchIndices(text, verbPattern);
  if (verbIndices.length === 0) return false;
  return topicIndices.some((t) => verbIndices.some((v) => Math.abs(t - v) <= CLAIM_PROXIMITY_WINDOW));
}

export function detectFabricatedFinancialClaim(finalText: string, toolsCalledThisTurn: string[], isArabic: boolean): FabricatedClaim | null {
  if (isArabic ? STATEMENT_SMS_CLAIM_AR.test(finalText) : STATEMENT_SMS_CLAIM_EN.test(finalText)) {
    return 'statement_sms_delivery';
  }
  const emailedSuccessfully = toolsCalledThisTurn.includes('send_statement_by_email');
  if (!emailedSuccessfully && (isArabic ? STATEMENT_EMAIL_CLAIM_AR.test(finalText) : STATEMENT_EMAIL_CLAIM_EN.test(finalText))) {
    return 'statement_email_delivery';
  }
  const confirmedTransfer = toolsCalledThisTurn.includes('confirm_transfer');
  if (!confirmedTransfer) {
    const topic = isArabic ? TRANSFER_COMPLETION_CLAIM_AR : TRANSFER_COMPLETION_CLAIM_EN;
    const verb = isArabic ? TRANSFER_COMPLETION_VERBS_AR : TRANSFER_COMPLETION_VERBS_EN;
    if (nearMatch(finalText, topic, verb)) return 'transfer';
  }
  const completedReset = toolsCalledThisTurn.includes('complete_pin_reset') || toolsCalledThisTurn.includes('complete_password_reset');
  if (!completedReset) {
    const topic = isArabic ? RESET_COMPLETION_CLAIM_AR : RESET_COMPLETION_CLAIM_EN;
    const verb = isArabic ? RESET_COMPLETION_VERBS_AR : RESET_COMPLETION_VERBS_EN;
    if (nearMatch(finalText, topic, verb)) return 'reset';
  }
  const calledBalance = toolsCalledThisTurn.includes('get_balance');
  if (!calledBalance) {
    const topic = isArabic ? BALANCE_CHANGE_CLAIM_AR : BALANCE_CHANGE_CLAIM_EN;
    const verb = isArabic ? BALANCE_CHANGE_VERBS_AR : BALANCE_CHANGE_VERBS_EN;
    if (nearMatch(finalText, topic, verb)) return 'balance';
  }
  const calledTransactions = toolsCalledThisTurn.includes('get_transactions');
  if (!calledTransactions) {
    const topic = isArabic ? TRANSACTION_SUMMARY_CLAIM_AR : TRANSACTION_SUMMARY_CLAIM_EN;
    const verb = isArabic ? TRANSACTION_SUMMARY_VERBS_AR : TRANSACTION_SUMMARY_VERBS_EN;
    if (nearMatch(finalText, topic, verb)) return 'transaction_summary';
  }
  return null;
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
    private readonly verification: VerificationService,
    private readonly transfers: TransfersService,
    private readonly statements: StatementsService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Fire-and-forget Qwen cache warm-up (2026-09-24, cold-start latency fix). CONFIRMED LIVE: a
   * brand new conversation's first real Qwen call was consistently costing ~3.6-4s of pure
   * prompt-eval (promptEvalCount ~7300, promptEvalDurationMs ~3600-4000 — see the
   * QwenConcurrencyGate stats persisted on 'latency.llm'), while every later turn in the SAME
   * conversation only cost ~600-660ms for a comparably-sized prompt. The reason: the system
   * instructions (~1000 tokens) plus the full tool schema list (~5300 tokens) are IDENTICAL on
   * every single call to a given agent — genuinely static, not conversation-specific — but
   * Ollama's KV cache starts empty for a brand new conversation, so the first call has to walk
   * that whole static prefix cold. Every later turn just extends an already-warm cache with a
   * small incremental suffix, which is why only turn one pays the full cost.
   *
   * This walks that same static prefix in the background the moment a call/conversation actually
   * starts — while the greeting is still playing, before the customer has even finished their
   * first sentence — so the expensive part happens hidden behind time that was passing anyway,
   * the same idea as the classification-ordering fix, applied to cache locality instead of to a
   * competing request. 'low' priority (see QwenConcurrencyGate — never contends with or delays a
   * real customer-facing call), maxTokens: 1 (only the PROMPT needs to be walked and cached; the
   * completion itself is thrown away), and this must never throw into or block its caller — a
   * failed prime just means the first real call pays the cost it always used to.
   */
  async primeQwenCache(aiAgentId: string | undefined | null, conversationId?: string, callId?: string): Promise<void> {
    if (!aiAgentId || typeof this.llm.generate !== 'function') return;
    const startedAt = Date.now();
    try {
      let allowedTools: string[] = [];
      let systemInstructions = DEFAULT_SYSTEM_INSTRUCTIONS;
      try {
        const { config } = await this.agentsService.getActiveConfig(aiAgentId);
        allowedTools = (config.allowedTools as string[]) ?? [];
        systemInstructions = config.systemInstructions;
      } catch {
        // No resolvable agent config — still worth priming the default instructions (also
        // static) rather than skipping entirely; a real call would fall back the same way.
      }
      const toolSchemas = this.toolRegistry.getSchemasFor(allowedTools);
      const messages = this.contextBuilder.build([], systemInstructions, []);
      const response = await this.llm.generate(messages, toolSchemas, { label: 'cache-prime', priority: 'low', maxTokens: 1 });
      // Persisted (not just console-logged), same rationale as every other Qwen call's stats —
      // lets this be verified/queried from real calls instead of grepping console output.
      await this.auditService
        .log({
          actorType: AuditActorType.SYSTEM,
          action: 'latency.cache_prime',
          entityType: 'conversation',
          entityId: conversationId ?? aiAgentId,
          result: { durationMs: Date.now() - startedAt, callId, aiAgentId, ...response.stats },
          success: true,
        })
        .catch(() => {});
    } catch (error) {
      this.logger.debug(`Qwen cache prime failed (non-fatal, purely a latency optimization): ${error instanceof Error ? error.message : error}`);
    }
  }

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
    // Not awaited here, and no longer awaited before the reply is persisted/returned either
    // (see below) — only its eventual RESULT is exposed, via HandleMessageResult.classification,
    // for callers that want to style not-yet-dispatched TTS chunks once it resolves (see
    // CallsService). Explicit customer-approved tradeoff (2026-09-14): several real seconds of
    // customer-facing wait must never be spent on tone-styling for the SAME turn.
    //
    // TRIED AND REVERTED (2026-09-23, classificationDelayMs experiment): delaying classification's
    // own Qwen call by a FIXED ~1.2s (still concurrent, just started later) was tested against 24
    // real turns to see if it would let the main reply's prompt-eval phase get a head start before
    // classification starts competing for the GPU. It measurably made things WORSE, not better:
    // avg time-to-first-audio rose from 3.61s to 5.13s, p90 from 6.6s to 12.7s — a blind fixed
    // delay doesn't know how long the main response will actually take, so it can't avoid piling
    // classification calls up faster than they drain under back-to-back turns.
    //
    // ROOT-CAUSED AND FIXED (2026-09-24, Qwen concurrency gate): the earlier "left AS-IS
    // deliberately" note above described a real, measured contention problem (concurrent
    // classification could evict the main response's cached prompt context mid-flight, costing
    // several real seconds) that a fixed delay couldn't safely fix. QwenProvider now serializes
    // every Qwen/Ollama request through QwenConcurrencyGate, with classification always queued at
    // 'low' priority behind the customer-facing main response — see qwen-concurrency-gate.ts.
    // That alone isn't quite enough, though: `classifyMessage()`'s own request has NO prior
    // `await` before it reaches the gate, while the main response path below still has several
    // (memory context, tool routing, message assembly) — so kicking classification off HERE, at
    // the top of this method, let it reach the gate's synchronous idle-grab first almost every
    // turn, regardless of the gate's own priority rules (priority only arbitrates between
    // requests that are ALREADY queued at the same instant; it can't retroactively bump someone
    // who already started). Confirmed live: real PSTN main-response calls were still measuring
    // ~2-3s of pure gate wait despite the gate itself working correctly (zero concurrent races).
    //
    // The fix is a plain resolved-signal, not a timer: classifyMessage() is only actually
    // DISPATCHED once `releaseClassification()` fires, which happens either (a) immediately, if
    // this turn resolves deterministically with no main Qwen call at all (nothing to race), or
    // (b) as the very first line of the model-decision loop below, i.e. on the same synchronous
    // tick as the main response's own `this.llm.generateStream()/generate()` call. Because calling
    // an async function runs its body synchronously up to its first `await` — which for both
    // calls is their own `gate.acquire()` — the main response's HIGH-priority request is always
    // registered with the gate before classification's continuation (scheduled as a microtask off
    // `mainResponseDispatched`) ever runs, so it never has an earlier claim to lose. This adds no
    // arbitrary wait of its own: classification starts as soon as the main call has been ISSUED,
    // not once it completes, and under the deterministic (no-LLM-call) path it's unaffected by
    // any of this.
    let releaseClassification!: () => void;
    const mainResponseDispatched = new Promise<void>((resolve) => {
      releaseClassification = resolve;
    });
    const classificationPromise = mainResponseDispatched.then(() =>
      this.classifyMessage(content, conversationId, requestId, callId),
    );
    // Same idea as classification above: this only needs customerId (already known from
    // params), not the conversation/agent-config lookups below, so there's no reason to make
    // it wait in line behind them — kicked off now, awaited only once actually needed.
    const memoryContextPromise = this.customerMemory.buildMemoryContext(customerId);
    // Computed fresh every turn from persisted VerificationSession rows — never cached on the
    // JWT, never inferred by the LLM. This is what makes minVerificationLevel enforcement in
    // ToolRegistryService a real backend-owned boundary rather than a prompt-level suggestion.
    const verificationLevel = await this.verification.computeLevel(customerId, conversationId);

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

    // DETERMINISTIC CONVERSATIONAL-STATE-ACTION ENFORCEMENT (see block above): runs BEFORE the
    // account-data check below, DB-gated so it only ever fires when the matching pending state
    // genuinely exists this conversation. When it fires, `forcedStateReply` short-circuits the
    // rest of this turn exactly like `useForcedToolPath` already does for account data (Qwen is
    // never invoked at all this turn) — see finalText's assignment further down.
    let forcedStateReply: string | undefined;
    let forcedStateToolCalled: string | undefined;
    if (allowedTools.includes('confirm_transfer') || allowedTools.includes('cancel_transfer')) {
      const pendingTransfer = await this.transfers.getActivePendingSummary(conversationId);
      if (pendingTransfer) {
        const intent = detectTransferReplyIntent(content, customerWroteArabic);
        const toolName = intent === 'confirm' ? 'confirm_transfer' : intent === 'cancel' ? 'cancel_transfer' : null;
        if (toolName && allowedTools.includes(toolName)) {
          try {
            const result = await this.toolRegistry.validateAndExecute(toolName, {}, {
              requestId,
              actor,
              customerId,
              conversationId,
              allowedTools,
              verificationLevel,
            });
            forcedStateReply = formatTransferActionReply(toolName, result, customerWroteArabic);
          } catch (error) {
            forcedStateReply = formatTransferActionFailureReply(error, customerWroteArabic);
          }
          forcedStateToolCalled = toolName;
        }
      }
    }
    if (forcedStateReply === undefined && allowedTools.includes('verify_otp')) {
      // Purpose-agnostic (see VerificationService.hasPendingCode's own doc comment) — a
      // PIN_RESET/PASSWORD_RESET-purpose session must gate this exactly the same as a general
      // IDENTITY one; missing that was a real, live-observed gap (Qwen's own discretion ran
      // instead and fabricated a fake "PIN reset completed" narrative with no tool call at all).
      const hasPendingCode = await this.verification.hasPendingCode(customerId, conversationId);
      if (hasPendingCode) {
        const code = extractOtpCode(content, customerWroteArabic);
        if (code) {
          try {
            const result = await this.toolRegistry.validateAndExecute('verify_otp', { code }, {
              requestId,
              actor,
              customerId,
              conversationId,
              allowedTools,
              verificationLevel,
            });
            void result;
            forcedStateReply = formatVerifyOtpReply(customerWroteArabic);
          } catch (error) {
            forcedStateReply = formatVerifyOtpFailureReply(error, customerWroteArabic);
          }
          forcedStateToolCalled = 'verify_otp';
        }
      }
    }
    // PENDING STATEMENT-EMAIL CONFIRMATION (2026-09-22, statement-email delivery feature) — same
    // pattern as the pending-transfer block above: a statement generated earlier THIS
    // conversation, not yet emailed, plus a short unambiguous affirmative reply, forces
    // send_statement_by_email deterministically (Qwen never decides whether to send). Checks
    // BOTH the bare "yes"/"confirm"/"go ahead" set (detectTransferReplyIntent, reused as-is) AND
    // the "send/email it" set (detectSendConfirmIntent, added specifically for this feature after
    // live testing showed "yes, please send it" — a very natural way to confirm THIS particular
    // action — isn't covered by the former). A short NEGATIVE reply intentionally falls through
    // unchanged (nothing needs to be "cancelled" — a generated, un-emailed statement is harmless
    // to just leave sitting there for later).
    if (forcedStateReply === undefined && allowedTools.includes('send_statement_by_email')) {
      const pendingStatement = await this.statements.getActivePendingEmail(customerId, conversationId);
      if (pendingStatement) {
        const intent = detectTransferReplyIntent(content, customerWroteArabic);
        const confirmed = intent === 'confirm' || detectSendConfirmIntent(content, customerWroteArabic);
        if (confirmed) {
          try {
            const result = await this.toolRegistry.validateAndExecute('send_statement_by_email', {}, {
              requestId,
              actor,
              customerId,
              conversationId,
              allowedTools,
              verificationLevel,
            });
            forcedStateReply = formatStatementEmailReply(result, customerWroteArabic);
          } catch (error) {
            forcedStateReply = formatStatementEmailFailureReply(error, customerWroteArabic);
          }
          forcedStateToolCalled = 'send_statement_by_email';
        }
      }
    }
    // GENERALIZED ZERO-ARGUMENT HIGH-RISK TOOL FORCING (see table above) — card status/incident,
    // PIN/password reset initiation, beneficiary/case listing. Stops at the first match since
    // these are disjoint intents for a single message.
    if (forcedStateReply === undefined) {
      for (const entry of ZERO_ARG_FORCED_TOOLS) {
        if (!allowedTools.includes(entry.toolName)) continue;
        const patterns = customerWroteArabic ? entry.patternsAr : entry.patternsEn;
        if (!patterns.some((p) => p.test(content))) continue;
        try {
          const result = await this.toolRegistry.validateAndExecute(entry.toolName, {}, {
            requestId,
            actor,
            customerId,
            conversationId,
            allowedTools,
            verificationLevel,
          });
          forcedStateReply = entry.formatReply(result, customerWroteArabic);
        } catch (error) {
          forcedStateReply = formatGenericForcedFailureReply(error, customerWroteArabic);
        }
        forcedStateToolCalled = entry.toolName;
        break;
      }
    }
    // ACTION-REQUIRED CATEGORY (see table above) — computed unconditionally (cheap, pure) so the
    // post-check after the model-decision loop further down knows what to watch for; has no
    // effect on its own until then.
    const actionRequiredCategory = detectActionRequiredCategory(content, customerWroteArabic);

    // DETERMINISTIC ACCOUNT-DATA TOOL ENFORCEMENT (see block above): matched purely off the
    // customer's own text, filtered to tools this agent config actually allows — an agent
    // without get_balance in its allowlist must still fall through to the normal model-decision
    // path below rather than forcing a call ToolRegistryService would reject anyway. Skipped
    // entirely once a conversational-state action has already been forced above — there's
    // nothing left for this turn to answer.
    const detectedTools =
      forcedStateReply !== undefined ? [] : detectRequiredAccountTools(content, customerWroteArabic).filter((t) => allowedTools.includes(t));
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
            verificationLevel,
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

    // Belt-and-suspenders reminder alongside the structural guarantee that actually matters
    // (confirm_transfer can only ever act on a live PENDING_CONFIRMATION row for THIS
    // conversation — see TransfersService). This just steers Qwen away from firing it on an
    // ambiguous/unrelated "yes" when a proposal genuinely is still open.
    const pendingTransfer = await this.transfers.getActivePendingSummary(conversationId);
    if (pendingTransfer) {
      extraContext.push(
        `A transfer of ${pendingTransfer.amount} ${pendingTransfer.currency} (reference ${pendingTransfer.transferReference}) ` +
          'is currently awaiting the customer\'s confirmation. Only call confirm_transfer when the customer\'s ' +
          'CURRENT message is an explicit, unambiguous yes/confirmation directly replying to that proposal — if ' +
          "it's ambiguous or clearly about something else, ask them to confirm explicitly instead of calling the tool.",
      );
    }

    // Empty when useForcedToolPath: the required tool(s) already ran above with a trusted
    // result already injected into extraContext — offering Qwen tool schemas here would only
    // give it a chance to call one again (extra latency) or call something else instead of
    // answering (see PRESERVE TOOL-CALL LATENCY / DO NOT LET QWEN'S DECISION OVERRIDE BUSINESS
    // RULES). The loop below still runs exactly once in this case: with no tools to call,
    // iteration 0's response always has content, never toolCalls, so the loop's own
    // `finalText === undefined` condition ends it immediately — no separate code path needed.
    const toolSchemas = useForcedToolPath || forcedStateReply !== undefined ? [] : this.toolRegistry.getSchemasFor(allowedTools);
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
        // BUG FIX (2026-09-21, banking-domain live test): confirmed live — after offering to
        // start verification and the customer replying "yes", Qwen replied "I've sent you a
        // one-time code via SMS and email" WITHOUT calling start_verification at all (zero tool
        // calls that turn) — a pure hallucination of an action that never happened, exactly the
        // failure category this whole domain must never allow (never claim a code was sent, a
        // card blocked/replaced, a PIN/password reset, a case opened, or a transfer completed
        // unless the matching tool was actually called THIS turn). Same "attach to the last
        // message" technique as the language/account-scope directives above, since this is the
        // same class of momentum problem: the model treats a plain "yes" as needing only a
        // textual acknowledgment rather than as the cue to actually invoke the tool now.
        '[Never tell the customer that something has happened, is happening, or will happen as a result of ' +
        'this reply (a code sent, a card blocked/unblocked/replaced, a PIN or password reset, a support case ' +
        'created, a transfer completed, a beneficiary added/removed) unless you call the matching tool IN ' +
        'THIS SAME RESPONSE and are reporting its real result. If the customer\'s message is agreeing to or ' +
        'confirming something you previously offered to do, that means you must call the tool now — a plain ' +
        'acknowledgement sentence with no tool call is never an acceptable reply to a yes/confirmation.] ' +
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
    // Checked only once neither a pending-transfer/OTP action NOR a real account-data request
    // matched — a message that's genuinely just a pleasantry can't be either of those anyway
    // (both are end-anchored themselves), but this keeps the priority explicit rather than
    // relying on that.
    const conversationalReplyKind =
      forcedStateReply === undefined && detectedTools.length === 0
        ? detectDeterministicConversationalReply(content, customerWroteArabic)
        : null;
    let finalText: string | undefined = forcedStateReply !== undefined
      ? forcedStateReply
      : useForcedToolPath
        ? formatSafeAccountSentence(forcedToolResults, customerWroteArabic)
        : conversationalReplyKind
          ? formatConversationalReply(conversationalReplyKind, customerWroteArabic)
          : detectedTools.length === 0 && isAmbiguousAccountQuery(content, customerWroteArabic)
            ? customerWroteArabic
              ? AMBIGUOUS_ACCOUNT_CLARIFICATION_AR
              : AMBIGUOUS_ACCOUNT_CLARIFICATION_EN
            : undefined;
    if (forcedStateReply !== undefined) {
      await this.auditService.log({
        requestId,
        actorType: AuditActorType.SYSTEM,
        action: 'tool_routing.forced_state_response',
        entityType: 'conversation',
        entityId: conversationId,
        result: { callId, tool: forcedStateToolCalled, finalText, finalLanguage: customerWroteArabic ? 'ar' : 'en', source: 'deterministic_policy' },
        success: true,
      });
    } else if (useForcedToolPath) {
      await this.auditService.log({
        requestId,
        actorType: AuditActorType.SYSTEM,
        action: 'tool_routing.deterministic_response',
        entityType: 'conversation',
        entityId: conversationId,
        result: { callId, requiredTools: detectedTools, finalText, finalLanguage: customerWroteArabic ? 'ar' : 'en' },
        success: true,
      });
    } else if (conversationalReplyKind) {
      await this.auditService.log({
        requestId,
        actorType: AuditActorType.SYSTEM,
        action: 'tool_routing.deterministic_conversational_reply',
        entityType: 'conversation',
        entityId: conversationId,
        result: { callId, kind: conversationalReplyKind, content, finalText, finalLanguage: customerWroteArabic ? 'ar' : 'en' },
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
    // ACTION-REQUIRED POST-CHECK (see block above): captured before the loop, since finalText
    // being already defined here means a deterministic path (forced-state/forced-tool/ambiguous)
    // already resolved this turn — the loop below won't even run, and the post-check further
    // down must not second-guess an already-trusted deterministic reply.
    const enteredModelDecisionLoop = finalText === undefined;
    if (!enteredModelDecisionLoop) {
      // Deterministic path already resolved this turn — no main Qwen call is coming, so there's
      // nothing left for classification to lose a race against. Let it go immediately.
      releaseClassification();
    }
    const toolsCalledThisTurn: string[] = [];
    // CONFIRMED LIVE BUG (2026-09-22, same review): Qwen called confirm_transfer with no pending
    // transfer to act on — the tool correctly THREW (no Transfer row exists) — yet Qwen's reply
    // still said "Your transfer... has been successfully initiated and confirmed," twice in a
    // row, on two separate turns. toolsCalledThisTurn only recorded that confirm_transfer was
    // ATTEMPTED, not whether it actually succeeded, so both the existing ACTION_REQUIRED_
    // CATEGORIES check and the new fabricated-claim guard below would have wrongly treated a
    // FAILED call the same as a real one and trusted the reply. This tracks successes only,
    // separately, and both checks below gate on this list instead.
    const toolsSucceededThisTurn: string[] = [];

    for (let iteration = 0; iteration < this.MAX_TOOL_ITERATIONS && finalText === undefined; iteration++) {
      // Idempotent past iteration 0 (resolving an already-resolved promise is a no-op) — must run
      // BEFORE the main Qwen call below, on the same synchronous tick, so that call's gate.acquire()
      // is always registered first. See mainResponseDispatched's doc comment above for why.
      releaseClassification();
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
        if (!llmResponse.toolCalls?.length && llmResponse.content && detectPromisedLookupWithoutToolCall(llmResponse.content)) {
          const impliedTools = detectRequiredAccountTools(llmResponse.content, customerWroteArabic).filter((t) => allowedTools.includes(t));
          if (impliedTools.length > 0) {
            this.logger.warn(
              `Reply promised to fetch data but called no tool — recovering deterministically (${impliedTools.join(', ')}): ${JSON.stringify(llmResponse.content)}`,
            );
            const recoveredResults: Partial<Record<AccountDataTool, unknown>> = {};
            for (const toolName of impliedTools) {
              try {
                recoveredResults[toolName] = await this.toolRegistry.validateAndExecute(toolName, {}, {
                  requestId,
                  actor,
                  customerId,
                  conversationId,
                  allowedTools,
                  verificationLevel,
                });
              } catch (error) {
                this.logger.warn(
                  `Promised-lookup recovery: call to ${toolName} failed too, leaving the original reply in place: ${error instanceof Error ? error.message : error}`,
                );
              }
            }
            if (Object.keys(recoveredResults).length > 0) {
              await this.auditService.log({
                requestId,
                actorType: AuditActorType.SYSTEM,
                action: 'tool_routing.promised_lookup_recovered',
                entityType: 'conversation',
                entityId: conversationId,
                result: { callId, impliedTools, executedTools: Object.keys(recoveredResults), rejectedContent: llmResponse.content },
                success: true,
              });
              llmResponse = { content: formatSafeAccountSentence(recoveredResults, customerWroteArabic) };
            }
          } else if (allowedTools.includes('get_cards') && /\bcards?\b/i.test(llmResponse.content)) {
            // detectRequiredAccountTools only knows balance/account/transactions — cards have
            // their own separate deterministic table (ZERO_ARG_FORCED_TOOLS/formatCardsStatusReply
            // above), so this promise's implied tool has to be resolved and formatted separately
            // rather than through formatSafeAccountSentence, which doesn't know about cards either.
            this.logger.warn(`Reply promised to fetch card data but called no tool — recovering deterministically: ${JSON.stringify(llmResponse.content)}`);
            try {
              const result = await this.toolRegistry.validateAndExecute('get_cards', {}, {
                requestId,
                actor,
                customerId,
                conversationId,
                allowedTools,
                verificationLevel,
              });
              await this.auditService.log({
                requestId,
                actorType: AuditActorType.SYSTEM,
                action: 'tool_routing.promised_lookup_recovered',
                entityType: 'conversation',
                entityId: conversationId,
                result: { callId, impliedTools: ['get_cards'], executedTools: ['get_cards'], rejectedContent: llmResponse.content },
                success: true,
              });
              llmResponse = { content: formatCardsStatusReply(result, customerWroteArabic) };
            } catch (error) {
              this.logger.warn(`Promised-lookup recovery: call to get_cards failed too, leaving the original reply in place: ${error instanceof Error ? error.message : error}`);
            }
          }
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
          toolsCalledThisTurn.push(call.name);
          await this.transition(conversationId, 'EXECUTING_ACTION', requestId, actor);
          let resultPayload: unknown;
          // AUDIT INSTRUMENTATION ONLY (2026-09-11 latency study — no behavior change): tool
          // execution time wasn't separately measurable before — only the LLM call durations
          // that bracket it (the tool-decision iteration and the iteration after) were logged.
          const toolStartedAt = Date.now();
          try {
            // Recomputed fresh for EVERY tool call in this loop, not reused from the turn-start
            // snapshot above: confirmed live — a customer submitting an OTP code and asking for
            // a VERIFIED-tier action in the SAME message (e.g. "the code is 123456, now reset
            // my PIN") calls verify_otp then the sensitive tool within the same iteration loop;
            // the stale turn-start level would have wrongly rejected the second call as
            // unverified even though verification had already just succeeded moments earlier in
            // this very turn.
            const currentVerificationLevel = await this.verification.computeLevel(customerId, conversationId);
            resultPayload = await this.toolRegistry.validateAndExecute(call.name, call.arguments, {
              requestId,
              actor,
              customerId,
              conversationId,
              allowedTools,
              verificationLevel: currentVerificationLevel,
            });
            toolsSucceededThisTurn.push(call.name);
          } catch (error) {
            // Backend-owned authorization boundary (see VerificationLevel/minVerificationLevel):
            // Qwen requested a tool it isn't currently allowed to run — never silently ignored,
            // and never a raw exception either. Telling Qwen WHY lets it offer start_verification
            // instead of dead-ending the conversation with a generic failure.
            resultPayload =
              error instanceof InsufficientVerificationException
                ? {
                    error: 'VERIFICATION_REQUIRED',
                    message:
                      'This action requires the customer to verify their identity first. Offer to start ' +
                      'verification (start_verification) before retrying this action.',
                  }
                : { error: "That action couldn't be completed right now." };
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
        (llmResponse.content?.trim() &&
          stripLeakedToolNameSentences(stripPolicyLeakSentences(stripNameAttribution(llmResponse.content.trim())), allowedTools)) ||
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

    // ACTION-REQUIRED POST-CHECK (2026-09-21, "first-ask" reliability pass): for a small set of
    // high-risk categories that genuinely need Qwen's own NLU to extract free-form arguments
    // (a transfer amount + beneficiary name, which transaction a fraud report refers to, a new
    // beneficiary's details) — so they can't be fully forced like the zero-argument tools above
    // — this is the backend's last check before trusting Qwen's text: if the customer's message
    // matched one of these categories, NONE of that category's required tools were actually
    // called this turn, AND the reply doesn't read as a genuine clarifying question (no "?"/"؟"),
    // it is treated as an undetected skip (the exact "narrate a fabricated completion" failure
    // this whole pass exists to close) and replaced with a real, deterministic clarification —
    // never silently trusted. A message that legitimately needed no tool (a genuine clarifying
    // question Qwen asked on its own) is unaffected, since it already contains a question mark.
    if (enteredModelDecisionLoop && actionRequiredCategory) {
      const requiredToolCalled = toolsSucceededThisTurn.some((t) => actionRequiredCategory!.requiredToolNames.includes(t));
      const readsLikeAQuestion = /[?؟]/.test(finalText);
      if (!requiredToolCalled && !readsLikeAQuestion) {
        await this.auditService.log({
          requestId,
          actorType: AuditActorType.SYSTEM,
          action: 'tool_routing.action_required_skip_detected',
          entityType: 'conversation',
          entityId: conversationId,
          result: { callId, category: actionRequiredCategory.name, rejectedReply: finalText, toolsCalledThisTurn },
          success: false,
        });
        finalText = customerWroteArabic ? actionRequiredCategory.clarificationAr : actionRequiredCategory.clarificationEn;
      }
    }

    // FABRICATED EMAIL-ADDRESS GUARD (see findFabricatedEmailMention's doc comment above):
    // unconditional, and deliberately NOT skipped just because the reply also contains a
    // question mark — unlike the ACTION-REQUIRED check above, a legitimate clarifying question
    // is not what this is protecting against; a fabricated email riding along in an otherwise
    // fine reply is a completely separate problem the "is this a real question" heuristic was
    // never meant to catch.
    if (enteredModelDecisionLoop) {
      const customerRecord = await this.prisma.customer.findUnique({ where: { id: customerId }, select: { email: true } });
      const fakeEmail = findFabricatedEmailMention(finalText, customerRecord?.email ?? null);
      if (fakeEmail) {
        await this.auditService.log({
          requestId,
          actorType: AuditActorType.SYSTEM,
          action: 'tool_routing.fabricated_email_blocked',
          entityType: 'conversation',
          entityId: conversationId,
          result: { callId, fakeEmail, rejectedReply: finalText },
          success: false,
        });
        finalText = customerWroteArabic
          ? 'يمكنني إرسال ذلك إلى بريدك الإلكتروني المسجل لدينا. هل ترغب أن أستمر؟'
          : "I can send that to your registered email address on file — would you like me to go ahead?";
      }
    }

    // FABRICATED FINANCIAL-CLAIM GUARD (see detectFabricatedFinancialClaim's doc comment above):
    // unconditional on every model-decision-loop turn, not gated by actionRequiredCategory — the
    // real bug this closes ("Hello" narrating a transfer that was never proposed, then inventing
    // a wrong balance) matched none of ACTION_REQUIRED_CATEGORIES's own keyword patterns, so that
    // check could never have caught it.
    if (enteredModelDecisionLoop) {
      const claim = detectFabricatedFinancialClaim(finalText, toolsSucceededThisTurn, customerWroteArabic);
      if (claim) {
        const rejectedReply = finalText;
        if (claim === 'transfer') {
          const pendingTransfer = await this.transfers.getActivePendingSummary(conversationId);
          finalText = pendingTransfer
            ? customerWroteArabic
              ? `لم يتم تأكيد التحويل بعد بقيمة ${pendingTransfer.amount} ${pendingTransfer.currency}. هل ترغب في المتابعة؟`
              : `Your transfer of ${pendingTransfer.amount} ${pendingTransfer.currency} hasn't been confirmed yet — would you like me to proceed?`
            : customerWroteArabic
              ? 'لم يتم إجراء أي تحويل حتى الآن. هل ترغب في إعداد تحويل؟'
              : "I haven't actually started a transfer — would you like me to set one up?";
        } else if (claim === 'reset') {
          finalText = customerWroteArabic
            ? 'لم يتم إكمال ذلك بعد — هل يمكنك تزويدي برمز التحقق الذي استلمته؟'
            : "That hasn't been completed yet — could you share the verification code you received?";
        } else if (claim === 'balance' && allowedTools.includes('get_balance')) {
          try {
            const freshLevel = await this.verification.computeLevel(customerId, conversationId);
            const result = await this.toolRegistry.validateAndExecute('get_balance', {}, {
              requestId,
              actor,
              customerId,
              conversationId,
              allowedTools,
              verificationLevel: freshLevel,
            });
            toolsSucceededThisTurn.push('get_balance');
            finalText = formatSafeAccountSentence({ get_balance: result }, customerWroteArabic);
          } catch {
            finalText = customerWroteArabic ? 'دعني أتحقق من ذلك مرة أخرى.' : 'Let me check that for you again.';
          }
        } else if (claim === 'balance') {
          finalText = customerWroteArabic ? 'دعني أتحقق من ذلك مرة أخرى.' : 'Let me check that for you again.';
        } else if (claim === 'statement_sms_delivery') {
          // SMS is genuinely never implemented (unlike email) — this stays a flat, permanent
          // deflection rather than a "try again" style reply.
          finalText = customerWroteArabic
            ? 'لا يمكنني إرسال كشف الحساب عبر الرسائل النصية، لكن يمكنني إرساله إلى بريدك الإلكتروني المسجل إذا رغبت.'
            : "I can't send the statement by text message, but I can email it to your registered address if you'd like.";
        } else if (claim === 'transaction_summary' && allowedTools.includes('get_transactions')) {
          try {
            const result = await this.toolRegistry.validateAndExecute('get_transactions', {}, {
              requestId,
              actor,
              customerId,
              conversationId,
              allowedTools,
              verificationLevel,
            });
            toolsSucceededThisTurn.push('get_transactions');
            finalText = formatSafeAccountSentence({ get_transactions: result }, customerWroteArabic);
          } catch {
            finalText = customerWroteArabic ? 'دعني أتحقق من معاملاتك مرة أخرى.' : 'Let me check your transactions for you again.';
          }
        } else if (claim === 'transaction_summary') {
          finalText = customerWroteArabic ? 'دعني أتحقق من معاملاتك مرة أخرى.' : 'Let me check your transactions for you again.';
        } else if (claim === 'statement_email_delivery') {
          // Unlike SMS, real email delivery DOES exist now — the false claim here means Qwen
          // narrated a send that didn't actually happen via send_statement_by_email this turn,
          // not that the capability is missing. Offer to actually do it, don't tell the customer
          // it's unavailable.
          finalText = customerWroteArabic
            ? 'لم أقم بإرسال ذلك بالفعل بعد — هل ترغب في أن أرسل الكشف إلى بريدك الإلكتروني المسجل الآن؟'
            : "I haven't actually sent that yet — would you like me to email the statement to your registered address now?";
        }
        await this.auditService.log({
          requestId,
          actorType: AuditActorType.SYSTEM,
          action: 'tool_routing.fabricated_claim_blocked',
          entityType: 'conversation',
          entityId: conversationId,
          result: { callId, claim, rejectedReply, replacedWith: finalText, toolsCalledThisTurn },
          success: false,
        });
      }
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
      // priority: 'low' (2026-09-24 normal-turn latency fix) — this call must never win the
      // shared Qwen instance ahead of, or overlap with, the same turn's main response: doing so
      // used to both delay the main reply behind classification's own request AND evict the main
      // reply's large cached prompt context with this call's tiny, unrelated one, adding ~4s of
      // pure prompt-re-evaluation to a turn that should have been fast. See QwenConcurrencyGate.
      const response = await this.llm.generate([{ role: 'user', content: prompt }], [], {
        maxTokens: 300,
        label: 'classification',
        priority: 'low',
      });
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
