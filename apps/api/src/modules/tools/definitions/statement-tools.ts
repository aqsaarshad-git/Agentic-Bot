import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { AccountsService } from '../../accounts/accounts.service';
import { StatementsService } from '../../statements/statements.service';
import { ToolDefinition } from '../tool-definition.interface';
import { VerificationLevel } from '../verification-level';
import { requireCustomerId, toJsonSchema } from './shared';

/** Real banks issue one statement per calendar month by default — a customer asking for "my
 *  statement" with no period in mind means the most recent one, not a year (that's a separate,
 *  much less common request — annual/tax statements). "Last calendar month" rather than
 *  "the last 30 days" matches how a real statement period is always delimited.
 *
 *  CONFIRMED LIVE BUG (2026-09-23): constructing these with the local-timezone Date constructor
 *  (`new Date(year, month, day, 0,0,0,0)`) meant a customer in a UTC+5 timezone got told their
 *  statement covered "July 31 to August 31" instead of "August 1 to August 31" — periodStart's
 *  local midnight shifted back a day once serialized via toISOString() for the tool result Qwen
 *  reads. Date.UTC() fixes this by constructing the boundary already in UTC, so there's no
 *  timezone-dependent shift left to happen when it's later read back as an ISO string. */
function lastCalendarMonth(): { periodStart: Date; periodEnd: Date } {
  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0));
  const periodEnd = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999)); // day 0 of this month = last day of previous month
  return { periodStart, periodEnd };
}

export function buildStatementTools(accounts: AccountsService, statements: StatementsService): ToolDefinition[] {
  return [
    {
      name: 'request_statement',
      description:
        'Call FIRST whenever a customer asks for a statement — none can be looked up before this runs. ' +
        'Statements are MONTHLY by default; if no period is named, omit period_start/period_end (defaults to ' +
        'last calendar month) — only ask if they implied a different period (a named month, "last 3 months", ' +
        'a date range), then convert it to ISO dates yourself. No PDF is generated here (only on an actual ' +
        'email send — see send_statement_by_email); this just creates the request. No SMS delivery exists; ' +
        'email is ONLY ever sent via send_statement_by_email after explicit confirmation — never claim a ' +
        'statement was sent from this tool alone.',
      inputSchema: z.object({
        period_start: z.string().optional().describe('ISO date, e.g. 2026-08-01 — omit for the default (last calendar month)'),
        period_end: z.string().optional().describe('ISO date, e.g. 2026-08-31 — omit for the default (last calendar month)'),
        account_id: z.string().optional(),
        format: z.enum(['PDF', 'CSV']).optional(),
      }),
      parametersJsonSchema: toJsonSchema(
        {
          period_start: { type: 'string', description: 'ISO start date of the statement period — omit for last calendar month' },
          period_end: { type: 'string', description: 'ISO end date of the statement period — omit for last calendar month' },
          account_id: { type: 'string', description: 'A specific account ID (optional)' },
          format: { type: 'string', description: 'Document format', enum: ['PDF', 'CSV'] },
        },
        [],
      ),
      handler: async (ctx, args) => {
        const customerId = requireCustomerId(ctx);
        const account = await accounts.resolveForCustomer(customerId, args.account_id);
        const defaultPeriod = args.period_start && args.period_end ? null : lastCalendarMonth();
        const statement = await statements.request({
          customerId,
          accountId: account.id,
          conversationId: ctx.conversationId,
          periodStart: args.period_start ? new Date(args.period_start) : defaultPeriod!.periodStart,
          periodEnd: args.period_end ? new Date(args.period_end) : defaultPeriod!.periodEnd,
          format: args.format,
        });
        return {
          requestNumber: statement.requestNumber,
          status: statement.status,
          downloadUrl: statement.downloadUrl,
          periodStart: statement.periodStart.toISOString().slice(0, 10),
          periodEnd: statement.periodEnd.toISOString().slice(0, 10),
        };
      },
    },
    {
      name: 'get_statement',
      description:
        "Get the status of a statement already requested this conversation, via request_statement's exact " +
        'request_number — never call this first for a new request; call request_statement instead.',
      inputSchema: z.object({ request_number: z.string() }),
      parametersJsonSchema: toJsonSchema({ request_number: { type: 'string', description: 'The statement request number' } }, ['request_number']),
      idempotent: true,
      handler: async (ctx, args) => {
        const statement = await statements.findByRequestNumberForCustomer(args.request_number, requireCustomerId(ctx));
        return { requestNumber: statement.requestNumber, status: statement.status, downloadUrl: statement.downloadUrl ?? undefined };
      },
    },
    {
      name: 'send_statement_by_email',
      description:
        "Emails the customer's most recently requested statement to their REGISTERED email — the destination " +
        'is always resolved server-side; never invent or ask for an email address. Call ONLY after ' +
        'request_statement has run this conversation AND the customer explicitly confirmed emailing it (a ' +
        'plain "yes"/"send it" replying to your own offer — never on a greeting or unrelated question). ' +
        "Performs a real send; only report success if this tool's result says success — report a failure " +
        'honestly, never as success. Safe to call again for the same statement (reports already-sent, never ' +
        'double-sends).',
      inputSchema: z.object({ statement_request_id: z.string().optional() }),
      parametersJsonSchema: toJsonSchema(
        {
          statement_request_id: {
            type: 'string',
            description: 'Only needed if the customer explicitly refers back to an older statement by its request number — omit for the normal case',
          },
        },
        [],
      ),
      minVerificationLevel: VerificationLevel.VERIFIED,
      handler: async (ctx, args) => {
        const customerId = requireCustomerId(ctx);
        try {
          const result = await statements.sendStatementByEmail({
            customerId,
            conversationId: ctx.conversationId,
            statementRequestId: args.statement_request_id,
          });
          return result;
        } catch (error) {
          if (error instanceof BadRequestException && error.message === 'NO_REGISTERED_EMAIL') {
            return { success: false, reason: 'NO_REGISTERED_EMAIL' };
          }
          throw error;
        }
      },
    },
  ];
}
