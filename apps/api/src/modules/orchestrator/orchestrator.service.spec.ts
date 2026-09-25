import {
  detectDeterministicConversationalReply,
  detectFabricatedFinancialClaim,
  detectPromisedLookupWithoutToolCall,
  detectSendConfirmIntent,
  detectTransferReplyIntent,
  extractOtpCode,
  findFabricatedEmailMention,
  formatSafeAccountSentence,
  stripLeakedToolNameSentences,
  stripPolicyLeakSentences,
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
