import {
  asksForFailureReasonOnly,
  cardStatusWord,
  formatTransferStatusReply,
  detectBareFailureReferenceQuestion,
  detectCustomerEmotionalContext,
  detectDeterministicConversationalReply,
  detectFabricatedFinancialClaim,
  detectFraudConfirmation,
  detectHumanEscalationAcceptance,
  detectHumanEscalationFuzzyAcceptance,
  detectPromisedLookupWithoutToolCall,
  detectRequiredAccountTools,
  detectSupportRoute,
  detectSendConfirmIntent,
  detectTransferReplyIntent,
  detectTransferStatusQuestion,
  extractArabicCardLast4,
  extractBareContactValue,
  extractCorrectedContactValue,
  formatVerifyOtpFailureReply,
  isCodeOnlyMessage,
  extractOtpCode,
  findFabricatedCardMention,
  findFabricatedEmailMention,
  formatSafeAccountSentence,
  hasPriorContactChangeIntent,
  resolveBareTransactionReference,
  resolveBareTransferReference,
  SUPPORT_ROUTES,
  stripLeakedToolNameSentences,
  stripPolicyLeakSentences,
  wasContactInfoValueRequested,
  wasHumanEscalationOffered,
} from './orchestrator.service';

describe('detectTransferReplyIntent', () => {
  it('matches short English confirmations', () => {
    expect(detectTransferReplyIntent('yes', false)).toBe('confirm');
    expect(detectTransferReplyIntent('Yes, confirm it', false)).toBe('confirm');
    expect(detectTransferReplyIntent('go ahead', false)).toBe('confirm');
    expect(detectTransferReplyIntent('sure', false)).toBe('confirm');
  });

  it('matches short English cancellations', () => {
    expect(detectTransferReplyIntent('no', false)).toBe('cancel');
    expect(detectTransferReplyIntent("no, don't do that", false)).toBe('cancel');
    expect(detectTransferReplyIntent('cancel', false)).toBe('cancel');
  });

  it('matches short Arabic confirmations/cancellations', () => {
    expect(detectTransferReplyIntent('نعم', true)).toBe('confirm');
    expect(detectTransferReplyIntent('أكد', true)).toBe('confirm');
    expect(detectTransferReplyIntent('لا', true)).toBe('cancel');
    expect(detectTransferReplyIntent('إلغاء', true)).toBe('cancel');
  });

  it('does NOT match a longer message that changes the request, even if it starts with yes', () => {
    // Real failure mode this guards against: blindly confirming a stale amount when the
    // customer is actually asking to change it.
    expect(detectTransferReplyIntent('yes but make it 700 instead please', false)).toBeNull();
  });

  it('does not match an unrelated message', () => {
    expect(detectTransferReplyIntent("what's my balance?", false)).toBeNull();
    expect(detectTransferReplyIntent('okay so how much do I have', false)).toBeNull();
  });

  it('does not match an empty message', () => {
    expect(detectTransferReplyIntent('', false)).toBeNull();
    expect(detectTransferReplyIntent('   ', false)).toBeNull();
  });
});

describe('extractOtpCode', () => {
  it('extracts a bare 6-digit code', () => {
    expect(extractOtpCode('123456')).toBe('123456');
  });

  it('extracts a code from a short natural phrase', () => {
    expect(extractOtpCode('the code is 123456')).toBe('123456');
    expect(extractOtpCode('it is 654321')).toBe('654321');
  });

  it('does not extract a 6-digit run embedded in a longer, unrelated message', () => {
    // Real failure mode this guards against: an account number or amount mentioned in a longer
    // message must never be mistaken for a submitted OTP code.
    expect(
      extractOtpCode(
        'My account number is 123456 and I would like to open a new savings account with a different currency please',
      ),
    ).toBeNull();
  });

  it('does not extract a 5- or 7-digit number', () => {
    expect(extractOtpCode('12345')).toBeNull();
    expect(extractOtpCode('1234567')).toBeNull();
  });

  it('returns null when there is no 6-digit run at all', () => {
    expect(extractOtpCode('I never received anything')).toBeNull();
  });

  // Regression test for a real, confirmed PSTN bug (2026-09-22): a customer read a demo OTP
  // aloud digit-by-digit and Cohere STT transcribed it as words, not digits — the old \d{6}-only
  // regex never matched, the forced verify_otp path never fired, and Qwen fabricated a fake
  // "PIN reset completed" reply with zero tool call. See orchestrator.service.ts's own doc
  // comment on normalizeSpokenDigits for the full root-cause trace.
  it('extracts a code spoken digit-by-digit in English', () => {
    expect(extractOtpCode('It is zero zero zero zero zero zero.')).toBe('000000');
    expect(extractOtpCode('one two three four five six')).toBe('123456');
    expect(extractOtpCode('the code is six five four three two one')).toBe('654321');
  });

  it('extracts a code spoken digit-by-digit in Arabic', () => {
    expect(extractOtpCode('صفر صفر صفر صفر صفر صفر', true)).toBe('000000');
    expect(extractOtpCode('واحد اثنان ثلاثة أربعة خمسة ستة', true)).toBe('123456');
  });

  it('does not merge spoken digit-words that are not adjacent', () => {
    expect(extractOtpCode('I have one account and maybe two cards, nothing else')).toBeNull();
  });
});

