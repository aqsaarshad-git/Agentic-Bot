import { Injectable, Logger } from '@nestjs/common';
import { NotificationChannel, NotificationRecipientType } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

export interface SendNotificationInput {
  recipientType: NotificationRecipientType;
  recipientId: string;
  channel: NotificationChannel;
  subject?: string;
  content: string;
}

/**
 * No real email/SMS gateway is part of the mandated stack yet, so this records the
 * notification as sent immediately. Swapping in a real provider later only changes
 * this service — callers (auth OTP, campaigns, etc.) are unaffected.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async send(input: SendNotificationInput) {
    const notification = await this.prisma.notification.create({
      data: { ...input, status: 'SENT', sentAt: new Date() },
    });
    this.logger.log(`Notification ${notification.id} (${input.channel}) -> ${input.recipientId}: ${input.content}`);
    return notification;
  }
}
