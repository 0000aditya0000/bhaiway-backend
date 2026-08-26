import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';

import { Booking } from '../../bookings/entities/booking.entity';
import {
  BookingPickupStatus,
  BookingStatus,
} from '../../bookings/enums/booking.enums';
import { decryptPickupOtp } from '../../bookings/pickup-otp.util';

/**
 * Integration-test helper: start a trip-lifecycle ride and verify pickup OTP
 * for every active CONFIRMED booking still waiting for pickup.
 */
export async function startRideAndVerifyAllPickups(
  app: INestApplication,
  dataSource: DataSource,
  driverAccessToken: string,
  rideId: string,
  otpPepper: string,
): Promise<void> {
  await request(app.getHttpServer())
    .post(`/rides/${rideId}/start`)
    .set('Authorization', `Bearer ${driverAccessToken}`)
    .expect(200);

  const bookings = await dataSource.getRepository(Booking).find({
    where: {
      rideId,
      status: BookingStatus.CONFIRMED,
    },
  });

  for (const booking of bookings) {
    if (booking.pickupStatus === BookingPickupStatus.PICKED_UP) {
      continue;
    }
    if (!booking.pickupOtpCiphertext) {
      throw new Error(
        `Booking ${booking.id} is missing pickup OTP after ride start`,
      );
    }
    const otp = decryptPickupOtp(booking.pickupOtpCiphertext, otpPepper);
    await request(app.getHttpServer())
      .post(`/bookings/${booking.id}/verify-pickup`)
      .set('Authorization', `Bearer ${driverAccessToken}`)
      .send({ otp })
      .expect(200);
  }
}