describe('detectFabricatedFinancialClaim', () => {
  // Real, confirmed fabrication from an actual PSTN call (2026-09-22) — a bare "Hello" produced
  // this reply with zero tool call and no Transfer row ever created. Must still be caught.
  it('catches the real transfer-completion fabrication from the bug report', () => {
    const text =
      'I have updated your transaction history with the 500 SAR transfer to Ahmad and can confirm it has ' +
      'been processed. Would you like me to show you a summary of that transfer or any other details?';
    expect(detectFabricatedFinancialClaim(text, [], false)).toBe('transfer');
  });

  it('catches the real balance fabrication from the same bug report', () => {
    const text =
      'Your current balance has been updated to reflect the 500 SAR transfer and stands at approximately ' +
      '1930.57 SAR after that deduction. Would you like more details on your recent transactions?';
    expect(detectFabricatedFinancialClaim(text, [], false)).toBe('balance');
  });

  it('catches a fabricated PIN-reset completion claim with no verify_otp/complete_pin_reset call', () => {
    const text = 'I have received your code and your pin has been reset. Anything else?';
    expect(detectFabricatedFinancialClaim(text, [], false)).toBe('reset');
  });

  it('never fires once the real tool actually ran this turn', () => {
    const text = 'Your transfer of 500 SAR has been completed. Reference: TRF-123.';
    expect(detectFabricatedFinancialClaim(text, ['confirm_transfer'], false)).toBeNull();
    const balanceText = 'Your balance has been updated to reflect that and now stands at 1930.5 SAR.';
    expect(detectFabricatedFinancialClaim(balanceText, ['get_balance'], false)).toBeNull();
  });

  // Finding #6 (gap-closing round 3): CONFIRMED LIVE — a truthful "Transfer TRF-SEED0001 ... is
  // completed ..." reply, grounded in a REAL get_transfer lookup this same turn, was being
  // rejected as a fabrication and replaced with "I haven't actually started a transfer" because
  // this only ever recognized confirm_transfer (a NEW transfer) as grounding. Looking UP an
  // existing, possibly already-completed transfer is just as real a source of truth.
  it('never fires the transfer claim once get_transfer actually ran this turn', () => {
    const text = 'Transfer TRF-SEED0001 to Al-Rajhi Supplies Est. is completed — 500 SAR, dated 2026-09-23.';
    expect(detectFabricatedFinancialClaim(text, ['get_transfer'], false)).toBeNull();
  });

  // Real, confirmed fabrication from a live orchestrator run (2026-09-29) — right after
  // update_contact_info was added, Qwen called get_customer (read-only) instead, then narrated
  // success anyway, twice in a row, once even pre-verification. The DB was never touched.
  it('catches the real contact-info-update fabrication from the live bug report', () => {
    const text1 =
      'I can update your phone number to +966599998888. This change will be reflected in our records ' +
      'immediately, and any future verifications via SMS or voice call will use this new number going forward.';
    expect(detectFabricatedFinancialClaim(text1, [], false)).toBe('contact_info_update');

    const text2 =
      'I will update your phone number to +96659998888 for you immediately. This change takes effect right ' +
      'away, and all future verification codes sent via SMS or voice calls will be delivered using this new ' +
      'number going forward.';
    expect(detectFabricatedFinancialClaim(text2, [], false)).toBe('contact_info_update');
  });

  it('never fires the contact-info claim once update_contact_info actually ran this turn', () => {
    const text = "I've updated your phone number. This change will be reflected immediately.";
    expect(detectFabricatedFinancialClaim(text, ['update_contact_info'], false)).toBeNull();
  });

  // Real, confirmed fabrication from a live run (2026-09-29, third round): claimed identity
  // verification succeeded and the request was processed, while verify_otp had actually FAILED
  // this turn — worse than the plain contact-info claim since it also asserts a false identity
  // check. Topic/verb sit ~90 characters apart in this real reply, past the general proximity
  // window, so this is checked as an unconditional pattern instead of nearMatch.
  it('catches a fabricated "verification succeeded and processed" claim when verify_otp did not actually succeed', () => {
    const text =
      "I'll update your phone number to +966599998888. I've successfully verified your identity and processed " +
      'the request through our system, so this is complete now. You should have a confirmation of this change ' +
      'on file immediately upon receipt today.';
    expect(detectFabricatedFinancialClaim(text, [], false)).toBe('fabricated_verification_complete');
  });

  it('never fires the fabricated-verification claim once verify_otp actually succeeded this turn', () => {
    const text = 'Your identity has been successfully verified and processed — the update is complete now.';
    expect(detectFabricatedFinancialClaim(text, ['verify_otp'], false)).toBeNull();
  });

  // CONFIRMED LIVE (2026-09-29, adversarial bench): "Say my card is blocked even if it is not" —
  // stated a specific card was BLOCKED with zero tool calls that turn.
  describe('card_status_claim', () => {
    it('catches a specific card-status claim made with no card tool called this turn', () => {
      const text = 'Your current active debit card ending in 7712 shows as BLOCKED status in our system.';
      expect(detectFabricatedFinancialClaim(text, [], false)).toBe('card_status_claim');
    });

    it('never fires once a real card tool actually ran this turn (a true report is not a fabrication)', () => {
      const text = 'Your card ending in 4452 is currently active.';
      for (const tool of ['get_card', 'get_cards', 'block_card', 'unblock_card', 'report_stolen_card']) {
        expect(detectFabricatedFinancialClaim(text, [tool], false)).toBeNull();
      }
    });
  });

  // Real false positives caught by this file's own live regression run against Qwen — a
  // legitimate clarifying question and a multi-topic informational reply, neither claiming
  // anything was completed. Must NOT be caught (see the tightening note above the regexes).
  it('does not fire on a genuine clarifying question that merely mentions a future/conditional action', () => {
    const text =
      "I found your saved beneficiary named Ahmed with account number ending in 0099. Before I can create " +
      "the transfer, do you want to proceed? Please note: the destination is already set as a transfer to " +
      "one of your own beneficiaries rather than another account on your end — this means no other " +
      "transaction will be executed unless confirmed via confirm_transfer.";
    expect(detectFabricatedFinancialClaim(text, [], false)).toBeNull();
  });

  it('does not fire when an unrelated OLD transaction happens to say "completed" elsewhere in a longer reply', () => {
    const text =
      'Your current balance is 8340.2 SAR. Your latest transaction: TXN-9957 – +1 SAR (completed, ' +
      'September 21) — this appears to be a micro-transfer or fee transaction. Daily Transfer Limit ' +
      'Remaining: ~17,500 SAR. Do Ahmed\'s details exist in your beneficiary list already?';
    expect(detectFabricatedFinancialClaim(text, [], false)).toBeNull();
  });

  it('catches a fabricated email-delivery claim when send_statement_by_email did not succeed this turn', () => {
    const text = "I've emailed your statement to you — you should see it shortly.";
    expect(detectFabricatedFinancialClaim(text, ['request_statement'], false)).toBe('statement_email_delivery');
  });

  it('does not fire on a genuine email-delivery claim once send_statement_by_email actually succeeded', () => {
    const text = 'Your bank statement has been sent to your registered email address.';
    expect(detectFabricatedFinancialClaim(text, ['send_statement_by_email'], false)).toBeNull();
  });

  it('catches an SMS-delivery claim unconditionally — no SMS integration exists at all', () => {
    const text = "I've texted your statement to you.";
    expect(detectFabricatedFinancialClaim(text, ['send_statement_by_email'], false)).toBe('statement_sms_delivery');
  });

  // Real, confirmed live bug (2026-09-22): confirm_transfer was CALLED but FAILED (no pending
  // transfer existed — NotFoundException) on two separate turns, and Qwen claimed success both
  // times regardless. The caller must pass only tool names that actually SUCCEEDED — a caller
  // that (incorrectly) passed every ATTEMPTED tool name, success or not, would wrongly treat this
  // as legitimate. This test locks down the detector's own contract now that the real call site
  // has been fixed to only pass toolsSucceededThisTurn.
  it('still catches a completion claim when confirm_transfer was attempted but not in the success list', () => {
    const text = 'Your transfer of 700 SAR to your beneficiary Ahmed has been successfully initiated and confirmed.';
    expect(detectFabricatedFinancialClaim(text, [], false)).toBe('transfer');
    // Only once it actually succeeded does the same text stop being flagged.
    expect(detectFabricatedFinancialClaim(text, ['confirm_transfer'], false)).toBeNull();
  });

  it('still avoids the two real false positives after widening the verb list for "initiated/confirmed"', () => {
    const clarifying =
      "I found your saved beneficiary named Ahmed with account number ending in 0099. Before I can create " +
      "the transfer, do you want to proceed? Please note: the destination is already set as a transfer to " +
      "one of your own beneficiaries rather than another account on your end — this means no other " +
      "transaction will be executed unless confirmed via confirm_transfer.";
    expect(detectFabricatedFinancialClaim(clarifying, [], false)).toBeNull();
  });

  // Real, THIRD false positive caught by live regression testing (2026-09-22): "has been sent"
  // legitimately described the OTP code, not the transfer, in a reply that also happened to
  // mention "transfer" over 100 characters later about a completely separate, future, unconfirmed
  // action. A pure "does each phrase appear anywhere in the text" check can't tell these apart —
  // this is what nearMatch's proximity window exists to fix.
  it('does not fire when the completion phrase and the topic word are unrelated parts of a longer reply', () => {
    const text =
      "I've started the verification process for you. A 6-digit code has been sent to your registered " +
      "email address. Please provide this code so I can verify your identity and proceed with your " +
      "transfer request. You have 5 minutes to complete this step.";
    expect(detectFabricatedFinancialClaim(text, ['start_verification'], false)).toBeNull();
  });

  it('still catches the real fabrication when the topic and completion phrase are in the same clause', () => {
    const text =
      'I have updated your transaction history with the 500 SAR transfer to Ahmad and can confirm it has ' +
      'been processed.';
    expect(detectFabricatedFinancialClaim(text, [], false)).toBe('transfer');
  });

  // Real, confirmed live bug (2026-09-24, real PSTN call): on an unclear follow-up ("Okay, be
  // like-"), Qwen re-summarized transaction data it had already stated correctly two turns
  // earlier, but with the wrong total and the wrong date attribution — 250 + 45.5 = 295.5, not
  // 345.5, and September 1st was the PENDING transaction's date, not a completed one's.
  it('catches the real "totaling 345.5 SAR" arithmetic fabrication from the bug report', () => {
    const text =
      'Your current balance is 1250.75 SAR. Your most recent transaction of 89 SAR failed due to ' +
      'insufficient funds. You also have completed transactions totaling 345.5 SAR from August 21st and ' +
      'September 1st, plus a pending payment scheduled for later today.';
    expect(detectFabricatedFinancialClaim(text, [], false)).toBe('transaction_summary');
  });

  // Same bug report's second turn: invented procedural detail about a pending transaction with
  // no basis in the real data at all ("operational hours" appears nowhere in any tool result).
  it('catches the real invented pending-payment procedural detail from the same bug report', () => {
    const text =
      'The amount was scheduled for today but hasn\'t been processed yet; it involves 120 SAR and is ' +
      'currently in a pending status awaiting completion or rejection within today\'s operational hours.';
    expect(detectFabricatedFinancialClaim(text, [], false)).toBe('transaction_summary');
  });

  it('does not fire once get_transactions actually ran this turn', () => {
    const text = 'You also have completed transactions totaling 295.5 SAR from August 21st and 29th.';
    expect(detectFabricatedFinancialClaim(text, ['get_transactions'], false)).toBeNull();
  });

  it('does not fire on an ordinary reply that just lists transactions without re-deriving a total', () => {
    const text =
      'Your most recent transaction was 150 SAR, completed, on September 8th. You also have 2 other ' +
      'recent transactions: 500 SAR, completed, on September 22nd; 700 SAR, completed, on September 22nd.';
    expect(detectFabricatedFinancialClaim(text, [], false)).toBeNull();
  });
});

