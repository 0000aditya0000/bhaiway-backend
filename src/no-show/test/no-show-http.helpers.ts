import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { NoShowClaimStatus } from '../enums/no-show.enums';

export async function approveNoShowClaim(
  app: INestApplication,
  claimId: string,
  respondentAccessToken: string,
) {
  return request(app.getHttpServer())
    .post(`/no-show-claims/${claimId}/approve`)
    .set('Authorization', `Bearer ${respondentAccessToken}`)
    .expect(200);
}

export async function rejectNoShowClaim(
  app: INestApplication,
  claimId: string,
  respondentAccessToken: string,
) {
  return request(app.getHttpServer())
    .post(`/no-show-claims/${claimId}/reject`)
    .set('Authorization', `Bearer ${respondentAccessToken}`)
    .expect(200);
}

export async function reportDriverNoShowAndApprove(
  app: INestApplication,
  rideId: string,
  passengerAccessToken: string,
  driverAccessToken: string,
) {
  const created = await request(app.getHttpServer())
    .post(`/rides/${rideId}/driver-no-show`)
    .set('Authorization', `Bearer ${passengerAccessToken}`)
    .expect(200);
  if (created.body.status !== NoShowClaimStatus.PENDING) {
    throw new Error(
      `Expected pending driver no-show claim, got ${created.body.status}`,
    );
  }
  return approveNoShowClaim(app, created.body.id, driverAccessToken);
}

export async function reportPassengerNoShowAndApprove(
  app: INestApplication,
  bookingId: string,
  driverAccessToken: string,
  passengerAccessToken: string,
) {
  const created = await request(app.getHttpServer())
    .post(`/bookings/${bookingId}/rider-no-show`)
    .set('Authorization', `Bearer ${driverAccessToken}`)
    .expect(200);
  if (created.body.status !== NoShowClaimStatus.PENDING) {
    throw new Error(
      `Expected pending passenger no-show claim, got ${created.body.status}`,
    );
  }
  return approveNoShowClaim(app, created.body.id, passengerAccessToken);
}
