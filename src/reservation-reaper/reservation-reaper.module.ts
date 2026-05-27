import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReservationReaperService } from './reservation-reaper.service';
import { TimeOffRequest } from '../entities/time-off-request.entity';
import { Outbox } from '../entities/outbox.entity';
import { TimeOffRequestModule } from '../time-off-request/time-off-request.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([TimeOffRequest, Outbox]),
    TimeOffRequestModule,
  ],
  providers: [ReservationReaperService],
})
export class ReservationReaperModule {}
