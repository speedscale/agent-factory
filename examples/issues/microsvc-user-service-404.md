# Sample Bug

## Title

Microsvc user service returns 500 instead of 404 for a missing user

## Description

When a client requests a user record that does not exist, the service responds with a generic `500` instead of preserving the expected `404` behavior.

## Expected Result

The service should return `404` for missing users and keep the error response stable under proxymock replay.

## Validation Hint

Replay the user-service traffic set after the patch and confirm the missing-user path no longer collapses into `500`.
