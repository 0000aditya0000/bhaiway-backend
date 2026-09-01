export enum RatingTaskStatus {
  PENDING = 'PENDING',
  COMPLETED = 'COMPLETED',
}

/** Role of the rating target relative to the authenticated rater. */
export enum RatingTargetRole {
  DRIVER = 'DRIVER',
  PASSENGER = 'PASSENGER',
}

/** Whether user ratings are received by or given by the profile user. */
export enum UserRatingDirection {
  RECEIVED = 'RECEIVED',
  GIVEN = 'GIVEN',
}