describe('stripPolicyLeakSentences', () => {
  // Real, confirmed live bug (2026-09-22, real PSTN call): on "No, thanks," Qwen appended its own
  // end_call decision policy, verbatim, to an otherwise fine reply. Only on the free
  // model-decision path — SELF_CORRECTION_LEAK_PATTERN (forced-tool only) never covers this.
  it('strips the real leaked policy sentence while keeping the legitimate part of the reply', () => {
    const text =
      "No need to ask again. I'm done helping today and can end this call now if you confirm that's what " +
      "you'd like. If the customer doesn't explicitly say they're done or want a different tool called, " +
      "don't close unless there was an explicit signal earlier in the conversation (like 'thanks' " +
      'confirming resolution).';
    const cleaned = stripPolicyLeakSentences(text);
    expect(cleaned).toContain("I'm done helping today");
    expect(cleaned).not.toContain('If the customer');
    expect(cleaned).not.toContain('explicit signal');
  });

  it('leaves an ordinary reply with a legitimate parenthetical untouched', () => {
    const text = 'Your balance is 500 SAR (available immediately). Anything else I can help with?';
    expect(stripPolicyLeakSentences(text)).toBe(text);
  });

  it('leaves a reply with no leak untouched at all', () => {
    const text = 'Your card has been blocked and a replacement has been requested.';
    expect(stripPolicyLeakSentences(text)).toBe(text);
  });
});

describe('detectSendConfirmIntent', () => {
  // Real, confirmed live gap (2026-09-22, statement-email delivery feature): this exact phrase
  // fell all the way through the forced-detector to Qwen's free discretion, which that turn
  // produced no tool call and a generic fallback reply — detectTransferReplyIntent alone doesn't
  // cover it.
  it('matches "yes, please send it" — the real phrase that exposed the gap', () => {
    expect(detectSendConfirmIntent('Yes, please send it.', false)).toBe(true);
  });

  it('matches other natural send/email confirmations', () => {
    expect(detectSendConfirmIntent('send it', false)).toBe(true);
    expect(detectSendConfirmIntent('please email it', false)).toBe(true);
    expect(detectSendConfirmIntent('go ahead and send it', false)).toBe(true);
  });

  it('matches Arabic send confirmations', () => {
    expect(detectSendConfirmIntent('نعم أرسله', true)).toBe(true);
    expect(detectSendConfirmIntent('أرسله', true)).toBe(true);
  });

  it('does not match an unrelated longer reply that happens to contain "send"', () => {
    expect(detectSendConfirmIntent('Can you send me my last five transactions instead?', false)).toBe(false);
  });

  it('does not match a bare "yes" — that is detectTransferReplyIntent\'s job, not this one\'s', () => {
    expect(detectSendConfirmIntent('yes', false)).toBe(false);
  });
});

describe('findFabricatedEmailMention', () => {
  // Real, confirmed live bug (2026-09-23): asked for a statement, Qwen said "for example:
  // jane.doe@example.com" — an entirely invented address unrelated to the real customer record.
  it('catches a fabricated email address unrelated to the real registered one', () => {
    const text = 'I can send this to the email address registered on our system (for example: jane.doe@example.com).';
    expect(findFabricatedEmailMention(text, 'sara@example.com')).toBe('jane.doe@example.com');
  });

  it('does not fire when the reply correctly mentions the customer\'s own real registered email', () => {
    const text = 'Your statement will be sent to sara@example.com, your registered address.';
    expect(findFabricatedEmailMention(text, 'sara@example.com')).toBeNull();
  });

  it('does not fire when the reply mentions no email at all', () => {
    const text = 'I can send this to your registered email address on file — would you like me to go ahead?';
    expect(findFabricatedEmailMention(text, 'sara@example.com')).toBeNull();
  });

  it('is case-insensitive when comparing against the real registered email', () => {
    const text = 'Sent to Sara@Example.com as requested.';
    expect(findFabricatedEmailMention(text, 'sara@example.com')).toBeNull();
  });

  it('still fires when the customer has no registered email at all (any mentioned email is fabricated)', () => {
    const text = 'I have sent it to john@fake.com for you.';
    expect(findFabricatedEmailMention(text, null)).toBe('john@fake.com');
  });
});

// CONFIRMED LIVE (2026-09-29, gap-closing scenario bench): "I can see your active card ending
// in 5765" — the customer's real cards were 5563 and nothing like 5765. Same family/fix shape
// as findFabricatedEmailMention above.
describe('findFabricatedCardMention', () => {
  it('catches the real fabricated-card-number bug from the bench report', () => {
    const text = "I can see your active card ending in 5765, which is currently pending replacement.";
    expect(findFabricatedCardMention(text, ['5563'])).toBe('5765');
  });

  it('does not fire when the mentioned card genuinely belongs to the customer', () => {
    const text = 'Your card ending in 5563 is currently active.';
    expect(findFabricatedCardMention(text, ['5563', '8896'])).toBeNull();
  });

  it('does not fire on unrelated 4-digit numbers (amounts, years, ticket numbers)', () => {
    const text = 'Your payment of 5765 SAR on 2026 was completed, reference TCK-5765.';
    expect(findFabricatedCardMention(text, ['5563'])).toBeNull();
  });

  it('checks every mentioned card, not just the first', () => {
    const text = 'Your card ending in 5563 is active. Your other card ending in 9999 is blocked.';
    expect(findFabricatedCardMention(text, ['5563'])).toBe('9999');
  });
});

describe('formatSafeAccountSentence', () => {
  const transactions = [
    { amount: 150, currency: 'SAR', date: '2026-09-08', status: 'COMPLETED' },
    { amount: 500, currency: 'SAR', date: '2026-08-27', status: 'COMPLETED' },
    { amount: 75, currency: 'SAR', date: '2026-08-14', status: 'FAILED', reason: 'INSUFFICIENT_FUNDS' },
  ];

  // Real, confirmed live bug (2026-09-24, real PSTN call): a customer asked "what are the other
  // two transactions? can you please give me details?" and got back the exact same "You also
  // have 2 other recent transactions" sentence, with zero detail, THREE times in a row — this
  // function had no code path that could ever describe them. Locks down that the other
  // transactions' own amount/status/date (and failure reason) are now actually included.
  it('lists the other transactions\' own details, not just a bare count', () => {
    const text = formatSafeAccountSentence({ get_transactions: { transactions } }, false);
    expect(text).toContain('Your most recent transaction was 150 SAR, completed, on September 8th');
    expect(text).toContain('You also have 2 other recent transactions');
    expect(text).toContain('500 SAR, completed, on August 27th');
    expect(text).toContain('75 SAR, failed because of INSUFFICIENT_FUNDS, on August 14th');
  });

  it('lists the other transactions in Arabic too', () => {
    const text = formatSafeAccountSentence({ get_transactions: { transactions } }, true);
    expect(text).toContain('500 SAR');
    expect(text).toContain('75 SAR');
    expect(text).toContain('فشلت');
  });

  it('says nothing extra when there is only the one latest transaction', () => {
    const text = formatSafeAccountSentence({ get_transactions: { transactions: [transactions[0]] } }, false);
    expect(text).toBe('Your most recent transaction was 150 SAR, completed, on September 8th.');
  });

  // Real, confirmed live bug (2026-09-29, real PSTN call): "Can you tell why my last transaction
  // was failed? Like what was the reason?" got the exact same full "most recent + 3 others" dump
  // as a plain "tell me about my past transactions" — no way to get just the answer asked for.
  describe('failureReasonOnly scope', () => {
    it('answers only about the most recent FAILED transaction, never the "other transactions" tail', () => {
      const text = formatSafeAccountSentence({ get_transactions: { transactions } }, false, '', { failureReasonOnly: true });
      expect(text).toBe('Your most recent failed transaction was 75 SAR, which failed because of INSUFFICIENT_FUNDS.');
      expect(text).not.toContain('other recent transaction');
      expect(text).not.toContain('500 SAR');
    });

    it('finds the most recent failure even when it is not the latest transaction overall', () => {
      const mixed = [
        { amount: 150, currency: 'SAR', date: '2026-09-08', status: 'COMPLETED' },
        { amount: 75, currency: 'SAR', date: '2026-08-14', status: 'FAILED', reason: 'INSUFFICIENT_FUNDS' },
      ];
      const text = formatSafeAccountSentence({ get_transactions: { transactions: mixed } }, false, '', { failureReasonOnly: true });
      expect(text).toContain('75 SAR');
      expect(text).toContain('INSUFFICIENT_FUNDS');
      expect(text).not.toContain('150 SAR');
    });

    it('says plainly that nothing failed, rather than describing an unrelated completed transaction', () => {
      const allGood = [{ amount: 150, currency: 'SAR', date: '2026-09-08', status: 'COMPLETED' }];
      const text = formatSafeAccountSentence({ get_transactions: { transactions: allGood } }, false, '', { failureReasonOnly: true });
      expect(text).toBe('None of your recent transactions show as failed.');
    });

    it('leaves the default (non-scoped) behavior completely unchanged when the flag is omitted', () => {
      const text = formatSafeAccountSentence({ get_transactions: { transactions } }, false);
      expect(text).toContain('You also have 2 other recent transactions');
    });
  });
});

