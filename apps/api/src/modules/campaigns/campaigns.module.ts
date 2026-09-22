import { Module } from '@nestjs/common';
import { ConversationsModule } from '../conversations/conversations.module';
import { CallsModule } from '../calls/calls.module';
import { TelephonyModule } from '../telephony/telephony.module';
import { CampaignsController } from './campaigns.controller';
import { CampaignsService } from './campaigns.service';
import { CampaignSchedulerService } from './campaign-scheduler.service';

@Module({
  imports: [ConversationsModule, CallsModule, TelephonyModule],
  controllers: [CampaignsController],
  providers: [CampaignsService, CampaignSchedulerService],
  exports: [CampaignsService],
})
export class CampaignsModule {}
