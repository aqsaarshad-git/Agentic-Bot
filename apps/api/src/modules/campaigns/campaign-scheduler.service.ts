import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AuditActorType, Campaign, CampaignContact } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ConversationsService } from '../conversations/conversations.service';
import { CallsService } from '../calls/calls.service';
import { PstnCallService } from '../telephony/pstn-call.service';

/**
 * Drives both outbound campaigns (§16) and the callback scheduler (§17). When
 * TELEPHONY_ENABLED and the customer has a phone number on file, "placing a call" now means a
 * real PSTN call via PstnCallService (FreeSWITCH/Connectel) — otherwise (the default, or no
 * phone on file) it falls back to exactly the original simulated behavior: creating the
 * Call + linked Conversation records and opening with the campaign script, ready to continue
 * over POST /calls/:id/turns like a browser call. Either way this file stays a thin caller, as
 * originally intended — only CallsService/PstnCallService know how a call actually happens.
 */
@Injectable()
export class CampaignSchedulerService {
  private readonly logger = new Logger(CampaignSchedulerService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly conversations: ConversationsService,
    private readonly callsService: CallsService,
    private readonly pstnCallService: PstnCallService,
    private readonly auditService: AuditService,
  ) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.processCampaigns();
      await this.processCallbacks();
    } catch (error) {
      this.logger.error('Scheduler tick failed', error instanceof Error ? error.stack : String(error));
    } finally {
      this.running = false;
    }
  }

  private isWithinCampaignWindow(campaign: Campaign): boolean {
    const now = new Date();
    if (campaign.startDate > now) return false;
    if (campaign.endDate && campaign.endDate < now) return false;
    if (campaign.startTime && campaign.endTime) {
      const hhmm = now.toTimeString().slice(0, 5);
      if (hhmm < campaign.startTime || hhmm > campaign.endTime) return false;
    }
    return true;
  }

  private isContactDue(campaign: Campaign, contact: CampaignContact): boolean {
    if (contact.attempts === 0) return true;
    if (!contact.lastAttemptAt) return true;
    const dueAt = contact.lastAttemptAt.getTime() + campaign.retryIntervalMinutes * 60_000;
    return Date.now() >= dueAt;
  }

  private async processCampaigns(): Promise<void> {
    const activeCampaigns = await this.prisma.campaign.findMany({ where: { status: 'ACTIVE' } });

    for (const campaign of activeCampaigns) {
      if (!this.isWithinCampaignWindow(campaign)) continue;

      const pendingContacts = await this.prisma.campaignContact.findMany({
        where: { campaignId: campaign.id, status: 'PENDING' },
        take: 5,
      });

      for (const contact of pendingContacts) {
        if (contact.attempts >= campaign.maxAttempts) {
          await this.prisma.campaignContact.update({ where: { id: contact.id }, data: { status: 'FAILED' } });
          continue;
        }
        if (!this.isContactDue(campaign, contact)) continue;

        await this.placeCampaignCall(campaign, contact);
      }
    }
  }

  private async placeCampaignCall(campaign: Campaign, contact: CampaignContact): Promise<void> {
    const { call } = await this.dial(contact.customerId, campaign.aiAgentId ?? undefined);

    if (campaign.script && call.conversationId) {
      await this.conversations.addMessage(call.conversationId, 'AI', campaign.script);
    }

    await this.prisma.campaignCall.create({
      data: {
        campaignContactId: contact.id,
        callId: call.id,
        attemptNumber: contact.attempts + 1,
        outcome: 'ANSWERED',
      },
    });

    await this.prisma.campaignContact.update({
      where: { id: contact.id },
      data: { status: 'IN_PROGRESS', attempts: { increment: 1 }, lastAttemptAt: new Date() },
    });

    await this.auditService.log({
      actorType: AuditActorType.SYSTEM,
      action: 'campaign.call_placed',
      entityType: 'campaign',
      entityId: campaign.id,
      result: { customerId: contact.customerId, callId: call.id },
      success: true,
    });
  }

  /** Places a real PSTN call when telephony is enabled and the customer has a phone number on
   *  file; otherwise falls back to the original browser-only simulated call. */
  private async dial(customerId: string, aiAgentId?: string) {
    if (this.config.get<boolean>('telephony.enabled')) {
      const customer = await this.prisma.customer.findUnique({ where: { id: customerId }, select: { phone: true } });
      if (customer?.phone) {
        return this.pstnCallService.dial({ customerId, phoneNumber: customer.phone, aiAgentId });
      }
      this.logger.warn(`Telephony enabled but customer ${customerId} has no phone on file — falling back to simulated call`);
    }
    return this.callsService.startCall(customerId, 'OUTBOUND', aiAgentId);
  }

  private combineDateAndTime(date: Date, time: string): Date {
    const [hours, minutes] = time.split(':').map(Number);
    const combined = new Date(date);
    combined.setHours(hours, minutes, 0, 0);
    return combined;
  }

  private async processCallbacks(): Promise<void> {
    const pending = await this.prisma.callback.findMany({ where: { status: 'PENDING' } });
    const now = new Date();

    for (const callback of pending) {
      const scheduledAt = this.combineDateAndTime(callback.requestedDate, callback.requestedTime);
      if (scheduledAt > now) continue;

      const { call } = await this.dial(callback.customerId);
      await this.prisma.callback.update({ where: { id: callback.id }, data: { status: 'SCHEDULED', callId: call.id } });

      await this.auditService.log({
        actorType: AuditActorType.SYSTEM,
        action: 'callback.call_placed',
        entityType: 'callback',
        entityId: callback.id,
        result: { callId: call.id },
        success: true,
      });
    }
  }
}