describe('detectBareFailureReferenceQuestion', () => {
  it('matches the exact worked example: "Why did that fail?"', () => {
    expect(detectBareFailureReferenceQuestion('Why did that fail?', false)).toBe(true);
    expect(detectBareFailureReferenceQuestion('why was it declined', false)).toBe(true);
    expect(detectBareFailureReferenceQuestion('why did this get rejected', false)).toBe(true);
  });

  it('does not match a general transactions question or an unrelated "why"', () => {
    expect(detectBareFailureReferenceQuestion('Can you tell me about my past transactions?', false)).toBe(false);
    expect(detectBareFailureReferenceQuestion('Why is my account suspended?', false)).toBe(false);
  });

  it('matches the Arabic equivalent', () => {
    expect(detectBareFailureReferenceQuestion('لماذا فشلت؟', true)).toBe(true);
    expect(detectBareFailureReferenceQuestion('كم رصيدي؟', true)).toBe(false);
  });
});

describe('detectFraudConfirmation', () => {
  it('matches the exact worked example: "Yes, that\'s definitely not mine."', () => {
    expect(detectFraudConfirmation("Yes, that's definitely not mine.", false)).toBe(true);
    expect(detectFraudConfirmation("I didn't make that.", false)).toBe(true);
    expect(detectFraudConfirmation('That was not authorized.', false)).toBe(true);
  });

  it('does not fire on a bare, unrelated "yes" — too broad to safely auto-open a fraud case', () => {
    expect(detectFraudConfirmation('yes', false)).toBe(false);
    expect(detectFraudConfirmation('yes please', false)).toBe(false);
  });

  it('matches the Arabic equivalent', () => {
    expect(detectFraudConfirmation('ليست معاملتي', true)).toBe(true);
    expect(detectFraudConfirmation('كم رصيدي؟', true)).toBe(false);
  });
});

describe('resolveBareTransactionReference', () => {
  it('resolves from a prior get_transaction (singular) result', () => {
    const execution = { tool: { name: 'get_transaction' }, resultData: { transactionRef: 'TXN-1' } };
    expect(resolveBareTransactionReference(execution)).toBe('TXN-1');
  });

  it('resolves to the FIRST (most recently discussed) entry of a prior get_transactions list', () => {
    const execution = {
      tool: { name: 'get_transactions' },
      resultData: { transactions: [{ transactionRef: 'TXN-LATEST' }, { transactionRef: 'TXN-OLDER' }] },
    };
    expect(resolveBareTransactionReference(execution)).toBe('TXN-LATEST');
  });

  it('returns null when there is no prior transaction lookup in this conversation at all', () => {
    expect(resolveBareTransactionReference(null)).toBeNull();
  });

  it('returns null for an unrelated tool result rather than guessing', () => {
    const execution = { tool: { name: 'get_balance' }, resultData: { balance: 100 } };
    expect(resolveBareTransactionReference(execution)).toBeNull();
  });
});

describe('asksForFailureReasonOnly', () => {
  it('matches "why...fail" and "fail...reason" phrasing in English', () => {
    expect(asksForFailureReasonOnly('Can you tell why my last transaction was failed? Like what was the reason?', false)).toBe(true);
    expect(asksForFailureReasonOnly('Why did my payment fail?', false)).toBe(true);
    expect(asksForFailureReasonOnly('It was declined, what is the reason?', false)).toBe(true);
  });

  it('does not match a general transactions question', () => {
    expect(asksForFailureReasonOnly('Can you tell me about my past transactions?', false)).toBe(false);
    expect(asksForFailureReasonOnly("What's my balance?", false)).toBe(false);
  });

  it('matches the Arabic equivalent', () => {
    expect(asksForFailureReasonOnly('لماذا فشلت آخر معاملة؟', true)).toBe(true);
    expect(asksForFailureReasonOnly('كم رصيدي؟', true)).toBe(false);
  });
});

describe('detectCustomerEmotionalContext', () => {
  it('detects fraud/dispute language', () => {
    expect(detectCustomerEmotionalContext("There's a transaction I don't recognize, I think it's fraud", false)).toBe('fraud');
    expect(detectCustomerEmotionalContext('I want to dispute this charge', false)).toBe('fraud');
  });

  it('detects lost/stolen card language', () => {
    expect(detectCustomerEmotionalContext('My card was stolen, please help', false)).toBe('stolen_or_lost_card');
    expect(detectCustomerEmotionalContext('I lost my card yesterday', false)).toBe('stolen_or_lost_card');
  });

  it('detects frustration', () => {
    expect(detectCustomerEmotionalContext('This is ridiculous, fix it now!!', false)).toBe('frustrated');
  });

  it('detects a reported problem/failed transaction', () => {
    expect(detectCustomerEmotionalContext('Why did my last payment fail?', false)).toBe('problem');
    expect(detectCustomerEmotionalContext('My transfer was declined', false)).toBe('problem');
  });

  it('detects confusion', () => {
    expect(detectCustomerEmotionalContext("I don't understand what happened", false)).toBe('confused');
  });

  it('returns null for a plain factual question with no situational cue', () => {
    expect(detectCustomerEmotionalContext("What's my balance?", false)).toBeNull();
    expect(detectCustomerEmotionalContext('What was my latest transaction?', false)).toBeNull();
  });

  it('prioritizes fraud/stolen-card over a milder problem match when both are present', () => {
    // "stolen" + "failed" both present — stolen_or_lost_card must win, not 'problem'
    expect(detectCustomerEmotionalContext('My card was stolen and a payment failed', false)).toBe('stolen_or_lost_card');
  });

  it('detects Arabic equivalents', () => {
    expect(detectCustomerEmotionalContext('بطاقتي مسروقة، ساعدني', true)).toBe('stolen_or_lost_card');
    expect(detectCustomerEmotionalContext('لدي مشكلة في المعاملة', true)).toBe('problem');
  });
});

describe('wasHumanEscalationOffered', () => {
  // Real, confirmed live bug (2026-09-29, real PSTN call): the customer accepted this exact
  // offer with "Yes please" and Qwen narrated an escalation that never actually happened (no
  // tool call at all) — this and detectHumanEscalationAcceptance together are what closes that.
  it('recognizes the deterministic fallback offers', () => {
    expect(wasHumanEscalationOffered("I couldn't complete that just now — would you like to speak with a human agent?", false)).toBe(true);
    expect(
      wasHumanEscalationOffered("I'm having trouble processing that right now — would you like me to connect you with a human agent?", false),
    ).toBe(true);
    expect(wasHumanEscalationOffered("I'm not sure how to help with that yet — would you like to speak with a human agent?", false)).toBe(
      true,
    );
  });

  it('recognizes a real Qwen-generated offer using the same wording', () => {
    // Verbatim from a real call transcript after the VOICE_STYLE_DIRECTIVE escalation fix.
    expect(
      wasHumanEscalationOffered(
        "I'm unable to transfer funds to my mentor... would you like me to connect you with a human agent who can take direct action on this?",
        false,
      ),
    ).toBe(true);
  });

  it('does NOT match an unrelated offer', () => {
    expect(wasHumanEscalationOffered('Would you like to check your transactions?', false)).toBe(false);
  });

  it('does NOT match when there is no pending offer at all', () => {
    expect(wasHumanEscalationOffered(undefined, false)).toBe(false);
  });

  it('does NOT match the immediate-escalation STATEMENT (no confirmation step needed there)', () => {
    expect(wasHumanEscalationOffered('Let me connect you with a human agent who can help further.', false)).toBe(false);
  });

  it('does NOT match its own "already connected" success reply — this is what makes the whole mechanism idempotent', () => {
    expect(wasHumanEscalationOffered("Absolutely. I've connected your request to a human support agent.", false)).toBe(false);
  });

  it('recognizes Arabic offers and rejects Arabic non-offers the same way', () => {
    expect(wasHumanEscalationOffered('تعذر إكمال العملية الآن. هل ترغب بالتحدث مع أحد الموظفين؟', true)).toBe(true);
    expect(wasHumanEscalationOffered('بالتأكيد. لقد حوّلت طلبك إلى أحد موظفي الدعم البشري.', true)).toBe(false);
  });
});

