import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';

import { CreateProfileDto } from './dto/create-profile.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UserProfile } from './entities/user-profile.entity';
import { User } from './entities/user.entity';
import { isProfileCompleted } from './profile-completion';
import { PassengerAssuredDepositPenaltyService } from '../assured/passenger-assured-deposit-penalty.service';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(UserProfile)
    private readonly userProfileRepository: Repository<UserProfile>,
    private readonly passengerDepositPenaltyService: PassengerAssuredDepositPenaltyService,
  ) {}

  async getMe(userId: string) {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const profile = await this.getProfileEntity(userId);
    const depositQuote =
      await this.passengerDepositPenaltyService.getDepositQuote(userId);

    return {
      user: {
        id: user.id,
        phone: user.phone,
        phoneVerified: user.phoneVerified,
        email: user.email,
        emailVerified: user.emailVerified,
        status: user.status,
      },
      profile: profile ? this.toProfileResponse(profile) : null,
      profileCompleted: isProfileCompleted(profile),
      assuredDepositPenalty: depositQuote.elevated
        ? {
            percentage: depositQuote.percentage,
            reason: depositQuote.reason!,
          }
        : null,
    };
  }

  async getProfile(userId: string) {
    const profile = await this.getProfileEntity(userId);
    if (!profile) {
      throw new NotFoundException('User profile not found');
    }
    return this.toProfileResponse(profile);
  }

  async createProfile(userId: string, dto: CreateProfileDto) {
    try {
      return await this.userRepository.manager.transaction(async (manager) => {
        const userRepo = manager.getRepository(User);
        const profileRepo = manager.getRepository(UserProfile);

        const user = await userRepo.findOne({ where: { id: userId } });
        if (!user) {
          throw new NotFoundException('User not found');
        }

        const existing = await profileRepo.findOne({ where: { userId } });
        if (existing) {
          throw new ConflictException('User profile already exists');
        }

        await this.applyOptionalEmail(userRepo, user, dto.email);

        const profile = profileRepo.create({
          userId,
          firstName: dto.firstName.trim(),
          lastName: dto.lastName ?? null,
          displayName: dto.displayName ?? null,
          gender: dto.gender ?? null,
          dateOfBirth: dto.dateOfBirth ?? null,
          profilePhoto: dto.profilePhoto ?? null,
        });

        const saved = await profileRepo.save(profile);
        return this.toProfileResponse(saved);
      });
    } catch (error) {
      this.rethrowDuplicateEmail(error);
      throw error;
    }
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const profile = await this.getProfileEntity(userId);
    if (!profile) {
      throw new NotFoundException('User profile not found');
    }

    if (dto.firstName !== undefined) {
      profile.firstName = dto.firstName.trim();
    }
    if (dto.lastName !== undefined) {
      profile.lastName = dto.lastName;
    }
    if (dto.displayName !== undefined) {
      profile.displayName = dto.displayName;
    }
    if (dto.gender !== undefined) {
      profile.gender = dto.gender;
    }
    if (dto.dateOfBirth !== undefined) {
      profile.dateOfBirth = dto.dateOfBirth;
    }
    if (dto.profilePhoto !== undefined) {
      profile.profilePhoto = dto.profilePhoto;
    }

    const saved = await this.userProfileRepository.save(profile);
    return this.toProfileResponse(saved);
  }

  private async applyOptionalEmail(
    userRepo: Repository<User>,
    user: User,
    email: string | null | undefined,
  ): Promise<void> {
    if (typeof email !== 'string' || email.trim().length === 0) {
      return;
    }

    const normalized = email.trim().toLowerCase();
    const owner = await userRepo.findOne({ where: { email: normalized } });
    if (owner && owner.id !== user.id) {
      throw new ConflictException('Email is already in use');
    }

    if (user.email === normalized) {
      return;
    }

    user.email = normalized;
    user.emailVerified = false;
    await userRepo.save(user);
  }

  private rethrowDuplicateEmail(error: unknown): void {
    if (!(error instanceof QueryFailedError)) {
      return;
    }
    const code =
      (error as { code?: string }).code ??
      (error.driverError as { code?: string } | undefined)?.code;
    const constraint =
      (error as { constraint?: string }).constraint ??
      (error.driverError as { constraint?: string } | undefined)?.constraint;
    if (
      code === '23505' &&
      (constraint === 'UQ_97672ac88f789774dd47f7c8be3' ||
        Boolean(constraint?.toLowerCase().includes('email')))
    ) {
      throw new ConflictException('Email is already in use');
    }
  }

  private async getProfileEntity(
    userId: string,
  ): Promise<UserProfile | null> {
    return this.userProfileRepository.findOne({ where: { userId } });
  }

  private toProfileResponse(profile: UserProfile) {
    return {
      id: profile.id,
      firstName: profile.firstName,
      lastName: profile.lastName,
      displayName: profile.displayName,
      gender: profile.gender,
      dateOfBirth: profile.dateOfBirth,
      profilePhoto: profile.profilePhoto,
    };
  }
}
