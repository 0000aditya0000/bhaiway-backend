import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CreateProfileDto } from './dto/create-profile.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UserProfile } from './entities/user-profile.entity';
import { User } from './entities/user.entity';
import { isProfileCompleted } from './profile-completion';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(UserProfile)
    private readonly userProfileRepository: Repository<UserProfile>,
  ) {}

  async getMe(userId: string) {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const profile = await this.getProfileEntity(userId);

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
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const existing = await this.getProfileEntity(userId);
    if (existing) {
      throw new ConflictException('User profile already exists');
    }

    const profile = this.userProfileRepository.create({
      userId,
      firstName: dto.firstName.trim(),
      lastName: dto.lastName ?? null,
      displayName: dto.displayName ?? null,
      gender: dto.gender ?? null,
      dateOfBirth: dto.dateOfBirth ?? null,
      profilePhoto: dto.profilePhoto ?? null,
    });

    const saved = await this.userProfileRepository.save(profile);
    return this.toProfileResponse(saved);
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