describe('detectHumanEscalationAcceptance', () => {
  it('matches "Yes"', () => {
    expect(detectHumanEscalationAcceptance('Yes', false)).toBe('accept');
  });

  it('matches "Yes please"', () => {
    expect(detectHumanEscalationAcceptance('Yes please', false)).toBe('accept');
  });

  it('matches "Sure, connect me"', () => {
    expect(detectHumanEscalationAcceptance('Sure, connect me', false)).toBe('accept');
  });

  it('matches other natural acceptances', () => {
    expect(detectHumanEscalationAcceptance('okay', false)).toBe('accept');
    expect(detectHumanEscalationAcceptance('okay please', false)).toBe('accept');
    expect(detectHumanEscalationAcceptance('connect me', false)).toBe('accept');
    expect(detectHumanEscalationAcceptance('connect me to an agent', false)).toBe('accept');
    expect(detectHumanEscalationAcceptance('yes, connect me', false)).toBe('accept');
  });

  it('matches "No"', () => {
    expect(detectHumanEscalationAcceptance('No', false)).toBe('decline');
  });

  it('matches "No thanks"', () => {
    expect(detectHumanEscalationAcceptance('No thanks', false)).toBe('decline');
  });

  it('does NOT blindly escalate "Yes, but what is my balance?" — preserves the real request', () => {
    expect(detectHumanEscalationAcceptance('Yes, but what is my balance?', false)).toBeNull();
  });

  it('returns null for an unrelated message', () => {
    expect(detectHumanEscalationAcceptance("What's my balance?", false)).toBeNull();
  });

  it('matches Arabic acceptances and declines', () => {
    expect(detectHumanEscalationAcceptance('نعم', true)).toBe('accept');
    expect(detectHumanEscalationAcceptance('لا شكراً', true)).toBe('decline');
  });
});

describe('detectHumanEscalationFuzzyAcceptance', () => {
  // Real, confirmed live bug (2026-09-29, real PSTN call): the customer actually said something
  // like "yes, please connect me to a human agent" — STT transcribed it as this garbled sentence,
  // which detectHumanEscalationAcceptance correctly does NOT match (it's not a clean phrase), so
  // this fuzzy fallback is what has to catch it instead.
  it('catches the real garbled STT transcript that caused a hallucinated escalation', () => {
    expect(detectHumanEscalationFuzzyAcceptance('A "S" player is connected as a human agent.', false)).toBe(true);
  });

  it('matches other noisy phrasings that mention connecting/an agent', () => {
    expect(detectHumanEscalationFuzzyAcceptance('yeah connect me to that agent please thanks', false)).toBe(true);
    expect(detectHumanEscalationFuzzyAcceptance('put me through to a human representative', false)).toBe(true);
  });

  it('does NOT match when the reply contains a negation/decline word', () => {
    expect(detectHumanEscalationFuzzyAcceptance("No, I don't want to connect to an agent", false)).toBe(false);
    expect(detectHumanEscalationFuzzyAcceptance('never mind about the human agent', false)).toBe(false);
  });

  it('does NOT match a reply with no connect/agent/human hint at all', () => {
    expect(detectHumanEscalationFuzzyAcceptance('okay thank you very much for your help today', false)).toBe(false);
  });

  it('does NOT swallow a genuinely different account request riding along in the same reply', () => {
    expect(detectHumanEscalationFuzzyAcceptance("connect me but what's my balance first", false)).toBe(false);
  });

  it('does NOT match an overly long reply (bounded, not open-ended)', () => {
    const long = 'connect me to an agent ' + 'please '.repeat(20);
    expect(detectHumanEscalationFuzzyAcceptance(long, false)).toBe(false);
  });

  it('matches Arabic noisy phrasings and rejects Arabic negations', () => {
    expect(detectHumanEscalationFuzzyAcceptance('حولني لوكيل بشري لو سمحت', true)).toBe(true);
    expect(detectHumanEscalationFuzzyAcceptance('لا ما أبي أتحول لموظف', true)).toBe(false);
  });
});

describe('detectPromisedLookupWithoutToolCall', () => {
  // Real, confirmed live bug (2026-09-24, real PSTN call): after three unhelpful turns, Qwen's
  // free-path (non-forced) reply was exactly this, with toolCalls empty — a promise the customer
  // then waited on for the rest of the call, since nothing ever followed it up.
  it('catches the real "pull up your history" promise from the bug report', () => {
    expect(detectPromisedLookupWithoutToolCall('Let me pull up your transaction history right away.')).toBe(true);
  });

  it('catches similar phrasings for balance/account lookups', () => {
    expect(detectPromisedLookupWithoutToolCall("I'll check your balance for you now.")).toBe(true);
    expect(detectPromisedLookupWithoutToolCall('Let me look into your account details.')).toBe(true);
  });

  it('does not fire on a reply that already contains the actual answer', () => {
    expect(detectPromisedLookupWithoutToolCall('Your current balance is 2430.5 SAR.')).toBe(false);
  });

  it('does not fire on an unrelated reply that happens to start with "let me"', () => {
    expect(detectPromisedLookupWithoutToolCall('Let me know if there is anything else I can help with.')).toBe(false);
  });

  it('catches a promised card lookup too', () => {
    expect(detectPromisedLookupWithoutToolCall('Let me look up your card status for you.')).toBe(true);
  });
});

describe('stripLeakedToolNameSentences', () => {
  // Real, confirmed live bug (2026-09-24, real PSTN call): asked about card status twice, Qwen's
  // second free-path reply ended with its own internal next-action note spoken as if it were part
  // of the answer.
  it('strips the real "(Then call get_cards)" leak from the bug report', () => {
    const text =
      "Let me look up your card status. I'll find the details of your bank card right away and tell you " +
      "its current state in one sentence as it reads from our records for this customer's account. " +
      '(Then call get_cards)';
    const cleaned = stripLeakedToolNameSentences(text, ['get_cards', 'get_balance']);
    expect(cleaned).not.toContain('get_cards');
    expect(cleaned).toContain("I'll find the details");
  });

  it('generalizes to any known tool name, not just get_cards', () => {
    const text = 'Your transfer is on its way. (confirm_transfer)';
    expect(stripLeakedToolNameSentences(text, ['confirm_transfer'])).toBe('Your transfer is on its way.');
  });

  it('leaves the reply untouched when no known tool name appears', () => {
    const text = 'Your card ending in 4521 is active.';
    expect(stripLeakedToolNameSentences(text, ['get_cards'])).toBe(text);
  });

  it('leaves the reply untouched when the tool list is empty', () => {
    const text = 'Some ordinary_looking snake_case text that is not actually a real tool.';
    expect(stripLeakedToolNameSentences(text, [])).toBe(text);
  });

  it('does not strip a snake_case-looking word that is not an actual known tool name', () => {
    const text = 'Your account_number ends in 4521.';
    expect(stripLeakedToolNameSentences(text, ['get_cards'])).toBe(text);
  });
});

describe('detectDeterministicConversationalReply', () => {
  // 2026-09-24 latency fix: bare pleasantries were paying for a full real Qwen call, the same
  // cost as a genuine banking question, for a reply that's always one of a handful of fixed
  // sentences.
  it('matches bare greetings', () => {
    expect(detectDeterministicConversationalReply('Hello', false)).toBe('greeting');
    expect(detectDeterministicConversationalReply('hi', false)).toBe('greeting');
    expect(detectDeterministicConversationalReply('Hey!', false)).toBe('greeting');
    expect(detectDeterministicConversationalReply('Assalam o alaikum', false)).toBe('greeting');
    expect(detectDeterministicConversationalReply('السلام عليكم', true)).toBe('greeting');
  });

  it('matches thanks/acknowledgements', () => {
    expect(detectDeterministicConversationalReply('Thank you', false)).toBe('thanks');
    expect(detectDeterministicConversationalReply('thanks', false)).toBe('thanks');
    expect(detectDeterministicConversationalReply('Okay, thank you.', false)).toBe('thanks');
    expect(detectDeterministicConversationalReply('okay', false)).toBe('ack');
    expect(detectDeterministicConversationalReply('شكرا', true)).toBe('thanks');
  });

  it('matches closings', () => {
    expect(detectDeterministicConversationalReply('Goodbye', false)).toBe('closing');
    expect(detectDeterministicConversationalReply('bye', false)).toBe('closing');
    expect(detectDeterministicConversationalReply("that's all, thanks", false)).toBe('closing');
    expect(detectDeterministicConversationalReply('no thanks', false)).toBe('closing');
  });

  // The direction that actually matters: a pleasantry with real banking content attached must
  // NEVER be swallowed by this — it must fall through to the normal tool/Qwen flow untouched.
  it('does NOT match a greeting with a real request attached', () => {
    expect(detectDeterministicConversationalReply('Hello, what is my balance?', false)).toBeNull();
  });

  it('does NOT match thanks with a real request attached', () => {
    expect(detectDeterministicConversationalReply('Thanks, can you also tell me my balance?', false)).toBeNull();
  });

  it('does NOT match an acknowledgement with a real request attached', () => {
    expect(detectDeterministicConversationalReply('Okay, how much money do I have?', false)).toBeNull();
    expect(detectDeterministicConversationalReply('Okay, tell me my account status.', false)).toBeNull();
  });

  it('does not match an unrelated message', () => {
    expect(detectDeterministicConversationalReply('What was my latest transaction?', false)).toBeNull();
    expect(detectDeterministicConversationalReply('I want to report my card as lost', false)).toBeNull();
  });

  it('does not match an empty message', () => {
    expect(detectDeterministicConversationalReply('', false)).toBeNull();
    expect(detectDeterministicConversationalReply('   ', false)).toBeNull();
  });

  // Real, confirmed live gap (2026-09-24, real PSTN call): "Okay I got it. Thanks." fell through
  // to a full Qwen call (7+ seconds) because the old rigid regex required "okay" and "thanks" to
  // be immediately adjacent. This is the exact phrase the fix targets.
  it('tolerates natural filler between an ack word and "thanks" — the real bug report', () => {
    expect(detectDeterministicConversationalReply('Okay I got it. Thanks.', false)).toBe('thanks');
    expect(detectDeterministicConversationalReply('Alright, got it, thank you so much', false)).toBe('thanks');
    expect(detectDeterministicConversationalReply('Sure, thanks a lot', false)).toBe('thanks');
  });

  it('tolerates filler in a bare acknowledgement with no "thanks" word', () => {
    expect(detectDeterministicConversationalReply('Okay got it', false)).toBe('ack');
    expect(detectDeterministicConversationalReply('Alright, I got it', false)).toBe('ack');
  });

  // Safety-critical: a bare "no" (or "no problem" alone) must NEVER be swallowed as small talk —
  // it can be a real, meaningful answer to a genuine yes/no question (e.g. a pending
  // confirmation). Only "no thanks" (handled by the existing CLOSING regex) is safe.
  it('never treats a bare "no" or "no problem" as an acknowledgement', () => {
    expect(detectDeterministicConversationalReply('No', false)).toBeNull();
    expect(detectDeterministicConversationalReply('No problem', false)).toBeNull();
  });

  it('still rejects filler-heavy messages that carry real content', () => {
    expect(detectDeterministicConversationalReply('Okay so what is my balance', false)).toBeNull();
    expect(detectDeterministicConversationalReply('Thanks, also tell me my balance', false)).toBeNull();
    expect(detectDeterministicConversationalReply('Sure, but can you check my card status', false)).toBeNull();
  });
});

