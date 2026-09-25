import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { StatementsService } from './statements.service';

@Module({
  imports: [NotificationsModule],
  providers: [StatementsService],
  exports: [StatementsService],
})
export class StatementsModule {}
