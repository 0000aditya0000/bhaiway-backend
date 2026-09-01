import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import {
  DataSource,
  EntityManager,
  Repository,
} from 'typeorm';

import { Booking } from '../bookings/entities/booking.entity';
import { BookingStatus } from '../bookings/enums/booking.enums';
import { Ride } from '../rides/entities/ride.entity';
import { RideStatus } from '../rides/enums/ride.enums';
import { UserProfile } from '../users/entities/user-profile.entity';
import { RatingTask } from './entities/rating-task.entity';
import {
  PendingRatingItemDto,
  PendingRatingsPageDto,
  ReceivedRatingItemDto,
  SkipRatingResponseDto,
  SubmitRatingResponseDto,
  UserRatingsSummaryDto,
} from './dto/rating-response.dto';
import { SubmitRatingDto } from './dto/submit-rating.dto';
import { UserRatingsQueryDto } from './dto/user-ratings-query.dto';
import { RatingTargetRole, RatingTaskStatus } from './enums/rating.enums';

const MAX_COMMENT_LENGTH = 500;

@Injectable()
export class RatingsService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(RatingTask)
    private readonly ratingTaskRepository: Repository<RatingTask>,
    @InjectRepository(Ride)
    private readonly rideRepository: Repository<Ride>,
    @InjectRepository(Booking)
    private readonly bookingRepository: Repository<Booking>,
    @InjectRepository(UserProfile)
    private readonly userProfileRepository: Repository<UserProfile>,
  ) {}

  /**
   * Idempotently creates driver↔passenger rating obligations for a completed ride.
   * Safe to call on completion retries; uses INSERT … ON CONFLICT DO NOTHING.
   */
  async createRatingTasksInTransaction(
    manager: EntityManager,
    ride: Pick<Ride, 'id' | 'driverId' | 'status'>,
  ): Promise<void> {
    if (ride.status !== RideStatus.COMPLETED) {
      return;
    }

    const completedBookings = await manager.getRepository(Booking).find({
      where: {
        rideId: ride.id,
        status: BookingStatus.COMPLETED,
      },
      order: { id: 'ASC' },
    });

    if (completedBookings.length === 0) {
      return;
    }

    const rows: Array<Partial<RatingTask>> = [];
    for (const booking of completedBookings) {
      if (booking.passengerId === ride.driverId) {
        continue;
      }

      rows.push({
        id: randomUUID(),
        rideId: ride.id,
        bookingId: booking.id,
        fromUserId: ride.driverId,
        toUserId: booking.passengerId,
        status: RatingTaskStatus.PENDING,
        reminderCount: 0,
      });
      rows.push({
        id: randomUUID(),
        rideId: ride.id,
        bookingId: booking.id,
        fromUserId: booking.passengerId,
        toUserId: ride.driverId,
        status: RatingTaskStatus.PENDING,
        reminderCount: 0,
      });
    }

    if (rows.length === 0) {
      return;
    }

    await manager
      .createQueryBuilder()
      .insert()
      .into(RatingTask)
      .values(rows)
      .orIgnore()
      .execute();
  }

  async findPendingForUser(userId: string): Promise<PendingRatingsPageDto> {
    const tasks = await this.ratingTaskRepository.find({
      where: {
        fromUserId: userId,
        status: RatingTaskStatus.PENDING,
      },
      order: { createdAt: 'ASC', id: 'ASC' },
    });

    if (tasks.length === 0) {
      return { items: [] };
    }

    const rideIds = [...new Set(tasks.map((task) => task.rideId))];
    const targetUserIds = [...new Set(tasks.map((task) => task.toUserId))];

    const rides = await this.rideRepository.find({
      where: rideIds.map((id) => ({ id })),
    });
    const rideById = new Map(rides.map((ride) => [ride.id, ride]));

    const profiles = await this.userProfileRepository.find({
      where: targetUserIds.map((id) => ({ userId: id })),
    });
    const profileByUserId = new Map(
      profiles.map((profile) => [profile.userId, profile]),
    );

    const driverIds = new Set(rides.map((ride) => ride.driverId));

    const items: PendingRatingItemDto[] = tasks.map((task) => {
      const ride = rideById.get(task.rideId);
      if (!ride) {
        throw new NotFoundException('Ride not found for pending rating task');
      }

      const profile = profileByUserId.get(task.toUserId);
      const role = driverIds.has(task.toUserId)
        ? RatingTargetRole.DRIVER
        : RatingTargetRole.PASSENGER;

      return {
        taskId: task.id,
        rideId: task.rideId,
        bookingId: task.bookingId,
        userId: task.toUserId,
        userName: profile?.displayName ?? profile?.firstName ?? null,
        userPhoto: profile?.profilePhoto ?? null,
        role,
        skippedAt: task.skippedAt?.toISOString() ?? null,
        ride: {
          rideId: ride.id,
          source: ride.source,
          destination: ride.destination,
          departureDate: ride.departureDate,
          departureTime: ride.departureTime,
        },
      };
    });

    return { items };
  }

  async skipRating(
    userId: string,
    taskId: string,
  ): Promise<SkipRatingResponseDto> {
    return this.dataSource.transaction(async (manager) => {
      const task = await this.lockTaskForUser(manager, userId, taskId);
      this.assertTaskPending(task);

      if (!task.skippedAt) {
        task.skippedAt = new Date();
        await manager.getRepository(RatingTask).save(task);
      }

      return {
        taskId: task.id,
        status: 'PENDING',
        skippedAt: task.skippedAt.toISOString(),
      };
    });
  }

  async submitRating(
    userId: string,
    dto: SubmitRatingDto,
  ): Promise<SubmitRatingResponseDto> {
    if (!Number.isInteger(dto.rating)) {
      throw new BadRequestException('rating must be an integer between 1 and 5');
    }

    const comment = this.normalizeComment(dto.comment);

    return this.dataSource.transaction(async (manager) => {
      const task = await this.lockTaskForUser(manager, userId, dto.taskId);

      if (task.status === RatingTaskStatus.COMPLETED) {
        if (task.rating !== dto.rating) {
          throw new ConflictException('Rating was already submitted');
        }
        const existingComment = task.comment ?? null;
        if (existingComment !== comment) {
          throw new ConflictException('Rating was already submitted');
        }
        return {
          taskId: task.id,
          rating: task.rating!,
          comment: task.comment,
          completedAt: task.completedAt!.toISOString(),
          alreadyCompleted: true,
        };
      }

      this.assertTaskPending(task);
      await this.assertTaskParticipants(manager, task);

      const completedAt = new Date();
      task.status = RatingTaskStatus.COMPLETED;
      task.rating = dto.rating;
      task.comment = comment;
      task.completedAt = completedAt;
      await manager.getRepository(RatingTask).save(task);

      return {
        taskId: task.id,
        rating: task.rating,
        comment: task.comment,
        completedAt: completedAt.toISOString(),
        alreadyCompleted: false,
      };
    });
  }

  async getUserRatingsSummary(
    userId: string,
    query: UserRatingsQueryDto,
  ): Promise<UserRatingsSummaryDto> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const aggregate = await this.ratingTaskRepository
      .createQueryBuilder('task')
      .select('AVG(task.rating)', 'average')
      .addSelect('COUNT(task.id)', 'count')
      .where('task.to_user_id = :userId', { userId })
      .andWhere('task.status = :status', {
        status: RatingTaskStatus.COMPLETED,
      })
      .andWhere('task.rating IS NOT NULL')
      .getRawOne<{ average: string | null; count: string }>();

    const totalRatings = Number(aggregate?.count ?? 0);
    const averageRating =
      totalRatings === 0
        ? 0
        : Math.round(Number(aggregate?.average ?? 0) * 10) / 10;

    const [tasks, total] = await this.ratingTaskRepository.findAndCount({
      where: {
        toUserId: userId,
        status: RatingTaskStatus.COMPLETED,
      },
      order: { completedAt: 'DESC', id: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    const items: ReceivedRatingItemDto[] = tasks
      .filter((task) => task.rating !== null && task.completedAt !== null)
      .map((task) => ({
        rating: task.rating!,
        comment: task.comment,
        createdAt: task.completedAt!.toISOString(),
      }));

    return {
      averageRating,
      totalRatings,
      items,
      page,
      limit,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  /**
   * Internal query for future reminder schedulers.
   * Returns PENDING tasks not reminded since `notRemindedSince`.
   */
  async findPendingRatingReminders(params: {
    notRemindedSince: Date;
    limit?: number;
  }): Promise<RatingTask[]> {
    return this.ratingTaskRepository
      .createQueryBuilder('task')
      .where('task.status = :status', { status: RatingTaskStatus.PENDING })
      .andWhere(
        '(task.last_reminded_at IS NULL OR task.last_reminded_at <= :notRemindedSince)',
        { notRemindedSince: params.notRemindedSince },
      )
      .orderBy('task.last_reminded_at', 'ASC', 'NULLS FIRST')
      .addOrderBy('task.created_at', 'ASC')
      .addOrderBy('task.id', 'ASC')
      .take(params.limit ?? 100)
      .getMany();
  }

  private async lockTaskForUser(
    manager: EntityManager,
    userId: string,
    taskId: string,
  ): Promise<RatingTask> {
    const task = await manager
      .getRepository(RatingTask)
      .createQueryBuilder('task')
      .setLock('pessimistic_write')
      .where('task.id = :taskId', { taskId })
      .getOne();

    if (!task || task.fromUserId !== userId) {
      throw new NotFoundException('Rating task not found');
    }

    return task;
  }

  private assertTaskPending(task: RatingTask): void {
    if (task.status !== RatingTaskStatus.PENDING) {
      throw new ConflictException('Rating task is not pending');
    }
  }

  private async assertTaskParticipants(
    manager: EntityManager,
    task: RatingTask,
  ): Promise<void> {
    if (task.fromUserId === task.toUserId) {
      throw new BadRequestException('Users cannot rate themselves');
    }

    const ride = await manager.getRepository(Ride).findOne({
      where: { id: task.rideId },
    });
    if (!ride || ride.status !== RideStatus.COMPLETED) {
      throw new ConflictException('Ride is not eligible for rating');
    }

    const booking = await manager.getRepository(Booking).findOne({
      where: { id: task.bookingId },
    });
    if (!booking || booking.rideId !== ride.id) {
      throw new BadRequestException('Booking does not belong to ride');
    }
    if (booking.status !== BookingStatus.COMPLETED) {
      throw new ConflictException('Booking is not eligible for rating');
    }

    const driverRatesPassenger =
      task.fromUserId === ride.driverId &&
      task.toUserId === booking.passengerId;
    const passengerRatesDriver =
      task.fromUserId === booking.passengerId &&
      task.toUserId === ride.driverId;

    if (!driverRatesPassenger && !passengerRatesDriver) {
      throw new ForbiddenException(
        'Rating participants do not match ride booking',
      );
    }
  }

  private normalizeComment(comment?: string | null): string | null {
    if (comment === undefined || comment === null) {
      return null;
    }
    const trimmed = comment.trim();
    if (trimmed.length === 0) {
      return null;
    }
    if (trimmed.length > MAX_COMMENT_LENGTH) {
      throw new BadRequestException(
        `comment must be at most ${MAX_COMMENT_LENGTH} characters`,
      );
    }
    return trimmed;
  }
}