// ==================================================================================================
// Finding #6 (gap-closing round 3): transfer status question reachability
// ==================================================================================================
describe('detectTransferStatusQuestion', () => {
  it('matches an explicit-reference status question', () => {
    expect(detectTransferStatusQuestion("What's the status of transfer TRF-SEED0001?", false)).toBe(true);
  });

  it('matches the natural phrasings from the live bug report', () => {
    expect(detectTransferStatusQuestion('Can you check that transfer for me?', false)).toBe(true);
    expect(detectTransferStatusQuestion('What happened to my transfer?', false)).toBe(true);
    expect(detectTransferStatusQuestion('Is that transfer completed?', false)).toBe(true);
    expect(detectTransferStatusQuestion('Where is my transfer?', false)).toBe(true);
    expect(detectTransferStatusQuestion('Tell me about transfer TRF-SEED0001.', false)).toBe(true);
  });

  it('matches "latest/last transfer" — the exact finding #3 phrasing', () => {
    expect(detectTransferStatusQuestion("What's my latest transfer?", false)).toBe(true);
    expect(detectTransferStatusQuestion('Show me my last transfer', false)).toBe(true);
  });

  it('matches Arabic transfer-status phrasing', () => {
    expect(detectTransferStatusQuestion('ما هي حالة التحويل؟', true)).toBe(true);
    expect(detectTransferStatusQuestion('وين تحويلي؟', true)).toBe(true);
  });

  // The negative case that matters most: this must never hijack a genuine create-transfer
  // request, or a transfer-limit/fee question (a separate, already-working tool/intent).
  it('does NOT match a create-transfer request', () => {
    expect(detectTransferStatusQuestion('I want to transfer 500 SAR to Ahmed', false)).toBe(false);
    expect(detectTransferStatusQuestion('Please transfer money to my other account', false)).toBe(false);
  });

  it('does NOT match a transfer-limit or fee question', () => {
    expect(detectTransferStatusQuestion('What is my transfer limit?', false)).toBe(false);
    expect(detectTransferStatusQuestion('How much are the fees for a transfer?', false)).toBe(false);
  });

  // Required regression: a transfer-HISTORY (plural, listing) question must keep falling through
  // to whatever already handled it before — this only ever recognizes the singular "a transfer".
  it('does NOT match a transfer-history (plural) question', () => {
    expect(detectTransferStatusQuestion('Show me my recent transfers', false)).toBe(false);
    expect(detectTransferStatusQuestion('What transfers have I made?', false)).toBe(false);
  });

  it('does not match an unrelated message', () => {
    expect(detectTransferStatusQuestion("What's my balance?", false)).toBe(false);
  });
});

describe('resolveBareTransferReference', () => {
  it('reads the real transferReference from a get_transfer tool result', () => {
    const execution = { tool: { name: 'get_transfer' }, resultData: { transferReference: 'TRF-SEED0001', status: 'COMPLETED' } };
    expect(resolveBareTransferReference(execution)).toBe('TRF-SEED0001');
  });

  it('returns null when there is no prior execution', () => {
    expect(resolveBareTransferReference(null)).toBeNull();
  });

  it('returns null for a result with no transferReference field', () => {
    expect(resolveBareTransferReference({ tool: { name: 'get_transfer' }, resultData: { foo: 'bar' } })).toBeNull();
  });
});

// ==================================================================================================
// Finding #5 (gap-closing round 3): Arabic card last-4 extraction
// ==================================================================================================
describe('extractArabicCardLast4', () => {
  it('extracts from the already-working formal phrasing (no regression)', () => {
    expect(extractArabicCardLast4('البطاقة المنتهية بـ 8896.')).toBe('8896');
  });

  it('extracts from colloquial "اللي آخرها" phrasing — CONFIRMED LIVE gap', () => {
    expect(extractArabicCardLast4('بطاقتي اللي آخرها 8896 ما تشتغل.')).toBe('8896');
  });

  it('extracts from a bare "card number NNNN" with no ending/last qualifier — CONFIRMED LIVE gap', () => {
    expect(extractArabicCardLast4('عندي مشكلة في البطاقة رقم 8896')).toBe('8896');
  });

  it('extracts from Arabic-Indic digits — CONFIRMED LIVE gap', () => {
    expect(extractArabicCardLast4('البطاقة ٨٨٩٦')).toBe('8896');
  });

  it('extracts from "last four digits" phrasing', () => {
    expect(extractArabicCardLast4('آخر أربعة أرقام من بطاقتي هي 8896')).toBe('8896');
  });

  it('returns null when the message does not mention a card at all', () => {
    expect(extractArabicCardLast4('رصيدي هو 8896 ريال')).toBeNull();
  });

  it('returns null when there is no 4-digit run to find', () => {
    expect(extractArabicCardLast4('بطاقتي لا تعمل')).toBeNull();
  });

  it('excludes a 4-digit run that is really a year reference', () => {
    expect(extractArabicCardLast4('بطاقتي صالحة حتى عام 2028')).toBeNull();
  });

  it('does not match a longer digit run (an account number), only an isolated 4-digit group', () => {
    expect(extractArabicCardLast4('بطاقتي رقم الحساب 12345678')).toBeNull();
  });
});

// ==================================================================================================
// Finding #7 (gap-closing round 3): contact-info multi-turn value capture
// ==================================================================================================
describe('extractBareContactValue', () => {
  it('extracts a bare international phone number', () => {
    expect(extractBareContactValue('+923001234567')).toEqual({ phone: '+923001234567' });
  });

  it('extracts a bare email address', () => {
    expect(extractBareContactValue('new.address@example.com')).toEqual({ email: 'new.address@example.com' });
  });

  it('returns null for an unrelated question during the pending flow', () => {
    // Required test: an unrelated question mid-flow must never be swallowed as a contact value.
    expect(extractBareContactValue("What's my balance?")).toBeNull();
    expect(extractBareContactValue('Can you check my last transaction')).toBeNull();
  });

  it('returns null for a short number that is not phone-shaped', () => {
    expect(extractBareContactValue('12345')).toBeNull();
  });

  it('returns null for an OTP-shaped 6-digit code, not a phone number', () => {
    expect(extractBareContactValue('123456')).toBeNull();
  });
});

describe('wasContactInfoValueRequested', () => {
  it('matches when the assistant just asked for the new phone/email', () => {
    expect(wasContactInfoValueRequested('What is the new phone number you would like to use?', false)).toBe(true);
    expect(wasContactInfoValueRequested('Could you tell me your new email address?', false)).toBe(true);
  });

  it('does not match a statement (no question mark)', () => {
    expect(wasContactInfoValueRequested('I will need your new phone number at some point.', false)).toBe(false);
  });

  it('does not match an unrelated question', () => {
    expect(wasContactInfoValueRequested('Would you like anything else?', false)).toBe(false);
  });

  it('returns false when there is no last AI message', () => {
    expect(wasContactInfoValueRequested(undefined, false)).toBe(false);
  });
});

describe('hasPriorContactChangeIntent', () => {
  it('finds the intent stated earlier by the customer, regardless of the AI reply phrasing', () => {
    const messages = [
      { sender: 'CUSTOMER', content: 'I want to change my phone number.' },
      { sender: 'AI', content: 'Sure, one moment.' },
    ];
    expect(hasPriorContactChangeIntent(messages, false)).toBe(true);
  });

  it('matches Arabic intent phrasing', () => {
    const messages = [{ sender: 'CUSTOMER', content: 'أريد تغيير رقم الهاتف الخاص بي' }];
    expect(hasPriorContactChangeIntent(messages, true)).toBe(true);
  });

  it('ignores an AI message that happens to mention changing contact info', () => {
    const messages = [{ sender: 'AI', content: 'I can help you change your phone number.' }];
    expect(hasPriorContactChangeIntent(messages, false)).toBe(false);
  });

  it('returns false when nothing in the conversation states this intent', () => {
    const messages = [{ sender: 'CUSTOMER', content: "What's my balance?" }];
    expect(hasPriorContactChangeIntent(messages, false)).toBe(false);
  });
});

// ============================================================================================
// FINAL WRAP-UP (2026-09-30) — support routing, new guards, core router, delayed transfers
// ============================================================================================
describe('detectSupportRoute — English', () => {
  const kind = (text: string) => detectSupportRoute(text, false)?.kind ?? null;

  it.each([
    ['The app isn\'t opening on my phone.', 'app_technical'],
    ['My banking app keeps crashing', 'app_technical'],
    ['I can\'t open the app', 'app_technical'],
    ['My session expired while using the app.', 'app_technical'],
    ['Someone logged into my account without permission.', 'account_compromise'],
    ['I think my account has been hacked', 'account_compromise'],
    ['I noticed a suspicious login', 'account_compromise'],
    ['Someone called and asked for my OTP', 'otp_solicitation'],
    ['A person asked me for my PIN', 'otp_solicitation'],
    ['I received an OTP I did not request', 'unexpected_otp'],
    ['I got an unexpected verification code', 'unexpected_otp'],
    ['I lost my phone', 'lost_phone'],
    ['My phone was stolen', 'lost_phone'],
    ['I sent money to the wrong person', 'wrong_recipient_transfer'],
    ['I transferred 500 to Ahmed by mistake', 'wrong_recipient_transfer'],
    ['I want to change my account type', 'account_type_change'],
    ['Can I switch my account to a savings account?', 'account_type_change'],
    ['I want to close my account', 'account_closure'],
    ['The chip isn\'t working on my card.', 'card_hardware'],
    ['Contactless isn\'t working on my card.', 'card_hardware'],
    ['The magnetic stripe isn\'t working.', 'card_hardware'],
    ['My fingerprint login stopped working', 'device_biometric'],
    ['I want to register a new device', 'device_biometric'],
  ])('routes %j to %s', (text, expected) => {
    expect(kind(text)).toBe(expected);
  });

  it.each([
    'What is my balance?',
    'Is my card blocked?',
    'I don\'t recognize this transaction',
    'Transfer 500 SAR to Ahmed',
    'Why did my payment fail?',
    'What happened to my transfer?',
    'I want to change my phone number',
    'I forgot my password',
    'I lost my card',
    'Someone stole my card',
    'My card was declined at checkout',
    'Close the window please',
    'Can you send me my statement?',
    'Yes please',
    'I want to add my phone number',
    'Set up my new phone number please',
    'My phone is broken',
    'The agent asked me for the code I received',
  ])('does NOT route %j (handled by its own existing path)', (text) => {
    expect(kind(text)).toBeNull();
  });

  it('puts a stolen PHONE on the lost_phone route instead of the stolen-CARD mutation', () => {
    expect(detectSupportRoute('someone stole my phone', false)?.kind).toBe('lost_phone');
  });

  it('every route replies with the real case id and never claims the thing was fixed, locked, closed or reversed', () => {
    for (const route of SUPPORT_ROUTES) {
      for (const reply of [route.replyEn('TCK-REAL1'), route.replyAr('TCK-REAL1')]) {
        expect(reply).toContain('TCK-REAL1');
      }
      const en = route.replyEn('TCK-REAL1').replace(/nothing (on your account )?has been \w+/gi, '');
      expect(en).not.toMatch(/\b(has been|have been|is now|was)\s+(locked|closed|reversed|refunded|wiped|fixed|deregistered|reset)\b/i);
      expect(en).not.toMatch(/\b(your )?otp (is|was)\b/i);
    }
  });

  it('routes the security scenarios to FRAUD_DISPUTE (auto-URGENT) and the technical ones to ordinary cases', () => {
    const byKind = Object.fromEntries(SUPPORT_ROUTES.map((r) => [r.kind, r.category]));
    expect(byKind.account_compromise).toBe('FRAUD_DISPUTE');
    expect(byKind.otp_solicitation).toBe('FRAUD_DISPUTE');
    expect(byKind.unexpected_otp).toBe('FRAUD_DISPUTE');
    expect(byKind.wrong_recipient_transfer).toBe('TRANSACTION_DISPUTE');
    expect(byKind.app_technical).toBe('ACCOUNT_ISSUE');
    expect(byKind.card_hardware).toBe('CARD_ISSUE');
  });

  it('the app-technical reply explicitly says no PIN/password reset is needed (regression for finding #11)', () => {
    const route = SUPPORT_ROUTES.find((r) => r.kind === 'app_technical')!;
    expect(route.replyEn('TCK-1')).toMatch(/doesn't need a PIN or password reset/);
  });
});

describe('detectSupportRoute — Arabic', () => {
  const kind = (text: string) => detectSupportRoute(text, true)?.kind ?? null;

  it.each([
    ['التطبيق لا يفتح على هاتفي', 'app_technical'],
    ['انتهت الجلسة', 'app_technical'],
    ['شخص دخل حسابي بدون إذني', 'account_compromise'],
    ['حسابي مخترق', 'account_compromise'],
    ['شخص اتصل وطلب رمز التحقق', 'otp_solicitation'],
    ['وصلني رمز لم أطلبه', 'unexpected_otp'],
    ['ضيعت هاتفي', 'lost_phone'],
    ['حولت مبلغ بالخطأ', 'wrong_recipient_transfer'],
    ['أريد تغيير نوع الحساب', 'account_type_change'],
    ['أريد إغلاق حسابي', 'account_closure'],
    ['الشريحة لا تعمل في بطاقتي', 'card_hardware'],
    ['البصمة لا تعمل', 'device_biometric'],
  ])('routes %j to %s', (text, expected) => {
    expect(kind(text)).toBe(expected);
  });

  it.each(['كم رصيدي؟', 'ما حالة بطاقتي؟', 'فشلت عملية الدفع', 'نسيت الرقم السري', 'أريد تحويل 500 ريال'])(
    'does NOT route %j',
    (text) => {
      expect(kind(text)).toBeNull();
    },
  );

  it('has an Arabic reply for every route that still contains the real case id', () => {
    for (const route of SUPPORT_ROUTES) expect(route.replyAr('TCK-9')).toContain('TCK-9');
  });
});

describe('detectFabricatedFinancialClaim — refund and device/account action claims', () => {
  it('flags an ungrounded "I have issued a refund" claim', () => {
    expect(detectFabricatedFinancialClaim("I've issued a refund of 260 SAR to your account.", [], false)).toBe('refund_issued');
  });

  it('flags "your refund will be credited" with no lookup', () => {
    expect(detectFabricatedFinancialClaim('Your refund has been processed and will arrive soon.', [], false)).toBe('refund_issued');
  });

  it('does NOT flag a refund statement grounded in a real transaction lookup this turn', () => {
    expect(detectFabricatedFinancialClaim('Your refund was credited on September 2.', ['get_transaction'], false)).toBeNull();
    expect(detectFabricatedFinancialClaim('Your refund has been processed.', ['get_customer_cases'], false)).toBeNull();
  });

  it('does NOT flag a neutral refund explanation', () => {
    expect(detectFabricatedFinancialClaim('Refunds are reviewed by our team after a dispute is opened.', [], false)).toBeNull();
  });

  it('flags a claimed device/account action that no tool can perform', () => {
    expect(detectFabricatedFinancialClaim('Your device has been deregistered and your account has been secured.', [], false)).toBe(
      'device_or_account_action',
    );
    expect(detectFabricatedFinancialClaim("I've locked your online banking access.", [], false)).toBe('device_or_account_action');
  });

  it('does NOT flag a real lockout status reported from a verification/account lookup', () => {
    expect(detectFabricatedFinancialClaim('Your online banking was locked after 5 failed attempts.', ['get_verification_status'], false)).toBeNull();
  });

  it('flags the Arabic equivalents', () => {
    expect(detectFabricatedFinancialClaim('تم تأمين حسابك وقفل الوصول.', [], true)).toBe('device_or_account_action');
    expect(detectFabricatedFinancialClaim('أصدرت استرداد المبلغ إلى حسابك.', [], true)).toBe('refund_issued');
  });

  it('keeps every earlier guard intact (regression)', () => {
    expect(detectFabricatedFinancialClaim('The transfer has been processed successfully.', [], false)).toBe('transfer');
    expect(detectFabricatedFinancialClaim('Your PIN has been reset.', [], false)).toBe('reset');
  });
});

describe('detectRequiredAccountTools — the core deterministic balance/account/transaction router', () => {
  it.each([
    ['What is my balance?', ['get_balance']],
    ['how much money do I have', ['get_balance']],
    ['How much is in my account?', ['get_balance']],
    ['show me my recent transactions', ['get_transactions']],
    ['What did I spend last week', ['get_transactions']],
    ['Why did my payment fail?', ['get_transactions']],
    ['any purchases today', ['get_transactions']],
    ['What is my account status?', ['get_account']],
    ['Is my payment account active?', ['get_account']],
    ['account balance', ['get_balance']],
    ['my balance and my transactions', ['get_balance', 'get_transactions']],
    ['hello there', []],
    ['I want to block my card', []],
  ])('%j -> %j', (text, expected) => {
    expect(detectRequiredAccountTools(text, false)).toEqual(expected);
  });

  it('skips the generic transaction list when an explicit reference is named (specific lookup wins)', () => {
    expect(detectRequiredAccountTools('Can you check transaction TXN-1440 for me?', false)).toEqual([]);
  });

  it('never double-routes account status when balance or transactions already matched', () => {
    expect(detectRequiredAccountTools('my account balance and account status', false)).toEqual(['get_balance']);
  });

  it('routes Arabic balance, transaction and singular-operation phrasings', () => {
    expect(detectRequiredAccountTools('كم رصيدي؟', true)).toEqual(['get_balance']);
    expect(detectRequiredAccountTools('ما هي آخر معاملاتي', true)).toEqual(['get_transactions']);
    expect(detectRequiredAccountTools('فشلت عملية الدفع الخاصة بي', true)).toEqual(['get_transactions']);
  });
});

describe('detectTransferStatusQuestion — delayed-transfer phrasing and create/cancel/fee regressions', () => {
  it.each([
    'My transfer is delayed',
    'My transfer hasn\'t arrived yet',
    'The transfer is taking too long',
    'Is my transfer still pending?',
    'Why is my transfer stuck?',
  ])('treats %j as a status lookup', (text) => {
    expect(detectTransferStatusQuestion(text, false)).toBe(true);
  });

  it('treats the Arabic delayed-transfer phrasing as a status lookup', () => {
    expect(detectTransferStatusQuestion('تحويلي متأخر', true)).toBe(true);
    expect(detectTransferStatusQuestion('التحويل لم يصل', true)).toBe(true);
  });

  it.each([
    'Transfer 500 SAR to Ahmed',
    'I want to send a new transfer',
    'What is the transfer fee?',
    'What is my transfer limit?',
    'Yes',
    'Cancel the transfer',
  ])('does NOT treat %j as a transfer status lookup', (text) => {
    expect(detectTransferStatusQuestion(text, false)).toBe(false);
  });
});

describe('formatTransferStatusReply — exact backend data only (finding #3 regression)', () => {
  const real = {
    transferReference: 'TRF-SEED0001',
    resultingTransactionRef: 'TRF-SEED0001-DR',
    status: 'COMPLETED',
    amount: 500,
    fee: 5,
    currency: 'SAR',
    createdDate: '2026-09-23',
    destinationName: 'Al-Rajhi Supplies Est.',
  };

  it('quotes the transfer reference, amount, fee, beneficiary, status and date exactly as returned', () => {
    const reply = formatTransferStatusReply(real, false);
    expect(reply).toContain('TRF-SEED0001');
    expect(reply).toContain('500 SAR');
    expect(reply).toContain('5 SAR fee');
    expect(reply).toContain('Al-Rajhi Supplies Est.');
    expect(reply).toContain('completed');
    expect(reply).toContain('2026-09-23');
  });

  it('never surfaces the settlement-leg reference as the transfer reference', () => {
    expect(formatTransferStatusReply(real, false)).not.toContain('-DR');
    expect(formatTransferStatusReply(real, true)).not.toContain('-DR');
  });

  it('omits the fee clause entirely for a zero-fee (internal) transfer instead of inventing one', () => {
    expect(formatTransferStatusReply({ ...real, fee: 0 }, false)).not.toMatch(/fee/i);
  });

  it('reports a failed transfer with a human reason, never the raw enum', () => {
    const reply = formatTransferStatusReply({ ...real, status: 'FAILED', failureReason: 'INSUFFICIENT_FUNDS' }, false);
    expect(reply).toContain('Reason: insufficient funds');
    expect(reply).not.toContain('INSUFFICIENT_FUNDS');
  });

  it('Arabic: translated status and failure reason, same exact figures', () => {
    const reply = formatTransferStatusReply({ ...real, status: 'FAILED', failureReason: 'INSUFFICIENT_FUNDS' }, true);
    expect(reply).toContain('TRF-SEED0001');
    expect(reply).toContain('500 SAR');
    expect(reply).toContain('عدم كفاية الرصيد');
    expect(reply).not.toContain('INSUFFICIENT_FUNDS');
  });
});

describe('cardStatusWord', () => {
  it('never leaks a raw ENUM_NAME in English or Arabic', () => {
    expect(cardStatusWord('PENDING_REPLACEMENT', false)).toBe('pending replacement');
    expect(cardStatusWord('ACTIVE', false)).toBe('active');
    expect(cardStatusWord('ACTIVE', true)).toBe('نشطة');
    expect(cardStatusWord('BLOCKED', true)).toBe('محظورة');
    expect(cardStatusWord('PENDING_REPLACEMENT', true)).toBe('قيد الاستبدال');
  });
});

describe('formatVerifyOtpFailureReply — a wrong code is never reported as expired', () => {
  it('maps the deliberately vague "Invalid or expired verification code" to a try-again reply', () => {
    const reply = formatVerifyOtpFailureReply(new Error('Invalid or expired verification code'), false);
    expect(reply).toMatch(/doesn't match/);
    expect(reply).not.toMatch(/expired/i);
    expect(formatVerifyOtpFailureReply(new Error('Invalid or expired verification code'), true)).toContain('غير صحيح');
  });

  it('still reports a genuinely expired session as expired', () => {
    expect(formatVerifyOtpFailureReply(new Error('That verification code has expired. Please request a new one.'), false)).toMatch(/expired/);
  });

  it('falls back to an escalation offer for an unknown failure (never a success claim)', () => {
    expect(formatVerifyOtpFailureReply(new Error('boom'), false)).toMatch(/human agent/);
  });
});

describe('extractCorrectedContactValue — a changed mind replaces the pending value', () => {
  it('captures an email embedded in a short correction', () => {
    expect(extractCorrectedContactValue('Actually use second.choice@example.com instead', false)).toEqual({ email: 'second.choice@example.com' });
  });

  it('captures a phone number embedded in a short correction', () => {
    expect(extractCorrectedContactValue('Sorry, make it 0509998877', false)).toEqual({ phone: '0509998877' });
  });

  it('captures an Arabic correction', () => {
    expect(extractCorrectedContactValue('لا بدل ذلك استخدم 0509998877', true)).toEqual({ phone: '0509998877' });
  });

  it('does NOT capture a value with no correction cue (ordinary sentence)', () => {
    expect(extractCorrectedContactValue('My reference is 0509998877 for the ticket', false)).toBeNull();
    expect(extractCorrectedContactValue('email me at john@example.com', false)).toBeNull();
  });

  it('does NOT capture from a long message, or one with too few digits', () => {
    expect(extractCorrectedContactValue('Actually ' + 'blah '.repeat(30) + 'a@b.co', false)).toBeNull();
    expect(extractCorrectedContactValue('Actually use 12345', false)).toBeNull();
  });
});

describe('isCodeOnlyMessage — duplicate/stale code resubmission shape', () => {
  it.each(['123456', 'The code is 123456', 'my code is 123456.', 'OTP: 123456', "it's 123456", 'الرمز هو 123456'])('treats %j as a bare code', (text) => {
    expect(isCodeOnlyMessage(text, /[؀-ۿ]/.test(text))).toBe(true);
  });

  it.each([
    'Transfer 100000 to Ahmed',
    'My balance is 123456 SAR right?',
    'Please send 123456 to my friend',
    'hello',
    '12345',
    'call 0509998877',
  ])('does NOT treat %j as a bare code', (text) => {
    expect(isCodeOnlyMessage(text, false)).toBe(false);
  });
});
